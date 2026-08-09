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

    /// Steigt bei jedem playCurrent()-Aufruf. beginPlayback() prueft vor jeder Mutation an
    /// "player", ob sein Token noch aktuell ist - verhindert, dass ein aelterer, an einem
    /// await noch haengender Aufruf (z.B. Songende-Auto-Skip) einen neueren (z.B. manueller
    /// Skip-Tap kurz danach) ueberschreibt. Ohne das entscheidet reine Ausfuehrungsreihenfolge
    /// der async Tasks, welcher Song am Ende wirklich laeuft - nicht der zuletzt angeforderte.
    private var playbackToken = 0

    /// Meldet der eingebetteten Webseite den echten nativen Zustand zurueck (WebShellView.
    /// Coordinator schickt das als JS an app2.js's _applyNativeNowPlaying weiter). Ohne das
    /// zeigt die Seite nach Auto-Skips im Hintergrund/gesperrtem Screen weiterhin den zuletzt
    /// manuell gestarteten Song, waehrend nativ laengst ein anderer laeuft - genau die
    /// gemeldete Inkonsistenz. Wird NUR bei echtem Songwechsel/Play-Pause ausgeloest, nicht
    /// im Sekundentakt (siehe observePlayerTime) - waere unnoetiger Overhead ohne Mehrwert.
    var onNowPlayingChanged: ((QueueItem, Bool) -> Void)?

    private func notifyNowPlayingChanged() {
        guard let item = currentItem else { return }
        onNowPlayingChanged?(item, isPlaying)
    }

    /// Von der Webseite gemeldet (MutationObserver auf #fullscreen-player in app2.js, ueber
    /// die Bridge als {cmd:"playerView", open}). Zwei Zwecke: (1) solange der grosse Player
    /// offen ist, pushen wir Fortschritt/Zeit jede Sekunde nach - dessen Zeitanzeige haengt
    /// sonst am lokalen <audio>-Element, das in der Huelle inert ist und nie "timeupdate"
    /// feuert. (2) NativePlayerBar blendet sich aus, solange der Web-Vollbild-Player offen
    /// ist - die native Leiste liegt AUSSERHALB der Webseite, ein Web-Overlay kann sie nie
    /// verdecken, ohne dieses Signal bliebe sie sichtbar darueber liegen.
    @Published var isBigPlayerOpen: Bool = false

    /// Nur gefeuert, waehrend isBigPlayerOpen true ist (siehe dort) - kein Grund, das jede
    /// Sekunde in die Seite zu pushen, wenn niemand hinschaut.
    var onProgressChanged: ((Double, Double) -> Void)?

    var currentItem: QueueItem? {
        queue.indices.contains(currentIndex) ? queue[currentIndex] : nil
    }

    init() {
        configureAudioSession()
        configureRemoteCommands()
        observePlayerTime()
    }

    // MARK: - Eingehende Abspielwuensche

    /// Hauptweg: Aufruf aus der eingebetteten Seite ueber die JS-Bruecke. Drei Formen:
    /// {cmd:"toggle"} fuers Play/Pause aus der Web-UI (app2.js kann den echten nativen
    /// Zustand nicht selbst kennen, deshalb eigenes Kommando statt lokalem Toggle dort),
    /// {cmd:"playerView", open} meldet, ob der grosse Web-Player offen ist (siehe
    /// isBigPlayerOpen) - sonst dasselbe Queue-JSON wie der alte URL-Weg, nur unverpackt
    /// (kein base64url, keine Laengengrenze).
    func handleBridgeJSON(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        if let command = try? JSONDecoder().decode(BridgeCommand.self, from: data) {
            switch command.cmd {
            case "toggle": togglePlayPause()
            case "playerView": isBigPlayerOpen = command.open ?? false
            default: break
            }
            return
        }
        guard let payload = try? JSONDecoder().decode(IncomingPayload.self, from: data),
              !payload.queue.isEmpty else {
            return
        }
        start(with: payload)
    }

    /// Alter Weg, absichtlich behalten: himusicplayer://play?q=<base64url(JSON)>.
    /// Greift, wenn die Seite in Safari statt in der Huelle laeuft - etwa wenn die
    /// Signatur der Huelle abgelaufen ist und der Nutzer auf den Browser zurueckfaellt.
    func handleIncoming(url: URL) {
        guard url.scheme?.lowercased() == "himusicplayer", url.host == "play" else { return }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let raw = components.queryItems?.first(where: { $0.name == "q" })?.value,
              let data = Data(base64urlEncoded: raw),
              let payload = try? JSONDecoder().decode(IncomingPayload.self, from: data),
              !payload.queue.isEmpty else {
            return
        }
        start(with: payload)
    }

    private func start(with payload: IncomingPayload) {
        queue = payload.queue
        currentIndex = min(max(payload.startIndex, 0), queue.count - 1)
        playCurrent()
        // Restliche Queue im Hintergrund vorladen (Schritt 3, ADR-007) - erst das
        // macht Wiedergabe ohne Netz im Hintergrund moeglich, nicht nur den aktuellen Song.
        Task { await AudioFileCache.shared.ensureCachedQueue(queue) }
    }

    // MARK: - Wiedergabe-Steuerung

    func playCurrent() {
        guard let item = currentItem else { return }
        playbackToken += 1
        let token = playbackToken
        Task { await beginPlayback(item, token: token) }
    }

    /// Loest zuerst gegen AudioFileCache auf. Liegt der Song schon lokal, spielt er
    /// von Platte (funktioniert ohne Netz im Hintergrund) - sonst wird direkt
    /// gestreamt und nebenbei fuer naechstes Mal heruntergeladen.
    ///
    /// Zwei Token-Checks nach den beiden await-Punkten: kam waehrenddessen ein neuerer
    /// playCurrent()-Aufruf dazwischen (z.B. Songende-Auto-Skip UND manueller Skip fast
    /// gleichzeitig), bricht dieser veraltete Aufruf hier ab, statt den "player" noch mit
    /// dem falschen/alten Song zu ueberschreiben.
    private func beginPlayback(_ item: QueueItem, token: Int) async {
        let cache = AudioFileCache.shared
        await cache.markCurrentlyPlaying(id: item.id)
        let localURL = await cache.localFileURL(forId: item.id)
        guard token == playbackToken else { return }
        guard let url = localURL ?? item.fileURL else { return }
        if localURL == nil {
            await cache.ensureCached(item: item)
            guard token == playbackToken else { return }
        }

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
        notifyNowPlayingChanged()
    }

    func togglePlayPause() {
        if isPlaying {
            player.pause()
        } else {
            player.play()
        }
        isPlaying.toggle()
        updateNowPlayingInfo()
        notifyNowPlayingChanged()
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
            self.notifyNowPlayingChanged()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.player.pause()
            self.isPlaying = false
            self.updateNowPlayingInfo()
            self.notifyNowPlayingChanged()
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
            guard let self else { return }
            self.updateNowPlayingInfo()
            guard self.isBigPlayerOpen else { return }
            let duration = self.player.currentItem?.duration.seconds ?? 0
            self.onProgressChanged?(self.player.currentTime().seconds, duration.isFinite ? duration : 0)
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
