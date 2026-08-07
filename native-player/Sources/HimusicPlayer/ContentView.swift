import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var player: PlayerViewModel

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                if let item = player.currentItem {
                    cover(for: item)
                    VStack(spacing: 6) {
                        Text(item.title)
                            .font(.title2.bold())
                            .foregroundColor(.white)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                        Text(item.artist)
                            .font(.body)
                            .foregroundColor(.gray)
                    }
                    .padding(.horizontal, 32)
                } else {
                    Text("Kein Song geladen")
                        .foregroundColor(.gray)
                    Text("Song in der Himusic-App abspielen, um hierher zu wechseln.")
                        .font(.footnote)
                        .foregroundColor(.gray.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }

                Spacer()

                HStack(spacing: 44) {
                    Button(action: player.previous) {
                        Image(systemName: "backward.fill")
                            .font(.system(size: 28))
                    }
                    Button(action: player.togglePlayPause) {
                        Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                            .font(.system(size: 68))
                    }
                    Button(action: player.next) {
                        Image(systemName: "forward.fill")
                            .font(.system(size: 28))
                    }
                }
                .foregroundColor(.white)
                .disabled(player.currentItem == nil)

                Spacer(minLength: 40)
            }
        }
    }

    @ViewBuilder
    private func cover(for item: QueueItem) -> some View {
        AsyncImage(url: item.coverURL) { phase in
            switch phase {
            case .success(let image):
                image.resizable().aspectRatio(contentMode: .fill)
            default:
                Rectangle().fill(Color.gray.opacity(0.25))
            }
        }
        .frame(width: 260, height: 260)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(radius: 20)
    }
}
