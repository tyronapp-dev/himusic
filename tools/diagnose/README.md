# tools/diagnose/ — Test- und Messskripte (ADR-015)

Entstanden am 2026-10-21, als die Wiedergabe-Fehler "an der Wurzel statt an der Naht" gesucht wurden.
Nichts davon wird ausgeliefert. **Alle Messskripte sind lesend** (nur `GET /songs` bzw. Range-Anfragen auf
`/media/*`) und geben **nur Summen** aus — nie Titel, nie den Key. Der Key kommt aus `tools/.env`
(`HIMUSIC_API_KEY=…`, gitignoriert), siehe [../README.md](../README.md).

## Bibliotheks-Messungen (Node, keine Abhängigkeiten)
| Skript | Frage |
|---|---|
| `bibliothek-uebersicht.mjs` | Songzahl, Formate, `duration==0`, eingebettete Cover (`data:`), Gesamtgröße |
| `bibliothek-groessen.mjs` | Größe/Bitrate je Format, größte Songs, Duplikate (`content_hash`), wie viele Songs bei X GB Cache passen |
| `bibliothek-mp4-stichprobe.mjs` | Enthalten die `.mp4`-Songs eine Videospur? (holt nur Anfang/Ende per Range) |
| `bibliothek-datentypen.mjs` | Datentypen der Felder, die in den Handoff gehen (Text statt Zahl würde die native Dekodierung kippen) |
| `bibliothek-urls.mjs` | Gibt es URLs, die eine strenge URL-Prüfung ablehnt? |
| `handoff-dekodierbar.mjs` | Bildet `toItem()` der Seite nach und prüft, ob die strikte Swift-Dekodierung (`QueueItem`: `t`/`a`/`u` Text, `id` ganzzahlig, `d` Zahl) einen Eintrag ablehnen würde (falsche Typen, einzelne Surrogate, Steuerzeichen); dazu doppelte `id`/`file_url`. **Warum:** `handleBridgeJSON` verwirft die GANZE Warteschlange still, wenn ein einziger Eintrag nicht dekodiert (kein Protokoll). |
| `id-wiederverwendung.mjs` | Hinweise auf wiederverwendete IDs / ersetzte Dateien (Dateistempel gegen ID-Reihenfolge, Lücken). **Warum:** der native Cache ist nur nach `id` indiziert (`AudioFileCache.Entry` hat keine URL) und prüft nie, ob die Datei zur Adresse passt. |

Stand der Messung (21.10.2026): 2188 Songs, 12,3 GB; 1449 mit `duration==0`; 117 `data:`-Cover = 16,8 MB;
**396 `.mp4` = Videodateien (20/20 Stichprobe), 5,14 GB = 42 % des Speichers**; 0 Duplikate; alle URLs gültig,
alle auf `himusic-api.tyron-app.workers.dev`.

## Browsertests der Seite (Playwright, **gestubbte API + gefälschte native Brücke**, nie der echte Worker)
Einmalig: `cd tools/diagnose && npm i playwright-core` (landet in `node_modules/`, gitignoriert). Die Skripte starten
Chromium aus dem Playwright-Cache (`%USERPROFILE%\AppData\Local\ms-playwright\chromium-*`); ist der Pfad ein anderer,
oben in der Datei `CHROME` anpassen.

| Skript | Prüft |
|---|---|
| `browsertest-huelle.mjs` | ~49 Prüfungen: Handoff (Fortsetzung, Cover-Fenster, Dauer), Zeitleiste (Anteil, genau ein Sprung, alte Hülle ohne `seekFraction`), Tab-Reset, Tastatur, Cache-Stand, Protokoll-Ansicht, `<audio>` der Hülle bleibt leer, Doppeltipp |
| `browsertest-songs-tippen.mjs` | Tipp auf Song N der Songs-Seite → erster Eintrag der gesendeten Warteschlange ist genau dieser Song (vorne, Lazy-Load, Suche, Tab-Reset, Shuffle) |

Aufruf: `node tools/diagnose/browsertest-huelle.mjs` (Exit-Code 0 = alles grün).

**Grenze:** Das prüft nur die Seite. Die native Hülle (Swift) lässt sich nur im CI (macOS-Build) übersetzen und nur am
iPhone ausführen — dafür gibt es das Ereignisprotokoll (Einstellungen → Wiedergabe-Diagnose).
