# ADR-013: Offline-Verlaesslichkeit — Ablageort, Inhaltspruefung, Fehlerbehandlung

## Status
Accepted

## Date
2026-08-15

## Context
Seit `4ffb97d` (08.08.2026, ADR-007 Schritt 3) laedt die Huelle Audiodateien selbst in einen
App-Ordner, damit `AVPlayer` offline von Platte liest statt zu streamen. Der Nutzer meldete
danach ein Muster, das sich keiner einzelnen Ursache zuordnen liess: **manche Probleme traten
mit WLAN auf, manche ohne, und dieselbe Aktion verhielt sich mal so, mal so.** Dazu Songs, die
in der Liste stehen, sich anzeigen lassen, aber nicht abspielen.

Die Untersuchung ergab drei unabhaengige Ursachen, die sich gegenseitig verdeckt haben:

**1. Der Cache lag in `Caches/`.** `FileManager.urls(for: .cachesDirectory, …)` ist genau das
Verzeichnis, das iOS bei Speicherdruck **jederzeit selbst leert** — ohne Rueckfrage, auch
waehrend die App laeuft, in beliebiger Teilmenge. Musik, die der Nutzer ausdruecklich offline
vorhaelt, ist damit genau dann weg, wenn er sie braucht. Und weil das vom Speicherstand des
Geraets abhaengt und nicht vom Verhalten der App, wirkte es zufaellig.

**2. Der Download prueft den Inhalt nicht.** `download()` akzeptierte jede Antwort mit
`statusCode == 200` als gueltige Audiodatei. Eine HTML-Fehlerseite, eine leere Antwort oder ein
unterwegs abgebrochener Transfer landete damit als vollwertiger Eintrag im Index. Weil
`beginPlayback()` die lokale Datei **immer** der Netzadresse vorzieht, war so ein Song danach
dauerhaft tot — auch bei bestem Empfang. Das ist die eigentliche Erklaerung fuer "manche Songs
spielen nicht ab": nicht die Datei auf dem Server ist beschaedigt, sondern die lokale Kopie.

**3. Fehler wurden nirgends behandelt.** Beobachtet wurde nur `.readyToPlay`. Ein
`AVPlayerItem` mit `.failed`, ein `AVPlayerItemFailedToPlayToEndTime` und ein Eintrag ohne
abspielbare Adresse liefen allesamt ins Leere. Der Player blieb stumm auf einem Song stehen,
den die Oberflaeche weiter als "laeuft" anzeigte.

Hinzu kam, dass die Huelle ohne Netz mit weisser Flaeche starten konnte: es gab genau einen
Nachladeversuch nach 3 Sekunden, zusaetzlich an `webView.url == nil` geknuepft — nach einer
gescheiterten Navigation steht dort aber meist die Ziel-URL, sodass der Versuch praktisch nie
startete. Und der Service-Worker-Fallback lieferte fuer jeden nicht gecachten Treffer der
eigenen Domain `login.html` aus, was fuer einen Seitenaufruf eine Sackgasse ist: der Login
braucht zwingend den Server (`POST /auth/login`).

## Decision
**Ablageort.** Der Datei-Cache liegt in `Application Support` statt in `Caches`, mit
`isExcludedFromBackup = true`. iOS raeumt dort nicht auf; das Aufraeumen uebernimmt
`enforceCap()`, das es ohnehin schon tut (8-GB-Deckel, LRU). Das Backup-Flag ist Pflicht, sonst
wandern bis zu 8 GB Musik ins iCloud-Backup. Bestehende Dateien **und der alte Index** werden
einmalig mit umgezogen — ohne den Index waeren die verschobenen Dateien unauffindbar und
gleichzeitig unaufraeumbar, weil beide Wege ueber ihn laufen.

**Inhaltspruefung.** Ein Download wird nur uebernommen, wenn Content-Type nach Audio aussieht
(oder fehlt), die Datei mindestens 16 KB gross ist und, sofern der Server eine Laenge genannt
hat, vollstaendig ankam. Sonst wird die temporaere Datei verworfen und nichts indiziert.

**Fehlerbehandlung mit Selbstheilung.** Scheitert ein Song trotzdem, wird **zuerst die lokale
Kopie verworfen und genau einmal vom Server nachgeladen** — der haeufigste Fall ist eine kaputte
Kopie bei intaktem Original. Erst wenn auch das scheitert, gilt der Song als defekt: die Seite
bekommt eine Meldung und der Player springt weiter. Nach fuenf Fehlschlaegen in Folge wird
angehalten statt weiterzuspringen, damit ein flaechiger Ausfall nicht die ganze Warteschlange
lautlos durchrast und am Ende unerklaert stumm dasteht.

**Sichtbarkeit.** Die Meldung geht ueber den bestehenden Rueckkanal an die Seite, die einen
Toast zeigt. Laeuft die App im Hintergrund, kommt der Push beim eingefrorenen Web-Prozess
ohnehin nicht an — und genau das ist gewuenscht: dann wird still uebersprungen. Das
Ueberspringen selbst haengt **nicht** an dieser Meldung, es passiert nativ.

**Start ohne Netz.** Mehrere Ladeversuche mit wachsendem Abstand (2s, 4s, 8s …, gedeckelt bei
30s), ab dem zweiten mit `returnCacheDataElseLoad`, plus ein Versuch beim Zurueckkommen in den
Vordergrund. Der Service Worker liefert fuer Seitenaufrufe `index.html` aus dem Cache statt
`login.html`; die App prueft den Login rein lokal (`himusic_auth` in `localStorage`) und kommt
damit ohne Server aus. Alles andere bekommt einen ehrlichen 503 statt einer falschen Datei.

## Consequences
**Positiv.** Offline ist jetzt ein definierter Zustand statt eines Zufalls: App-Shell und
Songliste liegen lokal, die Musik liegt an einem Ort, den iOS nicht wegraeumt, und ein
kaputter Eintrag heilt sich selbst statt dauerhaft zu blockieren.

**Preis.** Der Speicher zaehlt jetzt gegen "Dokumente & Daten" der App statt gegen den
weglaufenden Cache-Anteil — das faellt dem Nutzer in den iOS-Einstellungen auf. Das ist
gewollt: bis zu 8 GB Musik sollen sichtbar sein, nicht heimlich. Die 16-KB-Untergrenze ist
eine Heuristik; eine echte Audiodatei unter 16 KB (rund eine Sekunde) wuerde faelschlich
verworfen und stattdessen gestreamt.

**Bewusst nicht getan.** Keine Pruefsumme ueber die Datei und kein Dekodier-Test beim
Download — beides waere teuer und faengt nur wenig zusaetzlich, weil der Selbstheilungs-Pfad
den Rest ohnehin abdeckt.

**Offen.** Ob SideStore die Signatur nach 7 Tagen selbst erneuert, ist weiterhin ungeklaert
(siehe Projekt-Akte). Faellt die Huelle aus, greift die Safari-Rueckfallebene — die hat
keinen nativen Datei-Cache und damit kein echtes Hintergrund-Offline.
