import Foundation
import AVFoundation

/// Persistenter Datei-Cache fuer Audiodateien, damit AVPlayer offline aus dem lokalen
/// Dateisystem liest statt zu streamen - erst das erlaubt echte Hintergrund-Wiedergabe
/// ohne Netz (ADR-007, "Schritt 3"). Downloads brauchen keinen API-Key: /media/* ist
/// auf dem Worker unauthentifiziert, gleiches Verhalten wie downloadToLocal() in app2.js.
///
/// ZWEI PRIORITAETSKLASSEN (ADR-015). Bis 2026-10-21 gab es genau eine FIFO-Warteschlange mit
/// einer Spur. Gefuellt wurde sie von drei Seiten: dem Vorlade-Fenster um die aktuelle
/// Position (15 Songs), dem Wiederherstellen der letzten Sitzung (die KOMPLETTE gespeicherte
/// Warteschlange, bis ueber 2000 Songs) und der Seite, die fuer JEDEN Song der Bibliothek
/// einen Eintrag nachschob. Bei 12,3 GB Bibliothek und 8 GB Obergrenze lud das Auffuellen
/// dazu endlos: neue Downloads verdraengten per LRU aeltere, die beim naechsten App-Start
/// wieder eingereiht wurden. Folge: die naechsten Songs standen stundenlang HINTER Altlasten,
/// ein Skip landete fast immer auf einem nicht gecachten Song, der dann gestreamt wurde -
/// und ein Stream hat weder verlaessliche Dauer noch genaues Seeking, braucht Netz und
/// startet langsamer. Das war die gemeinsame Wurzel mehrerer gemeldeter Fehler.
///
///  - dringend: laufender Song + Vorlade-Fenster. Immer zuerst, bis zu 2 parallel, ersetzt bei
///    jedem Songwechsel den alten Stand (veraltete Eintraege entfallen).
///  - Auffuellen: der Rest der Bibliothek. Nur wenn nichts Dringendes ansteht, 1 parallel, und
///    NUR unterhalb von backgroundFillCeiling - es verdraengt nie etwas.
actor AudioFileCache {
    static let shared = AudioFileCache()

    /// Weiche Obergrenze, wird nach jedem abgeschlossenen Download durchgesetzt.
    /// Der aktuell gespielte Song ist von der Verdraengung ausgenommen, sonst fliegt
    /// der am laengsten nicht gespielte Song zuerst raus (LRU).
    private let capBytes: Int64 = 8 * 1_073_741_824  // 8 GB

    /// Ab hier hoert das Auffuellen im Leerlauf auf. Bewusst 1 GB unter der Obergrenze: dringende
    /// Downloads (Songs, die man gerade hoert) sollen Platz finden, ohne jedes Mal etwas zu
    /// verdraengen.
    private let backgroundFillCeiling: Int64 = 7 * 1_073_741_824  // 7 GB

    private struct Entry: Codable {
        let id: Int
        var ext: String
        var sizeBytes: Int64
        var lastAccessed: Date
        /// Gemessene Dauer der LOKALEN Datei in Sekunden (sample-genau, mit praeziser Zeitbasis
        /// gelesen). Optional, damit ein aelterer Index ohne dieses Feld weiter lesbar ist.
        var duration: Double?
        /// Dateiname der Netzadresse, von der diese Kopie stammt (Herkunftsnachweis). Der Index ist
        /// nach `id` geordnet - ohne diesen Nachweis lieferte er unter einer id JEDE Datei, die dort
        /// liegt, auch eine alte oder fremde (id wiederverwendet, Datei des Songs ausgetauscht). Die
        /// PWA spielt immer nach Adresse und kennt den Fehler nicht. nil = Eintrag aus einer Fassung
        /// vor dem Nachweis: gilt als unbestaetigt (siehe localFileURL(for:)).
        var src: String?
    }

    /// Herkunftsnachweis einer Adresse: der Dateiname (im Medien-Host eindeutig, enthaelt Zeitstempel).
    private static func sourceName(of item: QueueItem) -> String? {
        item.fileURL?.lastPathComponent
    }

    private let cacheDir: URL
    private let indexURL: URL
    private var index: [Int: Entry] = [:]
    private var indexDirty = false

    private var urgentQueue: [QueueItem] = []
    private var backgroundQueue: [QueueItem] = []
    private var activeUrgent: Set<Int> = []
    /// Laufende dringende Downloads, damit veraltete abgebrochen werden koennen (setUpcoming). Ohne
    /// das belegten nach einigen schnellen Skips zwei Downloads von Songs, die laengst nicht mehr
    /// dran waren (bis zu 3 Versuche je 25/90 s), beide Spuren - der laufende und der naechste Song
    /// warteten und wurden gestreamt.
    private var urgentTasks: [Int: Task<Void, Never>] = [:]
    private var activeBackground: Int?
    /// Laufender Auffuell-Download, damit er abgebrochen werden kann, sobald der Vordergrund Bandbreite braucht.
    private var backgroundTask: Task<Void, Never>?
    /// Letzter Moment, in dem der Vordergrund (Tipp, laufender/naechster Song ohne Kopie) etwas laden musste.
    private var lastForegroundActivity = Date.distantPast
    private var backgroundResumeScheduled = false
    /// So lange nach der letzten Vordergrund-Arbeit bleibt das Auffuellen still. "Leerlauf" hiess vorher nur
    /// "gerade ist keine dringende Warteschlange da" - ein laufender Bibliotheks-Download teilte sich die
    /// Leitung mit dem Song, den man gerade angetippt hatte (Stream UND dringender Download), und startete
    /// nach jedem Tipp sofort wieder.
    private static let backgroundQuietSeconds: TimeInterval = 30

    /// Der Vordergrund hat Vorrang: den Auffuell-Download abbrechen (er wird spaeter neu aufgenommen)
    /// und die Ruhezeit neu starten.
    private func foregroundNeeded() {
        lastForegroundActivity = Date()
        backgroundTask?.cancel()
    }
    private var inFlightNow: Set<Int> = []   // laeuft gerade ein fetchNow() fuer diese id?
    private var currentlyPlayingId: Int?
    private var loggedCeiling = false
    private static let maxParallelUrgent = 2

    /// Wird nach jedem fertigen Download gerufen (id). Das PlayerViewModel tauscht damit einen
    /// noch gestreamten Nachfolger gegen die lokale Kopie und meldet der Seite den Cache-Stand.
    private var onCached: (@Sendable (Int) -> Void)?

    func setOnCached(_ callback: (@Sendable (Int) -> Void)?) {
        onCached = callback
    }

    /// Eigene Session mit knappen Timeouts: ein haengender Download darf die Wiedergabe nicht
    /// minutenlang blockieren.
    private lazy var dlSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 25
        cfg.timeoutIntervalForResource = 300   // grosse Dateien (mp4 bis ~20 MB) schaffen 90 s im Mobilnetz nicht
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    private init() {
        // BEWUSST "Application Support" und nicht "Caches": iOS raeumt das Caches-Verzeichnis
        // bei Speicherdruck jederzeit selbst leer - ohne Rueckfrage, auch waehrend die App
        // laeuft. Musik, die der Nutzer ausdruecklich offline vorhaelt, ist damit genau dann
        // weg, wenn er sie braucht (unterwegs, kein Netz) - und weil das vom Speicherstand des
        // Geraets abhaengt, wirkte es zufaellig: derselbe Song lief mal, mal nicht. Application
        // Support wird von iOS nicht angetastet, dafuer muss die App selbst aufraeumen -
        // genau das tut enforceCap() ohnehin schon.
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        cacheDir = base.appendingPathComponent("AudioCache", isDirectory: true)
        indexURL = cacheDir.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

        // Ohne dieses Flag wandern bis zu 8 GB Musik ins iCloud-Backup - Apple lehnt genau das
        // ab (jederzeit wiederbeschaffbare Daten), und ein volles Backup faellt dem Nutzer als
        // Erstes auf die Fuesse. Die Dateien selbst bleiben davon unberuehrt.
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mutableDir = cacheDir
        try? mutableDir.setResourceValues(resourceValues)

        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([Int: Entry].self, from: data) {
            index = decoded
        }
        migrateLegacyCachesDirectory()
    }

    /// Holt Dateien aus dem frueheren Ablageort (Caches/AudioCache) einmalig herueber, damit
    /// eine bestehende Installation nach dem Update nicht alles neu laden muss. Was iOS dort
    /// bereits geloescht hat, fehlt schlicht - der Index raeumt sich beim naechsten Zugriff
    /// selbst auf (siehe localFileURL).
    ///
    /// Der alte Index MUSS mit uebernommen werden: ohne ihn laegen die verschobenen Dateien
    /// zwar am neuen Ort, wuerden aber von niemandem mehr gefunden (localFileURL fragt den
    /// Index) und auch nie wieder aufgeraeumt (enforceCap rechnet ebenfalls nur ueber den
    /// Index) - jeder Song waere neu zu laden, und die alten Dateien blieben als tote Last
    /// liegen.
    private func migrateLegacyCachesDirectory() {
        let legacy = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AudioCache", isDirectory: true)
        guard FileManager.default.fileExists(atPath: legacy.path) else { return }

        if index.isEmpty,
           let data = try? Data(contentsOf: legacy.appendingPathComponent("index.json")),
           let decoded = try? JSONDecoder().decode([Int: Entry].self, from: data) {
            index = decoded
        }

        let contents = (try? FileManager.default.contentsOfDirectory(at: legacy, includingPropertiesForKeys: nil)) ?? []
        for source in contents where source.lastPathComponent != "index.json" {
            let dest = cacheDir.appendingPathComponent(source.lastPathComponent)
            guard !FileManager.default.fileExists(atPath: dest.path) else { continue }
            try? FileManager.default.moveItem(at: source, to: dest)
        }
        try? FileManager.default.removeItem(at: legacy)
        saveIndex()
    }

    // MARK: - Abfragen

    /// Nur nachsehen, ob eine lokale Kopie existiert - ohne sie anzufassen und ohne den
    /// Zugriffszeitstempel zu aendern (das tut localFileURL bewusst, hier waere es falsch).
    /// Der Aufrufer entscheidet damit, ob ein zweiter Versuch ueber das Netz Sinn ergibt.
    func hasCachedFile(forId id: Int) -> Bool {
        guard let entry = index[id] else { return false }
        return FileManager.default.fileExists(atPath: fileURL(for: entry).path)
    }

    /// Verwirft die lokale Kopie eines Songs. Gibt zurueck, ob ueberhaupt eine da war.
    ///
    /// Wird **erst** aufgerufen, wenn feststeht, dass die Kopie das Problem war - also nachdem
    /// derselbe Song ueber die Netzadresse nachweislich lief. Frueher zu loeschen hiess, bei
    /// jedem voruebergehenden Fehler eine intakte Offline-Kopie zu vernichten, die sich ohne
    /// Netz nicht wiederbeschaffen liess.
    func discardCachedFile(forId id: Int) -> Bool {
        guard let entry = index[id] else { return false }
        try? FileManager.default.removeItem(at: fileURL(for: entry))
        index.removeValue(forKey: id)
        scheduleIndexSave()
        return true
    }

    private func fileURL(for entry: Entry) -> URL {
        cacheDir.appendingPathComponent("\(entry.id).\(entry.ext)")
    }

    /// Lokale Datei, falls schon gecacht. Aktualisiert den Zugriffszeitstempel (schuetzt den Song
    /// vor Verdraengung, solange er im Rotationsfenster bleibt) - aber hoechstens einmal pro
    /// Minute und ohne sofort den ganzen Index auf Platte zu schreiben. Vorher schrieb JEDER
    /// Aufruf den kompletten Index (2000+ Eintraege) atomar neu, und pro Songwechsel gibt es ueber
    /// ein Dutzend Aufrufe.
    func localFileURL(forId id: Int) -> URL? {
        guard var entry = index[id] else { return nil }
        let url = fileURL(for: entry)
        guard FileManager.default.fileExists(atPath: url.path) else {
            index.removeValue(forKey: id)
            scheduleIndexSave()
            return nil
        }
        if Date().timeIntervalSince(entry.lastAccessed) > 60 {
            entry.lastAccessed = Date()
            index[id] = entry
            scheduleIndexSave()
        }
        return url
    }

    /// Lokale Datei fuer DIESEN Song - aber nur, wenn die Kopie nachweislich von seiner Adresse stammt.
    /// Passt die Herkunft nicht (oder fehlt sie bei einem alten Eintrag), wird die Kopie verworfen und
    /// der Song streamt einmal und laedt dann neu. Kostet hoechstens einen Download pro betroffenem,
    /// tatsaechlich gespieltem Song; die Bibliothek wird dadurch nicht neu geladen.
    ///
    /// `online`: ein alter Eintrag OHNE Herkunft wird nur verworfen, wenn Netz da ist - ohne Netz laesse
    /// er sich nicht neu laden, und eine vermutlich intakte Offline-Kopie waere umsonst weg. Ein Eintrag
    /// MIT Herkunft, die nicht passt, ist dagegen sicher falsch und wird immer verworfen.
    func localFileURL(for item: QueueItem, online: Bool = true) -> URL? {
        guard let entry = index[item.id] else { return nil }
        guard let wanted = Self.sourceName(of: item) else { return localFileURL(forId: item.id) }
        if entry.src == nil, !online { return localFileURL(forId: item.id) }
        if entry.src != wanted {
            PlaybackJournal.note("Cache: Kopie id=\(item.id) gehoert nicht zu dieser Adresse (\(entry.src ?? "ohne Herkunft") statt \(wanted)) -> verworfen")
            try? FileManager.default.removeItem(at: fileURL(for: entry))
            index.removeValue(forKey: item.id)
            scheduleIndexSave()
            return nil
        }
        return localFileURL(forId: item.id)
    }

    /// Gemessene Dauer der lokalen Kopie, falls bekannt.
    func knownDuration(forId id: Int) -> Double? {
        guard let d = index[id]?.duration, d.isFinite, d > 0 else { return nil }
        return d
    }

    /// Haengt eine beim Abspielen gemessene Dauer an einen Eintrag, der noch keine hat (Songs,
    /// die vor dieser Fassung gecacht wurden). Nur fuer LOKALE Wiedergabe sinnvoll - die Dauer
    /// eines Streams kann eine Schaetzung sein.
    func recordDuration(forId id: Int, seconds: Double) {
        guard seconds.isFinite, seconds > 1, var entry = index[id], (entry.duration ?? 0) <= 0 else { return }
        entry.duration = seconds
        index[id] = entry
        scheduleIndexSave()
    }

    func cachedIds() -> [Int] {
        index.keys.sorted()
    }

    private func totalBytes() -> Int64 {
        index.values.reduce(Int64(0)) { $0 + $1.sizeBytes }
    }

    /// Merkt sich, welcher Song gerade laeuft, damit enforceCap() ihn nie loescht -
    /// auch wenn er zufaellig der aelteste Eintrag waere.
    func markCurrentlyPlaying(id: Int?) {
        currentlyPlayingId = id
    }

    // MARK: - Warteschlangen

    private func isBusy(_ id: Int) -> Bool {
        activeUrgent.contains(id) || activeBackground == id || inFlightNow.contains(id)
    }

    private func needsDownload(_ item: QueueItem) -> Bool {
        item.fileURL != nil && index[item.id] == nil && !isBusy(item.id)
    }

    /// Einzelner Song, niedrige Prioritaet (Auffuellen). Ruft die Seite fuer einzelne Songs
    /// (cmd "ensureCached"), ist das kein Grund, ein Vorlade-Fenster zu verdraengen.
    func ensureCached(item: QueueItem) {
        guard needsDownload(item),
              !urgentQueue.contains(where: { $0.id == item.id }),
              !backgroundQueue.contains(where: { $0.id == item.id }) else { return }
        backgroundQueue.append(item)
        pump()
    }

    /// Einzelner Song, hohe Prioritaet und ganz vorn: der Song, der GERADE gestreamt wird - sein
    /// lokale Kopie soll so schnell wie moeglich da sein (genaues Seeking, feste Dauer).
    func ensureCachedUrgent(item: QueueItem) {
        guard needsDownload(item) else { return }
        foregroundNeeded()
        backgroundQueue.removeAll { $0.id == item.id }
        urgentQueue.removeAll { $0.id == item.id }
        urgentQueue.insert(item, at: 0)
        pump()
    }

    /// Ersetzt die dringende Warteschlange durch genau diese Songs (in dieser Reihenfolge):
    /// laufender Song + die naechsten. Alles, was vorher dringend war und nicht mehr dazugehoert,
    /// faellt weg - wer weiterspringt, soll nicht noch die Songs von vorhin laden.
    func setUpcoming(_ items: [QueueItem]) {
        let keep = Set(items.map(\.id))
        // Dringende Downloads, die nicht mehr zum Fenster gehoeren, abbrechen - sie halten sonst eine
        // der zwei Spuren, waehrend der laufende/naechste Song wartet.
        for (id, task) in urgentTasks where !keep.contains(id) { task.cancel() }
        let wanted = items.filter { needsDownload($0) }
        if !wanted.isEmpty { foregroundNeeded() }   // nur wenn der Vordergrund wirklich etwas laden muss
        let ids = Set(wanted.map(\.id))
        backgroundQueue.removeAll { ids.contains($0.id) }
        urgentQueue = wanted
        pump()
    }

    /// Ersetzt die Auffuell-Warteschlange (ganze Bibliothek). Statt tausender Einzelnachrichten
    /// schickt die Seite die Liste einmal; Wiederholungen ersetzen, statt sich aufzustapeln.
    func setBackground(_ items: [QueueItem]) {
        let urgentIds = Set(urgentQueue.map(\.id))
        backgroundQueue = items.filter { needsDownload($0) && !urgentIds.contains($0.id) }
        pump()
    }

    /// Startet, was laufen darf. Dringendes hat immer Vorrang; Auffuellen nur im Leerlauf und
    /// nur unterhalb der Fuellgrenze.
    private func pump() {
        while activeUrgent.count < Self.maxParallelUrgent, !urgentQueue.isEmpty {
            let item = urgentQueue.removeFirst()
            guard needsDownload(item), let remote = item.fileURL else { continue }
            activeUrgent.insert(item.id)
            urgentTasks[item.id] = Task { await self.runQueued(item, remote: remote, urgent: true) }
        }

        guard urgentQueue.isEmpty, activeUrgent.isEmpty, inFlightNow.isEmpty, activeBackground == nil else { return }
        // Ruhezeit nach Vordergrund-Arbeit: erst danach weiter auffuellen (einmal wieder anstossen).
        let quiet = Date().timeIntervalSince(lastForegroundActivity)
        guard quiet >= Self.backgroundQuietSeconds else {
            if !backgroundResumeScheduled, !backgroundQueue.isEmpty {
                backgroundResumeScheduled = true
                let wait = Self.backgroundQuietSeconds - quiet + 0.5
                Task {
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    self.backgroundResumeScheduled = false
                    self.pump()
                }
            }
            return
        }
        guard totalBytes() < backgroundFillCeiling else {
            if !backgroundQueue.isEmpty, !loggedCeiling {
                loggedCeiling = true
                PlaybackJournal.note("Cache: Auffuellen gestoppt - Fuellgrenze erreicht (\(totalBytes() / 1_048_576) MB)")
            }
            backgroundQueue.removeAll()
            return
        }
        while !backgroundQueue.isEmpty {
            let item = backgroundQueue.removeFirst()
            guard needsDownload(item), let remote = item.fileURL else { continue }
            activeBackground = item.id
            backgroundTask = Task { await self.runQueued(item, remote: remote, urgent: false) }
            return
        }
    }

    private func runQueued(_ item: QueueItem, remote: URL, urgent: Bool) async {
        _ = await download(item: item, from: remote)
        if urgent {
            activeUrgent.remove(item.id)
            urgentTasks.removeValue(forKey: item.id)
        } else {
            activeBackground = nil
            // Fuer den Vordergrund abgebrochen: nicht aus der Liste verlieren, spaeter weitermachen.
            if Task.isCancelled, needsDownload(item) { backgroundQueue.insert(item, at: 0) }
        }
        pump()
    }

    /// Sofort-Download MIT PRIORITAET: laedt direkt (nicht hinten in die Warteschlange),
    /// mit den Retries + strikter Vollstaendigkeitspruefung aus download(). Gibt die lokale
    /// URL zurueck, wenn innerhalb von `maxWait` eine gueltige Datei liegt - sonst nil
    /// (Aufrufer streamt dann). Der Download selbst laeuft UNABHAENGIG von maxWait weiter und
    /// landet fuers naechste Mal im Cache.
    ///
    /// Laedt die Warteschlange genau diesen Song gerade, wird KEIN zweiter Download gestartet,
    /// sondern auf diesen gewartet.
    func fetchNow(item: QueueItem, maxWait: TimeInterval = .infinity) async -> URL? {
        if let existing = localFileURL(for: item) { return existing }
        guard let remote = item.fileURL else { return nil }
        foregroundNeeded()
        if !isBusy(item.id) {
            urgentQueue.removeAll { $0.id == item.id }
            backgroundQueue.removeAll { $0.id == item.id }
            inFlightNow.insert(item.id)
            Task {
                _ = await self.download(item: item, from: remote)
                self.inFlightNow.remove(item.id)
                self.pump()
            }
        }
        let deadline = maxWait.isFinite ? Date().addingTimeInterval(maxWait) : Date.distantFuture
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            // hasCachedFile statt localFileURL: Letzteres fasst den Zugriffsstempel an.
            if hasCachedFile(forId: item.id) { return localFileURL(for: item) }
            if !isBusy(item.id) { break }
        }
        return hasCachedFile(forId: item.id) ? localFileURL(for: item) : nil
    }

    // MARK: - Download

    /// Kleinste Groesse, die eine echte Audiodatei plausibel haben kann. Alles darunter ist
    /// eine Fehlerseite, eine leere Antwort oder ein abgebrochener Download.
    private static let minimumPlausibleBytes: Int64 = 16 * 1024

    private func measureDuration(of url: URL) async -> Double? {
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let d = ((try? await asset.load(.duration)) ?? .zero).seconds
        return (d.isFinite && d > 1) ? d : nil
    }

    @discardableResult
    private func download(item: QueueItem, from remote: URL) async -> Bool {
        // Bis zu 3 Anlaeufe mit wachsendem Abstand: ein frisch importierter Song ist am
        // CDN-Edge noch nicht gecacht, der erste Zugriff scheitert dort gern voruebergehend.
        // Ohne Retry blieb so ein Song dauerhaft ohne lokale Kopie (nur gestreamt, und der
        // erste Stream-Versuch scheiterte am selben kalten Edge) - genau das "spielt erst
        // nach einer Weile"-Verhalten.
        var tmpURL: URL?
        var http: HTTPURLResponse?
        for attempt in 0..<3 {
            if Task.isCancelled { return false }   // nicht mehr im Fenster (setUpcoming) - ohne Protokollzeile
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: UInt64(attempt) * 1_800_000_000)
                if Task.isCancelled { return false }
            }
            if let (u, resp) = try? await dlSession.download(from: remote),
               let h = resp as? HTTPURLResponse, h.statusCode == 200 {
                tmpURL = u
                http = h
                break
            }
        }
        guard let tmpURL, let http else {
            if Task.isCancelled { return false }
            PlaybackJournal.note("Cache: Download id=\(item.id) fehlgeschlagen (kein 200 nach 3 Versuchen)")
            return false
        }

        // Status 200 allein sagt NICHT, dass hier eine brauchbare Audiodatei ankam. Genau
        // darauf hat sich der Cache bisher verlassen - eine HTML-Fehlerseite, eine leere
        // Antwort oder ein unterwegs abgebrochener Download wurde als gueltiger Song abgelegt.
        // Weil die lokale Datei immer der Netzadresse vorgezogen wird, war der Song
        // danach dauerhaft tot, auch bei bestem Empfang: der Player zeigte ihn an und spielte
        // ihn nie. Drei billige Pruefungen fangen praktisch alle diese Faelle ab.
        let downloadedAttrs = try? FileManager.default.attributesOfItem(atPath: tmpURL.path)
        let downloadedBytes = (downloadedAttrs?[.size] as? Int64) ?? 0
        let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()

        // BEWUSST eine Ausschlussliste statt einer Erlaubnisliste. Ziel ist, eine Fehlerseite
        // als vermeintlichen Song zu erkennen - nicht, Audioformate zu validieren. Eine
        // Erlaubnisliste ("audio/*" oder "application/octet-stream") war hier zuerst drin und
        // ist zu eng: R2 und andere Speicher liefern dieselbe Datei je nach Konfiguration als
        // "binary/octet-stream" oder ganz ohne Angabe aus. Damit waeren voellig intakte Songs
        // nie im Cache gelandet und offline schlicht nicht da gewesen.
        let istFehlerseite = contentType.hasPrefix("text/")
            || contentType.hasPrefix("application/json")
            || contentType.hasPrefix("application/xml")

        // Kopf-Signatur: echte m4a beginnt mit "....ftyp", mp3 mit "ID3" oder einem MPEG-Sync
        // (0xFF Ex). Faengt Fehlerseiten und am Anfang abgeschnittene Dateien ab.
        let head: Data = {
            guard let fh = try? FileHandle(forReadingFrom: tmpURL) else { return Data() }
            defer { try? fh.close() }
            return (try? fh.read(upToCount: 12)) ?? Data()
        }()
        let hb = [UInt8](head)
        let looksM4A = hb.count >= 8 && hb[4] == 0x66 && hb[5] == 0x74 && hb[6] == 0x79 && hb[7] == 0x70
        let looksMP3 = hb.count >= 3 && ((hb[0] == 0x49 && hb[1] == 0x44 && hb[2] == 0x33) || (hb[0] == 0xFF && (hb[1] & 0xE0) == 0xE0))
        let goodHeader = looksM4A || looksMP3

        guard !istFehlerseite, goodHeader, downloadedBytes >= Self.minimumPlausibleBytes else {
            try? FileManager.default.removeItem(at: tmpURL)
            PlaybackJournal.note("Cache: Download id=\(item.id) verworfen (Fehlerseite/Kopf/Groesse: \(downloadedBytes) B, \(contentType))")
            return false
        }

        // Erst an den endgueltigen Ort mit RICHTIGER Endung verschieben - dann kann AVURLAsset
        // die Datei ueberhaupt als MP4/MP3 erkennen (der URLSession-Tempname endet auf .tmp).
        let ext = remote.pathExtension.isEmpty ? "m4a" : remote.pathExtension
        let dest = cacheDir.appendingPathComponent("\(item.id).\(ext)")
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.moveItem(at: tmpURL, to: dest)
        } catch {
            return false
        }

        // VOLLSTAENDIGKEIT (Kern gegen "spielt nur teilweise"): entweder die heruntergeladene
        // Byte-Zahl deckt die wahre Groesse (Content-Length, sonst Range-Probe), ODER die Datei
        // laesst sich als komplette Audiospur mit finiter Dauer > 1 s oeffnen. Trifft keins zu,
        // war der Download unterwegs abgeschnitten -> NICHT cachen (der Player wuerde die lokale
        // Kopie sonst immer vorziehen und mittendrin abbrechen).
        var trueSize = http.expectedContentLength
        if trueSize <= 0 {
            var probe = URLRequest(url: remote)
            probe.setValue("bytes=0-0", forHTTPHeaderField: "Range")
            if let (_, presp) = try? await dlSession.data(for: probe),
               let ph = presp as? HTTPURLResponse,
               let cr = ph.value(forHTTPHeaderField: "Content-Range"),
               let total = cr.split(separator: "/").last.flatMap({ Int64($0.trimmingCharacters(in: .whitespaces)) }) {
                trueSize = total
            }
        }
        // Dauer IMMER messen (nicht nur im Zweifel): 2/3 der Bibliothek hat in der Datenbank
        // keine Dauer, und ein Stream liefert sie erst spaet - die lokale Datei ist die
        // einzige Stelle, an der sie sample-genau und sofort feststeht.
        let measured = await measureDuration(of: dest)
        let complete = (trueSize > 0 && downloadedBytes >= trueSize) || measured != nil
        guard complete else {
            try? FileManager.default.removeItem(at: dest)
            PlaybackJournal.note("Cache: Download id=\(item.id) unvollstaendig (\(downloadedBytes) von \(trueSize) B)")
            return false
        }

        let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
        let size = (attrs?[.size] as? Int64) ?? 0
        // Lag unter dieser id eine Datei mit anderer Endung, wird sie hier nicht mehr referenziert - weg damit.
        if let old = index[item.id], old.ext != ext { try? FileManager.default.removeItem(at: fileURL(for: old)) }
        index[item.id] = Entry(id: item.id, ext: ext, sizeBytes: size, lastAccessed: Date(), duration: measured, src: Self.sourceName(of: item))
        scheduleIndexSave()
        enforceCap()
        onCached?(item.id)
        return true
    }

    private func enforceCap() {
        var total = totalBytes()
        guard total > capBytes else { return }
        let candidates = index.values
            .filter { $0.id != currentlyPlayingId }
            .sorted { $0.lastAccessed < $1.lastAccessed }
        for entry in candidates {
            guard total > capBytes else { break }
            try? FileManager.default.removeItem(at: fileURL(for: entry))
            index.removeValue(forKey: entry.id)
            total -= entry.sizeBytes
        }
        scheduleIndexSave()
    }

    // MARK: - Index

    /// Index nicht bei jeder kleinen Aenderung komplett neu schreiben, sondern gebuendelt. Ein
    /// Absturz in den 2 Sekunden dazwischen kostet hoechstens Zugriffsstempel - eine Datei ohne
    /// Indexeintrag wird beim naechsten Vorladen einfach neu geholt.
    private func scheduleIndexSave() {
        guard !indexDirty else { return }
        indexDirty = true
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            self.flushIndex()
        }
    }

    func flushIndex() {
        guard indexDirty else { return }
        indexDirty = false
        saveIndex()
    }

    private func saveIndex() {
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }
}
