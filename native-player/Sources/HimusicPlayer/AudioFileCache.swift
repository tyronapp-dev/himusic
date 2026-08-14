import Foundation

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
        guard let (tmpURL, response) = try? await URLSession.shared.download(from: remote),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            return
        }

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

        // Nur pruefen, wenn der Server eine Laenge genannt hat: fehlt sie (chunked), ist das
        // kein Fehlersignal, sondern schlicht keine Information.
        let announced = http.expectedContentLength
        let complete = announced <= 0 || downloadedBytes >= announced

        guard !istFehlerseite, downloadedBytes >= Self.minimumPlausibleBytes, complete else {
            try? FileManager.default.removeItem(at: tmpURL)
            return
        }

        let ext = remote.pathExtension.isEmpty ? "mp3" : remote.pathExtension
        let dest = cacheDir.appendingPathComponent("\(item.id).\(ext)")
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.moveItem(at: tmpURL, to: dest)
        } catch {
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
