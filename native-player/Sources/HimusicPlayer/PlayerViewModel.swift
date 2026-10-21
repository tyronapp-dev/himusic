import Foundation
import AVFoundation
import MediaPlayer
import UIKit
import Network

/// Kompletter Player laeuft nativ ueber AVQueuePlayer (nicht WKWebView) - genau das
/// umgeht die dokumentierte WKWebView-Hintergrund-Audio-Bug-Klasse, die den Grund
/// bildet, warum die PWA im Hintergrund einfriert bzw. Control Center die falsche
/// App zeigt. MPNowPlayingInfoCenter/MPRemoteCommandCenter sind Apples eigene,
/// von jeder Musik-App (auch Spotify) genutzte APIs fuer genau dieses Problem.
///
/// UMBAU 2026-10-21 (ADR-015). Die Fehler "Titelwechsel bei gesperrtem Handy bleibt aus",
/// "Zeitleiste landet neben der Stelle", "Sperrbildschirm ohne Zeit/ohne Reaktion" und
/// "Verzoegerung beim Skippen" kamen mehrfach wieder, weil jede Korrektur ein Symptom
/// behandelte. Gemeinsame Ursachen, hier an der Wurzel angegangen:
///
///  1. Der Titelwechsel am Songende hing an App-Code (Beobachter -> Task -> mehrere awaits ->
///     replaceCurrentItem). Bei gesperrtem Handy schweigt der Ton in diesem Moment, iOS kann
///     den Prozess einfrieren - der Wechsel passierte erst beim Entsperren. Jetzt: AVQueuePlayer
///     mit VORGELADENEM Nachfolger, das System wechselt selbst, ohne dass App-Code laufen muss.
///  2. Songs wurden meist GESTREAMT statt von Platte gespielt (der Vorlade-Cache verhungerte,
///     siehe AudioFileCache). Streams haben keine verlaessliche Dauer und kein genaues Seeking.
///     Jetzt: Cache mit Prioritaeten + EINE Funktion fuer die Dauer (effectiveDuration) + ein
///     Seek, der das Ergebnis pruefen und nachbessern kann.
///  3. Der Sperrbildschirm wurde einmalig (ohne Dauer) befuellt und nie nachgezogen, wenn die
///     Dauer spaeter feststand. Jetzt: Beobachter auf die Dauer, Pflege bei jedem Ereignis.
///  4. Zwei Kopien des Zustands (Seite und Player) liefen auseinander. Jetzt: der Player
///     fuehrt Position UND Dauer, die Seite schickt nur noch Anteile ("fraction").
///  5. Nichts davon war nachtraeglich sichtbar. Jetzt: PlaybackJournal (Platte, ueberlebt den
///     Hintergrund) und Build-Kennung.
@MainActor
final class PlayerViewModel: ObservableObject {
    @Published private(set) var queue: [QueueItem] = []
    @Published private(set) var currentIndex: Int = 0
    @Published private(set) var isPlaying: Bool = false

    private let player = AVQueuePlayer()
    private var timeObserverToken: Any?
    private var currentItemObservation: NSKeyValueObservation?
    private var timeControlObservation: NSKeyValueObservation?

    /// Alle Titel, die gerade im Player haengen (der laufende und der vorgeladene Nachfolger).
    private var tracks: [ObjectIdentifier: Track] = [:]

    private var currentTrack: Track? {
        guard let item = player.currentItem else { return nil }
        return tracks[ObjectIdentifier(item)]
    }

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

    /// Steigt bei jedem harten Songstart und bei jedem Wechsel. Ein harter Start prueft vor
    /// jeder Mutation am Player, ob sein Token noch aktuell ist - verhindert, dass ein aelterer,
    /// an einem await noch haengender Aufruf einen neueren (z.B. manueller Skip kurz danach)
    /// ueberschreibt. Ohne das entscheidet reine Ausfuehrungsreihenfolge der async Tasks, welcher
    /// Song am Ende wirklich laeuft - nicht der zuletzt angeforderte.
    private var playbackToken = 0

    /// Steigt bei jeder Aenderung, die den vorgeladenen Nachfolger betrifft. Ein noch im Bau
    /// befindlicher Nachfolger (async) verwirft sich selbst, wenn sich das inzwischen geaendert hat.
    private var preloadGeneration = 0

    /// Position, die noch angesprungen werden soll, sobald das Item bereit ist. Ein seek()
    /// direkt nach dem Einhaengen geht ins Leere: das Item laedt noch, bei einer Netz-URL ist
    /// die Dauer zu dem Zeitpunkt "indefinite". Genau das passierte beim Wiederherstellen der
    /// letzten Sitzung - der Player blieb danach in einem Zustand, in dem ein spaeteres play()
    /// nichts bewirkte (Zeit lief nicht los), bis man den Song wechselte.
    private var pendingSeekSeconds: Double?
    /// Wie pendingSeekSeconds, aber als Anteil: die Seite kennt die Dauer oft nicht verlaesslich,
    /// der Player rechnet deshalb selbst - sobald seine Dauer feststeht.
    private var pendingSeekFraction: Double?
    private var pendingSeekFractionAt: Date = .distantPast

    /// Anzahl gerade laufender Positionssprunge. Solange > 0, meldet der Sekundentakt keinen
    /// Fortschritt an die Seite - siehe observePlayerTime().
    private var seeksInFlight = 0
    private var seekGeneration = 0
    /// Weicht der Player nach einem Sprung um mehr als so viele Sekunden vom Ziel ab, gilt der
    /// Sprung als misslungen und wird einmal mit Toleranz wiederholt.
    private static let seekToleranceSeconds = 2.0

    /// Dauer der lokalen Kopie des laufenden Songs aus dem Datei-Cache (sample-genau gemessen).
    private var knownDurationForCurrent: (id: Int, seconds: Double)?

    private var wasPlayingBeforeInterruption = false
    private var handoverAssertion: BackgroundAssertion?

    /// Zeitmessung des letzten Songstarts fuer die "Wiedergabe-Diagnose" in den Einstellungen.
    struct StartDiag {
        let id: Int
        let title: String
        let source: String      // "lokal" | "Stream" | "Stream (vorgeladen)" | ...
        let waitMs: Int         // Start von beginPlayback bis Einhaengen
        let replacedAt: Date
        var readyMs: Int?       // Einhaengen bis .readyToPlay
    }
    private(set) var lastStartDiag: StartDiag?
    var lastStartDiagPayload: [String: Any]? {
        guard let d = lastStartDiag else { return nil }
        return ["id": d.id, "t": d.title, "src": d.source, "waitMs": d.waitMs, "readyMs": d.readyMs ?? -1]
    }

    /// Meldet der eingebetteten Webseite den echten nativen Zustand zurueck (WebShellView.
    /// Coordinator schickt das als JS an app2.js's _applyNativeNowPlaying weiter). Ohne das
    /// zeigt die Seite nach Auto-Skips im Hintergrund/gesperrtem Screen weiterhin den zuletzt
    /// manuell gestarteten Song, waehrend nativ laengst ein anderer laeuft. Wird NUR bei
    /// echtem Songwechsel/Play-Pause/neuer Dauer ausgeloest, nicht im Sekundentakt.
    var onNowPlayingChanged: ((QueueItem, Bool) -> Void)?

    private func notifyNowPlayingChanged() {
        guard let item = currentItem else { return }
        onNowPlayingChanged?(item, isPlaying)
        notifyQueueChanged()
        persistPosition()
    }

    /// Nur der Song-/Dauer-Stand an die Seite, ohne Warteschlange und Speichern.
    private func pushNowPlayingOnly() {
        guard let item = currentItem else { return }
        onNowPlayingChanged?(item, isPlaying)
    }

    /// Schickt der Seite den aktuellen Ausschnitt der nativen Warteschlange (fertiges JSON).
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
    /// (2) Solange etwas offen ist, pushen wir Fortschritt/Zeit jede Sekunde nach - die
    ///     Zeitanzeige des grossen Players haengt sonst am lokalen <audio>-Element, das in
    ///     der Huelle inert ist und nie "timeupdate" feuert.
    @Published var isWebOverlayVisible: Bool = false

    /// Nur gefeuert, waehrend isWebOverlayVisible true ist (siehe dort).
    var onProgressChanged: ((Double, Double) -> Void)?

    /// Ein Song liess sich nicht abspielen (defekte/leere Datei, Quelle nicht erreichbar).
    /// Die Seite zeigt daraufhin einen Hinweis - aber nur, wenn sie ueberhaupt sichtbar ist.
    /// Das Ueberspringen selbst passiert IMMER, unabhaengig von diesem Callback.
    var onPlaybackFailed: ((QueueItem, String) -> Void)?

    /// Ereignisprotokoll auf Anfrage der Seite (cmd "journal").
    var onJournalText: ((String) -> Void)?

    /// Stand des Datei-Caches (ids), damit die Seite "offline"-Haken und Zaehler aus dem
    /// zeigen kann, was nativ WIRKLICH lokal liegt (statt aus der unbenutzbaren IndexedDB).
    var onCachedIds: (([Int]) -> Void)?

    /// Bricht die Kette, wenn mehrere Songs hintereinander scheitern. Ohne das wuerde ein
    /// flaechiger Ausfall (Netz weg, Serverfehler, ganze Warteschlange ungueltig) die
    /// komplette Liste in Sekunden durchrasen und am Ende stumm stehen bleiben - fuer den
    /// Nutzer nicht von "die App hat meine Musik verloren" zu unterscheiden. Wird bei jedem
    /// Song zurueckgesetzt, der wirklich losspielt.
    ///
    /// ZWEI Schwellen, weil die alte einzelne (5) das falsche Problem loeste: bei "zufaellig
    /// abspielen" ueber die ganze Bibliothek liegen einzelne tote Importe verstreut - fuenf
    /// davon zufaellig hintereinander stoppten die Wiedergabe komplett, obwohl direkt danach
    /// wieder gute Songs kaemen. Bei bestehender Verbindung wird deshalb weit laenger
    /// weitergesprungen. Ohne Netz bleibt es bei 5: dann kann WIRKLICH nichts spielen.
    private var consecutiveFailures = 0
    private static let maxConsecutiveFailuresOffline = 5
    private static let maxConsecutiveFailuresOnline = 25

    /// Songs, die in DIESER Warteschlange bereits gescheitert sind. Sie werden beim
    /// Weiterspringen gleich mit uebersprungen. Bewusst nur zur Laufzeit und pro Warteschlange -
    /// ein Song, der heute an einer schlechten Verbindung scheiterte, soll morgen wieder
    /// versucht werden.
    private var failedItemIds: Set<Int> = []

    /// Wie oft ein Song ohne lokale Kopie schon direkt vom Netz neu angestossen wurde. Ein
    /// frisch importierter Song ist am CDN-Edge noch "kalt" - der erste AVPlayer-Zugriff
    /// scheitert dann gern, obwohl die Datei in Ordnung ist. Pro Warteschlange.
    private var remoteRetryCount: [Int: Int] = [:]
    private static let maxRemoteRetries = 3

    /// In welche Richtung zuletzt navigiert wurde: +1 vorwaerts, -1 rueckwaerts. Entscheidet,
    /// wohin ein defekter Song uebersprungen wird.
    private var lastNavigationStep = 1

    /// Ob gerade ueberhaupt eine Verbindung besteht.
    private var hasNetwork = true
    private let pathMonitor = NWPathMonitor()

    private func startNetworkMonitoring() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let hatteNetz = self.hasNetwork
                self.hasNetwork = (path.status == .satisfied)
                if hatteNetz != self.hasNetwork {
                    self.journal("Netz: \(self.hasNetwork ? "da" : "weg")")
                }
                // Verbindung kommt zurueck: ein Cover, das vorher mangels Netz nicht zu holen
                // war, jetzt nachholen statt bis zum naechsten Songwechsel ohne dazustehen.
                if !hatteNetz, self.hasNetwork {
                    self.artworkFailedForId = nil
                    if let item = self.currentItem { self.loadArtworkIfNeeded(for: item) }
                    // Verbindung war weg und ist zurueck: haengt die Wiedergabe noch im
                    // Puffer-Leerlauf, gleich nachtreten.
                    if self.isPlaying, self.player.timeControlStatus == .paused { self.startPlaybackResiliently() }
                    self.prefetchUpcoming()
                    self.prepareNext()
                }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "himusic.network"))
    }

    var currentItem: QueueItem? {
        queue.indices.contains(currentIndex) ? queue[currentIndex] : nil
    }

    // MARK: - Dauer: EINE Quelle fuer alle

    /// Dauer, die der Player selbst meldet (0 = unbekannt). Bei Streams kann das eine Schaetzung
    /// sein (VBR-MP3), oder sie steht erst spaet fest.
    private var playerDuration: Double {
        guard let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 else { return 0 }
        return d
    }

    /// DIE Dauer des laufenden Songs - fuer Sperrbildschirm, Zeitleiste der Seite, Anzeige,
    /// Sprung-Umrechnung und Begrenzung. Vorher rechneten Seite (Datenbankwert, bei 2/3 der
    /// Songs 0), Player (eigener Wert) und Sperrbildschirm (nur wenn bekannt) jeweils mit einer
    /// anderen Dauer; jede Abweichung zeigte sich als "Zeitleiste landet neben der Stelle".
    ///
    /// Lokale Kopie: die gemessene Dauer des Players ist sample-genau, sie gewinnt.
    /// Stream: der Wert des Players kann eine Schaetzung sein - dann haben die gespeicherte
    /// Messung der Datei und der Datenbankwert Vorrang, falls vorhanden.
    private func effectiveDuration() -> Double? {
        guard let item = currentItem else { return nil }
        let av = playerDuration
        let known = (knownDurationForCurrent?.id == item.id) ? knownDurationForCurrent?.seconds : nil
        if currentTrack?.isRemote == true {
            if let known { return known }
            if let db = item.dbDuration { return db }
            return av > 0 ? av : nil
        }
        if av > 0 { return av }
        if let known { return known }
        return item.dbDuration
    }

    /// Fuer die Seite (Payload "d" in pushNowPlaying). 0 = noch nicht bekannt.
    var currentItemDurationSeconds: Double { effectiveDuration() ?? 0 }

    private func safeSeconds(_ time: CMTime) -> Double {
        let s = time.seconds
        return (s.isFinite && s >= 0) ? s : 0
    }

    private func journal(_ message: String) {
        PlaybackJournal.shared.log(message)
    }

    init() {
        configureAudioSession()
        configureRemoteCommands()
        observePlayerTime()
        observePlayer()
        observeAudioSession()
        startNetworkMonitoring()
        wireCacheCallbacks()
        restoreLastSession()
        // Zuverlaessigster Speicherpunkt: feuert garantiert beim Wechsel in den Hintergrund
        // (Home-Geste, App-Wechsel, bevor iOS die App ggf. beendet) - im Gegensatz zu
        // applicationWillTerminate, das iOS nicht in jedem Fall aufruft.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.flushPersistence() }
        }
        journal("Huelle \(HimusicBuild.id) gestartet")
    }

    private func wireCacheCallbacks() {
        Task {
            await AudioFileCache.shared.setOnCached { [weak self] id in
                Task { @MainActor in self?.handleCached(id) }
            }
        }
    }

    // MARK: - Wiedergabe-Stand ueberleben lassen

    /// Warteschlange + Position, damit Mini-Leiste/Control-Center nach einem ECHTEN
    /// Neustart (App vorher vollstaendig beendet, nicht nur backgrounded) sofort am
    /// richtigen Song/Stand stehen - ein Tipp auf Play setzt exakt dort fort. Kein
    /// automatisches Loslaufen beim Oeffnen, das macht auch keine andere Musik-App.
    ///
    /// GETRENNT in zwei Teile (bis 2026-10-21 ein einziger Blob in UserDefaults): die
    /// Warteschlange (gross: ueber 2000 Songs, mit eingebetteten Covern bis ~12 MB) liegt
    /// jetzt als Datei, wird nur bei Aenderungen und abseits des Main-Threads geschrieben und
    /// ohne data:-Cover gespeichert. Die Position (drei Zahlen) steht in UserDefaults. Vorher
    /// kodierte der Sekundentakt alle 10 s die ganze Warteschlange auf dem Main-Thread - bei
    /// jedem Songwechsel und waehrend der Wiedergabe spuerbare Hakler (Skip-Verzoegerung).
    private struct LegacySnapshot: Codable {
        let queue: [QueueItem]
        let currentIndex: Int
        let positionSeconds: Double
    }
    private static let legacySnapshotKey = "himusic.native.playbackSnapshot"
    private static let indexKey = "himusic.native.index"
    private static let itemIdKey = "himusic.native.itemId"
    private static let positionKey = "himusic.native.position"

    nonisolated private static var queueFileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PlaybackQueue.json")
    }

    private let persistIO = DispatchQueue(label: "himusic.persist", qos: .utility)
    private var persistQueueWork: DispatchWorkItem?
    private var lastPositionSaveAt: Date = .distantPast

    private func persistPosition() {
        guard let item = currentItem else { return }
        lastPositionSaveAt = Date()
        let defaults = UserDefaults.standard
        defaults.set(currentIndex, forKey: Self.indexKey)
        defaults.set(item.id, forKey: Self.itemIdKey)
        defaults.set(safeSeconds(player.currentTime()), forKey: Self.positionKey)
    }

    nonisolated private static func writeQueueFile(_ items: [QueueItem]) {
        let slim = items.map { item -> QueueItem in
            (item.c?.hasPrefix("data:") == true) ? item.withCover(nil) : item
        }
        guard let data = try? JSONEncoder().encode(slim) else { return }
        try? data.write(to: queueFileURL, options: .atomic)
    }

    /// Warteschlange gebuendelt und abseits des Main-Threads speichern.
    private func persistQueueSoon() {
        persistQueueWork?.cancel()
        let snapshot = queue
        let work = DispatchWorkItem { Self.writeQueueFile(snapshot) }
        persistQueueWork = work
        persistIO.asyncAfter(deadline: .now() + 1.5, execute: work)
    }

    /// Beim Wechsel in den Hintergrund alles sofort sichern - dort kann der Prozess jederzeit
    /// eingefroren oder beendet werden.
    private func flushPersistence() {
        persistPosition()
        persistQueueWork?.cancel()
        let snapshot = queue
        let assertion = BackgroundAssertion("himusic.persist")
        persistIO.async {
            Self.writeQueueFile(snapshot)
            Task { @MainActor in assertion.end() }
        }
        Task { await AudioFileCache.shared.flushIndex() }
    }

    private func restoreLastSession() {
        let defaults = UserDefaults.standard
        var restoredQueue: [QueueItem] = []
        var restoredIndex = 0
        var restoredPosition = 0.0

        if let data = try? Data(contentsOf: Self.queueFileURL),
           let items = try? JSONDecoder().decode([QueueItem].self, from: data), !items.isEmpty {
            restoredQueue = items
            restoredIndex = defaults.integer(forKey: Self.indexKey)
            restoredPosition = defaults.double(forKey: Self.positionKey)
            let savedId = defaults.integer(forKey: Self.itemIdKey)
            // Position nur uebernehmen, wenn sie zum selben Song gehoert.
            if !(items.indices.contains(restoredIndex) && items[restoredIndex].id == savedId) { restoredPosition = 0 }
        } else if let data = defaults.data(forKey: Self.legacySnapshotKey),
                  let legacy = try? JSONDecoder().decode(LegacySnapshot.self, from: data), !legacy.queue.isEmpty {
            restoredQueue = legacy.queue
            restoredIndex = legacy.currentIndex
            restoredPosition = legacy.positionSeconds
            journal("Alten Snapshot uebernommen (\(data.count / 1024) KB)")
        }
        // Der alte Blob gehoert nicht mehr in UserDefaults - dort musste ihn jeder Zugriff
        // mitschleppen. Bei einem Fund (auch neben der neuen Datei) entfernen.
        if defaults.object(forKey: Self.legacySnapshotKey) != nil {
            defaults.removeObject(forKey: Self.legacySnapshotKey)
        }

        guard !restoredQueue.isEmpty else { return }
        queue = restoredQueue
        currentIndex = min(max(restoredIndex, 0), queue.count - 1)
        persistQueueSoon()
        guard let item = currentItem else { return }
        // Nicht direkt seeken (siehe pendingSeekSeconds) - beginPlayback holt das nach,
        // sobald das Item wirklich bereit ist. Positionen ganz am Songende werden verworfen:
        // wurde die App kurz vor Songende geschlossen, stuende der Player sonst beim Oeffnen
        // am Ende und ein play() liefe sofort ins Nichts.
        pendingSeekSeconds = restoredPosition > 3 ? restoredPosition : nil
        playbackToken += 1
        let token = playbackToken
        Task { @MainActor in await beginPlayback(item, token: token, autoplay: false) }
        // NUR das Fenster um die aktuelle Position vorladen. Hier stand ensureCachedQueue(queue)
        // mit der KOMPLETTEN Warteschlange (bis ueber 2000 Songs) - bei jedem App-Start.
        prefetchUpcoming()
    }

    // MARK: - Eingehende Abspielwuensche

    /// Hauptweg: Aufruf aus der eingebetteten Seite ueber die JS-Bruecke. Formen:
    /// {cmd:"toggle"}, {cmd:"playerView", open}, Transport/Sprung/Warteschlangen-Befehle -
    /// sonst dasselbe Queue-JSON wie der alte URL-Weg, nur unverpackt (kein base64url,
    /// keine Laengengrenze).
    func handleBridgeJSON(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        if let command = try? JSONDecoder().decode(BridgeCommand.self, from: data) {
            switch command.cmd {
            case "toggle": togglePlayPause()
            case "playerView": isWebOverlayVisible = command.open ?? false
            // Transport aus der Web-Oberflaeche: IMMER echter Songwechsel. Die Seite darf
            // nicht selbst aus playbackQueue/playbackHistory rechnen - die veralten bei
            // jedem nativen Auto-Skip im Hintergrund und lieferten dadurch falsche Songs.
            case "next":
                journal("Befehl: weiter (App)")
                next()
            case "prev":
                journal("Befehl: zurueck (App)")
                previousTrack()
            case "seekBy": seek(byDelta: command.delta ?? 0)
            // Scrub-Leiste im grossen Web-Player loslassen. Mit "fraction" rechnet der Player
            // selbst (mit der Dauer, die er auch anzeigt); aeltere Seiten schicken nur Sekunden.
            case "seekTo":
                if let fraction = command.fraction {
                    seek(toFraction: fraction)
                } else {
                    seek(toSeconds: command.seconds ?? 0)
                }
            case "insertNext": if let item = command.item { insertNext(item) }
            case "jumpTo": if let index = command.index { jumpTo(index) }
            case "removeAt": if let index = command.index { removeAt(index) }
            case "moveItem": if let index = command.index, let toIndex = command.toIndex { moveItem(from: index, to: toIndex) }
            case "shuffle": shuffleRemaining()
            // Einzelner Song fuers Auffuellen (Prioritaet niedrig).
            case "ensureCached": if let item = command.item { Task { await AudioFileCache.shared.ensureCached(item: item) } }
            // Die ganze Bibliothek fuers Auffuellen im Leerlauf - ersetzt tausende
            // Einzelnachrichten. Stoppt an der Fuellgrenze, verdraengt nie etwas.
            case "cacheBackground": if let items = command.items { Task { await AudioFileCache.shared.setBackground(items) } }
            // Frisch importierter Song: SOFORT mit Prioritaet in den lokalen Cache holen, damit
            // der erste Antipper von Platte spielt statt die noch kalte Datei zu streamen.
            case "cacheNow": if let item = command.item { Task { _ = await AudioFileCache.shared.fetchNow(item: item) } }
            case "setCover": if let id = command.id, let cover = command.c { applyCover(forId: id, cover: cover) }
            case "journal": onJournalText?(journalReport())
            case "journalClear": PlaybackJournal.shared.clear()
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
        remoteRetryCount.removeAll()
        consecutiveFailures = 0
        lastNavigationStep = 1
        journal("Warteschlange uebernommen: \(queue.count) Songs, Start \"\(currentItem?.title ?? "?")\"")
        persistQueueSoon()
        playCurrent()
    }

    /// Wieviele Songs ab der aktuellen Position vorausgeladen werden. Die Seite schickt die
    /// VOLLE Warteschlange (bei "zufaellig abspielen" ueber 2000 Songs) - es darf nie blind
    /// ueber die ganze Liste gelaufen werden. Ein gleitendes Fenster, das bei jedem
    /// Songwechsel mitwandert und die alte Warteschlange des Downloaders ERSETZT.
    private static let prefetchWindow = 15

    private func prefetchUpcoming() {
        guard !queue.isEmpty else { return }
        let start = min(currentIndex, queue.count - 1)
        let end = min(start + Self.prefetchWindow, queue.count)
        let window = Array(queue[start..<end])
        Task { await AudioFileCache.shared.setUpcoming(window) }
    }

    // MARK: - Wiedergabe-Steuerung (harter Start)

    /// Setzt die Wiedergabe bei currentIndex neu auf (Antippen, Sprung, Zurueck, Fehlerumgehung,
    /// Wiederaufnahme). Der NORMALE Weiterlauf zum naechsten Song laeuft nicht hierueber, sondern
    /// ueber den vorgeladenen Nachfolger (siehe prepareNext) - dort ist kein App-Code noetig.
    ///
    /// Haelt die App per Hintergrundaufgabe am Leben, solange der Start asynchron laeuft: kommt
    /// der Befehl vom Sperrbildschirm oder vom Songende, ist die App im Hintergrund.
    func playCurrent(ignoreLocalCopy: Bool = false, autoplay: Bool = true) {
        guard let item = currentItem else { return }
        playbackToken += 1
        let token = playbackToken
        // Vorlade-Fenster wandert mit der Wiedergabe mit.
        prefetchUpcoming()
        let assertion = BackgroundAssertion("himusic.start")
        Task { @MainActor in
            await beginPlayback(item, token: token, autoplay: autoplay, ignoreLocalCopy: ignoreLocalCopy)
            assertion.end()
        }
    }

    /// Loest zuerst gegen AudioFileCache auf. Liegt der Song schon lokal, spielt er von Platte
    /// (funktioniert ohne Netz im Hintergrund) - sonst wird SOFORT gestreamt und mit Prioritaet
    /// fuers naechste Mal heruntergeladen. Seit 2026-10-21 wartet der Start nie mehr auf einen
    /// Download: der alte Song lief sonst weiter, waehrend der neue schon angezeigt wurde (die
    /// gemeldete Verzoegerung). Fuer frisch importierte Songs sorgt die Seite vorab per cacheNow.
    ///
    /// Token-Checks nach jedem await: kam waehrenddessen ein neuerer Start dazwischen, bricht
    /// dieser veraltete Aufruf ab, statt den Player mit dem falschen Song zu ueberschreiben.
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
        let startedAt = Date()
        await cache.markCurrentlyPlaying(id: item.id)
        let localURL = ignoreLocalCopy ? nil : await cache.localFileURL(forId: item.id)
        let known = await cache.knownDuration(forId: item.id)
        guard token == playbackToken else { return }

        let source = localURL != nil ? "lokal" : "Stream"
        // Ohne abspielbare Adresse ist der Eintrag defekt. Frueher endete das in einem stillen
        // return: die Oberflaeche zeigte weiter einen Song, der nie loslief.
        guard let track = makeTrack(for: item, localURL: localURL, source: source) else {
            handlePlaybackFailure(for: item, reason: "Keine abspielbare Datei hinterlegt")
            return
        }

        // AB HIER ohne weiteres await bis zum Einhaengen - kein ueberholter Task kann dazwischen.
        seeksInFlight = 0
        knownDurationForCurrent = known.map { (id: item.id, seconds: $0) }
        let waitMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        lastStartDiag = StartDiag(
            id: item.id, title: item.title, source: source,
            waitMs: waitMs, replacedAt: Date(), readyMs: nil
        )
        installCurrent(track, autoplay: autoplay)
        journal("Start \"\(item.title)\" [\(source)] nach \(waitMs) ms, Index \(currentIndex)/\(queue.count)")
        updateNowPlayingInfo()
        // Jeder Songstart ist ein frischer Anlauf fuers Cover - eine Merkung aus einem
        // frueheren Versuch (z.B. damals kein Netz) soll ihn nicht blockieren.
        artworkFailedForId = nil
        loadArtworkIfNeeded(for: item)
        notifyNowPlayingChanged()
        prepareNext()
        // Stream: die lokale Kopie so schnell wie moeglich nachholen (genaues Seeking, feste Dauer).
        if localURL == nil { Task { await cache.ensureCachedUrgent(item: item) } }
    }

    /// Hängt den Titel als einzigen in den Player. removeAllItems + insert statt
    /// replaceCurrentItem: letzteres ist bei einem AVQueuePlayer nicht fuer eine Warteschlange
    /// gedacht.
    private func installCurrent(_ track: Track, autoplay: Bool) {
        preloadGeneration += 1
        track.consumed = true
        tracks[ObjectIdentifier(track.playerItem)] = track
        player.removeAllItems()
        player.insert(track.playerItem, after: nil)
        purgeUnusedTracks()
        releaseHandoverHold()
        if autoplay {
            player.play()
            isPlaying = true
        } else {
            player.pause()
        }
    }

    private func makeTrack(for item: QueueItem, localURL: URL?, source: String) -> Track? {
        guard let url = localURL ?? item.fileURL else { return nil }
        let remote = (localURL == nil)
        // Praezise Dauer/Timing nur bei LOKALEN Dateien (schneller Platten-Scan). AVURLAsset ohne
        // dieses Flag schaetzt die Dauer nur grob aus Bitrate/Container-Kopfdaten und erlaubt nur
        // ungefaehres Seeking - bei VBR-MP3 weicht das spuerbar vom echten Dateiende ab. Beim
        // Streamen wuerde derselbe Full-File-Scan ueber das Netz den Start verzoegern oder
        // kippen lassen - dort lieber ungefaehres Timing als gar keinen Ton.
        let options: [String: Any] = remote ? [:] : [AVURLAssetPreferPreciseDurationAndTimingKey: true]
        let asset = AVURLAsset(url: url, options: options)
        let track = Track(item: item, playerItem: AVPlayerItem(asset: asset), isRemote: remote, source: source)
        track.observe(
            onStatus: { [weak self] t in Task { @MainActor [weak self] in self?.trackStatusChanged(t) } },
            onDuration: { [weak self] t in Task { @MainActor [weak self] in self?.trackDurationChanged(t) } },
            onFail: { [weak self] t, reason in Task { @MainActor [weak self] in self?.trackFailedMidway(t, reason: reason) } },
            onEnd: { [weak self] t in Task { @MainActor [weak self] in self?.trackDidEnd(t) } },
            onStall: { [weak self] t in Task { @MainActor [weak self] in self?.trackStalled(t) } }
        )
        return track
    }

    /// Haengt Beobachter von Titeln ab, die nicht mehr im Player sind.
    private func purgeUnusedTracks() {
        let live = Set(player.items().map { ObjectIdentifier($0) })
        for key in Array(tracks.keys) where !live.contains(key) {
            tracks[key]?.stopObserving()
            tracks.removeValue(forKey: key)
        }
    }

    // MARK: - Vorgeladener Nachfolger (AVQueuePlayer)

    /// Naechster abspielbarer Index hinter `index` (ueberspringt Eintraege ohne Adresse und
    /// bereits als defekt bekannte).
    private func nextPlayableIndex(after index: Int) -> Int? {
        var i = index + 1
        while i < queue.count {
            if queue[i].fileURL != nil, !failedItemIds.contains(queue[i].id) { return i }
            i += 1
        }
        return nil
    }

    private func removeItemsAfterCurrent() {
        let items = player.items()
        guard items.count > 1 else { return }
        for item in items.dropFirst() {
            player.remove(item)
            if let t = tracks.removeValue(forKey: ObjectIdentifier(item)) { t.stopObserving() }
        }
    }

    /// Sorgt dafuer, dass hinter dem laufenden Song genau der richtige Nachfolger im Player
    /// haengt. Das ist der Kern von Fix 1: ist der Nachfolger beim Songende schon da, wechselt
    /// das SYSTEM - ohne dass App-Code laufen muss, auch bei gesperrtem Handy und ohne Luecke.
    /// Idempotent: stimmt der vorhandene Nachfolger schon, passiert nichts.
    private func prepareNext() {
        guard let current = player.currentItem, let nextIdx = nextPlayableIndex(after: currentIndex) else {
            preloadGeneration += 1
            removeItemsAfterCurrent()
            return
        }
        let nextItem = queue[nextIdx]
        if let second = player.items().dropFirst().first,
           let t = tracks[ObjectIdentifier(second)], t.item.id == nextItem.id {
            return
        }
        preloadGeneration += 1
        let generation = preloadGeneration
        let token = playbackToken
        removeItemsAfterCurrent()
        Task { @MainActor [weak self] in
            guard let self else { return }
            let cache = AudioFileCache.shared
            let local = await cache.localFileURL(forId: nextItem.id)
            guard generation == self.preloadGeneration, token == self.playbackToken,
                  self.player.currentItem === current else { return }
            let source = local != nil ? "lokal" : "Stream (vorgeladen)"
            guard let track = self.makeTrack(for: nextItem, localURL: local, source: source) else { return }
            guard self.player.canInsert(track.playerItem, after: current) else {
                track.stopObserving()
                return
            }
            self.tracks[ObjectIdentifier(track.playerItem)] = track
            self.player.insert(track.playerItem, after: current)
            self.journal("Nachfolger vorgeladen: \"\(nextItem.title)\" [\(source)]")
            // Ist der Nachfolger nur ein Stream, soll seine lokale Kopie als naechstes kommen.
            if local == nil { await cache.ensureCachedUrgent(item: nextItem) }
        }
    }

    /// Ein Download ist fertig. War genau dieser Song als Stream vorgeladen, wird er gegen die
    /// lokale Kopie getauscht (Streams: keine verlaessliche Dauer, kein genaues Seeking, brauchen
    /// Netz - im Hintergrund bei gesperrtem Handy ist lokal die einzige verlaessliche Quelle).
    private func handleCached(_ id: Int) {
        if let second = player.items().dropFirst().first,
           let t = tracks[ObjectIdentifier(second)], t.item.id == id, t.isRemote {
            journal("Nachfolger \"\(t.item.title)\" liegt jetzt lokal -> Stream ersetzt")
            preloadGeneration += 1
            removeItemsAfterCurrent()
            prepareNext()
        }
        scheduleCachedIdsPush()
    }

    private var cachedIdsPushPending = false

    /// Cache-Stand gebuendelt an die Seite (hoechstens alle 3 s, solange Downloads laufen).
    private func scheduleCachedIdsPush() {
        guard !cachedIdsPushPending, onCachedIds != nil else { return }
        cachedIdsPushPending = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self else { return }
            self.cachedIdsPushPending = false
            await self.pushCachedIds()
        }
    }

    private func pushCachedIds() async {
        let ids = await AudioFileCache.shared.cachedIds()
        onCachedIds?(ids)
    }

    /// Von aussen (WebShellView nach dem Laden der Seite).
    func sendCachedIds() {
        Task { await pushCachedIds() }
    }

    // MARK: - Ereignisse der Titel

    /// Wird bei JEDEM Wechsel des laufenden Items gerufen - auch bei denen, die das System
    /// selbst ausgeloest hat (Titelende mit vorgeladenem Nachfolger). Eigene Wechsel sind
    /// schon verbucht (track.consumed), nur fremde brauchen hier die Buchfuehrung.
    private func currentItemDidChange() {
        purgeUnusedTracks()
        guard let item = player.currentItem else {
            handleQueueDrained()
            return
        }
        guard let track = tracks[ObjectIdentifier(item)] else { return }
        if track.consumed {
            // Eigener Wechsel: nur absichern, dass der Nachfolger stimmt.
            prepareNext()
            return
        }
        advanceBookkeeping(to: track, how: "automatisch")
    }

    /// Verbucht, dass `track` jetzt der laufende Song ist: Index, Anzeige, Sperrbildschirm,
    /// Seite, Vorladen. Gemeinsamer Weg fuer den automatischen Wechsel am Songende und fuer den
    /// manuellen Skip auf den vorgeladenen Nachfolger.
    private func advanceBookkeeping(to track: Track, how: String) {
        var found: Int?
        var i = currentIndex + 1
        while i < queue.count {
            if queue[i].id == track.item.id { found = i; break }
            i += 1
        }
        track.consumed = true
        guard let idx = found else {
            // Die Warteschlange hat sich inzwischen geaendert und der Titel steht nicht mehr
            // dort, wo er erwartet wurde - sicher neu aufsetzen statt falsch zu verbuchen.
            journal("Wechsel (\(how)) auf unerwarteten Titel id=\(track.item.id) -> neu aufsetzen")
            playCurrent()
            return
        }
        let from = currentIndex
        currentIndex = idx
        lastNavigationStep = 1
        playbackToken += 1
        forgetPendingSeek()
        seeksInFlight = 0
        knownDurationForCurrent = nil
        releaseHandoverHold()
        journal("Wechsel \(from)->\(idx) (\(how)): \"\(track.item.title)\" [\(track.source)]")
        lastStartDiag = StartDiag(
            id: track.item.id, title: track.item.title, source: track.source,
            waitMs: 0, replacedAt: Date(), readyMs: nil
        )
        refreshKnownDuration(for: track.item)
        updateNowPlayingInfo()
        artworkFailedForId = nil
        loadArtworkIfNeeded(for: track.item)
        notifyNowPlayingChanged()
        prefetchUpcoming()
        prepareNext()
        let cache = AudioFileCache.shared
        let item = track.item
        Task {
            await cache.markCurrentlyPlaying(id: item.id)
            if track.isRemote { await cache.ensureCachedUrgent(item: item) }
        }
        if track.playerItem.status == .readyToPlay { trackBecameReady(track) }
        if isPlaying, player.timeControlStatus == .paused { player.play() }
    }

    private func refreshKnownDuration(for item: QueueItem) {
        Task { @MainActor [weak self] in
            let known = await AudioFileCache.shared.knownDuration(forId: item.id)
            guard let self, let known, self.currentItem?.id == item.id else { return }
            self.knownDurationForCurrent = (id: item.id, seconds: known)
            self.updateNowPlayingInfo()
            self.pushNowPlayingOnly()
        }
    }

    /// Der Player hat keinen Titel mehr: Ende der Warteschlange - oder (seltener Wettlauf) der
    /// Nachfolger war noch nicht vorgeladen. Letzteres faengt der harte Start ab.
    private func handleQueueDrained() {
        guard player.items().isEmpty, !queue.isEmpty, isPlaying else { return }
        if nextPlayableIndex(after: currentIndex) != nil {
            journal("Titelende ohne vorgeladenen Nachfolger -> harter Start (Rueckfall)")
            next()
        } else {
            journal("Ende der Warteschlange (Index \(currentIndex) von \(queue.count))")
            isPlaying = false
            updateNowPlayingInfo()
            notifyNowPlayingChanged()
        }
    }

    private func trackStatusChanged(_ track: Track) {
        let status = track.playerItem.status
        if player.currentItem === track.playerItem {
            switch status {
            case .readyToPlay:
                trackBecameReady(track)
            case .failed:
                let reason = track.playerItem.error?.localizedDescription ?? "Datei nicht lesbar"
                handlePlaybackFailure(for: track.item, reason: reason)
            default:
                break
            }
        } else if status == .failed, tracks[ObjectIdentifier(track.playerItem)] != nil {
            preloadedTrackFailed(track)
        }
    }

    /// Sobald das Item bereit ist: offenen Positionssprung nachholen und - falls die Wiedergabe
    /// laufen soll, aber steht - nachtreten. Genau der Moment, ab dem AVPlayer solche
    /// Anweisungen ueberhaupt zuverlaessig annimmt.
    private func trackBecameReady(_ track: Track) {
        guard !track.readyHandled else { return }
        track.readyHandled = true
        let item = track.item
        // Zeitmessung abschliessen: vom Einhaengen bis "spielbereit"
        if var d = lastStartDiag, d.id == item.id, d.readyMs == nil {
            d.readyMs = Int(Date().timeIntervalSince(d.replacedAt) * 1000)
            lastStartDiag = d
        }
        // Ab hier gilt der Song als spielbar - die Fehlerkette ist unterbrochen.
        consecutiveFailures = 0
        failedItemIds.remove(item.id)
        remoteRetryCount.removeValue(forKey: item.id)
        // Lief dieser Song gerade als zweiter Versuch ueber die Netzadresse, ist damit BEWIESEN,
        // dass nur die lokale Kopie kaputt war: der Song selbst spielt ja. Erst jetzt darf sie
        // weg - und der Cache laedt sie beim naechsten Vorladen sauber neu.
        if retriedFromRemoteId == item.id {
            retriedFromRemoteId = nil
            Task { _ = await AudioFileCache.shared.discardCachedFile(forId: item.id) }
        }
        // Dauer einer lokalen Datei festhalten (fuer Songs, die schon vor dieser Fassung im
        // Cache lagen und noch keine gemessene Dauer haben).
        if !track.isRemote, playerDuration > 1 {
            let seconds = playerDuration
            Task { await AudioFileCache.shared.recordDuration(forId: item.id, seconds: seconds) }
        }
        applyPendingSeek()
        if isPlaying && player.timeControlStatus == .paused { player.play() }
        // Jetzt steht die gemessene Songdauer fest. Zwei Empfaenger brauchen sie: der
        // SPERRBILDSCHIRM und die SEITE (Zeitleiste rechnet damit).
        updateNowPlayingInfo()
        notifyNowPlayingChanged()
    }

    /// Die Dauer eines Streams steht oft erst NACH .readyToPlay fest. Ohne diese Nachpflege
    /// blieb der Sperrbildschirm bei "-:--", weil er nur einmal (ohne Dauer) befuellt wurde.
    private func trackDurationChanged(_ track: Track) {
        guard player.currentItem === track.playerItem else { return }
        updateNowPlayingInfo()
        pushNowPlayingOnly()
        // Ein auf die Dauer wartender Sprung kann jetzt rechnen.
        if pendingSeekFraction != nil, track.playerItem.status == .readyToPlay { applyPendingSeek() }
    }

    private func trackFailedMidway(_ track: Track, reason: String) {
        handlePlaybackFailure(for: track.item, reason: reason)
    }

    private func trackStalled(_ track: Track) {
        handlePlaybackStall(for: track.item)
    }

    /// Titelende. Mit vorgeladenem Nachfolger wechselt der Player von selbst und
    /// currentItemDidChange verbucht es. Fehlt der Nachfolger, wird die App per
    /// Hintergrundaufgabe wachgehalten, bis der Rueckfall (harter Start) laeuft.
    private func trackDidEnd(_ track: Track) {
        guard !track.endHandled else { return }
        track.endHandled = true
        guard player.currentItem === track.playerItem else { return }
        let hasSuccessor = player.items().count > 1
        journal("Ende \"\(track.item.title)\" - Nachfolger vorgeladen: \(hasSuccessor ? "ja" : "nein")")
        if !hasSuccessor, nextPlayableIndex(after: currentIndex) != nil {
            beginHandoverHold()
        }
    }

    private func beginHandoverHold() {
        handoverAssertion?.end()
        let assertion = BackgroundAssertion("himusic.handover")
        handoverAssertion = assertion
        // Sicherheitsnetz: nie laenger als 25 s halten, auch wenn der Wechsel nie ankommt.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 25_000_000_000)
            assertion.end()
        }
    }

    private func releaseHandoverHold() {
        handoverAssertion?.end()
        handoverAssertion = nil
    }

    private func preloadedTrackFailed(_ track: Track) {
        let reason = track.playerItem.error?.localizedDescription ?? "Datei nicht lesbar"
        journal("Vorgeladener Nachfolger \"\(track.item.title)\" defekt: \(reason)")
        failedItemIds.insert(track.item.id)
        onPlaybackFailed?(track.item, hasNetwork ? reason : "\(reason) (offline)")
        player.remove(track.playerItem)
        if let t = tracks.removeValue(forKey: ObjectIdentifier(track.playerItem)) { t.stopObserving() }
        prepareNext()
    }

    /// Holt einen vorgemerkten Positionssprung nach. Gegen die Songdauer begrenzt, damit ein
    /// gespeicherter Stand knapp vor Schluss nicht am Ende landet (dort bewirkt play() nichts).
    private func applyPendingSeek() {
        if let fraction = pendingSeekFraction {
            // Ein Sprung, der ewig auf die Dauer wartet, soll nicht Minuten spaeter ploetzlich
            // greifen, wenn der Nutzer laengst woanders ist.
            guard Date().timeIntervalSince(pendingSeekFractionAt) < 15 else {
                pendingSeekFraction = nil
                return
            }
            guard effectiveDuration() != nil else { return }   // wartet auf die Dauer
            pendingSeekFraction = nil
            seek(toFraction: fraction)
            return
        }
        guard let target = pendingSeekSeconds else { return }
        pendingSeekSeconds = nil
        let duration = playerDuration
        guard !(duration > 0 && target >= duration - 2) else { return }
        seekExactly(to: target)
    }

    func togglePlayPause() {
        if isPlaying {
            player.pause()
            isPlaying = false
            journal("Pause")
            updateNowPlayingInfo()
            notifyNowPlayingChanged()
            return
        }
        startPlaybackResiliently()
    }

    private func activateSession() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    /// Startet die Wiedergabe und prueft kurz darauf nach, ob sie tatsaechlich laeuft.
    ///
    /// Hintergrund: ein blosses player.play() kann folgenlos bleiben - Item nie fertig
    /// geladen, Ladefehler, oder der Player steht am Songende. Statt nur die bekannten
    /// Ursachen einzeln abzufangen, wird hier das ERGEBNIS geprueft: laeuft eine Sekunde
    /// spaeter immer noch nichts, wird der Song frisch aufgesetzt und an derselben Stelle
    /// fortgesetzt. Das deckt auch Ursachen ab, die hier nicht einzeln vorhergesehen sind.
    private func startPlaybackResiliently() {
        guard currentItem != nil else { return }
        activateSession()
        // Gar kein Item oder eines mit Ladefehler: direkt neu aufsetzen, play() waere zwecklos.
        if player.currentItem == nil || player.currentItem?.status == .failed {
            journal("Play: kein brauchbares Item -> harter Start")
            playCurrent()
            return
        }
        applyPendingSeek()
        player.play()
        isPlaying = true
        journal("Play")
        updateNowPlayingInfo()
        notifyNowPlayingChanged()

        let token = playbackToken
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard let self, token == self.playbackToken, self.isPlaying,
                  self.player.timeControlStatus == .paused else { return }
            // An derselben Stelle weitermachen, nicht von vorn - der Neuaufbau soll nicht
            // wie ein Zuruecksetzen wirken.
            let resumeAt = self.safeSeconds(self.player.currentTime())
            self.pendingSeekSeconds = resumeAt > 3 ? resumeAt : nil
            self.journal("Play ohne Wirkung -> Song neu aufgesetzt bei \(Int(resumeAt)) s")
            self.playCurrent()
        }
    }

    /// Reaktion auf AVPlayerItemPlaybackStalled. Nutzt bewusst dieselbe Absicherung wie der
    /// Play-Knopf nach Kaltstart statt einer eigenen.
    private func handlePlaybackStall(for item: QueueItem) {
        guard currentItem?.id == item.id, isPlaying else { return }
        journal("Puffer leer bei \"\(item.title)\"")
        startPlaybackResiliently()
    }

    // MARK: - Zustand des Players mit der Wirklichkeit abgleichen

    private func observePlayer() {
        currentItemObservation = player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in self?.currentItemDidChange() }
        }
        timeControlObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in self?.timeControlDidChange() }
        }
    }

    /// Pausiert der Player OHNE unseren Befehl (Siri, Wecker, Anruf, andere App, Kopfhoerer ab),
    /// zeigte die App weiter "spielt": Sperrbildschirm mit Pause-Symbol und laufender Zeit, die
    /// Tasten daneben - nichts passte mehr zusammen. Kurz entprellt, damit das kurze "paused"
    /// beim Neuaufsetzen eines Songs keinen Fehlalarm ausloest.
    private func timeControlDidChange() {
        guard isPlaying, player.timeControlStatus == .paused, player.currentItem != nil else { return }
        let token = playbackToken
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let self, token == self.playbackToken, self.isPlaying,
                  self.player.timeControlStatus == .paused,
                  let item = self.player.currentItem, item.status == .readyToPlay,
                  self.seeksInFlight == 0 else { return }
            self.journal("Player pausiert ohne Befehl -> Zustand angeglichen")
            self.isPlaying = false
            self.updateNowPlayingInfo()
            self.notifyNowPlayingChanged()
        }
    }

    private func observeAudioSession() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
            Task { @MainActor [weak self] in self?.handleInterruption(typeRaw: typeRaw, optionsRaw: optionsRaw) }
        }
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            Task { @MainActor [weak self] in self?.handleRouteChange(reasonRaw: reasonRaw) }
        }
    }

    private func handleInterruption(typeRaw: UInt?, optionsRaw: UInt?) {
        guard let typeRaw, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            wasPlayingBeforeInterruption = isPlaying
            journal("Unterbrechung begonnen (spielte: \(isPlaying))")
            if isPlaying {
                isPlaying = false
                updateNowPlayingInfo()
                notifyNowPlayingChanged()
            }
        case .ended:
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw ?? 0)
            journal("Unterbrechung beendet (Fortsetzen empfohlen: \(options.contains(.shouldResume)))")
            if wasPlayingBeforeInterruption, options.contains(.shouldResume) {
                wasPlayingBeforeInterruption = false
                startPlaybackResiliently()
            }
        @unknown default:
            break
        }
    }

    /// Kopfhoerer/Bluetooth getrennt: Wiedergabe anhalten, nicht ploetzlich ueber den Lautsprecher
    /// weiterspielen (Apple-Vorgabe fuer Musik-Apps).
    private func handleRouteChange(reasonRaw: UInt?) {
        guard let reasonRaw, let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw),
              reason == .oldDeviceUnavailable, isPlaying else { return }
        journal("Ausgabegeraet getrennt -> Pause")
        player.pause()
        isPlaying = false
        updateNowPlayingInfo()
        notifyNowPlayingChanged()
    }

    // MARK: - Defekte Songs

    /// Ein Song laesst sich nicht abspielen. Zwei Stufen, bewusst in dieser Reihenfolge:
    ///
    /// 1. Lag eine lokale Kopie vor, ist oft SIE das Problem und nicht der Song (abgebrochener
    ///    Download, Fehlerseite als Audiodatei abgelegt). Dann wird derselbe Song noch einmal
    ///    versucht, diesmal ueber die Netzadresse.
    ///
    ///    **Die lokale Datei wird dabei ausdruecklich NICHT geloescht.** Geloescht wird erst, wenn
    ///    der Versuch ueber das Netz BEWEIST, dass es ohne die Kopie geht (siehe
    ///    trackBecameReady). Ohne Netz wird dieser Versuch gar nicht erst unternommen.
    /// 2. Scheitert auch das, ist der Song wirklich defekt oder die Quelle nicht erreichbar:
    ///    melden (die Seite zeigt es, falls jemand hinschaut) und weiterspringen.
    private func handlePlaybackFailure(for item: QueueItem, reason: String) {
        // Verspaetete Fehlermeldung zu einem Song, der laengst nicht mehr dran ist: ignorieren,
        // sonst wirft ein alter Fehler die inzwischen laufende Wiedergabe weiter.
        guard currentItem?.id == item.id else { return }
        journal("Fehler bei \"\(item.title)\": \(reason)")

        if retriedFromRemoteId != item.id, item.fileURL != nil, hasNetwork {
            retriedFromRemoteId = item.id
            Task { @MainActor [weak self] in
                let hasLocalCopy = await AudioFileCache.shared.hasCachedFile(forId: item.id)
                guard let self, self.currentItem?.id == item.id else { return }
                if hasLocalCopy {
                    // Lokale Kopie war das Problem - einmal ueber die Netzadresse gegenpruefen.
                    self.playCurrent(ignoreLocalCopy: true)
                } else {
                    // Keine lokale Kopie (frischer Import): die Datei ist wahrscheinlich in
                    // Ordnung, nur am CDN-Edge noch kalt. Ein paar kurze erneute Anlaeufe vom
                    // Netz, bevor der Song als defekt gilt und uebersprungen + gesperrt wird.
                    let n = self.remoteRetryCount[item.id, default: 0]
                    if n < Self.maxRemoteRetries {
                        self.remoteRetryCount[item.id] = n + 1
                        self.retriedFromRemoteId = nil   // erlaubt diesem Zweig, erneut zu greifen
                        try? await Task.sleep(nanoseconds: 1_800_000_000)
                        guard self.currentItem?.id == item.id else { return }
                        self.playCurrent()
                    } else {
                        self.reportAndSkip(item, reason: reason)
                    }
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
        // landete dadurch sofort wieder vor ihm und kam nie an den Song davor.
        let step = lastNavigationStep
        var ziel = currentIndex + step

        // Bereits als defekt bekannte Songs gleich mit ueberspringen, statt sie einzeln
        // scheitern zu lassen - jeder Versuch kostet sonst Wartezeit und einen Toast.
        while queue.indices.contains(ziel), failedItemIds.contains(queue[ziel].id) {
            ziel += step
        }

        // Reissleine (siehe consecutiveFailures): lieber sichtbar stehenbleiben als die ganze
        // Warteschlange lautlos durchrasen und am Ende ohne Erklaerung stumm sein.
        let reissleine = hasNetwork ? Self.maxConsecutiveFailuresOnline : Self.maxConsecutiveFailuresOffline
        guard consecutiveFailures < reissleine, queue.indices.contains(ziel) else {
            journal("Reissleine: \(consecutiveFailures) Fehler in Folge -> angehalten")
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
    /// mitten im Lied.
    private func forgetPendingSeek() {
        pendingSeekSeconds = nil
        pendingSeekFraction = nil
    }

    // MARK: - Transport

    /// Naechster Song. Ist der Nachfolger schon vorgeladen (der Normalfall), wechselt der Player
    /// sofort und ohne Neuaufbau - kein Download, kein Warten. Sonst harter Start.
    func next() {
        guard let target = nextPlayableIndex(after: currentIndex) else {
            journal("Weiter: kein Nachfolger vorhanden")
            return
        }
        lastNavigationStep = 1
        forgetPendingSeek()
        if let second = player.items().dropFirst().first,
           let t = tracks[ObjectIdentifier(second)], t.item.id == queue[target].id {
            isPlaying = true
            player.advanceToNextItem()
            // Buchfuehrung SOFORT und synchron, nicht erst ueber den (asynchronen) Beobachter:
            // sonst sieht ein zweiter Tipp direkt danach noch den alten Index und baut denselben
            // Song nochmal auf, statt einen weiterzuspringen.
            advanceBookkeeping(to: t, how: "Skip")
            player.play()
            return
        }
        currentIndex = target
        playCurrent()
    }

    /// "Als Naechstes spielen" aus dem Rechts-Swipe der Songliste. Bewusst EINFUEGEN statt
    /// die Warteschlange zu ersetzen: alles dahinter bleibt in seiner Reihenfolge stehen,
    /// sodass nach diesem Song die urspruengliche Playlist/der Mix normal weiterlaeuft.
    /// Laeuft gerade nichts, wird der Song bereitgestellt, aber nicht gestartet.
    func insertNext(_ item: QueueItem) {
        guard item.fileURL != nil else { return }
        if queue.isEmpty {
            // Nichts in der Warteschlange: Song bereitstellen, aber NICHT losspielen -
            // der Nutzer wollte einreihen, nicht starten. Mini-Leiste und Control Center
            // zeigen ihn danach, ein Tipp auf Play startet ihn.
            queue = [item]
            currentIndex = 0
            playbackToken += 1
            let token = playbackToken
            persistQueueSoon()
            Task { await beginPlayback(item, token: token, autoplay: false) }
            return
        }
        let insertAt = min(currentIndex + 1, queue.count)
        queue.insert(item, at: insertAt)
        notifyQueueChanged() // sonst zeigt die Warteschlangen-Ansicht den Song erst nach dem naechsten Songwechsel
        persistQueueSoon()
        persistPosition()
        prepareNext()
        Task { await AudioFileCache.shared.ensureCachedUrgent(item: item) }
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
    /// ausgenommen - ihn zu entfernen waere ein Stopp, kein Entfernen.
    func removeAt(_ index: Int) {
        guard queue.indices.contains(index), index != currentIndex else { return }
        queue.remove(at: index)
        if index < currentIndex { currentIndex -= 1 }
        notifyQueueChanged()
        persistQueueSoon()
        persistPosition()
        prepareNext()
    }

    /// Umsortieren per Drag in der Warteschlangen-Ansicht - nur der "Als naechstes"-Teil ist
    /// dort ueberhaupt anfassbar, daher reicht die einfache Absicherung "from muss danach
    /// liegen". "to" ist wie bei Array.splice() gemeint: die Zielposition im SCHON VERKUERZTEN
    /// Array nach dem Entfernen.
    func moveItem(from: Int, to: Int) {
        guard queue.indices.contains(from), from > currentIndex else { return }
        let item = queue.remove(at: from)
        let clampedTo = min(max(to, currentIndex + 1), queue.count)
        queue.insert(item, at: clampedTo)
        notifyQueueChanged()
        persistQueueSoon()
        prepareNext()
    }

    /// Shuffle-Knopf im grossen Web-Player: mischt nur den "als naechstes"-Teil, laufender
    /// Song und Verlauf bleiben stehen.
    func shuffleRemaining() {
        guard currentIndex + 1 < queue.count else { return }
        let remaining = Array(queue[(currentIndex + 1)...]).shuffled()
        queue.replaceSubrange((currentIndex + 1)..., with: remaining)
        notifyQueueChanged()
        persistQueueSoon()
        prefetchUpcoming()
        prepareNext()
    }

    /// Kurzer Tick beim Einreihen per Swipe. iOS gibt Web-Apps keine Vibrations-API, die
    /// Seite kann das also nicht selbst - sie schickt {cmd:"haptic"} und wir loesen es nativ aus.
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
        if safeSeconds(player.currentTime()) > 3 || currentIndex == 0 {
            seekExactly(to: 0)
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
            seekExactly(to: 0)
            return
        }
        lastNavigationStep = -1
        forgetPendingSeek()
        currentIndex -= 1
        playCurrent()
    }

    // MARK: - Positionssprung

    /// Sprung auf einen ANTEIL der Songdauer (Zeitleiste der Seite). Der Player rechnet selbst
    /// mit effectiveDuration() - der Dauer, die er auch anzeigt. Steht sie noch nicht fest,
    /// wird der Anteil vorgemerkt und nachgeholt (applyPendingSeek). Die Seite muss dafuer
    /// nichts mehr wissen - frueher rechnete sie mit einer eigenen, oft falschen Dauer.
    func seek(toFraction fraction: Double) {
        let f = max(0, min(1, fraction.isFinite ? fraction : 0))
        guard let track = currentTrack, track.playerItem.status == .readyToPlay,
              let duration = effectiveDuration() else {
            pendingSeekFraction = f
            pendingSeekFractionAt = Date()
            pendingSeekSeconds = nil
            journal("Sprung vorgemerkt: \(Int(f * 100)) % (Dauer/Item noch nicht bereit)")
            return
        }
        seek(toSeconds: f * duration)
    }

    /// Absoluter Positionssprung (Control Center, Langdruck, aeltere Seite).
    ///
    /// Frueher "teilweise nicht angenommen" aus mehreren Gruenden, alle behoben: ganze Sekunden
    /// als Zeitbasis (jetzt 600), Toleranz (jetzt .zero), Item noch nicht bereit (jetzt
    /// vorgemerkt), Ziel hinter dem Dateiende (jetzt begrenzt) - und seit 2026-10-21: der Sprung
    /// prueft, WO er gelandet ist, und wiederholt sich einmal mit Toleranz (seekExactly).
    func seek(toSeconds seconds: Double) {
        guard let track = currentTrack, track.playerItem.status == .readyToPlay else {
            pendingSeekSeconds = max(0, seconds)
            pendingSeekFraction = nil
            return
        }

        // GEGEN DAS SONGENDE BEGRENZEN. Ohne diese Grenze hatte ein Sprung hinter das
        // Dateiende eine drastische Nebenwirkung: AVPlayer landet am Ende, feuert
        // AVPlayerItemDidPlayToEndTime und schaltet zum NAECHSTEN SONG - ein Tipp auf die
        // Zeitleiste sah aus wie ein Weiterschalten. Begrenzt wird gegen die Dauer, die der
        // Player SELBST kennt (nicht gegen eine Datenbankangabe, die laenger sein kann als die Datei).
        let limit = playerDuration > 0 ? playerDuration : (effectiveDuration() ?? 0)
        let upper = limit > 1 ? limit - 0.5 : seconds
        let target = max(0, min(seconds, upper))

        // Streams springen ungenau (keine praezise Zeitbasis). Liegt inzwischen eine lokale Kopie
        // vor, wird erst darauf umgestellt und dann dort gesprungen - genau und mit fester Dauer.
        if track.isRemote {
            let item = track.item
            let token = playbackToken
            Task { @MainActor [weak self] in
                guard let self else { return }
                let local = await AudioFileCache.shared.localFileURL(forId: item.id)
                guard token == self.playbackToken, self.currentItem?.id == item.id else { return }
                if local != nil {
                    self.journal("Sprung: lokale Kopie vorhanden -> von Stream auf Datei umgestellt")
                    self.pendingSeekSeconds = target
                    // autoplay: nur weiterspielen, wenn vorher auch etwas lief - ein Sprung in
                    // der Pause darf die Wiedergabe nicht starten.
                    self.playCurrent(autoplay: self.isPlaying)
                } else {
                    self.seekExactly(to: target)
                }
            }
            return
        }
        seekExactly(to: target)
    }

    /// Springt und PRUEFT das Ergebnis. Vorher wurde der Abschluss-Handler nur zum Aufraeumen
    /// genutzt: ein Sprung, der nicht (oder woanders) landete, fiel niemandem auf - die Anzeige
    /// zeigte kurz das Ziel und sprang dann auf die tatsaechliche Stelle zurueck ("setzt sich
    /// ein ganzes Stueck zurueck, egal wie oft ich druecke"). Jetzt: weicht die Landung um mehr
    /// als seekToleranceSeconds ab oder schlug der Sprung fehl, wird EINMAL mit Toleranz
    /// wiederholt (der Player waehlt dann die naechste ihm moegliche Stelle), und jeder Sprung
    /// steht im Protokoll - so laesst sich spaeter belegen statt vermuten, was passiert ist.
    private func seekExactly(to seconds: Double, attempt: Int = 0) {
        // Zaehler statt Bool: zieht man schnell mehrfach, ueberlappen sich die Spruenge.
        seeksInFlight += 1
        seekGeneration += 1
        let generation = seekGeneration
        let tolerance: CMTime = (attempt == 0) ? .zero : .positiveInfinity
        let remote = currentTrack?.isRemote == true
        player.seek(
            to: CMTime(seconds: seconds, preferredTimescale: 600),
            toleranceBefore: tolerance,
            toleranceAfter: tolerance
        ) { [weak self] finished in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.seeksInFlight = max(0, self.seeksInFlight - 1)
                let landed = self.safeSeconds(self.player.currentTime())
                let off = abs(landed - seconds)
                self.journal(String(
                    format: "Sprung Ziel %.1f s -> gelandet %.1f s (%@, Abweichung %.1f s, Versuch %d, %@)",
                    seconds, landed, finished ? "ok" : "abgebrochen", off, attempt + 1, remote ? "Stream" : "lokal"
                ))
                // Nur der NEUESTE Sprung wird nachgebessert - ein ueberholter ist absichtlich abgebrochen.
                if generation == self.seekGeneration, attempt == 0,
                   !finished || off > Self.seekToleranceSeconds {
                    self.seekExactly(to: seconds, attempt: 1)
                    return
                }
                self.updateNowPlayingInfo()
                // Die Seite bekommt Fortschritt sonst erst beim naechsten Sekundentakt. Bis
                // dahin ueberschrieb genau dieser Takt die gezogene Position noch einmal mit
                // dem alten Stand.
                self.pushProgress()
            }
        }
    }

    /// Relativer Sprung fuer den Langdruck-Suchlauf der Web-Knoepfe. Auf 0 und Songende
    /// begrenzt, damit ein langer Druck nicht ueber das Ende hinausschiebt.
    func seek(byDelta delta: Double) {
        let ziel = safeSeconds(player.currentTime()) + delta
        let limit = playerDuration > 0 ? playerDuration : (effectiveDuration() ?? 0)
        let obergrenze = limit > 1 ? limit - 0.5 : ziel
        seek(toSeconds: max(0, min(ziel, obergrenze)))
    }

    private func pushProgress() {
        guard isWebOverlayVisible else { return }
        onProgressChanged?(safeSeconds(player.currentTime()), effectiveDuration() ?? 0)
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

    /// Alle Handler springen EXPLIZIT auf den Main-Thread und melden sofort Erfolg. Von welchem
    /// Thread MediaPlayer sie ruft, ist nicht zugesichert; vorher fassten sie PlayerViewModel-
    /// Zustand ohne Absicherung an. Jeder Befehl steht im Protokoll - so ist belegbar, ob eine
    /// Taste auf dem Sperrbildschirm ueberhaupt in der App ankam.
    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        // Ausdruecklich setzen statt auf Standardwerte zu bauen.
        [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
         center.nextTrackCommand, center.previousTrackCommand, center.changePlaybackPositionCommand]
            .forEach { $0.isEnabled = true }
        // Diese ersetzten auf dem Sperrbildschirm die Titel-Tasten durch +/-15 s.
        [center.skipForwardCommand, center.skipBackwardCommand,
         center.seekForwardCommand, center.seekBackwardCommand]
            .forEach { $0.isEnabled = false }

        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.journal("Fernbedienung: Play")
                self?.startPlaybackResiliently()
            }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.journal("Fernbedienung: Pause")
                self.player.pause()
                self.isPlaying = false
                self.updateNowPlayingInfo()
                self.notifyNowPlayingChanged()
            }
            return .success
        }
        // Kopfhoerer-/Sperrbildschirm-Toggle: lief bisher nicht ueber unsere Logik und konnte
        // dadurch play() ungeprueft absetzen.
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.journal("Fernbedienung: Play/Pause")
                self?.togglePlayPause()
            }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.journal("Fernbedienung: Weiter")
                self?.next()
            }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.journal("Fernbedienung: Zurueck")
                self?.previous()
            }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let position = event.positionTime
            Task { @MainActor [weak self] in
                self?.journal(String(format: "Fernbedienung: Sprung auf %.1f s", position))
                self?.seek(toSeconds: position)
            }
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
            // Position (drei Zahlen) hoechstens alle 10 s sichern - die Warteschlange selbst
            // wird hier NICHT mehr angefasst (siehe persistQueueSoon).
            if self.isPlaying, Date().timeIntervalSince(self.lastPositionSaveAt) > 10 {
                self.persistPosition()
            }
            guard self.isWebOverlayVisible else { return }
            // WAEHREND EINES LAUFENDEN SPRUNGS NICHTS MELDEN. player.currentTime() liefert bis
            // zum Abschluss des Sprungs weiterhin die ALTE Stelle. Dieser Takt hat sie
            // ungefiltert an die Seite geschickt und damit die gerade gezogene Position wieder
            // ueberschrieben. Der Abschluss-Handler in seekExactly() meldet die Zielstelle
            // ohnehin, sobald sie wirklich erreicht ist.
            guard self.seeksInFlight == 0 else { return }
            self.pushProgress()
        }
    }

    // MARK: - Control Center / Lock Screen

    /// Pflegt den Sperrbildschirm. Wird bei jedem relevanten Ereignis gerufen (Songwechsel,
    /// Play/Pause, Dauer bekannt, Sprung fertig) UND im Sekundentakt - der Sperrbildschirm
    /// rechnet zwischen zwei Aktualisierungen selbst weiter, aber nur, wenn Dauer, Position und
    /// Rate vollstaendig geliefert wurden. Fehlt die Dauer, zeigt er "-:--" und die Leiste
    /// bleibt leer (das gemeldete Bild).
    private func updateNowPlayingInfo() {
        let center = MPNowPlayingInfoCenter.default()
        guard let item = currentItem else {
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }

        let duration = effectiveDuration()
        var elapsed = safeSeconds(player.currentTime())
        if let duration { elapsed = min(elapsed, duration) }

        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.artist,
            MPMediaItemPropertyAlbumTitle: "Himusic Cloud",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let duration { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if let artwork = currentArtwork, currentArtworkItemId == item.id {
            info[MPMediaItemPropertyArtwork] = artwork
        } else {
            // Kein Cover zur Hand: nachladen anstossen statt das Feld einfach wegzulassen.
            // Diese Methode laeuft jede Sekunde; ohne den Anstoss blieb der Sperrbildschirm
            // dauerhaft ohne Cover, sobald es einmal fehlte.
            loadArtworkIfNeeded(for: item)
        }
        center.nowPlayingInfo = info
        center.playbackState = isPlaying ? .playing : .paused
    }

    /// Die Seite liefert ein eingebettetes Cover (data:-URI) nach. Die Warteschlange traegt
    /// solche Cover nur fuer die ersten Songs mit (sonst waeren es ~12 MB pro Handoff).
    private func applyCover(forId id: Int, cover: String) {
        guard cover.hasPrefix("data:image/"), cover.count <= 400_000 else { return }
        var changed = false
        queue = queue.map { (item: QueueItem) -> QueueItem in
            guard item.id == id, (item.c ?? "").isEmpty else { return item }
            changed = true
            return item.withCover(cover)
        }
        guard changed, let current = currentItem, current.id == id else { return }
        artworkFailedForId = nil
        loadArtworkIfNeeded(for: current)
    }

    /// Hebt die Aufloesung von iTunes-Cover-Adressen an. Die Bibliothek speichert sie als
    /// ".../600x600bb.jpg" - die Groesse steht im Pfad und laesst sich einfach austauschen. Fuer
    /// die kleine Mini-Leiste reichten 600px; seit iOS den Sperrbildschirm gross und flaechig
    /// zeichnet, ist das sichtbar unscharf. Andere Adressen bleiben unveraendert.
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
                // das Cover darstellen darf.
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
        // Selbst hochgeladene Cover kommen als data:-URI herein. URLSession kann dieses Schema
        // NICHT laden - Data(contentsOf:) dekodiert sie direkt, ohne Netzzugriff.
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

    // MARK: - Protokoll

    /// Kopfzeile + Ereignisprotokoll fuer Einstellungen -> Wiedergabe-Diagnose.
    private func journalReport() -> String {
        let duration = effectiveDuration().map { String(format: "%.1f s", $0) } ?? "unbekannt"
        let source = currentTrack.map { $0.isRemote ? "Stream" : "lokal" } ?? "-"
        let header = """
        Huelle \(HimusicBuild.id)
        Warteschlange \(queue.count) Songs, Index \(currentIndex), spielt: \(isPlaying ? "ja" : "nein")
        Laufender Song: \(currentItem?.title ?? "-") [\(source)], Dauer \(duration)
        Netz: \(hasNetwork ? "da" : "weg"), Nachfolger vorgeladen: \(player.items().count > 1 ? "ja" : "nein")
        ----
        """
        return header + "\n" + PlaybackJournal.shared.text
    }
}
