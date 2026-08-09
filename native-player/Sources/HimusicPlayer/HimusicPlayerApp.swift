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
            WebShellView(player: player)
                .ignoresSafeArea(.container, edges: .bottom)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    NativePlayerBar(player: player) {
                        NotificationCenter.default.post(name: .himusicExpandFullscreenPlayer, object: nil)
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
