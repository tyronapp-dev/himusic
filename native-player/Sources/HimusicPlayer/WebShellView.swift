import SwiftUI
import WebKit

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
        controller.addUserScript(
            WKUserScript(
                source: "window.__himusicNativeShell = true;",
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
