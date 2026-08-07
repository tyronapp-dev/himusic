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
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        cacheDir = caches.appendingPathComponent("AudioCache", isDirectory: true)
        indexURL = cacheDir.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([Int: Entry].self, from: data) {
            index = decoded
        }
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

    private func download(item: QueueItem, from remote: URL) async {
        guard let (tmpURL, response) = try? await URLSession.shared.download(from: remote),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else {
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
