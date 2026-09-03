import Foundation
import AVFoundation

/// Persistenter Datei-Cache fuer Audiodateien, damit AVPlayer offline aus dem lokalen
/// Dateisystem liest statt zu streamen - erst das erlaubt echte Hintergrund-Wiedergabe
/// ohne Netz (ADR-007, "Schritt 3"). Downloads brauchen keinen API-Key: /media/* ist
/// auf dem Worker unauthentifiziert, gleiches Verhalten wie downloadToLocal() in app2.js.
actor AudioFileCache {
    static let shared = AudioFileCache()

    /// Weiche Obergrenze, wird nach jedem abgeschlossenen Download durchgesetzt.
    /// Der aktuell gespielte Song ist von der Verdraengung ausgenommen, sonst fliegt
    /// der am laengsten nicht gespielte Song zuerst raus (LRU).
    private let capBytes: Int64 = 8 * 1_073_741_824  // 8 GB

    private struct Entry: Codable {
        let id: Int
        var ext: String
        var sizeBytes: Int64
        var lastAccessed: Date
    }

    private let cacheDir: URL
    private let indexURL: URL
    private var index: [Int: Entry] = [:]

    private var downloadQueue: [QueueItem] = []
    private var currentlyDownloadingId: Int?
    private var currentlyPlayingId: Int?
    private var inFlightNow: Set<Int> = []   // laeuft gerade ein fetchNow() fuer diese id?

    /// Eigene Session mit knappen Timeouts: ein haengender Download darf die Wiedergabe nicht
    /// minutenlang blockieren (beginPlayback wartet auf fetchNow).
    private lazy var dlSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 25
        cfg.timeoutIntervalForResource = 90
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
        saveIndex()
        return true
    }

    private func fileURL(for entry: Entry) -> URL {
        cacheDir.appendingPathComponent("\(entry.id).\(entry.ext)")
    }

    /// Lokale Datei, falls schon gecacht. Aktualisiert gleich den Zugriffszeitstempel -
    /// schuetzt den Song vor Verdraengung, solange er im Rotationsfenster bleibt.
    func localFileURL(forId id: Int) -> URL? {
        guard var entry = index[id] else { return nil }
        let url = fileURL(for: entry)
        guard FileManager.default.fileExists(atPath: url.path) else {
            index.removeValue(forKey: id)
            saveIndex()
            return nil
        }
        entry.lastAccessed = Date()
        index[id] = entry
        saveIndex()
        return url
    }

    /// Merkt sich, welcher Song gerade laeuft, damit enforceCap() ihn nie loescht -
    /// auch wenn er zufaellig der aelteste Eintrag waere.
    func markCurrentlyPlaying(id: Int?) {
        currentlyPlayingId = id
    }

    /// Reiht zum Download ein, falls weder gecacht noch schon in der Warteschlange
    /// oder gerade aktiv am Laden. Downloads laufen absichtlich sequenziell (1
    /// parallel) - gleiche Drosselung wie die PWA in ADR-002, schont Akku und Volumen.
    func ensureCached(item: QueueItem) {
        guard item.fileURL != nil else { return }
        if index[item.id] != nil { return }
        if currentlyDownloadingId == item.id { return }
        if downloadQueue.contains(where: { $0.id == item.id }) { return }
        downloadQueue.append(item)
        processQueueIfNeeded()
    }

    func ensureCachedQueue(_ items: [QueueItem]) {
        for item in items { ensureCached(item: item) }
    }

    /// Sofort-Download MIT PRIORITAET: laedt direkt (nicht hinten in die 1-parallel-Queue),
    /// mit den Retries + strikter Vollstaendigkeitspruefung aus download(). Gibt die lokale
    /// URL zurueck, wenn danach eine gueltige Datei liegt - sonst nil (Aufrufer streamt dann).
    /// Genau der Weg fuer "gerade importiert" / "gerade angetippt": danach spielt beginPlayback
    /// von Platte statt die noch kalte Remote-Datei zu streamen.
    func fetchNow(item: QueueItem) async -> URL? {
        if let existing = localFileURL(forId: item.id) { return existing }
        guard let remote = item.fileURL else { return nil }
        if inFlightNow.contains(item.id) {
            // Laeuft schon - kurz warten und nachsehen, kein zweiter Download.
            for _ in 0..<40 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if let u = localFileURL(forId: item.id) { return u }
                if !inFlightNow.contains(item.id) { break }
            }
            return localFileURL(forId: item.id)
        }
        inFlightNow.insert(item.id)
        await download(item: item, from: remote)
        inFlightNow.remove(item.id)
        return localFileURL(forId: item.id)
    }

    private func processQueueIfNeeded() {
        guard currentlyDownloadingId == nil, !downloadQueue.isEmpty else { return }
        let item = downloadQueue.removeFirst()
        guard let remote = item.fileURL else {
            processQueueIfNeeded()
            return
        }
        currentlyDownloadingId = item.id
        Task {
            await self.download(item: item, from: remote)
            await self.finishedDownloading()
        }
    }

    private func finishedDownloading() {
        currentlyDownloadingId = nil
        processQueueIfNeeded()
    }

    /// Kleinste Groesse, die eine echte Audiodatei plausibel haben kann. Alles darunter ist
    /// eine Fehlerseite, eine leere Antwort oder ein abgebrochener Download.
    private static let minimumPlausibleBytes: Int64 = 16 * 1024

    private func download(item: QueueItem, from remote: URL) async {
        // Bis zu 3 Anlaeufe mit wachsendem Abstand: ein frisch importierter Song ist am
        // CDN-Edge noch nicht gecacht, der erste Zugriff scheitert dort gern voruebergehend.
        // Ohne Retry blieb so ein Song dauerhaft ohne lokale Kopie (nur gestreamt, und der
        // erste Stream-Versuch scheiterte am selben kalten Edge) - genau das "spielt erst
        // nach einer Weile"-Verhalten.
        var tmpURL: URL?
        var http: HTTPURLResponse?
        for attempt in 0..<3 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: UInt64(attempt) * 1_800_000_000)
            }
            if let (u, resp) = try? await dlSession.download(from: remote),
               let h = resp as? HTTPURLResponse, h.statusCode == 200 {
                tmpURL = u
                http = h
                break
            }
        }
        guard let tmpURL, let http else { return }

        // Status 200 allein sagt NICHT, dass hier eine brauchbare Audiodatei ankam. Genau
        // darauf hat sich der Cache bisher verlassen - eine HTML-Fehlerseite, eine leere
        // Antwort oder ein unterwegs abgebrochener Download wurde als gueltiger Song abgelegt.
        // Weil beginPlayback die lokale Datei immer der Netzadresse vorzieht, war der Song
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
            return
        }

        // Erst an den endgueltigen Ort mit RICHTIGER Endung verschieben - dann kann AVURLAsset
        // die Datei ueberhaupt als MP4/MP3 erkennen (der URLSession-Tempname endet auf .tmp).
        let ext = remote.pathExtension.isEmpty ? "m4a" : remote.pathExtension
        let dest = cacheDir.appendingPathComponent("\(item.id).\(ext)")
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.moveItem(at: tmpURL, to: dest)
        } catch {
            return
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
        var complete = trueSize > 0 && downloadedBytes >= trueSize
        if !complete {
            let dur = ((try? await AVURLAsset(url: dest).load(.duration)) ?? .zero).seconds
            complete = dur.isFinite && dur > 1
        }
        guard complete else {
            try? FileManager.default.removeItem(at: dest)
            return
        }

        let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
        let size = (attrs?[.size] as? Int64) ?? 0
        index[item.id] = Entry(id: item.id, ext: ext, sizeBytes: size, lastAccessed: Date())
        saveIndex()
        enforceCap()
    }

    private func enforceCap() {
        var total = index.values.reduce(Int64(0)) { $0 + $1.sizeBytes }
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
        saveIndex()
    }

    private func saveIndex() {
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }
}
