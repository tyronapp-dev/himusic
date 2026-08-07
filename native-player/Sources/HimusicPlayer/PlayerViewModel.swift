import Foundation
import AVFoundation
import MediaPlayer
import UIKit

/// Kompletter Player laeuft nativ ueber AVPlayer (nicht WKWebView) - genau das
/// umgeht die dokumentierte WKWebView-Hintergrund-Audio-Bug-Klasse, die den Grund
/// bildet, warum die PWA im Hintergrund einfriert bzw. Control Center die falsche
/// App zeigt. MPNowPlayingInfoCenter/MPRemoteCommandCenter sind Apples eigene,
/// von jeder Musik-App (auch Spotify) genutzte APIs fuer genau dieses Problem.
@MainActor
final class PlayerViewModel: ObservableObject {
    @Published private(set) var queue: [QueueItem] = []
    @Published private(set) var currentIndex: Int = 0
    @Published private(set) var isPlaying: Bool = false

    private let player = AVPlayer()
    private var timeObserverToken: Any?
    private var endObserver: NSObjectProtocol?
    private var artworkCache: [Int: MPMediaItemArtwork] = [:]

    /// Adresse der PWA - Ziel fuer den automatischen Ruecksprung nach der Uebergabe.
    private static let himusicURL = URL(string: "https://tyronapp-dev.github.io/himusic/")!

    var currentItem: QueueItem? {
        queue.indices.contains(currentIndex) ? queue[currentIndex] : nil
    }

    /// Schickt den Nutzer zurueck in die PWA.
    ///
    /// Hintergrund: iOS erlaubt keinen stillen Start einer App im Hintergrund - ein
    /// Custom-URL-Aufruf holt die Ziel-App IMMER in den Vordergrund. Der kurze Wechsel
    /// ist deshalb technisch unvermeidbar. Was wir kontrollieren koennen, ist die Dauer:
    /// sobald die Wiedergabe laeuft, geben wir den Bildschirm sofort wieder frei. Dank
    /// UIBackgroundModes: audio spielt der AVPlayer im Hintergrund weiter, waehrend der
    /// Nutzer wieder in seiner Bibliothek steht.
    func returnToHimusic() {
        UIApplication.shared.open(Self.himusicURL)
    }

    init() {
        configureAudioSession()
        configureRemoteCommands()
        observePlayerTime()
    }

    // MARK: - Eingehender Aufruf aus der PWA

    /// Erwartet: himusicplayer://play?q=<base64url(JSON IncomingPayload)>
    func handleIncoming(url: URL) {
        guard url.scheme?.lowercased() == "himusicplayer", url.host == "play" else { return }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let raw = components.queryItems?.first(where: { $0.name == "q" })?.value,
              let data = Data(base64urlEncoded: raw),
              let payload = try? JSONDecoder().decode(IncomingPayload.self, from: data),
              !payload.queue.isEmpty else {
            return
        }
        queue = payload.queue
        currentIndex = min(max(payload.startIndex, 0), queue.count - 1)
        playCurrent()

        // Bildschirm zurueckgeben, sobald die Wiedergabe wirklich laeuft. Die kurze
        // Wartezeit verhindert, dass wir den Vordergrund abgeben, bevor der AVPlayer
        // gestartet ist - sonst kann iOS die Audio-Session gleich wieder abraeumen.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let self, self.isPlaying else { return }
            self.returnToHimusic()
        }
    }

    // MARK: - Wiedergabe-Steuerung

    func playCurrent() {
        guard let item = currentItem, let url = item.fileURL else { return }

        let playerItem = AVPlayerItem(url: url)
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: playerItem,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.next() }
        }

        player.replaceCurrentItem(with: playerItem)
        player.play()
        isPlaying = true
        updateNowPlayingInfo()
        loadArtworkIfNeeded(for: item)
    }

    func togglePlayPause() {
        if isPlaying {
            player.pause()
        } else {
            player.play()
        }
        isPlaying.toggle()
        updateNowPlayingInfo()
    }

    func next() {
        guard currentIndex + 1 < queue.count else { return }
        currentIndex += 1
        playCurrent()
    }

    func previous() {
        // Erste 3 Sekunden: vorherigen Song. Danach: aktuellen Song neu starten -
        // gleiches Verhalten wie in app2.js's Skip-Back-Handling.
        if player.currentTime().seconds > 3 || currentIndex == 0 {
            player.seek(to: .zero)
            return
        }
        currentIndex -= 1
        playCurrent()
    }

    func seek(toSeconds seconds: Double) {
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 1))
        updateNowPlayingInfo()
    }

    // MARK: - Setup

    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            // Kann bei fehlender Background-Mode-Deklaration in Info.plist fehlschlagen -
            // dann bleibt Wiedergabe im Vordergrund moeglich, nur nicht im Hintergrund.
        }
    }

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.player.play()
            self.isPlaying = true
            self.updateNowPlayingInfo()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.player.pause()
            self.isPlaying = false
            self.updateNowPlayingInfo()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.next()
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.previous()
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.seek(toSeconds: event.positionTime)
            return .success
        }
    }

    private func observePlayerTime() {
        timeObserverToken = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 1),
            queue: .main
        ) { [weak self] _ in
            self?.updateNowPlayingInfo()
        }
    }

    // MARK: - Control Center / Lock Screen

    private func updateNowPlayingInfo() {
        guard let item = currentItem else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }

        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.artist,
            MPMediaItemPropertyAlbumTitle: "Himusic Cloud",
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime().seconds,
        ]
        if let duration = player.currentItem?.duration.seconds, duration.isFinite, duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let artwork = artworkCache[item.id] {
            info[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadArtworkIfNeeded(for item: QueueItem) {
        guard artworkCache[item.id] == nil, let url = item.coverURL else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self, let data, let image = UIImage(data: data) else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            Task { @MainActor in
                self.artworkCache[item.id] = artwork
                if self.currentItem?.id == item.id {
                    self.updateNowPlayingInfo()
                }
            }
        }.resume()
    }
}
