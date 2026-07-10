# ADR-001: Background-Sync gibt nach mehreren Fehlversuchen auf, statt endlos zu retryen

## Status
Accepted

## Date
2026-07-09

## Context
Songs, die per YouTube-Import in die Bibliothek kommen, landen ohne Cover/Künstler
(`artist: "Unbekannt"`, `cover_data: ""`) in der Datenbank — YouTube liefert nur einen
Videotitel, keine sauberen Musik-Metadaten. Ein Hintergrund-Prozess (`processBackgroundSync`
in `app2.js`) sucht deshalb automatisch bei externen Metadaten-Quellen nach Titel/Künstler/Cover
und trägt sie nach.

Ursprünglich fragte der Sync ausschließlich iTunes an. Nutzer-Symptom: ~200 Songs standen seit
Tagen mit der Meldung "später erneut versuchen" fest, ohne je fertig zu werden. Root Cause: der
Sync retryte Songs ohne Treffer für immer (exponentielles Backoff, gedeckelt bei 10 Min), ohne
Ausstiegspunkt. Das war kein Netzwerkfehler — iTunes antwortete normal, fand aber schlicht keinen
Treffer für kryptische YouTube-Titel (z. B. `"Artist - Song (Official Video) [4K] prod. by XY"`,
oder Songs, die im iTunes-Katalog gar nicht existieren: Remixe, Mixtapes, Bootlegs, Nischen-
Künstler).

Zusätzlicher Kontext: Am 2026-07-02 hatte der Sync mit 6 parallelen **Spotify**-Anfragen über
~1400 Songs Spotifys App-weites Rate-Limit (HTTP 429) ausgeschöpft — das ließ auch alle manuellen
Spotify-Suchen im Tag-Editor fehlschlagen. Seitdem lief Spotify absichtlich NICHT im Hintergrund-
Sync, nur iTunes.

## Decision
1. **Spotify läuft als Fallback im Sync mit**, aber nur wenn iTunes für einen Song nichts findet
   (nicht für jeden Song) — das hält das Anfragevolumen niedrig genug, um das Rate-Limit nicht
   erneut auszulösen. Vor jedem Fallback-Call wird `window._spotifyCooldownUntil` geprüft; ist
   Spotify gerade gedrosselt, wird der Call übersprungen (nicht: aufgegeben — siehe Punkt 3).
2. Finden **weder iTunes noch Spotify** etwas, gilt der Song sofort als synchronisiert (Feld
   `artist: "Unbekannter Künstler"` bleibt stehen) und wandert in eine persistente Give-up-Liste
   (`localStorage` Key `himusic_sync_giveup`, Set von Song-IDs). Diese Songs werden nicht mehr
   automatisch retried.
3. Sicherheitsnetz: Falls Spotify durch andauerndes Rate-Limiting nie wirklich versucht werden
   kann (Cooldown greift jedes Mal), gibt der Song trotzdem nach `_SYNC_MAX_ATTEMPTS = 5`
   Durchläufen auf — verhindert eine Endlosschleife auch in diesem Randfall.
4. Give-up-Songs bleiben **manuell im Tag-Editor bearbeitbar** (dort auch gezielte
   Spotify-Suche verfügbar) und verlassen die Give-up-Liste implizit, sobald `cover_data`
   gesetzt wird.

## Alternatives Considered

### Retry für immer, nur Backoff-Intervall verlängern
- Pros: Kein Code für "Aufgeben" nötig, Song hat theoretisch für immer eine Chance.
- Cons: Genau das war der ursprüngliche Bug — löst das Kernproblem nicht, nur die Symptom-
  Häufigkeit ändert sich.
- Rejected: Nutzer wollte explizit einen definierten Endzustand ("gilt als synchronisiert").

### Spotify weiterhin komplett aus dem Sync raushalten (nur iTunes)
- Pros: Kein Risiko, das Rate-Limit vom 2026-07-02 erneut auszulösen.
- Cons: Viele Songs, die iTunes nicht findet, hätte Spotify gefunden (größerer Katalog gerade
  bei Nischen-/Afrobeat-/Amapiano-Titeln) — höhere permanente Give-up-Quote.
- Rejected: Nutzer wollte Spotify explizit zurück, mit dem Kompromiss "vorsichtig, nur als
  Fallback".

## Consequences
- Sync-Fortschrittsanzeige erreicht jetzt zuverlässig 100 % (Give-up-Songs zählen als "erledigt"
  in der UI, mit eigenem Hinweistext statt grünem Haken).
- Manuelle Nacharbeit im Tag-Editor bleibt für schwierige Songs nötig — das ist eine bewusste
  UX-Entscheidung, kein technisches Defizit.
- Spotify-Rate-Limit-Risiko ist reduziert, aber nicht eliminiert: bei einer sehr großen Zahl
  gleichzeitiger iTunes-Fehlschläge (z. B. direkt nach einem Massenimport vieler Nischentitel)
  könnten weiterhin viele Spotify-Fallback-Calls kurz hintereinander auflaufen. Falls das erneut
  ein 429 auslöst, ist der nächste Schritt vermutlich ein eigenes Concurrency-Limit nur für die
  Fallback-Calls (aktuell geteilt mit den 3 parallelen Sync-Workern).
- Relevanter Code: `app2.js` Funktion `processBackgroundSync` (~Zeile 2879 ff.), Konstanten
  `_SYNC_GIVEUP_KEY`, `_SYNC_MAX_ATTEMPTS`, `_syncBackoffMs`.
