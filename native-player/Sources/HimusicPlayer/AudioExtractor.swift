import Foundation
import AVFoundation

/// Extrahiert die Audiospur aus einer beliebigen Video-/Audiodatei, komplett lokal, ohne
/// eigenen Container-Parser - AVFoundation kennt jedes Format, das die Kamera-App und Fotos
/// produzieren (H.264/HEVC in .mov/.mp4, AAC- oder PCM-Ton), waehrend der YouTube-Import
/// (siehe app2.js) genau deshalb einen eigenen MP4-Remux von Hand macht: dort gibt es kein
/// natives Bindeglied, hier schon.
enum AudioExtractor {
    /// Groesster Video-Input, den die WebView-Bruecke annimmt. Die Datei kommt als Base64-String
    /// durch WKScriptMessageHandler - das ist rund 1,35x die Rohgroesse als JS-String im Speicher
    /// des Webinhalts-Prozesses UND nochmal im nativen Prozess beim Decodieren. Groesser als das
    /// hier riskiert Speicherdruck bis zum Absturz des Webinhalts-Prozesses (WKWebView killt ihn
    /// dann kommentarlos - siehe aehnliche Faelle bei grossen Downloads in AudioFileCache).
    /// ~300 MB deckt ein paar Minuten 1080p-Handyvideo; laenger/hoeher aufgeloest muss der Nutzer
    /// vorher kuerzen oder komprimieren.
    static let maxInputBytes = 300 * 1024 * 1024

    struct ExtractResult {
        let data: Data
        let durationSeconds: Double
    }

    enum ExtractError: LocalizedError {
        case tooLarge(Int)
        case writeFailed
        case noAudioTrack
        case exportSessionUnavailable
        case exportFailed(String)

        var errorDescription: String? {
            switch self {
            case .tooLarge(let bytes):
                return "Video zu gross fuer die Audio-Extraktion (\(bytes / 1_048_576) MB, Grenze \(maxInputBytes / 1_048_576) MB)"
            case .writeFailed:
                return "Video konnte nicht zwischengespeichert werden"
            case .noAudioTrack:
                return "Keine Audiospur in der Datei gefunden"
            case .exportSessionUnavailable:
                return "Audio-Export fuer dieses Format nicht verfuegbar"
            case .exportFailed(let reason):
                return "Audio-Export fehlgeschlagen: \(reason)"
            }
        }
    }

    /// suggestedExtension steuert nur, mit welcher Dateiendung AVFoundation die Zwischendatei
    /// sieht (hilft beim Container-Erkennen, ist aber kein hartes Erfordernis) - der eigentliche
    /// Dateiinhalt wird unveraendert aus `data` uebernommen.
    static func extractAudio(from data: Data, suggestedExtension: String) async throws -> ExtractResult {
        guard data.count <= maxInputBytes else { throw ExtractError.tooLarge(data.count) }

        let workDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("himusic-audio-extract-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        // Egal ob Erfolg oder Fehlschlag: die Zwischendateien (Rohvideo + exportiertes M4A)
        // sollen nie liegen bleiben - das waere sonst genau der stille Speicherfresser, den
        // AudioFileCache an anderer Stelle explizit vermeidet.
        defer { try? FileManager.default.removeItem(at: workDir) }

        // Nicht nur trimmen (das liesse etwas wie "mp4/../../etc" fast unveraendert durch,
        // da weder Start noch Ende alphanumerisch-fremd sind) - jedes Nicht-Alphanumerische
        // wird entfernt. JS saeubert die Endung zwar schon vorher genauso, aber diese Seite
        // soll sich nicht darauf verlassen muessen, dass der Aufrufer das immer richtig macht.
        let ext = String(suggestedExtension.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
        let inputURL = workDir.appendingPathComponent("input.\(ext.isEmpty ? "mov" : ext)")
        do {
            try data.write(to: inputURL, options: .atomic)
        } catch {
            throw ExtractError.writeFailed
        }

        let asset = AVURLAsset(url: inputURL)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        guard !audioTracks.isEmpty else { throw ExtractError.noAudioTrack }

        guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw ExtractError.exportSessionUnavailable
        }
        let outputURL = workDir.appendingPathComponent("output.m4a")
        exportSession.outputURL = outputURL
        exportSession.outputFileType = .m4a

        // exportAsynchronously(completionHandler:) statt des neueren export(to:as:) - Letzteres
        // braucht iOS 18, das Deployment-Target hier ist 16.0. Die Continuation bruecken das in
        // denselben async/await-Stil, den der Rest der App durchgehend nutzt.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            exportSession.exportAsynchronously {
                switch exportSession.status {
                case .completed:
                    continuation.resume()
                case .failed:
                    continuation.resume(throwing: ExtractError.exportFailed(
                        exportSession.error?.localizedDescription ?? "unbekannter Fehler"))
                case .cancelled:
                    continuation.resume(throwing: ExtractError.exportFailed("abgebrochen"))
                default:
                    continuation.resume(throwing: ExtractError.exportFailed("Status \(exportSession.status.rawValue)"))
                }
            }
        }

        let outputData = try Data(contentsOf: outputURL)
        let duration = try await asset.load(.duration).seconds
        return ExtractResult(data: outputData, durationSeconds: duration.isFinite && duration > 0 ? duration : 0)
    }
}
