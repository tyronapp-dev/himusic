# ADR-016: YouTube-Vorschau im normalen Player ("Vorschau = Import ohne Registrierung")

## Status
Proposed (Entwurf, noch nichts gebaut, Entscheidung offen)

## Date
2026-11-21

## Context
Wunsch (Tyron, 2026-11-21): Musik aus dem Internet hören, ohne sie erst in die Bibliothek zu
importieren ("von YouTube direkt streamen"). Gewählte Richtung: **Vorschau-Variante** — antippen,
anhören, bei Gefallen behalten.

**Heute vorhanden:**
- Import komplett am Gerät: `_ytExtract` (InnerTube, Primärclient VISIONOS) → 512-KB-Chunks →
  `_ytRemuxToProgressiveMp4` → Probe → Upload (`app2.js`, siehe CLAUDE.md "YouTube Import").
- Vorschau in der Suche: versteckter YouTube-IFrame-Player (`_toggleYtPreview`). Er läuft nur im
  Vordergrund, ist nicht Teil des nativen Players (keine Warteschlange, kein Sperrbildschirm,
  keine Hintergrundwiedergabe) und hängt an der YouTube-Player-API.

## Warum NICHT "die Stream-URL direkt an den Player geben"
Drei Befunde aus dem Code und der Akte, jeder für sich schon ausreichend:

1. **Format.** YouTube liefert Audio als fragmentiertes MP4 (DASH) oder WebM/Opus. Der native
   `AVPlayer` spielt beides nicht (Akte, 30.08.2026: "Browser spielen das, der native AVPlayer der
   Hülle nicht"). Deshalb gibt es überhaupt `_ytRemuxToProgressiveMp4`. Muxed-Formate (Video+Audio)
   sind nicht verlässlich vorhanden und würden das Video mitladen.
2. **Host-Allowlist.** `HimusicBuild.isAllowedMediaURL` lässt die Hülle nur Audio vom eigenen Host
   laden (bewusste Härtung vom 21.10.2026). Direktes Streaming bräuchte wechselnde
   `googlevideo.com`-Hosts auf dieser Liste — die Härtung wäre weg.
3. **Lebensdauer.** Die URLs laufen nach Stunden ab; eine in der Warteschlange stehende URL wäre
   beim Nachrücken evtl. schon tot.

Zusätzlich: der Remux braucht den **kompletten** Track (die Sample-Tabellen stehen verteilt in
allen `moof`-Blöcken), "Abspielen während des Ladens" geht ohne Neubau eines Live-Remuxers nicht.

## Entscheidung (Vorschlag)
Eine Vorschau ist ein **Import ohne Registrierung**: derselbe Weg bis zur fertigen progressiven
m4a, aber das Ergebnis kommt **nicht** nach R2 und **nicht** in die Bibliothek, sondern in einen
kleinen, selbstaufräumenden **Vorschau-Cache der Hülle** und wird vom normalen nativen Player
gespielt. Audio ist klein (4 Minuten ≈ 4 MB), "erst laden, dann spielen" ist deshalb gut genug
und vermeidet jede neue Format-Frage.

```
Tipp auf ▶ in der Suche
  → _ytPreviewFetch(videoId)            [JS, wiederverwendet _ytExtract + Chunks + Remux]
  → cmd:'previewStore' {id, bytes}      [Brücke, Base64, wie extractAudio: 5-8 MB sind unkritisch]
  → PreviewCache schreibt Datei         [Swift, Caches/preview, LRU]
  → insertNext / Start mit u:'himusic-preview://<id>'
  → beginPlayback löst die Adresse gegen den PreviewCache auf, spielt von Platte
  → Sperrbildschirm, Hintergrund, Warteschlange, Skip: wie bei jedem Song
"Behalten" → bestehender Importpfad (_enqueueYoutubeLinks, force)
```

### Bausteine
- **JS** `_ytPreviewFetch(videoId)`: Extract → Download → Remux, liefert `{bytes, title, artist,
  lengthSeconds, thumbnail}`. Kein Upload, keine Registrierung. Zustände in der Suchzeile:
  *lädt (n %)* → *spielt* → *Fehler* (Text aus `_ytDiagnose`).
- **Vorschau-Songs** liegen in `window._previewSongs` (Map), **nie** in `globalSongsData`/`_songIndex`.
  `_resolveSongById` kennt die Map, damit Big Player und Menüs sie auflösen. Negative `id`
  (`-1`, `-2`, …): `QueueItem.id` ist `Int`, Kollision mit echten Song-IDs ausgeschlossen.
- **Herkunft** am Song (`s = "Vorschau · YouTube"`, Muster ADR-012), Abzeichen "Vorschau" im Mini-
  und Big Player, dort zusätzlich Knopf **Behalten**.
- **Swift** `PreviewCache`: eigenes Verzeichnis, getrennt vom `AudioFileCache`. Grenzen 200 MB /
  20 Dateien, älteste fliegen zuerst, Aufräumen beim App-Start. **Zählt nicht** zur Offline-Belegung,
  wird von `cacheBackground`/Fortsetzung/Cache-Kennzeichen ignoriert.
- **Auflösung** `himusic-preview://<id>` passiert in `beginPlayback` **vor** dem Host-Check; die
  Allowlist für Netzadressen bleibt unverändert streng. Fehlt die Datei (App neu gestartet, Cache
  aufgeräumt): überspringen + Protokollzeile, nie hängen.
- **Fähigkeit** `ytPreview` in `HimusicBuild.capabilities`. Ohne sie (alte Hülle) bleibt die
  Suche beim bisherigen IFrame — die Funktion **verschlechtert sich, sie bricht nicht**.
- **Grenzen** gegen Bot-Muster und Datenverbrauch: ein Abruf gleichzeitig, **nur auf Antippen**
  (keine Vorab-Abrufe für die Trefferliste), höchstens 30 Vorschauen pro Stunde, dieselbe Video-ID
  24 h aus dem Cache, Abbruch über 20 MB (`_YT_IMPORT_MAX_BYTES`) und bei Livestreams.

### Verworfene Alternativen
| | Warum nicht |
|---|---|
| **A** URL direkt an AVPlayer | Format, Allowlist, Ablauf — siehe oben |
| **B** Temp-Upload nach R2, von dort streamen | Fremdinhalt auf Tyrons Cloudflare-Konto, Speicher/Egress, Worker-Änderung + Aufräumjob; kein Vorteil gegenüber lokaler Datei |
| **C** Live-Remux-Proxy (`AVAssetResourceLoader`) | hoher Aufwand für wenige gesparte Sekunden; erst sinnvoll, wenn die Messung (Phase 0) lange Wartezeiten zeigt |
| **D** IFrame ausbauen | kein Hintergrund, keine Warteschlange, kein Sperrbildschirm — bleibt nur als Rückfallebene |

**Ergänzende Option E (rechtlich sauber, wenig Aufwand):** die iTunes-Suche, die der Sync schon
nutzt, liefert pro Treffer eine **30-Sekunden-Vorschau** als direkte m4a-URL (`previewUrl`), die
`AVPlayer` ohne Remux spielt. Nur zum Reinhören, kein Volltrack; bräuchte den Apple-Preview-Host
auf der Allowlist. Kann unabhängig von diesem ADR zusätzlich gebaut werden.

## Phasen
| Phase | Inhalt | IPA nötig? | Abbruchkriterium |
|---|---|---|---|
| **0 Messung** | `_ytSpikeTest` erweitern: komplette Datei laden + remuxen, Zeiten einzeln messen (Extract / Download / Remux / gesamt bis "spielbereit"); 20 verschiedene Videos | nein | typisch > 8 s bis zum Ton **oder** Bot-Quote > 10 % → Design überdenken (Teil-Remux der ersten ~30 s, Option C) |
| **1 Web-Vorschau** | Remux-Ergebnis als Blob in `<audio>` statt IFrame; "lädt/spielt/Behalten"-Oberfläche. Nur Vordergrund. Prüft Bedienung, ohne neue Hülle | nein | — |
| **2 Native Vorschau** | `PreviewCache`, `previewStore`, `himusic-preview://`, Fähigkeit `ytPreview`, `HimusicBuild.id` hochzählen | **ja** | Gerätetest siehe unten |
| **3 Politur** | "Behalten" ohne zweiten Download (Bytes weiterverwenden), "Als nächstes", Einstieg auch über "Link einfügen" | ja/nein | — |

### Prüfung
- Browsertests mit gefälschter Brücke (Muster `tools/diagnose/browsertest-*.mjs`): Zustände der
  Suchzeile, Vorschau taucht nie in `globalSongsData`/Fortsetzung/Cache-Liste auf, Rückfall auf
  IFrame ohne Fähigkeit, Obergrenzen greifen, "Behalten" reiht genau einen Import ein.
- **Nur am Gerät prüfbar:** Wiedergabe bei gesperrtem Handy, Songende → Nachfolger, Skip, Neustart
  mit einer Vorschau in der Warteschlange (Datei weg → überspringen). Die Swift-Seite lässt sich
  nur im CI übersetzen; Phase 2 ist bis zum Gerätetest "ungetestet", wie bisher gekennzeichnet.

## Konsequenzen und Risiken
- **Mehr YouTube-Abrufe als heute.** Hören ≫ Importieren; das Bot-Risiko steigt. Gegenmittel: die
  Grenzen oben + Rückfall auf den IFrame. Ob sie reichen, zeigt erst Phase 0.
- **Erbt die bekannte Bruchstelle** (`_YT_CLIENTS`, `visitorData`): bricht der Import, bricht die
  Vorschau mit; Wartungsweg und `_ytDiagnose` gelten unverändert.
- **Zeit bis zum Ton ist bisher nur geschätzt** (2-5 s), nicht gemessen — deshalb Phase 0 zuerst.
- **Rechtslage:** private Nutzung, nichts wird weitergegeben oder auf dem eigenen Konto gehostet
  (Worker und R2 bleiben unberührt). Die YouTube-Nutzungsbedingungen untersagen aber den Zugriff
  außerhalb der angebotenen Player; das gilt schon für den Import und wird durch die Vorschau
  **häufiger**, nicht anders. Das Repo ist öffentlich, der Extraktionscode dort ohnehin einsehbar.
  Ob das für dich vertretbar ist, ist deine Entscheidung, nicht eine technische.

## Offene Fragen an Tyron
1. Nur im WLAN? Auf iOS-Safari gibt es dafür keinen Web-Weg; ginge nur nativ (`NWPathMonitor`, Phase 2).
2. Einstieg nur über die Suche, oder auch beim Einfügen eines Links?
3. Option E (30-Sekunden-Vorschau über iTunes) zusätzlich ja/nein?
4. 200 MB Vorschau-Cache in Ordnung?
