import SwiftUI

@main
struct HimusicPlayerApp: App {
    @StateObject private var player = PlayerViewModel()

    var body: some Scene {
        WindowGroup {
            // Die Huelle IST die App: himusic laeuft eingebettet, der Ton nativ.
            // Kein App-Wechsel, kein Bestaetigungsdialog, kein Streit um die
            // Audio-Sitzung. Siehe WebShellView und ADR-007.
            // NativePlayerBar (ADR-011) ersetzt die Web-eigene Mini-Leiste - direkt an
            // PlayerViewModel gebunden statt ueber die JS-Bruecke synchronisiert, kann
            // strukturell nicht mehr vom echten Zustand abweichen. Tippen (ausserhalb der
            // Buttons) oeffnet weiterhin den grossen Web-Player, wie es die ersetzte
            // Web-Leiste auch tat.
            //
            // ZStack statt safeAreaInset: safeAreaInset haette die WKWebView-Flaeche
            // verkleinert, wodurch die Webseite ihren eigenen env(safe-area-inset-bottom)
            // anders berechnet haette - #bottom-nav (die Home/Playlists/Songs/Settings-
            // Leiste, komplett unabhaengig vom Mini-Player) landete dadurch verdeckt/
            // verschoben. Die WebView bleibt deshalb unangetastet wie vor ADR-011; die
            // native Leiste wird stattdessen exakt in den Slot gelegt, den #mini-player in
            // style2.css immer hatte (56px Nav-Hoehe + 10px Abstand oberhalb von
            // #bottom-nav, siehe --nav-h/--mini-gap) - ueberlappt dadurch #bottom-nav nie.
            // isBigPlayerOpen (von app2.js per MutationObserver gemeldet, siehe
            // PlayerViewModel) blendet die Leiste aus, solange der grosse Web-Player offen
            // ist - die liegt AUSSERHALB der Webseite, deren eigenes Vollbild-Overlay kann
            // sie sonst nie verdecken.
            ZStack(alignment: .bottom) {
                WebShellView(player: player)
                    .ignoresSafeArea(.container, edges: .bottom)
                if !player.isBigPlayerOpen {
                    NativePlayerBar(player: player) {
                        NotificationCenter.default.post(name: .himusicExpandFullscreenPlayer, object: nil)
                    }
                    .padding(.bottom, 66)
                }
            }
                .preferredColorScheme(.dark)
                // Absichtlich behalten: greift nur, wenn die Seite in Safari laeuft
                // und von dort per himusicplayer:// uebergibt.
                .onOpenURL { url in
                    player.handleIncoming(url: url)
                }
        }
    }
}
