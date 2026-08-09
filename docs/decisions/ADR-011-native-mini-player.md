# ADR-011: Native Mini-Player-Leiste statt Web-Bruecken-Sync

## Status
Accepted

## Date
2026-08-09

## Context
Seit der nativen Huelle (ADR-007) laeuft die Oberflaeche als Webseite in einem WKWebView,
der Ton nativ ueber `AVPlayer`. Damit die Webseite ueberhaupt weiss, was der native Player
gerade tut (fuer ihre eigene Mini-/Grossplayer-Anzeige und den Play/Pause-Knopf), musste ihr
Zustand per `WKWebView.evaluateJavaScript()` aus Swift heraus nachgefuehrt werden
(`onNowPlayingChanged` -> `_applyNativeNowPlaying`, siehe Commit `4c93fda`).

Nach zwei Nachbesserungsrunden (Race-Condition-Fix `7d572ec`, Bridge-Kommando fuers
Play/Pause + Vordergrund-Resync `d953b21`) meldete der Nutzer beim dritten Test weiterhin
dieselbe Symptomklasse: falscher Play/Pause-Zustand, falscher Song/Cover nach einer
Control-Center-Aktion aus einer anderen App heraus. Nach der eigenen Eskalationsregel
(dritte Meldung, zwei gescheiterte Fixes -> Ansatz wechseln statt weiterpatchen) wurde
verifiziert, dass die zuletzt gebaute IPA tatsaechlich installiert war (Build-SHA im
CI-Lauf stimmte exakt mit dem getesteten Commit ueberein) - das Problem war also nicht
"Fix nicht angekommen", sondern strukturell.

**Root Cause:** `evaluateJavaScript()` an ein WKWebView, dessen Webinhalts-Prozess im
Hintergrund suspendiert sein kann (App nicht im Vordergrund, z.B. waehrend man in einer
anderen App ist), ist ein Fire-and-forget-Aufruf ohne Zustellgarantie. Jede Aktion, die
waehrend dieses Fensters passiert (typischerweise Control-Center-Interaktionen aus einer
anderen App heraus), kann den Sync-Push verlieren. Es gibt kein zuverlaessiges Signal, WANN
das WKWebView wieder bereit ist - der Vordergrund-Resync (`d953b21`) deckt nur den Fall ab,
dass die App danach ueberhaupt wieder geoeffnet wird, nicht jede Zwischenaktion.

Vergleich mit etablierten Player-Apps (Spotify, Deezer): deren Bedienelemente sind nativ
und lesen den Player-Zustand direkt (z.B. Combine/KVO), nicht ueber einen seriellen
Nachrichtenkanal zwischen zwei getrennten Laufzeiten. Es gibt dort strukturell keine zwei
Kopien des Zustands, die auseinanderlaufen koennten.

## Decision
Die Mini-Player-Leiste (Cover, Titel, Artist, Play/Pause, Skip vor/zurueck) wird nativ in
SwiftUI gebaut (`NativePlayerBar.swift`) und bindet sich direkt an `PlayerViewModel` per
`@ObservedObject`/`@Published` - dieselbe Quelle, die auch `MPNowPlayingInfoCenter` fuehrt.
Kein Nachrichtenkanal, keine Serialisierung, keine Zustellgarantie noetig: SwiftUI rendert
bei jeder Aenderung von `isPlaying`/`currentItem` automatisch neu, weil es dieselbe
In-Memory-Quelle liest statt eine Kopie zu pflegen.

Die Web-eigene Mini-Leiste (`#mini-player`) wird per frueh injiziertem CSS
(`WKUserScript`, `atDocumentStart`) ausgeblendet, damit nicht zwei Leisten uebereinander
sitzen. Tippen auf die native Leiste (ausserhalb der Steuerknoepfe) oeffnet weiterhin den
grossen Web-Player (`#fullscreen-player.classList.add('open')`), ueber eine lokale
`NotificationCenter`-Nachricht an `WebShellView.Coordinator` - dieselbe Funktion, die die
ersetzte Web-Leiste per Klick auch ausloeste.

**Der bisherige Rueckkanal (`onNowPlayingChanged` -> `_applyNativeNowPlaying`,
Vordergrund-Resync) bleibt bestehen** - er haelt weiterhin Grossplayer, Home-Widget und
`heatbox_state` synchron, die alle web-gerendert bleiben. Nur die IMMER SICHTBARE,
kritischste Flaeche (Mini-Leiste) wurde strukturell aus der Fehlerklasse herausgenommen.

## Alternatives Considered
### Rueckkanal noch robuster machen (Bestaetigungs-Handshake, Retry-Queue)
- Rejected fuer die Mini-Leiste: wuerde die Fehlerklasse nur verkleinern, nicht eliminieren
  - jedes Retry-Fenster hat wieder eine Luecke. Fuer eine staendig sichtbare
  Kernsteuerung, bei der Nutzer sofort Falsches sehen, ist "kann strukturell nicht
  divergieren" der einzige Standard, der wirklich haelt.

### Komplette Oberflaeche nativ nachbauen
- Rejected: verwirft den zentralen Vorteil der Huelle (UI-Aenderungen rollen sofort ueber
  GitHub Pages aus, kein App-Neubau) fuer den gesamten ~4500-Zeilen-Funktionsumfang
  (Bibliothek, Suche, Import, Tag-Editor, Playlists). Nur die Flaeche nativ bauen, die
  tatsaechlich staendig sichtbar UND fehleranfaellig war.

## Consequences
- Play/Pause, Skip, Song-/Cover-Anzeige in der Mini-Leiste koennen strukturell nicht mehr
  vom echten `AVPlayer`-Zustand abweichen.
- Grossplayer und Home-Widget haengen weiterhin am bestehenden (verbesserten, aber nicht
  perfekten) Rueckkanal - bei ihnen bleibt ein kleines Restrisiko einer kurzzeitig
  veralteten Anzeige, bis das naechste Sync-Event greift. Niedrigeres Risiko als vorher,
  da sie seltener sichtbar sind (erst nach Antippen) und der Vordergrund-Resync meist schon
  gegriffen hat, bevor der Nutzer dorthin navigiert.
- Cover-Bild in der nativen Leiste laedt unabhaengig vom bereits in `PlayerViewModel`
  gepflegten `MPMediaItemArtwork`-Cache (eigener kleiner `URLSession`-Fetch) - bewusst
  einfach gehalten statt den privaten Cache zu teilen, doppelter Netzwerk-Request pro
  Songwechsel als akzeptierter Kompromiss.
- Zusaetzliche, wartungsbeduerftige SwiftUI-Flaeche, die UI-Aenderungen an dieser einen
  Stelle (Mini-Leiste) jetzt doch einen App-Neubau erfordert - Trade-off bewusst eingegangen,
  weil genau diese Flaeche der wiederholt gemeldete Bug-Herd war.
