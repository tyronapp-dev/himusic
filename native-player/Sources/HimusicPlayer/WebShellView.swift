import SwiftUI
import WebKit
import UIKit

/// Von NativePlayerBar gepostet, wenn ausserhalb der Steuerknoepfe getippt wird - oeffnet
/// den grossen Web-Player, genau wie die ersetzte Web-Mini-Leiste es per Klick tat.
extension Notification.Name {
    static let himusicExpandFullscreenPlayer = Notification.Name("himusic.expandFullscreenPlayer")
}

/// Traegt die komplette himusic-Oberflaeche als eingebettete Webseite.
///
/// Warum: Der vorherige Ansatz (separate Player-App, Aufruf per himusicplayer://) hat
/// funktioniert, war aber im Alltag unbrauchbar - iOS fragt bei JEDEM Aufruf aus einer
/// Webseite nach Bestaetigung, und beim Zuruecksprung nach Safari riss dieses die
/// Audio-Sitzung an sich, wodurch die Wiedergabe sofort stoppte und der Sperrbildschirm
/// nichts Sinnvolles mehr zeigte. Ursache ist strukturell: iOS laesst nur EINE App
/// gleichzeitig den Ton fuehren, und zwei Apps streiten sich bei jedem Wechsel darum.
///
/// Loesung: nur noch eine App. Die Oberflaeche bleibt die bestehende Webseite (kein
/// Neubau der ~300 KB app2.js, UI-Aenderungen rollen weiter sofort ueber GitHub Pages
/// aus), aber der Ton laeuft NICHT im WebView - dort friert iOS ihn im Hintergrund ein,
/// genau der Befund aus ADR-007. Stattdessen meldet die Seite Abspielwuensche ueber die
/// JS-Bruecke `himusicNative` an den nativen AVPlayer.
struct WebShellView: UIViewRepresentable {
    let player: PlayerViewModel

    private static let startURL = URL(string: "https://tyronapp-dev.github.io/himusic/")!

    func makeCoordinator() -> Coordinator { Coordinator(player: player) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "himusicNative")

        // Marker fuer app2.js: laeuft die Seite in der Huelle, geht Wiedergabe immer
        // nativ - unabhaengig vom Schalter in den Einstellungen, der nur den alten
        // Weg aus Safari betraf. atDocumentStart, damit er vor app2.js gesetzt ist.
        // Blendet zusaetzlich die Web-eigene Mini-Player-Leiste aus - die native
        // NativePlayerBar ersetzt sie jetzt (siehe ADR-011). Als frueh injiziertes CSS
        // statt JS-Style-Toggle, weil playSong()/_applyNativeNowPlaying an mehreren
        // Stellen "display:flex" auf #mini-player setzen und ein einmaliger JS-Hide
        // davon sonst wieder ueberschrieben wuerde.
        controller.addUserScript(
            WKUserScript(
                source: """
                window.__himusicNativeShell = true;
                var s = document.createElement('style');
                s.textContent = '#mini-player{display:none!important;}';
                document.documentElement.appendChild(s);
                """,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        // Persistenter Speicher: Login, Einstellungen und IndexedDB der Seite
        // ueberleben den App-Neustart. Getrennt von Safaris Speicher - deshalb ist
        // eine einmalige Neuanmeldung in der Huelle noetig.
        config.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.load(URLRequest(url: Self.startURL))
        context.coordinator.webView = webView
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        private let player: PlayerViewModel
        weak var webView: WKWebView?

        init(player: PlayerViewModel) {
            self.player = player
            super.init()
            // Rueckkanal: bei jedem echten Songwechsel/Play-Pause meldet PlayerViewModel sich
            // hier, wir reichen es als JS an app2.js's _applyNativeNowPlaying weiter. Haelt die
            // Seite synchron mit dem, was nativ WIRKLICH laeuft (z.B. nach Auto-Skip im
            // Hintergrund) - siehe Kommentar bei onNowPlayingChanged.
            self.player.onNowPlayingChanged = { [weak self] item, isPlaying in
                self?.pushNowPlaying(item: item, isPlaying: isPlaying)
            }
            self.player.onProgressChanged = { [weak self] current, duration in
                self?.pushProgress(current: current, duration: duration)
            }
            // Zweite Absicherung noetig: evaluateJavaScript() waehrend die App im Hintergrund
            // ist (z.B. Control-Center-Play, waehrend man in einer anderen App ist), kommt
            // beim WKWebView oft gar nicht an - der Webinhalts-Prozess kann suspendiert sein.
            // Ein Push allein reicht daher nicht. Beim Vordergrund-Comeback deshalb den
            // AKTUELLEN Stand nochmal proaktiv schicken statt nur aufs naechste Event zu warten.
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(appDidBecomeActive),
                name: UIApplication.didBecomeActiveNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(expandFullscreenPlayer),
                name: .himusicExpandFullscreenPlayer,
                object: nil
            )
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        @objc private func appDidBecomeActive() {
            Task { @MainActor [weak self] in self?.pushCurrentStateIfAny() }
        }

        /// Gemeinsam fuer beide Resync-Ausloeser (Vordergrund-Comeback UND jeder abgeschlossene
        /// Seiten-Ladevorgang, siehe didFinish unten). Zweiter Ausloeser noetig: loadPlayerState()
        /// in app2.js zeigt bei JEDEM (Neu-)Laden der Seite erstmal den zuletzt lokal
        /// gespeicherten Song aus localStorage - der kann veraltet sein, wenn die Huelle im
        /// Hintergrund per Auto-Skip weitergesprungen ist und der 800ms-Debounce-Save davor nicht
        /// mehr durchlief. appDidBecomeActive allein deckt das nicht zuverlaessig ab, weil ein
        /// Seiten-Reload (z.B. WKWebView-Inhaltsprozess von iOS unter Speicherdruck neu erstellt)
        /// nicht zwingend zeitgleich mit "App aktiv geworden" passiert.
        @MainActor
        private func pushCurrentStateIfAny() {
            guard let item = player.currentItem else { return }
            pushNowPlaying(item: item, isPlaying: player.isPlaying)
        }

        @objc private func expandFullscreenPlayer() {
            webView?.evaluateJavaScript("document.getElementById('fullscreen-player')?.classList.add('open');")
        }

        private func pushNowPlaying(item: QueueItem, isPlaying: Bool) {
            guard let webView else { return }
            // [String: Any] mit "c": item.c ?? "" statt [String: Any?] - Optionals bridgen
            // nicht zuverlaessig zu NSNull fuer JSONSerialization. Leerer String ist hier
            // gleichwertig: _applyNativeNowPlaying() in app2.js behandelt beides als "kein Cover".
            let payload: [String: Any] = [
                "id": item.id, "t": item.title, "a": item.artist,
                "u": item.u, "c": item.c ?? "", "isPlaying": isPlaying
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window._applyNativeNowPlaying && window._applyNativeNowPlaying(\(json));")
        }

        private func pushProgress(current: Double, duration: Double) {
            guard let webView else { return }
            webView.evaluateJavaScript(
                "window._applyNativeProgress && window._applyNativeProgress(\(current), \(duration));"
            )
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let json = message.body as? String else { return }
            Task { @MainActor in
                self.player.handleBridgeJSON(json)
            }
        }

        /// Nach JEDEM abgeschlossenen Laden (Ersteinstieg, Retry nach weisser Flaeche, iOS-
        /// initiiertes Neuladen unter Speicherdruck) lief gerade synchron loadPlayerState() in
        /// app2.js durch und zeigt moeglicherweise einen veralteten Song - siehe
        /// pushCurrentStateIfAny(). Laeuft strikt NACH diesem synchronen Code, korrigiert es
        /// zuverlaessig, statt auf eine zufaellige zeitliche Naehe zu appDidBecomeActive zu hoffen.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor [weak self] in self?.pushCurrentStateIfAny() }
        }

        /// Ohne Netz laedt die Seite nicht. Statt einer weissen Flaeche einmal
        /// nachladen - der Service Worker der Seite bedient danach aus dem Cache.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            retryLater(webView)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            retryLater(webView)
        }

        private func retryLater(_ webView: WKWebView) {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if webView.url == nil {
                    webView.load(URLRequest(url: WebShellView.startURL))
                }
            }
        }
    }
}
