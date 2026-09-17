# tools/

Hilfsprogramme, die **neben** der App laufen — nichts davon wird ausgeliefert oder vom Browser
geladen.

## backup-cloud.js — Sicherung der eigentlichen Sammlung

Der Backup-Knopf **in** der App sichert nur, was im Browser liegt (Sender, Vibe-Mixe, offene
Tag-Änderungen, Einstellungen). **Songs, Playlists und die Audiodateien selbst sind dort nicht
enthalten** — die liegen in Cloudflare D1 und R2. Genau dafür ist dieses Skript da.

Ohne es existiert die Sammlung genau einmal, in einem einzigen Cloudflare-Konto.

### Benutzung

```bash
# einmalig: Schlüssel hinterlegen (tools/.env ist gitignoriert)
echo "HIMUSIC_API_KEY=dein-schluessel" > tools/.env

# dann, so oft du willst:
node tools/backup-cloud.js "D:/himusic-backup"
```

Den Schlüssel findest du in der App: Entwicklerkonsole → `localStorage.himusic_api_key`.
Alternativ ohne Datei: `HIMUSIC_API_KEY=... node tools/backup-cloud.js "D:/himusic-backup"`.

### Was dabei herauskommt

```
D:/himusic-backup/
  songs.json        komplette Songliste aus D1 (inkl. Tags, Vibes, Cover-Verweise)
  playlists.json    alle Playlists samt Zuordnung Song → Playlist
  manifest.json     Zeitpunkt, Anzahl, Liste der Fehlschläge
  audio/            die Audiodateien, benannt als <song-id>__<originalname>
```

### Eigenschaften, auf die man sich verlassen kann

- **Inkrementell.** Dateien, die schon mit passender Größe vorliegen, werden übersprungen. Der
  zweite Lauf über eine große Bibliothek dauert Sekunden.
- **Löscht nie etwas** im Zielordner. Verschwindet ein Song in der Cloud, bleibt er in der
  Sicherung — das ist der ganze Zweck.
- **Bricht nicht beim ersten Fehler ab.** Einzelne Fehlschläge landen in `manifest.json`, der Rest
  wird gesichert. Rückgabewert `2`, wenn etwas fehlschlug (für geplante Läufe auswertbar).
- Halb übertragene Dateien werden erst unter `.teil` geschrieben und dann umbenannt, können also
  beim nächsten Lauf nicht als „schon vorhanden" durchrutschen.

### Sinnvoller Rhythmus

Nach jeder größeren Import-Runde, sonst monatlich. Wer es automatisieren will: Windows-
Aufgabenplanung auf denselben Befehl, Ziel am besten eine **externe** Platte — eine Sicherung auf
derselben Platte hilft gegen Cloudflare-Ausfall, aber nicht gegen einen Plattenschaden.

### Wiederherstellung

Es gibt bewusst kein automatisches Zurückspielen: das würde massenhaft Uploads gegen die
Produktiv-API auslösen, und ein falscher Lauf richtet mehr Schaden an als der Ausfall.
`songs.json` enthält alle Metadaten, `audio/` die Dateien — damit lässt sich im Ernstfall gezielt
wiederherstellen, ohne dass ein Automatismus etwas überschreibt.

---

## fetch-worker.js — Worker-Quelltext sichern

Die komplette Server-Logik (Auth, Routing, R2-Anbindung, Range-Handling für `/media`) liegt **nur**
im Cloudflare-Dashboard. Wird sie überschrieben oder das Konto gesperrt, ist sie weg und muss aus
dem Gedächtnis nachgebaut werden. Dieses Skript zieht sie heraus, wiederholbar.

```bash
# Worker des Kontos auflisten
CF_API_TOKEN=... node tools/fetch-worker.js

# einen bestimmten sichern
CF_API_TOKEN=... node tools/fetch-worker.js himusic-api "D:/worker-backup"
```

Token anlegen: Cloudflare → My Profile → API Tokens → Create Token. Es genügt **Lesen**:
`Account | Workers Scripts | Read`. Das Skript schreibt nichts nach Cloudflare zurück.

> **Das Ergebnis gehört nicht in dieses Repo.** `tyronapp-dev/himusic` ist öffentlich, der Worker
> enthält die Zugriffslogik. Standardziel ist deshalb ein Ordner außerhalb — von dort in ein
> **privates** Repo committen.
