import SwiftUI

@main
struct HimusicPlayerApp: App {
    @StateObject private var player = PlayerViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(player)
                .preferredColorScheme(.dark)
                .onOpenURL { url in
                    player.handleIncoming(url: url)
                }
        }
    }
}
