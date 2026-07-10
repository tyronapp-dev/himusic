# ADR-004: HTML-Escaping für alle extern beeinflussbaren Song-/Playlist-Daten

## Status
Accepted

## Date
2026-07-10

## Context
Im Rahmen eines angeforderten Security-Audits (Skill `security-and-hardening`) wurde die
gesamte Codebasis auf Schwachstellen geprüft. Fund: Song-Titel, Künstler, Playlist-/Sender-/
Vibe-Mix-Namen sowie YouTube-Suchergebnisse (Titel, Kanalname, Thumbnail-URL) wurden an ~17
Stellen in `app2.js` per `innerHTML`-Template-Strings ins DOM geschrieben, ohne HTML-Escaping.

Das ist ausnutzbar, weil mehrere dieser Felder aus externen, nicht vertrauenswürdigen Quellen
stammen:
- **YouTube-Videotitel und Kanalname** sind von jedem YouTube-Uploader frei wählbar. Ein Titel
  wie `<img src=x onerror=...>` würde bereits beim Anzeigen der Suchergebnisse
  (`yt-search-input` → `runSearch()`) ausgeführt — noch bevor der Song überhaupt importiert wird.
- Nach einem Import landet ein solcher Titel dauerhaft in der Datenbank und würde bei **jedem**
  Rendern der Songs-Liste (Hauptliste, Warteschlange, Duplikat-Cleaner, Startseiten-Suche —
  alle nutzen dieselbe `updateSongDOM`-Funktion oder ähnliche Templates) erneut ausgeführt:
  gespeichertes XSS.
- Kombiniert mit dem Fund aus ADR-005 (Worker-API zum Zeitpunkt des Audits ohne
  Authentifizierung) hätte injiziertes JS vollen Lese-/Schreibzugriff auf die komplette Song-/
  Playlist-Datenbank gehabt.

## Decision
Neue Hilfsfunktion `_esc(s)` in `app2.js` (direkt nach `_parseVibes`, ganz oben in der Datei):

```js
function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
```

Angewendet auf **jede** Stelle, an der Song-/Playlist-/YouTube-Daten in einen `innerHTML`-String
interpoliert werden — u. a. `updateSongDOM`, `buildQueueItem`, `renderHomeSections`
(Sender-/Mix-Karten), die YouTube-Suchergebnis-Zeilen, den Duplikat-Cleaner und die
Playlist-Listen-Items.

`alert()`- und `confirm()`-Aufrufe mit Song-/Playlist-Namen wurden bewusst **nicht** angefasst —
native Browser-Dialoge rendern nur Klartext, können kein HTML/JS ausführen.

## Alternatives Considered

### DOMPurify oder ähnliche Sanitizer-Bibliothek einbinden
- Pros: Robuster gegen komplexere Payloads, Industriestandard.
- Cons: Das Projekt hat explizit keinen Build-Step und keinen Paketmanager (siehe CLAUDE.md) —
  eine neue Abhängigkeit hieße entweder einen CDN-Script-Tag zusätzlich laden oder den
  "kein Build-Step"-Grundsatz brechen. Für reinen Text-Escaping-Bedarf (keine der betroffenen
  Felder soll jemals HTML enthalten dürfen) ist eine Sanitizer-Bibliothek Overkill.
- Rejected: Eine simple Escape-Funktion deckt den tatsächlichen Bedarf vollständig ab.

### Von `innerHTML` auf `textContent`/DOM-Methoden umstellen
- Pros: Kategorisch keine XSS-Möglichkeit mehr, unabhängig von Escaping-Disziplin.
- Cons: Deutlich größerer, invasiverer Umbau (jede der ~17 Stellen baut komplexes verschachteltes
  Markup mit SVGs/Buttons/Event-Handlern per Template-String) — hohes Risiko, in einer ohnehin
  schon sehr umfangreichen Session weitere Bugs einzuführen.
- Rejected für jetzt: als spätere, größere Refactoring-Option vorgemerkt, falls `innerHTML` an
  diesen Stellen grundsätzlich abgelöst werden soll.

## Consequences
- Jede neue Stelle, die künftig Song-/Playlist-/externe Daten per `innerHTML` einfügt, MUSS
  `_esc()` verwenden — das ist keine Konvention, die von selbst durchgesetzt wird (kein Linter-
  Regel dafür eingerichtet). Code-Review-Punkt für zukünftige Änderungen.
- `applySongPatch` (app2.js) wurde zusätzlich angepasst: vorher leerte ein Cover-Update
  `c.innerHTML = ''` den kompletten Cover-Container, was den "keine Vibes"-Punkt (roter Punkt,
  siehe separates Feature) mitgelöscht hätte. Jetzt wird der Punkt vor dem Leeren gerettet und
  danach wieder angehängt.
- Relevanter Code: `app2.js` `_esc()` (~Zeile 10), alle Fundstellen per Grep nach
  `_esc(` auffindbar.
