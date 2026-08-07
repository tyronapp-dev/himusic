import Foundation

/// Kompaktes Format, das die PWA per Custom-URL-Scheme uebergibt.
/// Kurze Feldnamen (t/a/u/c) absichtlich, um die URL-Laenge klein zu halten.
struct QueueItem: Codable, Identifiable, Equatable {
    let id: Int
    let t: String
    let a: String
    let u: String
    let c: String?

    var title: String { t }
    var artist: String { a }
    var fileURL: URL? { URL(string: u) }
    var coverURL: URL? { c.flatMap { URL(string: $0) } }
}

struct IncomingPayload: Codable {
    let queue: [QueueItem]
    let startIndex: Int
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
