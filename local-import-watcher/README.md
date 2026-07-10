# YouTube-Import-Watcher

Läuft auf einer normalen Internet-IP (PC zuhause ODER eigener Linux-Server) statt auf einem
Cloud-CI-Runner. Grund: YouTubes Bot-Erkennung blockiert GitHub-Actions-IPs zunehmend
(verifiziert: mehrere Videos scheiterten dort 0/8 trotz PO-Token und TLS-Impersonation),
während eine normale Heim- oder Server-IP im Test keinen einzigen Bot-Block hatte.

## API-Key (einmalig, auf jedem Rechner der den Watcher ausführt)

Der Worker prüft seit kurzem einen `X-Api-Key`-Header auf jeder Route. Lege in diesem Ordner
eine Datei **`.env`** an (liegt in `.gitignore`, wird nie committet) mit genau einer Zeile:

```
HIMUSIC_API_KEY=dein-key-hier
```

Den Key findest du in `config.js` im Hauptprojekt (Feld `apiKey`) bzw. im Cloudflare-Dashboard
unter Worker → Settings → Variables and Secrets → `API_KEY`. Ohne diese Datei startet `watch.js`
gar nicht erst und sagt dir das direkt.

## Einmaliges Setup — Windows (eigener PC)

1. Diesen Ordner (`local-import-watcher/`) auf deinem PC haben (liegt schon im Projekt-Repo).
2. Doppelklick auf **`setup.bat`** — lädt `yt-dlp.exe` und `ffmpeg.exe` automatisch herunter (~110 MB, dauert 1-2 Min).
3. `.env` mit dem API-Key anlegen (siehe oben).
4. Fertig. Starten mit Doppelklick auf **`start.bat`**.

Nachteil: läuft nur, solange der PC an und das Fenster offen ist.

## Einmaliges Setup — Linux-Server (z.B. Oracle Cloud Free-Tier-VM, läuft 24/7)

1. Diesen Ordner per `scp` auf den Server kopieren, z.B.:
   ```
   scp -i deinkey.pem -r local-import-watcher opc@DEINE_SERVER_IP:~/himusic-watcher
   ```
2. Per SSH einloggen: `ssh -i deinkey.pem opc@DEINE_SERVER_IP`
3. Im Ordner: `chmod +x setup-linux.sh install-service.sh && ./setup-linux.sh`
   (installiert yt-dlp, ffmpeg, Node.js)
4. `.env` mit dem API-Key anlegen (siehe oben), z.B. `echo "HIMUSIC_API_KEY=dein-key-hier" > .env`
5. Als Dauer-Dienst einrichten: `sudo ./install-service.sh`
   (läuft ab jetzt automatisch, auch nach Neustart, auch nach SSH-Trennung)

Log ansehen: `sudo journalctl -u himusic-watcher -f`

## Wie es funktioniert

Der Watcher prüft alle 5 Sekunden, ob in der App ein YouTube-Import angestoßen wurde, und
lädt mehrere Songs gleichzeitig herunter (Windows: 3 parallel, Linux-VM: 2 parallel, wegen
weniger RAM). Gescheiterte Importe werden aus der Warteschlange entfernt, damit nichts
hängen bleibt — einfach in der App erneut anstoßen.

## Voraussetzung im Backend

Der Worker braucht die `/youtube-queue`-Endpunkte und die App muss Importe dort statt (oder
zusätzlich zu) `/dispatch-import` einreihen — siehe Hauptunterhaltung für den Worker-Code und
die D1-Tabelle.
