# ADR-008: Lautstärke-Boost über Web Audio (Gain + Limiter), Kette nur lazy bei Boost > 100%

## Status
Accepted

## Date
2026-07-26

## Context
Nutzerwunsch: Wiedergabe soll lauter können als das normale Maximum. Das `<audio>`-Element
deckelt `volume` hart bei 1.0 (100%) — mehr geht nur, wenn das Signal durch eine
Web-Audio-Kette läuft. Ein früherer Equalizer-Anlauf über Web Audio war an CORS gescheitert
("wird über Web geblockt"); der Service Worker trägt aus dieser Zeit noch vorbereitete
CORS-Header auf seinen synthetischen Range-Antworten (sw.js, Kommentar "Web-Audio-Equalizer").

Randbedingungen:
- Web Audio darf fremde Quellen nur anfassen, wenn das `<audio>`-Element mit
  `crossOrigin="anonymous"` lädt UND der Server CORS-Header liefert — sonst liefert die
  Kette nur Stille ("tainted"). Der Worker liefert `Access-Control-Allow-Origin: *` auf
  allen Antworten (live per curl verifiziert, auch auf 404). blob:-URLs aus dem
  IndexedDB-Offline-Cache sind same-origin und brauchen nichts davon.
- `createMediaElementSource()` ist eine Einbahnstraße: einmal verbunden, läuft das Element
  für immer durch den AudioContext. iOS pausiert AudioContexte gern (Sperrbildschirm,
  App-Wechsel) — das Projekt hat dokumentierte iOS-Hintergrund-Audio-Probleme, die dadurch
  schlimmer werden könnten.
- Digitale Verstärkung über 1.0 übersteuert (Clipping/Verzerrung), wenn nichts die
  Pegelspitzen abfängt.

## Decision
Boost-Regler in den Settings (100–300%, persistiert als `heatbox_state.boost`):

- **Kette nur lazy**: `MediaElementSource → GainNode → DynamicsCompressor → Lautsprecher`
  wird erst aufgebaut, wenn Boost tatsächlich > 100% ist (beim ersten Play bzw. beim
  Hochziehen des Reglers). Bei Standard 100% bleibt der Wiedergabepfad **komplett
  unangetastet** — kein neues iOS-Risiko für alle, die den Boost nie benutzen.
- **DynamicsCompressor als Limiter** (threshold −3 dB, knee 0, ratio 20, attack 2 ms):
  fängt Übersteuern ab, statt hörbar zu clippen.
- **crossOrigin nur bei aktivem Boost**: wird beim App-Start (persistierter Boost > 1)
  vor dem src-Setzen bzw. beim ersten Hochregeln gesetzt (laufender Song wird einmal mit
  Positions-Erhalt neu geladen, Attribut wirkt erst beim Laden).
- **Sicherheitsnetz**: Ladefehler im crossOrigin-Modus (falls je eine Song-URL ohne
  CORS-Header auftaucht) deaktiviert den Boost automatisch, persistiert das sofort
  (nicht debounced) und lädt den Song ohne CORS-Modus neu — lieber normale Lautstärke
  als gar keine Musik. Nur einmal pro Session und nur online, damit Offline-503s den
  Boost nicht fälschlich abschalten.
- **AudioContext-Wachhalten**: `resume()` auf play/playing/visibilitychange/statechange,
  weil iOS den Context sonst stumm einschlafen lässt.
- `window._boostDebug` (ctx/gain/limiter) als Debug-Haken für Tests/Fehlersuche.

Verifiziert per Playwright + AnalyserNode gegen die echte App: Faktor 2.00 bei 200%,
2.50 bei 250% (RMS hinter dem GainNode, Sinuston unterhalb der Limiter-Schwelle).
Direkt nach dem Kettenaufbau gibt es eine kurze (<1 s) Umschalt-Transiente, einmalig
pro Session — akzeptiert.

## Alternatives Considered

### Kette immer aufbauen (auch bei 100%)
- Pros: kein Umschalt-Moment beim ersten Hochregeln, einheitlicher Codepfad.
- Rejected: Jede Wiedergabe liefe dauerhaft durch einen AudioContext, den iOS im
  Hintergrund pausieren kann — genau das dokumentierte Freeze-Risiko, auch für Nutzer,
  die den Boost nie anfassen. Einbahnstraßen-Charakter von `createMediaElementSource`
  macht das irreversibel pro Seiten-Lebensdauer.

### Nur GainNode ohne Limiter
- Pros: simpler.
- Rejected: Verstärkung über 1.0 clippt hörbar bei lauten Songs; Verzerrung wäre als
  "kaputte Qualität" wahrgenommen worden — das Gegenteil des Nutzerwunschs.

### Lautstärke-Normalisierung/ReplayGain statt Boost
- Pros: "richtige" Lösung gegen leise Songs.
- Rejected (vorerst): erfordert Pegel-Analyse aller Dateien (Rechenzeit, Komplexität);
  der Nutzerwunsch war explizit "lauter als Maximum", nicht "gleich laut".

## Consequences
- Boost wirkt nur in der Web-App, nicht beim Hand-off an die native Player-App.
- Solange Boost > 100% gesetzt ist, läuft die Wiedergabe durch den AudioContext —
  falls iOS-Hintergrund-Aussetzer damit zunehmen, ist Runterregeln auf 100% + App-Neustart
  der saubere Rückweg (Kette wird nach Neustart gar nicht erst aufgebaut).
- Sollten künftig Song-URLs von Hosts ohne CORS-Header dazukommen, spielt die App sie
  dank Sicherheitsnetz normal (ohne Boost) ab; der Boost schaltet sich dann selbst ab.
