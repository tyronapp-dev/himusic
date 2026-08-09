import SwiftUI

/// Ersetzt die Mini-Player-Leiste der Webseite INNERHALB der Huelle. Bindet sich direkt an
/// PlayerViewModel (SwiftUI @ObservedObject) statt wie die Webseite ueber die JS-Bruecke
/// synchron gehalten zu werden - es gibt hier gar keinen Nachrichtenkanal, der Nachrichten
/// verlieren koennte, weil die View direkt aus derselben Quelle liest, die AVPlayer/Control
/// Center auch fuehrt. Loest damit strukturell die ganze Klasse Sync-Bugs (Play/Pause-Icon
/// zeigt falschen Zustand, falscher Song/Cover nach Control-Center-Aktion aus einer anderen
/// App), die die Web-Bruecke trotz mehrerer Anlaeufe nicht zuverlaessig wegbekam.
/// Siehe ADR-011.
struct NativePlayerBar: View {
    @ObservedObject var player: PlayerViewModel
    let onExpand: () -> Void
    @State private var artwork: UIImage?

    init(player: PlayerViewModel, onExpand: @escaping () -> Void) {
        self.player = player
        self.onExpand = onExpand
    }

    var body: some View {
        if let item = player.currentItem {
            HStack(spacing: 12) {
                artworkView
                    .frame(width: 42, height: 42)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))

                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    Text(item.artist).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                }

                Spacer(minLength: 8)

                Button(action: player.previous) {
                    Image(systemName: "backward.fill").font(.system(size: 15))
                }
                Button(action: player.togglePlayPause) {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 19))
                        .frame(width: 26)
                }
                Button(action: player.next) {
                    Image(systemName: "forward.fill").font(.system(size: 15))
                }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(.black.opacity(0.94))
            .contentShape(Rectangle())
            .onTapGesture { onExpand() }
            .task(id: item.id) { await loadArtwork(item) }
        }
    }

    @ViewBuilder
    private var artworkView: some View {
        if let artwork {
            Image(uiImage: artwork).resizable().aspectRatio(contentMode: .fill)
        } else {
            Color.white.opacity(0.08)
        }
    }

    private func loadArtwork(_ item: QueueItem) async {
        artwork = nil
        guard let url = item.coverURL else { return }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let image = UIImage(data: data) else { return }
        artwork = image
    }
}
