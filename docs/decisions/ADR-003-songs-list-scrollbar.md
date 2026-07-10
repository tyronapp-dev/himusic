# ADR-003: Schlichte ziehbare Scrollbar statt A-Z-Buchstabenleiste auf der Songs-Seite

## Status
Accepted (supersedes eine Zwischenversion aus derselben Session, nie separat veröffentlicht)

## Date
2026-07-09

## Context
Nutzer-Anfrage: "eine Nav Bar am rechten Rand der Songs-Seite, mit der man schnell scrollen
kann". Auf Nachfrage (welche Art Navigation genau) wurde zunächst "A-Z Schnellsprung wie
Apple Music/Kontakte" gewählt und umgesetzt: eine feste Buchstabenleiste (A-Z + `#`), Antippen/
Ziehen springt zum jeweiligen Anfangsbuchstaben. Diese Implementierung sortierte die Liste beim
ersten Antippen implizit nach Titel um (ein Alphabet-Index ergibt nur auf einer alphabetisch
sortierten Liste Sinn).

Direkt danach stellte sich heraus, dass das nicht dem eigentlichen Wunsch entsprach: "ich will
rechts eine scroll bar keine nav bar" — gemeint war eine klassische, gedrückt haltbare Scrollbar
(Positions-Anzeige + Drag-to-Scroll), keine Buchstaben-Sprungliste.

## Decision
Die A-Z-Leiste wurde vollständig entfernt und durch eine schlichte Scrollbar ersetzt:
- Ein Griff (`#songs-scrollbar-thumb`) zeigt proportional Position und Länge des sichtbaren
  Ausschnitts innerhalb der (potenziell lazy-geladenen) Songs-Liste.
- Ziehbar per Touch/Maus über die gesamte Spur (`#songs-scrollbar`), nicht nur den Griff selbst.
- Blendet sich beim Scrollen/Ziehen ein (`.visible`-Klasse) und nach ~600–900 ms Inaktivität
  wieder aus — analog zu nativen OS-Scrollbars.
- **Kein** erzwungenes Umsortieren der Liste mehr (das brauchte nur der Buchstaben-Index) — die
  Reihenfolge bleibt exakt die vom Nutzer gewählte (Datum/Titel/Künstler).
- Bei sehr langen, lazy-gerenderten Listen lädt das Ziehen aktiv weitere Batches nach
  (`lazyRenderBatch()`), damit der Ziel-Scrollbereich existiert, bevor `scrollTop` gesetzt wird.

## Alternatives Considered

### A-Z-Buchstabenleiste beibehalten
- Pros: War bereits fertig implementiert und funktionsfähig.
- Rejected: Entspricht nicht dem, was der Nutzer tatsächlich wollte — explizit "keine nav bar".

### Beides parallel anbieten (A-Z-Leiste UND Scrollbar)
- Wurde als Option angeboten, aber nicht gewählt (mehr Platzbedarf am rechten Rand, unnötige
  Komplexität für einen einzigen Anwendungsfall: schnell durch die Liste kommen).

## Consequences
- Einfacherer, kleinerer Code als die A-Z-Variante (kein Buchstaben-Array, keine
  Sortier-Erzwingung, keine Bubble-Anzeige nötig).
- Nutzer muss zum gezielten Springen zu einem Buchstaben ggf. weiterhin per Titel-Sortierung +
  Scrollbar navigieren, statt direkt zum Buchstaben zu springen — bewusster Trade-off zugunsten
  der einfacheren, erwarteten Interaktion.
- Relevanter Code: `app2.js` Abschnitt "Songs-Scrollbar" (~Zeile 1060 ff.), `style2.css` Klassen
  `.songs-scrollbar` / `.songs-scrollbar-thumb`, `index.html` `#view-songs`.
