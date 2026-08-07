import SwiftUI

@main
struct HimusicPlayerApp: App {
    @StateObject private var player = PlayerViewModel()

    var body: some Scene {
        WindowGroup {
            // Die Huelle IST die App: himusic laeuft eingebettet, der Ton nativ.
            // Kein App-Wechsel, kein Bestaetigungsdialog, kein Streit um die
            // Audio-Sitzung. Siehe WebShellView und ADR-007.
            WebShellView(player: player)
                .ignoresSafeArea(.container, edges: .bottom)
                .preferredColorScheme(.dark)
                // Absichtlich behalten: greift nur, wenn die Seite in Safari laeuft
                // und von dort per himusicplayer:// uebergibt.
                .onOpenURL { url in
                    player.handleIncoming(url: url)
                }
        }
    }
}
