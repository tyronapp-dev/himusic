# ADR-012: Herkunft eines Songs haengt am Song, nicht an der Sitzung

## Status
Accepted

## Date
2026-08-15

## Context
Seit `2011edd` (13.08.2026) zeigt der grosse Player unter dem Cover eine Herkunfts-Kennung:
"Aus Vibe Mix: LD", "Aus Playlist: …", "Aus Sender: …". Sie wurde bei jedem Anzeigen frisch
aus `window.currentPlayingPlaylistId` abgeleitet (`_describePlaybackSource()` in `app2.js`).

Der Nutzer meldete, dass dort regelmaessig eine Quelle steht, aus der der laufende Song gar
nicht stammt. Der eindeutige Beleg: **Songs ohne einen einzigen Vibe** trugen die Kennung
eines Vibe-Mixes — sie koennen per Definition in keinem Vibe-Mix enthalten sein.

**Root Cause.** `currentPlayingPlaylistId` ist eine globale Variable, die nur an den Stellen
gesetzt wird, an denen eine Quelle *gestartet* wird (`togglePlaylistPlayback`, die
Playlist-Detail-Knoepfe, der Songlisten-Tap). Seit der nativen Huelle (ADR-007) fuehrt aber
nicht mehr die Seite die Warteschlange, sondern der native `AVPlayer`. Der laeuft eigenstaendig
weiter, und zwar an mindestens vier Stellen, an denen die Seite gar nicht beteiligt ist:

- Auto-Skip am Songende, waehrend die App im Hintergrund ist
- Skip ueber Control Center oder Sperrbildschirm
- ein per Rechts-Swipe eingereihter Song (`insertNext`)
- Wiederherstellen der letzten Sitzung nach echtem App-Neustart

In all diesen Faellen aktualisiert der Rueckkanal (`_applyNativeNowPlaying`) zwar
`currentPlayingSongId`, fasst `currentPlayingPlaylistId` aber nicht an. Die Variable bleibt
auf dem zuletzt *gestarteten* Kontext stehen und beschriftet ab da jeden Song mit einer
Herkunft, die fuer ihn nie galt.

Der bereits vorhandene Behelf — eine Merkliste `_manuallyQueuedIds` fuer von Hand eingereihte
Songs — konnte das nicht auffangen: sie lebt nur im Arbeitsspeicher der Seite und ist nach
jedem Reload leer. In der Huelle laedt iOS die Seite regelmaessig neu (WKWebView-Inhaltsprozess
unter Speicherdruck), der eingereihte Song trug danach wieder das alte Etikett.

Das ist **exakt die Fehlerklasse aus ADR-011**: zwei Kopien desselben Zustands, von denen eine
die Wahrheit ist (native Warteschlange) und die andere nachgefuehrt werden muesste. Dort war
die Lehre, die Zweitkopie zu entfernen statt sie besser zu synchronisieren.

## Decision
Die Herkunft wird **einmal beim Start einer Quelle** ausgewertet und als Feld `s` an jeden
`QueueItem` der uebergebenen Warteschlange geheftet. Sie wandert mit dem Song durch den
nativen Player und kommt mit ihm ueber den Rueckkanal zurueck (`payload.s` →
`window._nativeSourceLabel`). Das Badge liest in der Huelle **ausschliesslich** diesen Wert.

Ein von Hand eingereihter Song bekommt ausdruecklich `s: ""` — "kommt aus keiner Quelle" — statt
dass das Feld weggelassen wird. Der Unterschied ist bedeutungstragend: `null` heisst "noch
nichts gemeldet" (Badge aus), `""` heisst "gehoert zu nichts" (Badge aus, aber bewusst).

Die lokale Ableitung wird in der Huelle **nicht** als Rueckfallebene benutzt. Genau das waere
der Fehler von vorher. Ausserhalb der Huelle (Safari-Rueckfallebene, falls die 7-Tage-Signatur
ablaeuft) fuehrt die Seite die Warteschlange selbst — dort bleibt die Ableitung samt
`_manuallyQueuedIds` richtig und in Kraft.

## Consequences
**Positiv.** Die Anzeige kann strukturell nicht mehr falsch werden: es gibt keinen Zustand
mehr, der auseinanderlaufen koennte. Sie ueberlebt Seiten-Reloads, Hintergrund-Skips und den
App-Neustart, weil sie Teil des persistierten `PlaybackSnapshot` ist.

**Preis.** Die Herkunft ist ein Schnappschuss vom Startzeitpunkt. Wird ein Vibe-Mix
*umbenannt*, waehrend er laeuft, zeigt das Badge bis zum naechsten Start den alten Namen.
Bewusst akzeptiert — ein falscher Name ist harmlos gegen eine falsche Zugehoerigkeit, und der
Fall ist selten.

**Kompatibilitaet.** `s` ist optional (`String?`). Ein vor dieser Aenderung gespeicherter
`PlaybackSnapshot` dekodiert weiter; die betroffenen Songs zeigen dann kein Badge, bis die
Quelle einmal neu gestartet wird.

**Regel fuer kuenftige Anzeigen.** Alles, was etwas ueber den *laufenden* Song aussagt, gehoert
an den `QueueItem` und nicht in eine Variable der Seite. Die Seite weiss nicht, was laeuft — sie
erfaehrt es.
