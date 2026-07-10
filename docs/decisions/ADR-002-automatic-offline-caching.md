# ADR-002: Bibliothek wird automatisch im Hintergrund gecacht, statt nur auf Wunsch

## Status
Accepted

## Date
2026-07-09

## Context
Himusic Cloud speichert Audio für Offline-Wiedergabe in IndexedDB (`HeatBoxAudio`-Datenbank,
siehe CLAUDE.md → "Offline / caching layers"). Es gab zwei Wege, wie ein Song dort landete:

1. Manuell über einen "Alle Songs offline speichern"-Button (bulk-Download, 6 parallele
   Verbindungen).
2. Automatisch im Hintergrund — aber NUR wenn der Nutzer den Offline-Modus-Schalter aktiv
   eingeschaltet hatte (`localStorage: himusic_offline === '1'`).

Die Funktion `startBackgroundCacheQueue()` (app2.js) existierte bereits vollständig und lief
mit 3 parallelen Downloads, war aber an diese Bedingung gekoppelt. Der Grund für diese Kopplung
stand im Code dokumentiert: unbedingtes Hintergrund-Caching hatte bei 2000+ Songs ~14 GB auf
einmal im Hintergrund gezogen und die App dauerhaft langsam gemacht.

Nutzer-Wunsch: die gesamte Bibliothek soll automatisch offline verfügbar sein, ohne dass man
den Button oder den Offline-Schalter manuell betätigen muss.

## Decision
`startBackgroundCacheQueue()` läuft jetzt **immer** nach jedem Laden der Bibliothek
(`fetchSongsFromDatabase`), unabhängig vom Offline-Schalter — aber bewusst gedrosselt:
- `IDLE_PARALLEL` von 3 auf **1** parallele Verbindung reduziert.
- Pausiert komplett, solange gerade ein Song abgespielt wird (`player && !player.paused`),
  damit Hintergrund-Downloads nicht mit dem Streaming um Bandbreite konkurrieren.
- Der manuelle "Alle Songs offline speichern"-Button bleibt bei 12 parallelen Verbindungen
  (siehe unten) — er ist ein bewusster, einmaliger "Ich will das JETZT, sofort"-Vorgang und
  folgt daher nicht der gleichen Drosselungslogik wie der beiläufige Hintergrund-Sync.

## Alternatives Considered

### Alles unverändert lassen (nur Offline-Modus-Schalter)
- Pros: Kein Risiko für erneute Performance-Probleme.
- Rejected: Widerspricht dem expliziten Nutzerwunsch nach "kein manuelles Anstoßen mehr".

### Automatisch, aber mit gleicher Parallelität wie vorher (3 gleichzeitig)
- Pros: Schneller fertig.
- Cons: Genau das war die Ursache des ursprünglichen Performance-Problems bei großen
  Bibliotheken — nur diesmal würde es JEDEN App-Start betreffen, nicht nur den expliziten
  Offline-Modus.
- Rejected: Nutzer wählte explizit "automatisch, aber gedrosselt" aus mehreren vorgeschlagenen
  Optionen (siehe Optionsvergleich in der Session).

### Nur neu importierte Songs automatisch, Altbestand bleibt manuell
- Wurde als Alternative angeboten, aber nicht gewählt.

## Consequences
- Speicherverbrauch wächst jetzt dauerhaft mit der Bibliotheksgröße mit, ohne dass der Nutzer
  aktiv etwas tut — es gibt **keinen** automatischen Cleanup-/Eviction-Mechanismus für alte oder
  lange nicht gespielte Songs (separat notiert, siehe CLAUDE.md-Frage dazu in der Session). Bei
  sehr großen Bibliotheken kann der Browser-Speicher (insbesondere iOS Safari) irgendwann unter
  Druck geraten und Teile des Caches eigenmächtig verwerfen.
- Bei 1 paralleler Verbindung dauert das initiale Vollcachen einer großen Bibliothek entsprechend
  lange (verteilt sich über viele App-Sitzungen, falls die App nicht durchgehend offen bleibt) —
  das ist beabsichtigt (Priorität: App-Performance über Cache-Geschwindigkeit).
- Relevanter Code: `app2.js` Funktion `startBackgroundCacheQueue` (~Zeile 648 ff.), Aufruf in
  `fetchSongsFromDatabase` (~Zeile 1170).
