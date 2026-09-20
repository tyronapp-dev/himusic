# ADR-014: Audio-Extraktion aus Video nativ statt in JS

## Status
Accepted

## Date
2026-09-20

## Context
Der Datei-Import (`btn-add-songs`) liess `video/mp4` im `accept`-Filter zu, verarbeitete ein
gewähltes Video aber genauso wie eine Audiodatei: roh nach R2 hochladen, `duration: 0`
registrieren. Zwei Probleme:

1. **Der Upload scheiterte oft.** `uploadOne()` hat ein 180-Sekunden-Timeout — für ein
   Musikstück (wenige MB) reichlich, für ein Handyvideo (oft 100 MB bis mehrere GB) auf
   normaler Heim-Upload-Bandbreite oft zu knapp.
2. **Selbst ein erfolgreicher Upload wäre falsch gewesen.** Die App hätte das komplette Video
   als "Song" gespeichert — massiv mehr Speicher/Bandbreite als nötig, für etwas, das niemand
   als Video abspielen will.

Der Nutzer wollte ausdrücklich nur die Audiospur, nicht das Video selbst.

## Entscheidung
Ein Video wird vor dem Hochladen **nativ** auf seine Audiospur reduziert, nicht in JavaScript.

Abwägung:

| | Aufwand | Robustheit |
|---|---|---|
| **Nativ (AVFoundation)** | Neuer WKScriptMessageHandler-Kanal, neue Swift-Datei, neuer IPA-Build+Install | Sehr hoch — Apples eigene Frameworks kennen jedes Format, das Kamera/Fotos produzieren |
| **In JS** | Kein natives Build nötig | Fragil — bräuchte einen selbstgebauten Container-Demuxer für beliebige Formate (HEVC/.mov, H.264/.mp4, …), ohne eine Bibliothek wie ffmpeg.wasm (widerspricht "kein Build-Step") kaum robust umsetzbar |

Der YouTube-Import (`app2.js`) remuxt zwar auch selbst — aber dort ist die Eingabe IMMER
YouTubes eine bekannte, fragmentierte MP4-Form (siehe `_ytRemuxToProgressiveMp4`). Ein von
Nutzern gewähltes Video kann in beliebigen Containern/Codecs vorliegen; ein generischer
Demuxer dafür ist ein anderes Kaliber Aufwand als ein Spezialfall-Remux.

## Umsetzung
- **Neuer Kanal `himusicMedia`** (WebShellView.swift, parallel zu `himusicHttp`, aber ohne
  Host-Allowlist — rein lokale Verarbeitung, keine Netzwerkanfrage).
- **`AudioExtractor.swift`**: Bytes → Temp-Datei → `AVURLAsset.loadTracks(withMediaType:.audio)`
  (wirft `noAudioTrack`, falls keine Audiospur existiert) → `AVAssetExportSession` mit
  `AVAssetExportPresetAppleM4A` → Ergebnis-Bytes + gemessene Dauer zurück. Temp-Dateien werden
  per `defer` in jedem Fall (Erfolg wie Fehler) aufgeräumt.
- **API-Wahl**: die ältere `exportAsynchronously(completionHandler:)` statt der neueren
  `export(to:as:)` — Letztere braucht iOS 18, das Deployment-Target hier ist 16.0. Per
  `withCheckedThrowingContinuation` in denselben async/await-Stil gebracht, den der Rest der
  App durchgehend nutzt. Erzeugt eine Deprecation-Warnung beim Bauen mit neueren SDKs — bewusst
  in Kauf genommen, das Projekt setzt keine Warnings-als-Fehler.
- **JS-Seite** (`app2.js`): `_isVideoFile()` erkennt Videos an MIME-Typ ODER Endung (iOS liefert
  den MIME-Typ beim Datei-Picker nicht immer zuverlässig). `_nativeExtractAudio()` liest die
  Datei als Base64, ruft die Bridge, liefert Bytes + Dauer zurück. `_bytesToB64()` kodiert in
  32-KB-Blöcken (`String.fromCharCode.apply` auf ein komplettes großes Array sprengt sonst den
  Call-Stack).
- **Größengrenze 300 MB** auf beiden Seiten (`AudioExtractor.maxInputBytes` /
  `_VIDEO_EXTRACT_MAX_BYTES`, **müssen synchron gehalten werden**). Grund: die Datei geht als
  kompletter Base64-String durch `WKScriptMessageHandler`, kein Chunking/Streaming - das
  belastet den Speicher des Webinhalts-Prozesses spürbar (~1,35× Rohgröße als JS-String), zu
  groß riskiert dessen stillen Absturz. JS prüft die Größe VOR dem Einlesen, damit ein zu
  großes Video gar nicht erst eingelesen/kodiert wird.
- **`accept`-Filter erweitert**: `video/mp4` → `video/*` plus explizit `.mov`/`.m4v` — iPhone-
  Videos liegen standardmäßig oft als HEVC/.mov vor, nicht als .mp4.
- **Kein stiller Fallback.** Fehlt die Bridge (reiner Browser) oder überschreitet das Video die
  Grenze, scheitert der Import mit einer konkreten, lesbaren Meldung - nie wird ersatzweise das
  Rohvideo hochgeladen.
- **Bonus**: `durationSeconds` kommt als echte, gemessene Dauer zurück - besser als der
  reguläre Datei-Upload-Pfad, der bisher immer `duration: 0` speicherte.

## Konsequenzen
- Datei-Import braucht ab sofort die Hülle für Videos; im reinen Browser bleibt nur der
  Audio-Direktweg (unverändert).
- Ein neuer nativer Build ist für dieses Feature erforderlich (IPA-Zyklus), bevor es am Gerät
  nutzbar ist.
- Nicht getestet gegen ein echtes Gerät/echte AVFoundation-Ausführung - kein Swift-Build-
  Toolchain mit iOS-SDK in der Entwicklungsumgebung verfügbar, nur `swiftc -parse` auf
  Syntaxfehler geprüft. Die JS-Seite ist vollständig mit Playwright gegen eine gefälschte
  Bridge verifiziert (Video-Erkennung, kein Rohvideo-Upload, Dateiname/Content-Type, Dauer-
  Übergabe, Größengrenze, fehlende Bridge).
