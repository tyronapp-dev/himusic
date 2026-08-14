import Foundation

/// Kompaktes Format, das die PWA per Custom-URL-Scheme uebergibt.
/// Kurze Feldnamen (t/a/u/c) absichtlich, um die URL-Laenge klein zu halten.
///
/// "s" (Herkunft, z.B. "Aus Vibe Mix: LD") haengt bewusst AM EINZELNEN SONG und nicht an
/// einer globalen "was laeuft gerade fuer eine Quelle"-Variable der Seite. Genau diese
/// Kopie lief auseinander: die Seite setzte ihre Variable beim Start einer Quelle, der
/// native Player sprang danach eigenstaendig weiter (Auto-Skip, Control Center, per Swipe
/// eingereihter Song) - die Variable blieb stehen und der grosse Player behauptete eine
/// Herkunft, die fuer den laufenden Song nie gegolten hat (sichtbar u.a. an Songs ohne
/// jeden Vibe, die angeblich aus einem Vibe-Mix kamen). Dieselbe Fehlerklasse wie ADR-011,
/// dieselbe Konsequenz: die Zweitkopie entfaellt, statt sie besser zu synchronisieren.
///
/// Optional, damit ein vor dieser Aenderung gespeicherter Snapshot weiter dekodierbar ist.
struct QueueItem: Codable, Identifiable, Equatable {
    let id: Int
    let t: String
    let a: String
    let u: String
    let c: String?
    let s: String?

    var title: String { t }
    var artist: String { a }
    var fileURL: URL? { URL(string: u) }
    var coverURL: URL? { c.flatMap { URL(string: $0) } }
    var sourceLabel: String? { (s?.isEmpty == false) ? s : nil }
}

struct IncomingPayload: Codable {
    let queue: [QueueItem]
    let startIndex: Int
}

/// Ausschnitt der echten nativen Warteschlange fuer die Warteschlangen-Ansicht der Seite.
/// Bewusst nur ein Fenster um die aktuelle Position statt der ganzen Liste: die kann seit
/// dem Wegfall des 25er-Limits die komplette Bibliothek sein (2000+), und die Ansicht zeigt
/// ohnehin nur ~50 Eintraege. "currentIndex" ist relativ zu "items", nicht zur echten Queue.
struct QueueSnapshot: Codable {
    let items: [QueueItem]
    let currentIndex: Int
    let totalCount: Int
    let remainingAfter: Int
}

/// Zweite Bridge-Nachrichtenform neben IncomingPayload - siehe handleBridgeJSON().
/// "open" nur bei cmd == "playerView" (meldet, ob der grosse Web-Player offen ist),
/// "delta" nur bei cmd == "seekBy" (relativer Sprung, Sekunden, negativ fuer rueckwaerts),
/// "seconds" nur bei cmd == "seekTo" (absolute Zielposition, z.B. Scrub-Leiste loslassen),
/// "item" nur bei cmd == "insertNext" (Song aus dem Rechts-Swipe der Songliste),
/// "index" nur bei cmd == "jumpTo"/"removeAt" (Position in der echten nativen Warteschlange).
struct BridgeCommand: Codable {
    let cmd: String
    let open: Bool?
    let delta: Double?
    let seconds: Double?
    let item: QueueItem?
    let index: Int?
}

extension Data {
    /// Dekodiert Base64url (RFC 4648, "-"/"_" statt "+"/"/", ohne Padding) -
    /// so kommt der Queue-Payload sauber durch eine URL-Query ohne zusaetzliches Escaping.
    init?(base64urlEncoded input: String) {
        var base64 = input
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        self.init(base64Encoded: base64)
    }
}
