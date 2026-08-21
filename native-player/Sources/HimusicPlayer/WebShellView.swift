import SwiftUI
import WebKit
import UIKit
import Foundation

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
        // OHNE uiDelegate verschluckt WKWebView alert()/confirm()/prompt() ersatzlos, und
        // confirm() liefert dann immer false. In der Huelle war dadurch JEDER
        // Bestaetigungsdialog der Seite tot - betroffen u.a. "Warteschlange komplett leeren",
        // "Import-Historie zuruecksetzen", "Alle offline gespeicherten Songs loeschen",
        // Duplikate loeschen, Mix loeschen: der Klick lief in "if (!confirm(...)) return;"
        // und tat sichtbar nichts. In Safari funktionierten dieselben Knoepfe.
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        context.coordinator.webView = webView
        context.coordinator.loadStartPage()
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
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
            self.player.onQueueChanged = { [weak self] json in
                self?.pushQueue(json)
            }
            self.player.onPlaybackFailed = { [weak self] item, reason in
                self?.pushPlaybackFailed(item: item, reason: reason)
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
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Blieb die Oberflaeche beim Start ohne Netz weiss, ist das Zurueckkommen in den
                // Vordergrund der natuerlichste Moment fuer einen neuen Versuch - typischerweise
                // ist inzwischen entweder Netz da oder zumindest der Cache erreichbar.
                if !self.pageIsLoaded { self.loadStartPage(forceCache: true) }
                self.pushCurrentStateIfAny()
            }
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
            // Warteschlange zuerst: eine frisch geladene Seite hat noch gar keinen Stand,
            // sonst zeigt ihre Warteschlangen-Ansicht bis zum naechsten Songwechsel nichts.
            if let queueJSON = player.encodedQueueSnapshot() { pushQueue(queueJSON) }
            guard let item = player.currentItem else { return }
            pushNowPlaying(item: item, isPlaying: player.isPlaying)
        }

        @objc private func expandFullscreenPlayer() {
            webView?.evaluateJavaScript(
                "document.getElementById('fullscreen-player')?.classList.add('open'); window._updateSourceBadge && window._updateSourceBadge();"
            )
        }

        private func pushNowPlaying(item: QueueItem, isPlaying: Bool) {
            guard let webView else { return }
            // [String: Any] mit "c": item.c ?? "" statt [String: Any?] - Optionals bridgen
            // nicht zuverlaessig zu NSNull fuer JSONSerialization. Leerer String ist hier
            // gleichwertig: _applyNativeNowPlaying() in app2.js behandelt beides als "kein Cover".
            // "s" ist die Herkunft, die BEIM SONG haengt (siehe QueueItem). Die Seite leitet
            // sie nicht mehr selbst aus einer eigenen Variable ab - die blieb bei nativen
            // Songwechseln stehen und behauptete danach eine falsche Quelle.
            // "d" ist die GEMESSENE Songdauer. Sie muss hier mit, nicht erst im
            // Sekundentakt-Push: die Zeitleiste rechnet die Tippposition als Anteil der Dauer
            // um, und bis der erste Fortschritts-Push kam, haette sie nur den ungenauen
            // Datenbankwert - ein Sprung direkt nach dem Songwechsel landete dann daneben.
            // 0 heisst "noch nicht bekannt" (Datei laedt noch), dann bleibt der Notbehelf.
            let payload: [String: Any] = [
                "id": item.id, "t": item.title, "a": item.artist,
                "u": item.u, "c": item.c ?? "", "s": item.sourceLabel ?? "",
                "d": player.currentItemDurationSeconds,
                "isPlaying": isPlaying
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window._applyNativeNowPlaying && window._applyNativeNowPlaying(\(json));")
        }

        /// Meldet der Seite einen Song, der sich nicht abspielen liess. Sie zeigt einen Hinweis,
        /// wenn sie gerade sichtbar ist - laeuft die App im Hintergrund, kommt dieser Aufruf
        /// beim eingefrorenen Web-Prozess ohnehin nicht an, und dann ist stilles Ueberspringen
        /// genau das gewuenschte Verhalten. Das Ueberspringen selbst passiert nativ und haengt
        /// nicht an dieser Meldung.
        private func pushPlaybackFailed(item: QueueItem, reason: String) {
            guard let webView else { return }
            let payload: [String: Any] = ["id": item.id, "t": item.title, "reason": reason]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window._applyNativePlaybackFailed && window._applyNativePlaybackFailed(\(json));")
        }

        private func pushProgress(current: Double, duration: Double) {
            guard let webView else { return }
            webView.evaluateJavaScript(
                "window._applyNativeProgress && window._applyNativeProgress(\(current), \(duration));"
            )
        }

        private func pushQueue(_ json: String) {
            guard let webView else { return }
            webView.evaluateJavaScript("window._applyNativeQueue && window._applyNativeQueue(\(json));")
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let json = message.body as? String else { return }
            // Abgefangen statt an PlayerViewModel weitergereicht, weil dafuer die WKWebView-
            // Referenz noetig ist, die nur die Coordinator hier haelt (siehe clearCacheAndReload).
            if let data = json.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               obj["cmd"] as? String == "clearCacheAndReload" {
                Task { @MainActor [weak self] in self?.clearCacheAndReload() }
                return
            }
            Task { @MainActor in
                self.player.handleBridgeJSON(json)
            }
        }

        /// Behebt "App zeigt trotz frisch ausgeliefertem Code den alten Stand" (siehe Session
        /// vom 21.08.2026): die App-eigene WKWebsiteDataStore-Partition kann am alten Service-
        /// Worker/Cache haengenbleiben, ein normaler App-Neustart laedt die WKWebView-Instanz
        /// nicht zwingend neu vom Server. Bisher war "App loeschen und neu installieren" der
        /// einzige Ausweg. Loescht GEZIELT nur Service-Worker-Registrierung + Disk-/Memory-
        /// Cache - NICHT localStorage/IndexedDB, damit Login und lokale Bibliothek erhalten
        /// bleiben (siehe btn-clear-native-cache in app2.js).
        @MainActor
        private func clearCacheAndReload() {
            let types: Set<String> = [
                WKWebsiteDataTypeServiceWorkerRegistrations,
                WKWebsiteDataTypeDiskCache,
                WKWebsiteDataTypeMemoryCache
            ]
            WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
                guard let self, let webView = self.webView else { return }
                self.pageIsLoaded = false
                self.loadAttempt = 0
                var request = URLRequest(url: WebShellView.startURL)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                webView.load(request)
            }
        }

        // MARK: - WKUIDelegate: alert() / confirm() / prompt() der Seite

        /// Sucht den obersten sichtbaren Controller zum Praesentieren. Ohne das landet der
        /// Dialog ggf. auf einem bereits verdeckten Controller und erscheint nie.
        private func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
                ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
                ?? scene?.windows.first?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            return top
        }

        /// Jeder Zweig MUSS den completionHandler genau einmal aufrufen - sonst blockiert
        /// WebKit die betroffene Seite dauerhaft. Deshalb auch im Fehlerfall (kein
        /// Controller gefunden) ein definierter Aufruf statt stillem Abbruch.
        private func present(_ alert: UIAlertController, fallback: () -> Void) {
            guard let top = topViewController() else { fallback(); return }
            top.present(alert, animated: true)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(alert, fallback: completionHandler)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(alert, fallback: { completionHandler(false) })
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                completionHandler(alert?.textFields?.first?.text)
            })
            present(alert, fallback: { completionHandler(nil) })
        }

        /// Nach JEDEM abgeschlossenen Laden (Ersteinstieg, Retry nach weisser Flaeche, iOS-
        /// initiiertes Neuladen unter Speicherdruck) lief gerade synchron loadPlayerState() in
        /// app2.js durch und zeigt moeglicherweise einen veralteten Song - siehe
        /// pushCurrentStateIfAny(). Laeuft strikt NACH diesem synchronen Code, korrigiert es
        /// zuverlaessig, statt auf eine zufaellige zeitliche Naehe zu appDidBecomeActive zu hoffen.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageIsLoaded = true
            loadAttempt = 0
            Task { @MainActor [weak self] in self?.pushCurrentStateIfAny() }
        }

        // MARK: - Laden, auch ohne Netz

        /// Ob die Oberflaeche gerade steht. Erst wenn sie das tut, wird nicht weiter probiert.
        private var pageIsLoaded = false
        private var loadAttempt = 0

        /// Laedt die Oberflaeche. Ab dem zweiten Versuch ausdruecklich mit
        /// `returnCacheDataElseLoad`: ohne Netz bricht WKWebView die Navigation sonst schon ab,
        /// BEVOR der Service Worker der Seite ueberhaupt zum Zug kaeme - das Ergebnis war eine
        /// weisse Flaeche, obwohl App-Shell und Songliste laengst lokal vorliegen und die Musik
        /// selbst im nativen Datei-Cache liegt. Mit dieser Policy bedient WebKit die Seite aus
        /// seinem eigenen Cache und uebergibt danach normal an den Service Worker.
        @MainActor
        func loadStartPage(forceCache: Bool = false) {
            guard let webView else { return }
            var request = URLRequest(url: WebShellView.startURL)
            if forceCache || loadAttempt > 0 {
                request.cachePolicy = .returnCacheDataElseLoad
            }
            loadAttempt += 1
            webView.load(request)
        }

        /// Ohne Netz laedt die Seite nicht auf Anhieb. Statt einer weissen Flaeche mehrfach
        /// nachfassen, mit wachsendem Abstand (2s, 4s, 8s, ...), gedeckelt bei einer halben
        /// Minute. Vorher gab es genau EINEN Versuch nach 3 Sekunden, und der war zusaetzlich
        /// an `webView.url == nil` geknuepft - nach einer gescheiterten Navigation steht dort
        /// aber meist die Ziel-URL, sodass der Nachlade-Versuch in der Praxis gar nicht erst
        /// startete und die weisse Flaeche stehenblieb.
        private func retryLater() {
            guard !pageIsLoaded else { return }
            let delay = min(pow(2.0, Double(loadAttempt)), 30.0)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let self, !self.pageIsLoaded else { return }
                self.loadStartPage()
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            pageIsLoaded = false
            retryLater()
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            pageIsLoaded = false
            retryLater()
        }
    }
}
