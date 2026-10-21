import Foundation
import AVFoundation
import UIKit

/// Kennung der nativen Huelle. Steht in Einstellungen -> Wiedergabe-Diagnose, damit sofort
/// sichtbar ist, WELCHE Fassung auf dem Geraet laeuft. Das war bisher die haeufigste Quelle
/// fuer Verwirrung: "ist die neue IPA ueberhaupt installiert?" liess sich nur raten.
/// Bei jeder Aenderung unter native-player/ hochzaehlen.
enum HimusicBuild {
    static let id = "2026-10-21.3"

    /// Einziger Host, von dem die Huelle Audio laedt oder streamt (alle 2188 Songs der Bibliothek
    /// liegen dort, gemessen 2026-10-21). Bis dahin konnte die Seite - oder ein fremder Frame, der
    /// die Bruecke erreicht - der Huelle JEDE https-Adresse zum Laden geben (cacheBackground,
    /// ensureCached, Stream). himusicHttp hat so eine Allowlist schon; fuer Audio fehlte sie.
    /// Aendert sich der Host (eigene Domain), muss er hier nachgezogen werden - Songs mit anderem
    /// Host gelten sonst als "keine abspielbare Datei hinterlegt" und stehen im Protokoll.
    static let mediaHost = "himusic-api.tyron-app.workers.dev"

    static func isAllowedMediaURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == mediaHost
    }

    /// Faehigkeiten, die diese Huelle der Seite meldet (window.__himusicNativeCaps). Die Seite
    /// nutzt neue Bridge-Befehle nur, wenn die Huelle sie kennt - so bleibt eine noch nicht
    /// aktualisierte Huelle mit der neuen Seite kompatibel (die Seite wird ueber GitHub Pages
    /// sofort ausgeliefert, die Huelle erst nach Neuinstallation).
    static let capabilities = [
        "queuePlayer",      // vorgeladener Nachfolger, Wechsel synchron verbucht: schnelle Doppeltipps sicher
        "seekFraction",     // seekTo mit "fraction" - die Huelle rechnet mit ihrer eigenen Dauer
        "journal",          // Ereignisprotokoll abrufbar (cmd "journal")
        "keyboard",         // _applyNativeKeyboard
        "cachedIds",        // _applyNativeCachedIds
        "cacheBackground",  // Bibliothek als Ganzes im Leerlauf nachladen
        "setCover",         // eingebettetes Cover nachliefern
    ]
}

/// Ereignisprotokoll der Wiedergabe - dauerhaft auf Platte, nicht nur im Speicher.
///
/// Warum es das braucht: die Fehler dieser App treten genau dann auf, wenn niemand hinschaut
/// (Bildschirm gesperrt, App im Hintergrund, Webseite eingefroren). Die Seite kann dann nichts
/// mitschreiben, und beim naechsten Oeffnen bleibt nur die Vermutung. Das native Protokoll
/// laeuft auch im Hintergrund weiter und ueberlebt einen Neustart - der Nutzer kann es in den
/// Einstellungen ansehen und kopieren, statt dass wieder geraten werden muss.
@MainActor
final class PlaybackJournal {
    static let shared = PlaybackJournal()

    private static let maxLines = 400
    /// Waehrend einer langen Sitzung waechst die Datei; ab dieser Zeilenzahl wird sie auf die
    /// letzten maxLines gekuerzt (nicht nur beim App-Start).
    private static let rewriteThreshold = 1500
    private var lines: [String] = []
    private var linesInFile = 0
    private let fileURL: URL
    private var handle: FileHandle?
    private let formatter: DateFormatter

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        fileURL = base.appendingPathComponent("PlaybackJournal.log")
        formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.dateFormat = "dd.MM. HH:mm:ss.SSS"

        if let text = try? String(contentsOf: fileURL, encoding: .utf8) {
            lines = Array(
                text.split(separator: "\n", omittingEmptySubsequences: true)
                    .map(String.init)
                    .suffix(Self.maxLines)
            )
        }
        rewriteFile()
    }

    /// Schreibt die Datei neu auf die letzten maxLines und oeffnet das Schreib-Handle erneut.
    /// Aus dem iCloud-Backup ausgenommen: das Protokoll sagt, wann welcher Song lief - das gehoert
    /// aufs Geraet, nicht in ein Backup (wie der Audio-Cache, siehe AudioFileCache).
    private func rewriteFile() {
        try? handle?.close()
        lines = Array(lines.suffix(Self.maxLines))
        let content = lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
        try? content.write(to: fileURL, atomically: true, encoding: .utf8)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = fileURL
        try? excluded.setResourceValues(values)
        linesInFile = lines.count
        handle = try? FileHandle(forWritingTo: fileURL)
        _ = try? handle?.seekToEnd()
    }

    /// Von ueberall aufrufbar (auch aus dem Cache-Actor). Der Zeitstempel wird SOFORT
    /// genommen, nicht erst nach dem Wechsel auf den Main-Thread - sonst stuende bei
    /// dichter Ereignisfolge die falsche Reihenfolge im Protokoll.
    nonisolated static func note(_ message: String) {
        let now = Date()
        Task { @MainActor in shared.log(message, at: now) }
    }

    func log(_ message: String, at date: Date = Date()) {
        let line = "\(formatter.string(from: date))  \(message)"
        lines.append(line)
        if lines.count > Self.maxLines * 2 { lines.removeFirst(lines.count - Self.maxLines) }
        // Sofort schreiben: im Hintergrund kann der Prozess jederzeit eingefroren werden, ein
        // "spaeter gesammelt schreiben" ginge dann genau im interessanten Moment verloren.
        if let data = (line + "\n").data(using: .utf8) {
            try? handle?.write(contentsOf: data)
        }
        linesInFile += 1
        if linesInFile > Self.rewriteThreshold { rewriteFile() }
    }

    var text: String { lines.suffix(Self.maxLines).joined(separator: "\n") }

    func clear() {
        lines.removeAll()
        try? handle?.truncate(atOffset: 0)
        _ = try? handle?.seekToEnd()
        linesInFile = 0
    }
}

/// Ein abspielbarer Titel samt seinen Beobachtern. Bewusst eine eigene Klasse statt loser
/// Observer-Variablen im PlayerViewModel: mit einer AVQueuePlayer-Warteschlange existieren zwei
/// Titel gleichzeitig (der laufende und der vorgeladene Nachfolger), jeder braucht seine eigenen
/// Beobachter, und beim Ausscheiden muessen genau diese wieder abgehaengt werden.
///
/// Nur vom Main-Thread aus anfassen (das PlayerViewModel ist @MainActor). Beobachter werden
/// ausdruecklich ueber stopObserving() abgehaengt, nicht ueber deinit.
final class Track {
    let item: QueueItem
    let playerItem: AVPlayerItem
    /// true = ueber das Netz gestreamt (keine lokale Kopie). Streams haben keine verlaessliche
    /// Dauer und kein sample-genaues Seeking - alles Folgende in der Wiedergabe richtet sich danach.
    let isRemote: Bool
    let source: String

    /// Wurde dieser Titel schon als "laufender" verbucht (Index, Anzeige, Lockscreen)? Bei
    /// einem Wechsel, den die Warteschlange selbst ausloest, erkennt das PlayerViewModel daran,
    /// dass die Buchfuehrung noch aussteht.
    var consumed = false
    var readyHandled = false
    var endHandled = false

    private var statusObservation: NSKeyValueObservation?
    private var durationObservation: NSKeyValueObservation?
    private var tokens: [NSObjectProtocol] = []

    init(item: QueueItem, playerItem: AVPlayerItem, isRemote: Bool, source: String) {
        self.item = item
        self.playerItem = playerItem
        self.isRemote = isRemote
        self.source = source
    }

    func observe(
        onStatus: @escaping (Track) -> Void,
        onDuration: @escaping (Track) -> Void,
        onFail: @escaping (Track, String) -> Void,
        onEnd: @escaping (Track) -> Void,
        onStall: @escaping (Track) -> Void
    ) {
        statusObservation = playerItem.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
            guard let self else { return }
            onStatus(self)
        }
        // Die Dauer steht bei Streams oft erst NACH .readyToPlay fest. Ohne diesen Beobachter
        // blieb der Sperrbildschirm bei "-:--", weil er nur einmal (ohne Dauer) befuellt wurde.
        durationObservation = playerItem.observe(\.duration, options: [.new]) { [weak self] _, _ in
            guard let self else { return }
            onDuration(self)
        }
        let nc = NotificationCenter.default
        tokens.append(nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: playerItem, queue: .main) { [weak self] _ in
            guard let self else { return }
            onEnd(self)
        })
        // Abbruch MITTEN im Song (Datei bricht ab, Verbindung stirbt). Eigenes Ereignis:
        // .status bleibt dabei .readyToPlay.
        tokens.append(nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: playerItem, queue: .main) { [weak self] note in
            guard let self else { return }
            let reason = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?
                .localizedDescription ?? "Wiedergabe abgebrochen"
            onFail(self, reason)
        })
        // Puffer leergelaufen (typisch beim Wechsel WLAN <-> Mobilfunk).
        tokens.append(nc.addObserver(forName: .AVPlayerItemPlaybackStalled, object: playerItem, queue: .main) { [weak self] _ in
            guard let self else { return }
            onStall(self)
        })
    }

    func stopObserving() {
        statusObservation?.invalidate()
        statusObservation = nil
        durationObservation?.invalidate()
        durationObservation = nil
        tokens.forEach { NotificationCenter.default.removeObserver($0) }
        tokens.removeAll()
    }
}

/// Meldet, ob die Bildschirmtastatur sichtbar ist. Zwei Abnehmer: die native Mini-Leiste
/// blendet sich dann aus (sie rutschte sonst mit der Tastatur nach oben und verdeckte die
/// Suchergebnisse), und die Seite bekommt es als Klasse "kb-open" (Navigation weg, mehr Platz).
@MainActor
final class KeyboardObserver: ObservableObject {
    @Published private(set) var isVisible = false
    var onChange: ((Bool) -> Void)?
    private var tokens: [NSObjectProtocol] = []

    init() {
        let nc = NotificationCenter.default
        tokens.append(nc.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.set(true) }
        })
        tokens.append(nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.set(false) }
        })
    }

    private func set(_ visible: Bool) {
        guard visible != isVisible else { return }
        isVisible = visible
        onChange?(visible)
    }
}

/// Haelt die App am Leben, solange ein asynchroner Wechsel laeuft. Hintergrund: am Titelende bei
/// gesperrtem Bildschirm schweigt der Ton kurz, und iOS kann den Prozess in genau dieser Luecke
/// einfrieren - der Nachfolger startete dann erst, wenn man die App wieder oeffnete. Eine
/// Hintergrundaufgabe gibt der App in dieser Zeit ausdruecklich Rechenzeit.
@MainActor
final class BackgroundAssertion {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(_ name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
