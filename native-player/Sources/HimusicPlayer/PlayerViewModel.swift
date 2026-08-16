import Foundation
import AVFoundation
import MediaPlayer
import UIKit
import Network

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
    private var failObserver: NSObjectProtocol?
    /// Cover des GERADE laufenden Songs, bewusst stark gehalten und bewusst nur EINS.
    ///
    /// Vorgeschichte, zwei Fehlversuche: erst ein Dictionary ueber alle Songs - das wuchs
    /// unbegrenzt (ein entpacktes 1200x1200-Bild belegt rund 5,5 MB, bei dieser Bibliothek
    /// summiert sich das auf hunderte MB, bis iOS die App im Hintergrund abschiesst). Dann
    /// NSCache - der loest das Speicherproblem, **raeumt aber genau im falschen Moment**: er
    /// gibt Objekte frei, sobald die App in den Hintergrund geht. Das ist exakt der Moment, in
    /// dem der Sperrbildschirm das Cover braucht. Ergebnis war ein Cover, das mal da war und
    /// mal nicht.
    ///
    /// Loesung ohne beide Nachteile: nur das aktuelle Cover halten. Es wird ohnehin nur eins
    /// gleichzeitig angezeigt, ein Songwechsel laedt das naechste. Speicherbedarf bleibt bei
    /// rund 5 MB statt hunderten, und weggeraeumt wird es von niemandem.
    private var currentArtwork: MPMediaItemArtwork?
    private var currentArtworkItemId: Int?
    private var artworkLoadingForId: Int?
    /// Song, fuer den das Cover nachweislich nicht zu holen war (Adresse tot, kein Netz).
    /// Ohne diese Merkung wuerde der Sekundentakt aus updateNowPlayingInfo() es endlos neu
    /// versuchen - ohne Netz waere das ein Netzabruf pro Sekunde, dauerhaft.
    private var artworkFailedForId: Int?

    /// Fuer welchen Song die kaputte lokale Kopie bereits verworfen und ein zweiter Versuch
    /// vom Server unternommen wurde. Verhindert, dass sich Verwerfen und Neuladen endlos im
    /// Kreis drehen, wenn nicht die Kopie kaputt ist, sondern die Quelle selbst.
    private var retriedFromRemoteId: Int?

    /// Steigt bei jedem playCurrent()-Aufruf. beginPlayback() prueft vor jeder Mutation an
    /// "player", ob sein Token noch aktuell ist - verhindert, dass ein aelterer, an einem
    /// await noch haengender Aufruf (z.B. Songende-Auto-Skip) einen neueren (z.B. manueller
    /// Skip-Tap kurz danach) ueberschreibt. Ohne das entscheidet reine Ausfuehrungsreihenfolge
    /// der async Tasks, welcher Song am Ende wirklich laeuft - nicht der zuletzt angeforderte.
    private var playbackToken = 0

    /// Position, die noch angesprungen werden soll, sobald das Item bereit ist.
    /// Ein seek() direkt nach replaceCurrentItem() geht ins Leere: das Item laedt noch, bei
    /// einer Netz-URL ist die Dauer zu dem Zeitpunkt "indefinite". Genau das passierte beim
    /// Wiederherstellen der letzten Sitzung - der Player blieb danach in einem Zustand, in dem
    /// ein spaeteres play() nichts bewirkte (Zeit lief nicht los), bis man den Song wechselte.
    private var pendingSeekSeconds: Double?
    private var itemStatusObservation: NSKeyValueObservation?

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
        notifyQueueChanged()
        saveSnapshot()
    }

    /// Schickt der Seite den aktuellen Ausschnitt der nativen Warteschlange (fertiges JSON).
    /// Noetig, weil die Warteschlangen-Ansicht bis 2026-08-13 aus playbackQueue/playbackHistory
    /// gerendert wurde - beides fuehrt in der Huelle niemand mehr, die Anzeige stimmte deshalb
    /// nicht mit dem ueberein, was tatsaechlich als naechstes lief.
    var onQueueChanged: ((String) -> Void)?

    private func notifyQueueChanged() {
        guard let json = encodedQueueSnapshot() else { return }
        onQueueChanged?(json)
    }

    /// Auch von aussen aufrufbar (WebShellView nach jedem Seiten-Ladevorgang), damit eine
    /// frisch geladene Seite den Stand sofort bekommt statt erst beim naechsten Songwechsel.
    func encodedQueueSnapshot() -> String? {
        guard !queue.isEmpty else { return "null" }
        let historyWindow = 10
        let upcomingWindow = 50
        let start = max(0, currentIndex - historyWindow)
        let end = min(queue.count, currentIndex + upcomingWindow + 1)
        let snapshot = QueueSnapshot(
            items: Array(queue[start..<end]),
            currentIndex: currentIndex - start,
            totalCount: queue.count,
            remainingAfter: queue.count - end
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Von der Webseite gemeldet (MutationObserver in app2.js, ueber die Bridge als
    /// {cmd:"playerView", open}). True, sobald IRGENDEINE Web-Oberflaeche ueber der
    /// Mini-Leiste liegt: der grosse Player ODER ein Action-Sheet (Vibe-Mix, Tag-Editor,
    /// Warteschlange, ...). Zwei Zwecke:
    /// (1) NativePlayerBar blendet sich aus, solange etwas darueber liegt - die native
    ///     Leiste liegt AUSSERHALB der Webseite, kein z-index der Seite kann sie verdecken.
    ///     Ohne dieses Signal bleibt sie sichtbar liegen und fing Beruehrungen ab, die dem
    ///     Overlay galten (gemeldet beim Vibe-Mix: "Mix generieren" nicht drueckbar).
    /// (2) Solange etwas offen ist, pushen wir Fortschritt/Zeit jede Sekunde nach - die
    ///     Zeitanzeige des grossen Players haengt sonst am lokalen <audio>-Element, das in
    ///     der Huelle inert ist und nie "timeupdate" feuert.
    @Published var isWebOverlayVisible: Bool = false

    /// Nur gefeuert, waehrend isWebOverlayVisible true ist (siehe dort) - kein Grund, das
    /// jede Sekunde in die Seite zu pushen, wenn niemand hinschaut.
    var onProgressChanged: ((Double, Double) -> Void)?

    /// Ein Song liess sich nicht abspielen (defekte/leere Datei, Quelle nicht erreichbar).
    /// Die Seite zeigt daraufhin einen Hinweis - aber nur, wenn sie ueberhaupt sichtbar ist.
    /// Im Hintergrund/auf dem Homescreen kommt der Push ohnehin nicht an, und das ist genau
    /// das gewuenschte Verhalten: dann wird still weitergesprungen, ohne Stau in der
    /// Wiedergabe. Das Ueberspringen selbst passiert IMMER, unabhaengig von diesem Callback.
    var onPlaybackFailed: ((QueueItem, String) -> Void)?

    /// Bricht die Kette, wenn mehrere Songs hintereinander scheitern. Ohne das wuerde ein
    /// flaechiger Ausfall (Netz weg, Serverfehler, ganze Warteschlange ungueltig) die
    /// komplette Liste in Sekunden durchrasen und am Ende stumm stehen bleiben - fuer den
    /// Nutzer nicht von "die App hat meine Musik verloren" zu unterscheiden. Wird bei jedem
    /// Song zurueckgesetzt, der wirklich losspielt (siehe readyToPlay-Beobachter).
    private var consecutiveFailures = 0
    private static let maxConsecutiveFailures = 5

    /// Songs, die in DIESER Warteschlange bereits gescheitert sind. Sie werden beim
    /// Weiterspringen gleich mit uebersprungen, statt jedes Mal erneut zu haengen und einen
    /// Hinweis zu erzeugen. Bewusst nur zur Laufzeit und pro Warteschlange - ein Song, der
    /// heute an einer schlechten Verbindung scheiterte, soll morgen wieder versucht werden.
    private var failedItemIds: Set<Int> = []

    /// In welche Richtung zuletzt navigiert wurde: +1 vorwaerts, -1 rueckwaerts. Entscheidet,
    /// wohin ein defekter Song uebersprungen wird. Ohne das ging es immer vorwaerts, und wer
    /// rueckwaerts an einem defekten Song vorbeiwollte, wurde jedes Mal wieder nach vorn
    /// geworfen.
    private var lastNavigationStep = 1

    /// Ob gerade ueberhaupt eine Verbindung besteht. Zwei Stellen brauchen das: der zweite
    /// Abspielversuch ueber die Netzadresse waere ohne Netz reine Zeitverschwendung, und die
    /// Fehlermeldung an die Seite soll "offline" von "Datei kaputt" unterscheiden koennen -
    /// das ist fuer den Nutzer der entscheidende Unterschied.
    private var hasNetwork = true
    private let pathMonitor = NWPathMonitor()

    private func startNetworkMonitoring() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let hatteNetz = self.hasNetwork
                self.hasNetwork = (path.status == .satisfied)
                // Verbindung kommt zurueck: ein Cover, das vorher mangels Netz nicht zu holen
                // war, jetzt nachholen statt bis zum naechsten Songwechsel ohne dazustehen.
                if !hatteNetz, self.hasNetwork {
                    self.artworkFailedForId = nil
                    if let item = self.currentItem { self.loadArtworkIfNeeded(for: item) }
                }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "himusic.network"))
    }

    var currentItem: QueueItem? {
        queue.indices.contains(currentIndex) ? queue[currentIndex] : nil
    }

    /// Gemessene Dauer des laufenden Stuecks, 0 solange sie nicht feststeht (Datei laedt noch,
    /// bei einer Netzadresse ist sie bis dahin "indefinite"). Die Seite braucht sie fuer die
    /// Zeitleiste und darf sich nicht auf den Datenbankwert verlassen - der stammt aus
    /// Metadaten und weicht ab.
    var currentItemDurationSeconds: Double {
        guard let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 else { return 0 }
        return d
    }

    init() {
        configureAudioSession()
        configureRemoteCommands()
        observePlayerTime()
        startNetworkMonitoring()
        restoreLastSession()
        // Zuverlaessigster Speicherpunkt: feuert garantiert beim Wechsel in den Hintergrund
        // (Home-Geste, App-Wechsel, bevor iOS die App ggf. beendet) - im Gegensatz zu
        // applicationWillTerminate, das iOS nicht in jedem Fall aufruft. Reine Closure-
        // Registrierung statt #selector, weil PlayerViewModel kein NSObject ist.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.saveSnapshot() }
        }
    }

    // MARK: - Wiedergabe-Stand ueberleben lassen

    /// Warteschlange + Position, damit Mini-Leiste/Control-Center nach einem ECHTEN
    /// Neustart (App vorher vollstaendig beendet, nicht nur backgrounded) sofort am
    /// richtigen Song/Stand stehen - ein Tipp auf Play setzt exakt dort fort. Kein
    /// automatisches Loslaufen beim Oeffnen, das macht auch keine andere Musik-App.
    private struct PlaybackSnapshot: Codable {
        let queue: [QueueItem]
        let currentIndex: Int
        let positionSeconds: Double
    }
    private static let snapshotDefaultsKey = "himusic.native.playbackSnapshot"
    private var lastSnapshotSaveAt: Date = .distantPast

    private func saveSnapshot() {
        guard !queue.isEmpty else { return }
        lastSnapshotSaveAt = Date()
        let snapshot = PlaybackSnapshot(
            queue: queue, currentIndex: currentIndex, positionSeconds: player.currentTime().seconds
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: Self.snapshotDefaultsKey)
    }

    private func loadSnapshot() -> PlaybackSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: Self.snapshotDefaultsKey) else { return nil }
        return try? JSONDecoder().decode(PlaybackSnapshot.self, from: data)
    }

    private func restoreLastSession() {
        guard let snapshot = loadSnapshot(), !snapshot.queue.isEmpty else { return }
        queue = snapshot.queue
        currentIndex = min(max(snapshot.currentIndex, 0), queue.count - 1)
        guard let item = currentItem else { return }
        // Nicht direkt seeken (siehe pendingSeekSeconds) - beginPlayback holt das nach,
        // sobald das Item wirklich bereit ist. Positionen ganz am Songende werden verworfen:
        // wurde die App kurz vor Songende geschlossen, stuende der Player sonst beim Oeffnen
        // am Ende und ein play() liefe sofort ins Nichts.
        pendingSeekSeconds = snapshot.positionSeconds > 3 ? snapshot.positionSeconds : nil
        playbackToken += 1
        let token = playbackToken
        Task { @MainActor in await beginPlayback(item, token: token, autoplay: false) }
        Task { await AudioFileCache.shared.ensureCachedQueue(queue) }
    }

    // MARK: - Eingehende Abspielwuensche

    /// Hauptweg: Aufruf aus der eingebetteten Seite ueber die JS-Bruecke. Drei Formen:
    /// {cmd:"toggle"} fuers Play/Pause aus der Web-UI (app2.js kann den echten nativen
    /// Zustand nicht selbst kennen, deshalb eigenes Kommando statt lokalem Toggle dort),
    /// {cmd:"playerView", open} meldet, ob der grosse Web-Player offen ist (siehe
    /// isWebOverlayVisible) - sonst dasselbe Queue-JSON wie der alte URL-Weg, nur unverpackt
    /// (kein base64url, keine Laengengrenze).
    func handleBridgeJSON(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        if let command = try? JSONDecoder().decode(BridgeCommand.self, from: data) {
            switch command.cmd {
            case "toggle": togglePlayPause()
            case "playerView": isWebOverlayVisible = command.open ?? false
            // Transport aus der Web-Oberflaeche: IMMER echter Songwechsel. Die Seite darf
            // nicht selbst aus playbackQueue/playbackHistory rechnen - die veralten bei
            // jedem nativen Auto-Skip im Hintergrund und lieferten dadurch falsche Songs.
            case "next": next()
            case "prev": previousTrack()
            case "seekBy": seek(byDelta: command.delta ?? 0)
            // Scrub-Leiste im grossen Web-Player loslassen - absolute Zielposition statt
            // relativem Sprung. Vorher setzte die Seite das lokale <audio> direkt, das ist
            // in der Huelle inert und bewegte den echten AVPlayer gar nicht.
            case "seekTo": seek(toSeconds: command.seconds ?? 0)
            case "insertNext": if let item = command.item { insertNext(item) }
            case "jumpTo": if let index = command.index { jumpTo(index) }
            case "removeAt": if let index = command.index { removeAt(index) }
            case "haptic": playHapticTick()
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
        // Neue Warteschlange = neuer Anlauf. Ein Song, der beim letzten Mal an einer schlechten
        // Verbindung scheiterte, soll hier wieder eine Chance bekommen statt stumm zu bleiben.
        failedItemIds.removeAll()
        consecutiveFailures = 0
        lastNavigationStep = 1
        playCurrent()
        prefetchUpcoming()
    }

    /// Wieviele Songs ab der aktuellen Position vorausgeladen werden. Seit die Seite die
    /// VOLLE Warteschlange schickt (vorher 25, siehe _tryNativePlayerHandoff), darf hier
    /// nicht mehr blind ueber die ganze Liste gelaufen werden: bei "zufaellig abspielen"
    /// sind das ueber 2000 Songs - die wuerden alle in die Download-Warteschlange wandern,
    /// das 8-GB-Cap sofort sprengen und dauerhaft Daten ziehen. Ein gleitendes Fenster
    /// reicht: es wandert bei jedem Songwechsel mit (siehe playCurrent).
    private static let prefetchWindow = 15

    private func prefetchUpcoming() {
        guard !queue.isEmpty else { return }
        let start = min(currentIndex, queue.count - 1)
        let end = min(start + Self.prefetchWindow, queue.count)
        let window = Array(queue[start..<end])
        Task { await AudioFileCache.shared.ensureCachedQueue(window) }
    }

    // MARK: - Wiedergabe-Steuerung

    func playCurrent(ignoreLocalCopy: Bool = false) {
        guard let item = currentItem else { return }
        playbackToken += 1
        let token = playbackToken
        // Vorlade-Fenster wandert mit der Wiedergabe mit - sonst waere nach den ersten
        // 15 Songs nichts mehr vorgeladen (siehe prefetchUpcoming).
        prefetchUpcoming()
        Task { await beginPlayback(item, token: token, ignoreLocalCopy: ignoreLocalCopy) }
    }

    /// Loest zuerst gegen AudioFileCache auf. Liegt der Song schon lokal, spielt er
    /// von Platte (funktioniert ohne Netz im Hintergrund) - sonst wird direkt
    /// gestreamt und nebenbei fuer naechstes Mal heruntergeladen.
    ///
    /// Zwei Token-Checks nach den beiden await-Punkten: kam waehrenddessen ein neuerer
    /// playCurrent()-Aufruf dazwischen (z.B. Songende-Auto-Skip UND manueller Skip fast
    /// gleichzeitig), bricht dieser veraltete Aufruf hier ab, statt den "player" noch mit
    /// dem falschen/alten Song zu ueberschreiben.
    ///
    /// autoplay:false nur fuer restoreLastSession() - laedt Song+Cover+Control-Center-Info
    /// vor, ohne loszuspielen, damit ein App-Neustart nichts hoerbar von selbst startet.
    /// `ignoreLocalCopy` erzwingt den Weg ueber die Netzadresse, obwohl eine lokale Kopie
    /// vorliegt. Das ist der zweite Versuch nach einem Fehlschlag - siehe
    /// handlePlaybackFailure. Die lokale Datei wird dabei ausdruecklich NICHT geloescht,
    /// sondern erst, wenn dieser Versuch beweist, dass es ohne sie geht.
    private func beginPlayback(
        _ item: QueueItem, token: Int, autoplay: Bool = true, ignoreLocalCopy: Bool = false
    ) async {
        let cache = AudioFileCache.shared
        await cache.markCurrentlyPlaying(id: item.id)
        let localURL = ignoreLocalCopy ? nil : await cache.localFileURL(forId: item.id)
        guard token == playbackToken else { return }
        // Ohne abspielbare Adresse ist der Eintrag defekt. Frueher endete das hier in einem
        // stillen return: die Oberflaeche zeigte weiter einen Song, der nie loslief, und ein
        // Tipp auf Play tat nichts. Jetzt wird er wie jeder andere Fehlschlag behandelt.
        guard let url = localURL ?? item.fileURL else {
            handlePlaybackFailure(for: item, reason: "Keine abspielbare Datei hinterlegt")
            return
        }
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

        // Abbruch MITTEN im Song (Datei bricht ab, Verbindung stirbt beim Streamen). Das ist
        // ein eigenes Ereignis - .status bleibt dabei .readyToPlay, der Song wuerde sonst
        // einfach fuer immer stehenbleiben, ohne dass irgendetwas davon Notiz nimmt.
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
        failObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: playerItem,
            queue: .main
        ) { [weak self] note in
            let reason = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?
                .localizedDescription ?? "Wiedergabe abgebrochen"
            Task { @MainActor in self?.handlePlaybackFailure(for: item, reason: reason) }
        }

        // Sobald das Item bereit ist: offenen Positionssprung nachholen und - falls die
        // Wiedergabe laufen soll, aber steht - nachtreten. Beides ist genau der Moment, ab
        // dem AVPlayer solche Anweisungen ueberhaupt zuverlaessig annimmt.
        //
        // Der .failed-Zweig ist neu: eine beschaedigte, leere oder gar nicht erreichbare Datei
        // landete vorher in keinem der beiden Faelle. AVPlayer meldete den Fehler, niemand
        // hoerte zu, und der Player blieb stumm auf einem Song stehen, den die Oberflaeche
        // weiter als "laeuft" anzeigte - exakt das gemeldete Verhalten.
        itemStatusObservation?.invalidate()
        itemStatusObservation = playerItem.observe(\.status, options: [.initial, .new]) { [weak self] observed, _ in
            Task { @MainActor [weak self] in
                guard let self, self.player.currentItem === observed else { return }
                switch observed.status {
                case .readyToPlay:
                    // Ab hier gilt der Song als spielbar - die Fehlerkette ist unterbrochen.
                    self.consecutiveFailures = 0
                    self.failedItemIds.remove(item.id)
                    // Lief dieser Song gerade als zweiter Versuch ueber die Netzadresse, ist
                    // damit BEWIESEN, dass nur die lokale Kopie kaputt war: der Song selbst
                    // spielt ja. Erst jetzt darf sie weg - und der Cache laedt sie beim
                    // naechsten Vorladen sauber neu. Vorher zu loeschen hiess, intakte
                    // Offline-Kopien auf Verdacht zu vernichten.
                    if self.retriedFromRemoteId == item.id {
                        self.retriedFromRemoteId = nil
                        Task { _ = await AudioFileCache.shared.discardCachedFile(forId: item.id) }
                    }
                    self.applyPendingSeek()
                    if self.isPlaying && self.player.rate == 0 { self.player.play() }
                    // Jetzt - und erst jetzt - steht die gemessene Songdauer fest. Zwei
                    // Empfaenger brauchen sie:
                    //
                    // (1) Der SPERRBILDSCHIRM. updateNowPlayingInfo() setzt die Dauer nur, wenn
                    //     sie bekannt ist - beim ersten Song nach dem Start war sie das noch
                    //     nicht, und danach lief nichts mehr, was die Info erneuert haette:
                    //     der Sekundentakt-Beobachter feuert nur waehrend laufender Wiedergabe.
                    //     Ergebnis war eine Fortschrittsleiste ohne Zeitangaben links und
                    //     rechts, die sich erst beim naechsten Songwechsel von selbst heilte.
                    // (2) Die SEITE, damit ihre Zeitleiste sofort mit dem gemessenen Wert
                    //     rechnet statt bis zum naechsten Sekundentakt mit dem Datenbankwert.
                    self.updateNowPlayingInfo()
                    self.notifyNowPlayingChanged()
                case .failed:
                    let reason = observed.error?.localizedDescription ?? "Datei nicht lesbar"
                    self.handlePlaybackFailure(for: item, reason: reason)
                default:
                    break
                }
            }
        }

        player.replaceCurrentItem(with: playerItem)
        if autoplay {
            player.play()
            isPlaying = true
        }
        updateNowPlayingInfo()
        // Jeder Songstart ist ein frischer Anlauf fuers Cover - eine Merkung aus einem
        // frueheren Versuch (z.B. damals kein Netz) soll ihn nicht blockieren.
        artworkFailedForId = nil
        loadArtworkIfNeeded(for: item)
        notifyNowPlayingChanged()
    }

    /// Holt einen vorgemerkten Positionssprung nach. Gegen die Songdauer begrenzt, damit ein
    /// gespeicherter Stand knapp vor Schluss nicht am Ende landet (dort bewirkt play() nichts).
    private func applyPendingSeek() {
        guard let target = pendingSeekSeconds else { return }
        pendingSeekSeconds = nil
        let duration = player.currentItem?.duration.seconds ?? 0
        guard !(duration.isFinite && duration > 0 && target >= duration - 2) else { return }
        seekExactly(to: target)
    }

    func togglePlayPause() {
        if isPlaying {
            player.pause()
            isPlaying = false
            updateNowPlayingInfo()
            notifyNowPlayingChanged()
            return
        }
        startPlaybackResiliently()
    }

    /// Startet die Wiedergabe und prueft kurz darauf nach, ob sie tatsaechlich laeuft.
    ///
    /// Hintergrund: ein blosses player.play() kann folgenlos bleiben - Item nie fertig
    /// geladen, Ladefehler, oder der Player steht am Songende. Fuer den Nutzer sah das so
    /// aus, dass Play nach dem Öffnen der App einfach nichts tat und erst ein Songwechsel
    /// half. Statt nur die bekannten Ursachen einzeln abzufangen, wird hier das ERGEBNIS
    /// geprueft: laeuft eine Sekunde spaeter immer noch nichts, wird der Song frisch
    /// aufgesetzt und an derselben Stelle fortgesetzt. Das deckt auch Ursachen ab, die hier
    /// nicht einzeln vorhergesehen sind.
    private func startPlaybackResiliently() {
        guard currentItem != nil else { return }
        // Gar kein Item oder eines mit Ladefehler: direkt neu aufsetzen, play() waere zwecklos.
        if player.currentItem == nil || player.currentItem?.status == .failed {
            playCurrent()
            return
        }
        applyPendingSeek()
        player.play()
        isPlaying = true
        updateNowPlayingInfo()
        notifyNowPlayingChanged()

        let token = playbackToken
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard let self, token == self.playbackToken, self.isPlaying, self.player.rate == 0 else { return }
            // An derselben Stelle weitermachen, nicht von vorn - der Neuaufbau soll nicht
            // wie ein Zuruecksetzen wirken.
            let resumeAt = self.player.currentTime().seconds
            self.pendingSeekSeconds = resumeAt > 3 ? resumeAt : nil
            self.playCurrent()
        }
    }

    // MARK: - Defekte Songs

    /// Ein Song laesst sich nicht abspielen. Zwei Stufen, bewusst in dieser Reihenfolge:
    ///
    /// 1. Lag eine lokale Kopie vor, ist oft SIE das Problem und nicht der Song (abgebrochener
    ///    Download, Fehlerseite als Audiodatei abgelegt). Dann wird derselbe Song noch einmal
    ///    versucht, diesmal ueber die Netzadresse.
    ///
    ///    **Die lokale Datei wird dabei ausdruecklich NICHT geloescht.** Genau das war der
    ///    Fehler der ersten Fassung: sie flog sofort raus, und wenn der Fehlschlag einen
    ///    voruebergehenden Grund hatte, war die intakte Offline-Kopie unwiederbringlich weg -
    ///    ohne Netz liess sie sich nicht neu laden. Songs, die vorher zuverlaessig liefen,
    ///    verschwanden dadurch. Geloescht wird erst, wenn der Versuch ueber das Netz BEWEIST,
    ///    dass es ohne die Kopie geht (siehe .readyToPlay-Zweig in beginPlayback).
    ///
    ///    Ohne Netz wird dieser Versuch gar nicht erst unternommen - er kann nur scheitern und
    ///    wuerde den Song unnoetig aus der Warteschlange werfen.
    /// 2. Scheitert auch das, ist der Song wirklich defekt oder die Quelle nicht erreichbar:
    ///    melden (die Seite zeigt es, falls jemand hinschaut) und weiterspringen.
    private func handlePlaybackFailure(for item: QueueItem, reason: String) {
        // Verspaetete Fehlermeldung zu einem Song, der laengst nicht mehr dran ist: ignorieren,
        // sonst wirft ein alter Fehler die inzwischen laufende Wiedergabe weiter.
        guard currentItem?.id == item.id else { return }

        if retriedFromRemoteId != item.id, item.fileURL != nil, hasNetwork {
            retriedFromRemoteId = item.id
            Task { @MainActor [weak self] in
                let hasLocalCopy = await AudioFileCache.shared.hasCachedFile(forId: item.id)
                guard let self, self.currentItem?.id == item.id else { return }
                if hasLocalCopy {
                    self.playCurrent(ignoreLocalCopy: true)
                } else {
                    self.reportAndSkip(item, reason: reason)
                }
            }
            return
        }
        reportAndSkip(item, reason: hasNetwork ? reason : "\(reason) (offline)")
    }

    private func reportAndSkip(_ item: QueueItem, reason: String) {
        onPlaybackFailed?(item, reason)
        failedItemIds.insert(item.id)
        consecutiveFailures += 1

        // In die Richtung weiterspringen, in die der Nutzer zuletzt navigiert hat. Die erste
        // Fassung sprang IMMER vorwaerts - wer von einem defekten Song aus zurueckwollte,
        // landete dadurch sofort wieder vor ihm und kam nie an den Song davor. Rueckwaerts
        // durch eine Luecke von defekten Songs zu kommen war damit unmoeglich.
        let step = lastNavigationStep
        var ziel = currentIndex + step

        // Bereits als defekt bekannte Songs gleich mit ueberspringen, statt sie einzeln
        // scheitern zu lassen - jeder Versuch kostet sonst Wartezeit und einen Toast.
        while queue.indices.contains(ziel), failedItemIds.contains(queue[ziel].id) {
            ziel += step
        }

        // Reissleine (siehe consecutiveFailures): lieber sichtbar stehenbleiben als die ganze
        // Warteschlange lautlos durchrasen und am Ende ohne Erklaerung stumm sein.
        guard consecutiveFailures < Self.maxConsecutiveFailures, queue.indices.contains(ziel) else {
            player.pause()
            isPlaying = false
            updateNowPlayingInfo()
            notifyNowPlayingChanged()
            return
        }
        currentIndex = ziel
        playCurrent()
    }

    /// Jeder echte Songwechsel verwirft einen noch offenen Positionssprung. Sonst wandert er
    /// auf den naechsten Song weiter: wer auf der Zeitleiste zieht, waehrend das Stueck noch
    /// laedt, und dann weiterschaltet, landete im NAECHSTEN Song an der gezogenen Stelle
    /// mitten im Lied. Der Sprung galt dem Song, den man vor sich hatte - nicht dem danach.
    private func forgetPendingSeek() {
        pendingSeekSeconds = nil
    }

    func next() {
        guard currentIndex + 1 < queue.count else { return }
        lastNavigationStep = 1
        forgetPendingSeek()
        currentIndex += 1
        playCurrent()
    }

    /// "Als Naechstes spielen" aus dem Rechts-Swipe der Songliste. Bewusst EINFUEGEN statt
    /// die Warteschlange zu ersetzen: alles dahinter bleibt in seiner Reihenfolge stehen,
    /// sodass nach diesem Song die urspruengliche Playlist/der Mix normal weiterlaeuft.
    /// Laeuft gerade nichts, wird der Song sofort gestartet - sonst laege er in einer
    /// Warteschlange, die niemand abspielt.
    func insertNext(_ item: QueueItem) {
        guard item.fileURL != nil else { return }
        if queue.isEmpty {
            // Nichts in der Warteschlange: Song bereitstellen, aber NICHT losspielen -
            // der Nutzer wollte einreihen, nicht starten. Mini-Leiste und Control Center
            // zeigen ihn danach, ein Tipp auf Play startet ihn (gleiche Logik wie beim
            // Wiederherstellen der letzten Sitzung).
            queue = [item]
            currentIndex = 0
            playbackToken += 1
            let token = playbackToken
            Task { await beginPlayback(item, token: token, autoplay: false) }
            return
        }
        let insertAt = min(currentIndex + 1, queue.count)
        queue.insert(item, at: insertAt)
        notifyQueueChanged() // sonst zeigt die Warteschlangen-Ansicht den Song erst nach dem naechsten Songwechsel
        saveSnapshot()
        Task { await AudioFileCache.shared.ensureCached(item: item) }
    }

    /// Antippen eines Eintrags in der Warteschlangen-Ansicht: direkt dorthin springen.
    /// Der Rest der Warteschlange bleibt unveraendert, uebersprungene Songs stehen danach
    /// im "Verlauf"-Teil der Ansicht (alles vor currentIndex).
    func jumpTo(_ index: Int) {
        guard queue.indices.contains(index) else { return }
        lastNavigationStep = index >= currentIndex ? 1 : -1
        forgetPendingSeek()
        currentIndex = index
        playCurrent()
    }

    /// Eintrag per Wisch aus der Warteschlange entfernen. Der laufende Song ist bewusst
    /// ausgenommen - ihn zu entfernen waere ein Stopp, kein Entfernen, und die Ansicht
    /// bietet dafuer keinen erkennbaren Weg zurueck.
    func removeAt(_ index: Int) {
        guard queue.indices.contains(index), index != currentIndex else { return }
        queue.remove(at: index)
        if index < currentIndex { currentIndex -= 1 }
        notifyQueueChanged()
        saveSnapshot()
    }

    /// Kurzer Tick beim Einreihen per Swipe. iOS gibt Web-Apps keine Vibrations-API, die
    /// Seite kann das also nicht selbst - sie schickt {cmd:"haptic"} und wir loesen es nativ
    /// aus (gleiche Wirkung wie in Spotify, wo die Rueckmeldung kommt, sobald die Schwelle
    /// ueberschritten ist, nicht erst beim Loslassen).
    private func playHapticTick() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred()
    }

    /// Verhalten fuer Sperrbildschirm/Control Center: laeuft der Song schon laenger als
    /// 3 Sekunden, startet er neu statt zurueckzuspringen. Dort ist dieses Doppeltipp-Muster
    /// von jeder Musik-App etabliert und wird erwartet. **Bewusst nur dort** - in der
    /// App-Oberflaeche (Web-Player, NativePlayerBar) wollte der Nutzer genau das nicht,
    /// dafuer gibt es previousTrack().
    func previous() {
        if player.currentTime().seconds > 3 || currentIndex == 0 {
            player.seek(to: .zero)
            return
        }
        lastNavigationStep = -1
        forgetPendingSeek()
        currentIndex -= 1
        playCurrent()
    }

    /// Ein Tipp = ein Song zurueck, ohne 3-Sekunden-Regel. Fuer die Knoepfe in der App
    /// (grosser Web-Player und native Leiste). Am Anfang der Warteschlange bleibt nur der
    /// Neustart des aktuellen Songs uebrig - es gibt nichts davor.
    func previousTrack() {
        guard currentIndex > 0 else {
            player.seek(to: .zero)
            return
        }
        lastNavigationStep = -1
        forgetPendingSeek()
        currentIndex -= 1
        playCurrent()
    }

    /// Absoluter Positionssprung (Scrub-Leiste im grossen Player, Control Center).
    ///
    /// Drei Gruende, warum das vorher "teilweise nicht angenommen" wurde - alle hier behoben:
    ///
    /// 1. `preferredTimescale: 1` konnte nur GANZE Sekunden darstellen. Jede Zielposition
    ///    wurde also auf die naechste Sekunde gerundet, bevor AVPlayer sie ueberhaupt sah.
    /// 2. `seek(to:)` ohne Toleranzangabe darf zum naechstgelegenen Sync-Sample springen.
    ///    Bei MP3 ohne exakten Index liegt das schnell mehrere Sekunden neben dem Ziel - genau
    ///    das Bild "er geht nicht auf die Stelle, die ich gedrueckt habe". Mit .zero/.zero
    ///    springt er exakt (minimal teurer, bei lokalen Dateien nicht spuerbar).
    /// 3. Ist das Item noch nicht `readyToPlay` - beim Streamen mit schwachem Netz der
    ///    Normalfall, deshalb die Abhaengigkeit vom WLAN - verpufft ein Seek folgenlos. Statt
    ///    ihn zu verlieren, wird er wie beim Sitzungs-Wiederherstellen vorgemerkt und greift,
    ///    sobald das Item bereit ist (siehe pendingSeekSeconds).
    func seek(toSeconds seconds: Double) {
        guard let item = player.currentItem, item.status == .readyToPlay else {
            pendingSeekSeconds = max(0, seconds)
            return
        }

        // GEGEN DAS SONGENDE BEGRENZEN. Ohne diese Grenze hatte ein Sprung hinter das
        // Dateiende eine drastische Nebenwirkung: AVPlayer landet am Ende, feuert
        // AVPlayerItemDidPlayToEndTime, und der daran haengende Beobachter schaltet zum
        // NAECHSTEN SONG. Fuer den Nutzer sah ein Tipp auf die Zeitleiste dadurch aus wie ein
        // Weiterschalten - und zwar unberechenbar mal so, mal so.
        //
        // Dass die Seite ueberhaupt eine zu grosse Zahl schicken kann, liegt an der Songdauer,
        // gegen die sie die Tippposition umrechnet: bis der Player seine gemessene Dauer
        // gemeldet hat, gilt der Wert aus der Datenbank, und der stammt aus Import-Metadaten.
        // Ist er LAENGER als die Datei, liegt das Sprungziel hinter deren Ende. Der Seite ist
        // das inzwischen ausgetrieben (gemessene Dauer hat Vorrang), aber die Grenze gehoert
        // trotzdem hierher: der Player darf sich nicht darauf verlassen, dass der Aufrufer
        // richtig rechnet. seek(byDelta:) macht das laengst so - nur der absolute Sprung nicht.
        let duration = item.duration.seconds
        let obergrenze = (duration.isFinite && duration > 0) ? duration - 0.5 : seconds
        seekExactly(to: max(0, min(seconds, obergrenze)))
    }

    private func seekExactly(to seconds: Double) {
        player.seek(
            to: CMTime(seconds: seconds, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.updateNowPlayingInfo()
                // Die Seite bekommt Fortschritt sonst erst beim naechsten Sekundentakt. Bis
                // dahin ueberschrieb genau dieser Takt die gezogene Position noch einmal mit
                // dem alten Stand - fuer den Nutzer sah der Sprung dadurch aus, als waere er
                // verworfen worden, obwohl er lief.
                guard self.isWebOverlayVisible else { return }
                let duration = self.player.currentItem?.duration.seconds ?? 0
                self.onProgressChanged?(self.player.currentTime().seconds, duration.isFinite ? duration : 0)
            }
        }
    }

    /// Relativer Sprung fuer den Langdruck-Suchlauf der Web-Knoepfe. Auf 0 und Songende
    /// begrenzt, damit ein langer Druck nicht ueber das Ende hinausschiebt.
    func seek(byDelta delta: Double) {
        let duration = player.currentItem?.duration.seconds ?? 0
        let ziel = player.currentTime().seconds + delta
        let obergrenze = (duration.isFinite && duration > 0) ? duration - 0.5 : ziel
        seek(toSeconds: max(0, min(ziel, obergrenze)))
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
            // Gleicher Weg wie der Play-Knopf in der App - sonst haette der Sperrbildschirm
            // dieselbe Schwaeche (play() verpufft, Wiedergabe startet nicht) ohne Absicherung.
            self.startPlaybackResiliently()
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
        // Kopfhoerer-/Sperrbildschirm-Toggle: lief bisher nicht ueber unsere Logik und konnte
        // dadurch play() ungeprueft absetzen.
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.togglePlayPause()
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
            // Sicherheitsnetz zusaetzlich zum didEnterBackground-Speicherpunkt (Absturz,
            // Batterie leer o.ae. ohne sauberes Hintergrund-Signal) - waehrend Wiedergabe
            // hoechstens 10s alter Stand, nicht bei jedem Sekundentakt (unnoetige Schreiblast).
            if self.isPlaying, Date().timeIntervalSince(self.lastSnapshotSaveAt) > 10 {
                self.saveSnapshot()
            }
            guard self.isWebOverlayVisible else { return }
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
        if let artwork = currentArtwork, currentArtworkItemId == item.id {
            info[MPMediaItemPropertyArtwork] = artwork
        } else {
            // Kein Cover zur Hand: nachladen anstossen statt das Feld einfach wegzulassen.
            // Diese Methode laeuft jede Sekunde; ohne den Anstoss blieb der Sperrbildschirm
            // dauerhaft ohne Cover, sobald es einmal fehlte - genau das passierte, als der
            // Speicher-Cache es im Hintergrund weggeraeumt hatte.
            loadArtworkIfNeeded(for: item)
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Hebt die Aufloesung von iTunes-Cover-Adressen an. Die Bibliothek speichert sie als
    /// ".../600x600bb.jpg" (siehe app2.js, wo artworkUrl100 schon einmal hochgesetzt wird) -
    /// die Groesse steht im Pfad und laesst sich einfach austauschen. Fuer die kleine
    /// Mini-Leiste reichten 600px; seit iOS den Sperrbildschirm gross und flaechig zeichnet,
    /// ist das sichtbar unscharf. Andere Adressen bleiben unveraendert.
    private static func highResCoverURL(_ url: URL) -> URL {
        let s = url.absoluteString
        guard s.contains("mzstatic.com") else { return url }
        for groesse in ["600x600bb", "300x300bb", "100x100bb"] where s.contains(groesse) {
            return URL(string: s.replacingOccurrences(of: groesse, with: "1200x1200bb")) ?? url
        }
        return url
    }

    private func loadArtworkIfNeeded(for item: QueueItem) {
        guard currentArtworkItemId != item.id || currentArtwork == nil else { return }
        // updateNowPlayingInfo() laeuft im Sekundentakt und stoesst das Laden an, solange kein
        // Cover da ist. Ohne diesen Riegel waere das ein Netzabruf pro Sekunde.
        guard artworkLoadingForId != item.id, artworkFailedForId != item.id,
              let url = item.coverURL else { return }
        artworkLoadingForId = item.id

        Task { [weak self] in
            let image = await Self.ladeBild(von: Self.highResCoverURL(url), rueckfallAuf: url)
            await MainActor.run {
                guard let self else { return }
                self.artworkLoadingForId = nil
                guard let image, self.currentItem?.id == item.id else {
                    // Nur merken, wenn es wirklich dieser Song war, der nicht geladen werden
                    // konnte - nicht, wenn inzwischen ein anderer laeuft.
                    if image == nil, self.currentItem?.id == item.id { self.artworkFailedForId = item.id }
                    return
                }
                // boundsSize muss die ECHTE Bildgroesse sein - daran erkennt iOS, wie gross es
                // das Cover darstellen darf. Ein zu klein gemeldetes Artwork zeichnet das
                // System nicht hoch, es zeigt es einfach klein.
                self.currentArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.currentArtworkItemId = item.id
                self.updateNowPlayingInfo()
            }
        }
    }

    /// Laedt das Cover in hoher Aufloesung und faellt auf die Originaladresse zurueck, wenn es
    /// die nicht gibt. Der Rueckfall ist nicht optional: die hochskalierte Adresse ist geraten
    /// (Groesse im Pfad ausgetauscht), und wenn der Bildserver genau diese Groesse nicht
    /// vorhaelt, gaebe es sonst GAR KEIN Cover statt eines etwas kleineren.
    private static func ladeBild(von hoch: URL, rueckfallAuf original: URL) async -> UIImage? {
        // Selbst hochgeladene Cover kommen als data:-URI herein (im Tag-Editor per
        // FileReader.readAsDataURL erzeugt). URLSession kann dieses Schema NICHT laden - ein
        // dataTask darauf scheitert schlicht, und genau deshalb blieb der Sperrbildschirm bei
        // eigenen Bildern leer, obwohl die App sie anzeigte. Data(contentsOf:) dekodiert sie
        // direkt, ohne Netzzugriff.
        if original.scheme == "data" {
            guard let data = try? Data(contentsOf: original) else { return nil }
            return UIImage(data: data)
        }
        if let (data, response) = try? await URLSession.shared.data(from: hoch),
           (response as? HTTPURLResponse)?.statusCode == 200,
           let image = UIImage(data: data) {
            return image
        }
        guard hoch != original,
              let (data, response) = try? await URLSession.shared.data(from: original),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return UIImage(data: data)
    }
}
