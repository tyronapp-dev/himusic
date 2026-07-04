# Lokaler YouTube-Import-Watcher

Läuft auf deinem PC statt auf einem Cloud-CI-Runner. Grund: YouTubes Bot-Erkennung blockiert
GitHub-Actions-IPs zunehmend (verifiziert: mehrere Videos scheiterten dort 0/8 trotz PO-Token
und TLS-Impersonation), während die eigene Heim-IP im Test keinen einzigen Bot-Block hatte.

## Einmaliges Setup

1. Diesen Ordner (`local-import-watcher/`) auf deinem PC haben (liegt schon im Projekt-Repo).
2. Doppelklick auf **`setup.bat`** — lädt `yt-dlp.exe` und `ffmpeg.exe` automatisch herunter (~110 MB, dauert 1-2 Min).
3. Fertig.

## Benutzen

Doppelklick auf **`start.bat`**, solange offen lassen. Der Watcher prüft alle 5 Sekunden, ob
in der App ein YouTube-Import angestoßen wurde, und lädt bis zu 3 Songs gleichzeitig herunter.

Fenster einfach offen lassen, während du Songs importierst. Schließen (Strg+C oder Fenster zu)
stoppt ihn — laufende Importe brechen dann ab, in der Warteschlange verbleibt aber nichts hängen
(die App zeigt neue Importe erst an, wenn der Watcher sie tatsächlich verarbeitet hat).

## Voraussetzung im Backend

Der Worker braucht die `/youtube-queue`-Endpunkte und die App muss Importe dort statt (oder
zusätzlich zu) `/dispatch-import` einreihen — siehe Hauptunterhaltung für den Worker-Code und
die D1-Tabelle.
