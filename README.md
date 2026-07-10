# Himusic Cloud

Eine private Progressive Web App (PWA) zum Verwalten und Abspielen der eigenen Musiksammlung —
gedacht als persönlicher Ersatz für Spotify/Apple Music mit eigener Cloud-Bibliothek statt
Streaming-Katalog. Ein Nutzer, eigene Songs (hochgeladen oder per YouTube importiert), volle
Kontrolle über Tags/Cover/Stimmungen, funktioniert auch offline.

Kein Build-Step, kein Bundler, kein Paketmanager — reines Vanilla JS/HTML/CSS, Dateien werden
direkt bearbeitet und ausgeliefert.

## Was die App kann

**Bibliothek aufbauen**
- Songs manuell hochladen (Datei-Auswahl, mehrere gleichzeitig).
- Songs von YouTube importieren: URL einfügen oder per Namenssuche einen Song finden und direkt
  herunterladen (mit Vorschau-Player + Seek-Leiste vor dem Import).
- Automatische Inhalts-Duplikaterkennung beim Import (byte-identische Dateien werden nicht doppelt
  gespeichert) plus ein manueller Duplikat-Cleaner für den Bestand.

**Metadaten**
- Tag-Editor pro Song: Titel, Künstler, Cover, Album, "Vibes" (Stimmungs-Tags aus einer festen
  Liste wie Afro, RnB, Gym, HYPE, Calm, ...).
- Ein-Klick-Suche bei iTunes oder Spotify füllt Titel/Künstler/Cover automatisch.
- Hintergrund-Sync trägt fehlende Metadaten für unsauber importierte Songs automatisch nach
  (Details: [ADR-001](docs/decisions/ADR-001-background-sync-giveup-strategy.md)).
- Songs ohne Vibe-Tags sind in der Liste und im großen Player an einem roten Punkt auf dem Cover
  erkennbar.

**Abspielen**
- Mini-Player + großer Vollbild-Player mit mehreren visuellen Stilen.
- Warteschlange (manuell umsortierbar), Verlauf, Shuffle, Repeat, Crossfade (optional).
- Wahl des Ausgabegeräts (Chrome/Edge Desktop), native Medien-Steuerung (Sperrbildschirm,
  CarPlay/Android Auto über die Standard-Media-Session-API).

**Organisieren**
- Playlists (erstellen, umbenennen, sortieren, Songs per Drag neu anordnen).
- "Sender": automatisch generierte, zeitlich befristete Playlists rund um einen Song + ähnliche
  Vibes.
- "Vibe Mixes": Playlists aus einer selbst gewählten Vibe-Kombination.

**Offline**
- Bibliothek wird automatisch (gedrosselt) im Hintergrund fürs Offline-Abspielen gecacht, kein
  manuelles Anstoßen mehr nötig (Details: [ADR-002](docs/decisions/ADR-002-automatic-offline-caching.md)).
  Zusätzlich ein manueller "Alles jetzt herunterladen"-Button für den sofortigen Volldownload.
  Als installierbare PWA nutzbar (App-Icon, Startbildschirm, offline ladbar dank Service Worker).

**Navigation**
- Songs-Liste mit A-Z-Suche, Sortierung (Titel/Künstler/Datum), Listen-/Grid-Ansicht, ziehbarer
  Scrollbar am rechten Rand für lange Listen (Details: [ADR-003](docs/decisions/ADR-003-songs-list-scrollbar.md)).

## Schnellstart (lokal)

```
npx serve .
# oder
python -m http.server 8080
```

`index.html` im Browser öffnen. Der Service Worker (fürs Offline-Verhalten) registriert sich nur
über HTTPS oder `localhost` — für lokales Testen reicht `localhost`.

## Architektur im Überblick

- **Frontend**: eine einzelne `app2.js` (~3500 Zeilen), `style2.css`, `index.html`/`login.html` —
  keine Frameworks, kein Build-Step.
- **Backend**: ein Cloudflare Worker (`https://himusic-api.tyron-app.workers.dev`) mit
  Cloudflare D1 (Datenbank) und R2 (Objektspeicher für Audio/Cover). Der Worker-Quellcode liegt
  nur im Cloudflare-Dashboard, nicht in diesem Repo.
- **YouTube-Import**: läuft primär über einen lokalen Watcher (`local-import-watcher/`, auf
  einem eigenen PC/Server, da YouTube Rechenzentrums-IPs zunehmend blockt) mit GitHub Actions
  (`.github/workflows/audio-worker.yml`) als Fallback.
- **Hosting**: aktuell GitHub Pages direkt aus diesem Repo (siehe Sicherheitshinweis unten —
  diese Doku wird aktualisiert, sobald der geplante Umzug auf Cloudflare Pages abgeschlossen ist).

Technische Detail-Referenz für Agenten/Entwickler: [CLAUDE.md](CLAUDE.md).
Begründungen hinter größeren Architektur-Entscheidungen: [docs/decisions/](docs/decisions/).

## Sicherheitsstatus (Stand 2026-07-10 — bitte vor Annahmen hier nachlesen)

Diese App ist bewusst für **einen** Nutzer gebaut, nicht für öffentliche Mehrnutzer-Anmeldung.
Ein Security-Audit dieser Session hat mehrere Lücken gefunden und behoben (gespeichertes XSS
über Song-/YouTube-Titel — siehe [ADR-004](docs/decisions/ADR-004-xss-hardening-html-escaping.md)),
aber die **Zugriffskontrolle auf die Backend-API ist zum jetzigen Zeitpunkt noch nicht
abgeschlossen**. Details, aktueller Stand und offene nächste Schritte: [ADR-005](docs/decisions/ADR-005-worker-api-authentication.md).
Bitte nicht davon ausgehen, dass die App vollständig abgesichert ist, bis dieses ADR den Status
"Accepted" trägt.

## Unterprojekte

- [local-import-watcher/](local-import-watcher/) — lokales Hilfsprogramm für den primären
  YouTube-Import-Weg, eigene README dort.
