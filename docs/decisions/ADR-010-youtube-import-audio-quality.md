# ADR-010: Höhere Audio-Qualität beim YouTube-Import (Cobalt-Bitrate + yt-dlp-Format-Fix)

## Status
Accepted

## Date
2026-07-26

## Context
Nutzerwunsch: bessere, klarere Audio-Qualität. Die Wiedergabe-Kette (`app2.js`, ADR-008:
GainNode + DynamicsCompressor als Limiter) ist bereits so sauber wie möglich — Web Audio
kann keine Details ergänzen, die nicht in der Datei stecken. Die tatsächliche Qualitäts-
Decke liegt beim Import, nicht beim Abspielen. Zwei konkrete Lücken gefunden:

1. **Cobalt-Anfragen ohne `audioBitrate`**: `src/extractor_worker.py` und
   `local-import-watcher/watch.js` fragen Cobalt nur mit `audioFormat: "mp3"` an, ohne
   `audioBitrate`. Laut Cobalt-API-Doku (github.com/imputnet/cobalt/blob/main/docs/api.md)
   liegt der Default dafür bei **128 kbit/s**; erlaubt sind bis 320. Da Cobalt seit
   [ADR-009](ADR-009-cobalt-instance-pool-fallback.md) der primäre Importweg ist, lief der
   Großteil der Importe unnötig auf niedriger Bitrate.
2. **yt-dlp-Fallback in `extractor_worker.py` ohne Format-Selektor**: `watch.js` hat bereits
   (eigener Kommentar dort) `-f bestaudio[ext=m4a]/bestaudio` gesetzt, weil yt-dlp ohne
   `-f` meist Opus/webm lädt und das per ffmpeg komplett zu AAC/m4a neu enkodieren muss
   (verlustbehafteter Doppel-Transcode). Format 140 (natives AAC im m4a) überspringt den
   Re-Encode ganz und hat die höhere Quell-Bitrate (gemessen dort: 130 statt 106 kbit/s).
   `extractor_worker.py` (GitHub-Actions-Fallback-Pfad) hatte diesen Fix nicht — Inkonsistenz
   zwischen den beiden Importpfaden.

## Decision
- `audioBitrate: "320"` zur Cobalt-Anfrage in beiden Dateien ergänzt (`extractor_worker.py`
  Zeile ~172, `watch.js` Zeile ~172).
- `-f bestaudio[ext=m4a]/bestaudio` in `extractor_worker.py`s `_run_ytdlp_download()`
  ergänzt, analog zu `watch.js`. `--audio-quality 0` bleibt für den `/bestaudio`-Rückfall-
  Zweig (Videos ohne natives m4a) stehen.

## Alternatives Considered
### Client-seitige Nachbearbeitung (EQ, Enhancer) statt Import-seitiger Fix
- Rejected: Web Audio kann keine Information ergänzen, die beim verlustbehafteten Encode
  bereits verloren ging. Ein EQ ändert Klangfarbe, nicht Klarheit/Rauschabstand. Fix an der
  Quelle (Import) ist der einzige Hebel mit echtem Qualitätsgewinn.

## Consequences
- Nur **künftige** Importe profitieren — bereits importierte Songs bleiben auf ihrer
  ursprünglichen Bitrate (kein rückwirkendes Re-Encoding geplant).
- Größere Dateien: 320-kbit/s-MP3 statt 128-kbit/s-MP3 bedeutet mehr R2-Speicher und mehr
  Bandbreite pro Song beim Cobalt-Pfad. Bei typischen 3–4-Minuten-Songs ~7–10 MB statt
  ~3–4 MB — bei aktueller Bibliotheksgröße kein akutes Speicherproblem, aber Wachstumsrate
  steigt entsprechend.
- Cobalt-Instanzen könnten `audioBitrate` ignorieren oder nicht unterstützen (nicht pro
  Instanz verifiziert, nur laut offizieller Doku des Referenz-Projekts) — in dem Fall liefern
  sie vermutlich weiterhin ihren eigenen Default, kein harter Fehler zu erwarten.
