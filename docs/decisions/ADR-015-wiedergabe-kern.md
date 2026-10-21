# ADR-015: Wiedergabe-Kern umgebaut — Ursachen statt Symptome (Titelwechsel, Zeitleiste, Sperrbildschirm, Skip-Verzögerung)

## Status
Accepted — Code fertig und im CI-Build grün, **am Gerät noch nicht getestet** (siehe "Offen / Gerätetest").

## Date
2026-10-21

## Context
Der Nutzer meldete nach längerer Nutzung fünf Fehler, ausdrücklich als **wiederkehrend** ("schon mehrere Male angesprochen"):

1. Bei gesperrtem Handy springt der Player am Songende manchmal nicht zum nächsten Song, bis man entsperrt und die App öffnet.
2. Zeitleiste: Tippen auf eine Stelle landet meist nicht dort, die Position "setzt sich ein ganzes Stück zurück", egal wie oft man tippt.
3. Sperrbildschirm: Anzeige "-:--" ohne Fortschritt, Weiter/Zurück tun nichts, obwohl Musik läuft. Außerdem: nach einer Suche soll ein Tipp auf einen Tab der unteren Leiste die Standardansicht zeigen.
4. Skippen hat spürbare Verzögerungen — es soll flüssig laufen wie bei Spotify, mit WLAN, ohne WLAN, in allen Zuständen.
5. Suche: die Tastatur nimmt zu viel Platz, die Mini-Leiste rutscht mit nach oben.

### Wie diese Fehler bisher "gelöst" wurden — und warum das nicht gehalten hat
Allein die Zeitleiste hat in der Git-Historie **neun** Korrekturen: `2c51716` (Brücken-Befehl `seekTo`), `ed4af14` (Zeitbasis/Toleranz/Vormerken), `69bea4d` (Wisch-Handler entfernt), `8723bf2` (gemessene Dauer hat Vorrang), `f7eeac4` (Obergrenze), `5559d16` ("root cause": präzise Zeitbasis), `6e9e217` (Takt unterdrücken), `6c99354` (Zähler-Leck), `7724df9` (Sprung als Prozent vormerken). **Jede war ein echter Fehler, keine hat das Fundament angefasst.** Gemeinsames Muster: ein Wert (die Dauer) lag an drei Stellen in drei Fassungen vor, ein Zustand (Position) an zwei Stellen, und jede Korrektur flickte eine Naht dazwischen. Auch `5559d16` nannte sich "root cause" und war es nicht.

## Messung (2026-10-21, lesend gegen den eigenen Worker, nur Summen)
| Messwert | Ergebnis | Warum wichtig |
|---|---|---|
| Songs / Gesamtgröße | 2188 / 12,3 GB | Cache-Grenze ist 8 GB → nur ~65 % passen |
| Formate | 1426 mp3, 360 m4a, 396 mp4, 6 wav | MP3 hat keine exakte Zeitbasis ohne vollständigen Scan |
| `duration == 0` in der DB | **1449 von 2188 (66 %)** | Die Seite kennt bei zwei Dritteln der Songs keine Dauer; sie muss vom Player kommen |
| Eingebettete Cover (`data:`) | 117 Songs, 16,8 MB (max 529 KB) | Jeder Antipp schickte ~12 MB JSON über die Brücke |

## Ursachen (belegt = im Code/den Daten nachgewiesen; Hypothese = plausibel, nicht am Gerät beobachtet)
1. **Vorlade-Cache verhungerte — belegt.** `AudioFileCache` war eine FIFO-Warteschlange mit einer Spur. `restoreLastSession` reihte bei **jedem App-Start die komplette gespeicherte Warteschlange** (bis über 2000 Songs) ein, die Seite reihte für **jeden Song der Bibliothek** einen Eintrag nach (`_nativeEnsureCached` in der Hintergrund-Spur), und weil Bibliothek (12,3 GB) > Grenze (8 GB), verdrängte jeder neue Download per LRU einen alten, der beim nächsten Start wieder eingereiht wurde: ein **Dauerlauf von mehreren GB**. Die 15 Songs hinter dem laufenden standen deshalb hinter Altlasten; ein Skip landete meist auf einem nicht gecachten Song → **Stream**. Ein Stream hat keine verlässliche Dauer, kein sample-genaues Seeking, braucht Netz, startet langsamer. Das ist die gemeinsame Wurzel von Fehler 2 (teilweise), 3 ("-:--") und 4.
2. **Titelwechsel hing an App-Code — belegt im Code, Folge Hypothese.** `AVPlayerItemDidPlayToEndTime` → `Task` → mehrere `await` (Cache-Actor, optional Download-Wartezeit, `replaceCurrentItem`). Bei gesperrtem Handy schweigt der Ton in dieser Lücke; iOS darf den Prozess einfrieren. Genau das beschreibt Fehler 1 ("erst nach Entsperren"). Das "ab und zu" passt dazu, weil es von Netz/Cache-Treffer abhing.
3. **Sperrbildschirm wurde einmalig ohne Dauer befüllt — belegt.** `updateNowPlayingInfo()` setzte die Dauer nur, wenn bekannt; bei Streams steht sie oft erst **nach** `.readyToPlay` fest, es gab keinen Beobachter auf `duration`. Dazu: bei 66 % der Songs steht in der DB 0, es gab also keinen Notbehelf.
4. **Dauer in drei Quellen — belegt.** Seite (DB-Wert oder erster Tick), Player (eigener Wert), Sperrbildschirm (nur wenn bekannt). Jede Abweichung zeigte sich als "Zeitleiste landet daneben".
5. **12-MB-Handoff + 12-MB-Snapshot auf dem Main-Thread — belegt (Messung).** `saveSnapshot()` kodierte alle 10 s und bei jedem Songwechsel die ganze Warteschlange nach `UserDefaults` — spürbare Hakler beim Skippen.
6. **Landung des Sprungs wurde nie geprüft — belegt.** Der Abschluss-Handler von `player.seek` räumte nur auf; ein Sprung, der nicht (oder woanders) landete, fiel niemandem auf. **Was bei Fehler 2 am Gerät konkret schiefging, ist nicht bewiesen** (Streams ohne präzise Zeitbasis, unterbrochene Sprünge, Überschreiben der Anzeige). Deshalb wird es jetzt gemessen statt vermutet (Protokoll).
7. Kleiner Beitrag, belegt: iOS erzeugt nach einem Touch zusätzlich synthetische Maus-Ereignisse; ein Tipp lief zweimal durch dieselbe Logik. Außerdem überschrieb der Sekundentakt die Anzeige, solange der Finger auf der Leiste lag.
8. **Fortsetzung fehlte — belegt.** Die native Warteschlange ist genau die Liste, aus der man gestartet hat (Playlist, Vibe-Filter, kleiner Sender). Danach `next()` → stilles `return`, der Player zeigte weiter "spielt".

## Decision
**Native Hülle**
- **AVQueuePlayer mit vorgeladenem Nachfolger** (`PlayerViewModel.prepareNext`). Beim Titelende wechselt das **System** selbst, ohne dass App-Code laufen muss — auch bei gesperrtem Handy, ohne Lücke. Skip auf den vorgeladenen Titel ist `advanceToNextItem()` (sofort, kein Neuaufbau). Nur Antippen/Sprung/Zurück/Fehler setzen hart neu auf. Ein ersatzweiser harter Start läuft unter einer Hintergrundaufgabe (`BackgroundAssertion`).
- **Der Start wartet nie mehr auf einen Download** (vorher bis 1,5 s, davor länger): lokal falls da, sonst sofort streamen und die Datei mit Priorität nachholen.
- **`AudioFileCache` mit zwei Prioritäten:** *dringend* (laufender Song + Fenster von 15, ersetzt bei jedem Wechsel den alten Stand, bis 2 parallel) und *Auffüllen* (Rest der Bibliothek, nur im Leerlauf, nur unter **7 GB**, **verdrängt nie etwas**). Restore lädt nur noch das Fenster. Index wird gebündelt statt bei jedem Zugriff komplett geschrieben. Pro Datei wird die **sample-genaue Dauer** gemessen und gespeichert.
- **Eine Funktion für die Dauer** (`effectiveDuration`): lokale Datei → Messung des Players; Stream → gespeicherte Messung, dann DB-Wert, dann Schätzung des Players. Gleiche Quelle für Sperrbildschirm, Seite, Sprung-Umrechnung und Begrenzung.
- **Sprung als Anteil** (`seekTo` mit `fraction`): der Player rechnet mit seiner eigenen Dauer, merkt vor, bis sie feststeht, und **prüft die Landung** (`seekExactly`): weicht sie um > 2 s ab oder bricht der Sprung ab, **einmal Wiederholung mit Toleranz**. Bei einem Stream mit inzwischen vorhandener lokaler Kopie wird erst auf die Datei umgestellt. Jeder Sprung steht im Protokoll.
- **Sperrbildschirm:** Beobachter auf `duration` pro Titel, vollständige Info bei jedem Ereignis (Wechsel, Play/Pause, Dauer, Sprung) und im Sekundentakt, `IsLiveStream=false`, `playbackState`, Remote-Commands ausdrücklich aktiviert und mit Sprung auf den Main-Thread. Unterbrechungen (Anruf, Siri, Wecker) und getrennte Kopfhörer gleichen den Zustand an (`isPlaying` blieb sonst auf "spielt").
- **Warteschlange nicht mehr als Blob in `UserDefaults`:** Datei, abseits des Main-Threads, ohne `data:`-Cover; Position (drei Zahlen) getrennt. Der alte Blob wird beim ersten Start entfernt.
- **Tastatur:** `KeyboardObserver` blendet die Mini-Leiste aus; die Seite bekommt `kb-open` (Navigation gleitet weg).
- **`PlaybackJournal`:** Ereignisprotokoll **auf Platte**, läuft auch im Hintergrund, überlebt Neustart; **Build-Kennung** (`HimusicBuild.id`) der Hülle.
- `navigator.mediaSession` der Seite wird in der Hülle stillgelegt (Hauptframe). *Absicherung, kein belegter Fehler:* in der Hülle registriert die Seite sie ohnehin nicht (`playSong` nimmt den Handoff-Zweig), WebKit hängt aber seine Medien-Sitzung an dieselbe System-Schnittstelle.

**Seite**
- Zeitleiste sendet den Anteil; genau ein Sprung pro Tipp; die Anzeige gehört beim Ziehen dem Finger. Ältere Hüllen (ohne Fähigkeit `seekFraction`) bekommen weiter Sekunden — **Fähigkeiten statt Versionsabfrage** (`window.__himusicNativeCaps`).
- **Fortsetzung am Listenende:** weniger als 30 Folgesongs → 200 Songs mit der größten Vibe-Ähnlichkeit (`_continuationTail`, dieselbe Ähnlichkeit wie bei Sendern) hängen in der nativen Warteschlange dran; Etikett "Danach: ähnliche Songs"; abschaltbar mit `localStorage himusic_autocontinue = '0'`.
- **Eingebettete Cover** nur für die ersten 25 Songs der Warteschlange; fehlende liefert die Seite per `setCover` nach, wenn der Song dran ist (Handoff von ~12 MB auf ~20 KB).
- **Tab-Leiste:** Tipp zeigt die Standardansicht (Suche geleert, nach oben, Tastatur weg); auf dem aktiven Tab scrollt er sanft nach oben. Ein aktiver Vibe-Filter bleibt bewusst bestehen.
- **Tastatur:** Navigation raus, Scrollen/Enter schließt die Tastatur, `enterkeyhint="search"`, Autokorrektur in den Suchfeldern aus (sie "verbesserte" Künstlernamen).
- **Kein doppeltes Caching in der Hülle:** die Seite lädt die Bibliothek dort nicht mehr in die IndexedDB (der Player liest sie nie), sondern schickt sie **einmal** zum Auffüllen an die Hülle. "Offline"-Haken und Zähler kommen aus dem nativen Cache-Stand.
- **Einstellungen → Wiedergabe-Diagnose:** zeigt Fassung von Seite und Hülle, die letzten Songstarts und das Ereignisprotokoll, zum Kopieren.

## Alternatives Considered
- **Weiter patchen (zehnte Zeitleisten-Korrektur).** Verworfen: das Muster ist dokumentiert, jede Korrektur schiebt das Problem an die nächste Naht.
- **Eigene Streaming-Engine mit progressivem Cache (wie Spotify, `AVAssetResourceLoader`).** Verworfen: sehr großer Aufwand, ohne Gerätezugriff nicht zu verifizieren. Stattdessen wird dafür gesorgt, dass fast immer **lokal** gespielt wird; der Stream ist der Notfall.
- **Alles vorab herunterladen.** Unmöglich: 12,3 GB > 8 GB.
- **Grenze von 8 GB anheben.** Nicht entschieden (Speicherplatz auf dem Gerät ist Sache des Nutzers); `AudioFileCache.capBytes` ist die eine Stellschraube.
- **Seite rechnet weiter mit Sekunden.** Verworfen: sie kennt bei 66 % der Songs keine Dauer.

## Consequences
- **Neue IPA nötig** (alles unter `native-player/`). Die Seite ist sofort live und bleibt mit der alten Hülle kompatibel (altes Verhalten, ohne die neuen Funktionen).
- **Gewollte Verhaltensänderung:** nach dem Ende einer Playlist/eines Filters spielt die App **weiter** (ähnliche Songs) statt stehenzubleiben. Abschaltbar.
- Der Auffüll-Cache hört bei 7 GB auf. Danach kommen weitere Songs über das Vorladen beim Hören. Wer mehr lokal will, hebt `capBytes` und `backgroundFillCeiling` an.
- Die bisher gefüllte **IndexedDB der Seite (mehrere GB, von der Hülle nie gelesen)** bleibt liegen, bis man in Einstellungen → Offline-Modus → "Alle offline gespeicherten Songs löschen" drückt. Das gibt den Platz frei und berührt den nativen Cache nicht.
- "Jetzt herunterladen" im Offline-Dialog löst in der Hülle nur noch das native Auffüllen aus.
- Preis: ein größerer, weniger vertrauter Player-Kern (`Track`, `prepareNext`, `advanceBookkeeping`). Er ist dafür an einer Stelle erklärt (diese Datei + Kommentare).

## Offen / Gerätetest
Am Gerät **nicht** prüfbar von hier; die Prüfpunkte nennen, was im Protokoll stehen müsste:
1. **Gesperrt, Songende:** Handy sperren, einen Song bis zum Ende laufen lassen. Erwartet: Zeile `Wechsel i->j (automatisch) … [lokal]`, **ohne** Zeile `harter Start (Rückfall)`. Steht dort `Nachfolger vorgeladen: nein`, ist der Nachfolger nicht rechtzeitig gebaut worden (→ Hypothese 2 muss nachgeschärft werden).
2. **Zeitleiste:** an verschiedenen Stellen tippen, auch bei einem frisch übersprungenen Song (Stream). Erwartet: `Sprung Ziel x s -> gelandet y s (ok, Abweichung < 2 s …)`. Bleibt ein Fehler, steht dort **Quelle (Stream/lokal), Abweichung und Versuchszahl** — das ist die Information, die bisher fehlte.
3. **Sperrbildschirm:** Zeit sichtbar? Tasten wirken? Erwartet: `Fernbedienung: Weiter` im Protokoll bei jedem Tipp. Fehlt die Zeile, kam der Befehl nicht in der App an (dann ist es iOS/Now-Playing-Zuständigkeit, nicht der Player).
4. **Skip-Fluss:** mehrfach schnell weiter. Erwartet: `Wechsel … (Skip)`. Zeilen `Start … [Stream] nach … ms` zeigen, wann doch gestreamt wurde.
5. **Offline** (Flugmodus): Songs im Fenster müssen weiterspielen; `Cache:`-Zeilen zeigen Fehlschläge.
6. **Tastatur:** Suchen — Navigation weg, Leiste weg, Scrollen schließt die Tastatur.
7. **Was nicht entschieden ist:** ob `AVQueuePlayer` einen *defekten* Titel selbst überspringt (angenommen ja, Buchführung fängt beide Reihenfolgen ab); ob iOS bei `advanceToNextItem()` `currentItem` synchron setzt (die Buchführung ist dagegen abgesichert).

## Nächste Wiederkehr eines dieser Fehler
**Zuerst Einstellungen → Wiedergabe-Diagnose öffnen, kopieren, lesen — nicht den Code raten.** Das Protokoll läuft auch bei gesperrtem Handy mit.
