# ADR-005: Worker-API-Authentifizierung

## Status
Accepted — Worker-Code mit Auth-Gate ist deployed, `API_KEY`-Secret gesetzt, per curl gegen den
echten Worker verifiziert (`401` ohne Header, `200` mit korrektem `X-Api-Key`). Weiterhin offen:
die Hosting-Migration (siehe "Next Steps"), die den Key erst wirklich vor dem öffentlichen Repo
verbirgt — bis dahin schützt der Key nur vor zufälligem/automatisiertem Zugriff, nicht vor
jemandem, der gezielt den öffentlichen Quellcode liest.

## Date
2026-07-10 (Auth-Gate entworfen) / 2026-07-11 (deployed und verifiziert)

### Nachtrag: Rollout-Fehler und ihre Behebung (2026-07-11)
Der Rollout verlief nicht reibungslos — drei Bugs traten nacheinander auf, alle inzwischen
behoben:
1. **CORS-Preflight-Blockade:** Client sendete den `X-Api-Key`-Header, bevor der Worker ihn in
   `Access-Control-Allow-Headers` erlaubte — blockte ausnahmslos jeden Request (Speichern, Sync,
   alles). Kurzzeitig durch Deaktivieren des Headers clientseitig entschärft, dann nach dem
   tatsächlichen Worker-Deploy wieder aktiviert.
2. **Service-Worker-Stale-Cache:** `CACHE_NAME` war seit vor dem Bug unverändert, die
   Stale-while-revalidate-Strategie lieferte alte App-Shell-Dateien noch mehrere Reloads lang
   aus. Behoben durch harten Versionsbump (v1.4 → v1.5).
3. **Trailing Newline im Secret:** Das im Cloudflare-Dashboard gesetzte `API_KEY`-Secret hatte
   einen unsichtbaren Zeilenumbruch am Ende (`keyLength: 44` statt 43) — vermutlich beim
   Kopieren aus einem Chat-Code-Block mitgekommen. Erst durch einen temporären Diagnose-Endpoint
   (`/debug-key-check`, zeigte Länge + erstes/letztes Zeichen ohne den vollen Wert preiszugeben)
   im Worker gefunden; danach durch manuelles Abtippen des Secrets statt Copy-Paste behoben.
   Diagnose-Endpoint wurde nach dem Fix wieder entfernt.

**Lehre:** Bei clientseitigen Header-/Auth-Änderungen, die einen CORS-Preflight auslösen, immer
zuerst den Server, dann den Client deployen (nicht umgekehrt) — und bei "Secret stimmt einfach
nicht"-Rätseln früh einen harmlosen Diagnose-Endpoint einbauen (Länge/Randzeichen, nie den vollen
Wert), statt wiederholt blind neu einzutippen.

## Context
Security-Audit (siehe ADR-004) deckte auf: die REST-API auf Cloudflare Workers
(`himusic-api.tyron-app.workers.dev`) hatte **keinerlei Authentifizierung** auf irgendeiner
Route. Die Worker-URL ist fest in `config.js` hinterlegt und damit öffentlich sichtbar für
jeden, der die App lädt oder das Repo liest. Ohne Auth-Prüfung konnte jeder mit dieser URL per
simplem HTTP-Request die komplette Song-/Playlist-Datenbank lesen, verändern oder löschen —
kombiniert mit dem XSS-Fund aus ADR-004 ein besonders gefährliches Zusammenspiel (injiziertes
Skript hätte uneingeschränkten API-Zugriff gehabt).

Nutzer entschied sich für den pragmatischen Mittelweg: ein festes Secret als Header
(`X-Api-Key`), geprüft im Worker, statt eines vollständigen Umbaus auf echte serverseitige
Sessions. Bewusst akzeptierter Trade-off: schützt zuverlässig vor zufälligem Auffinden der URL
und automatisiertem Scanning, **nicht** vor jemandem, der die laufende App gezielt im Browser
öffnet und die Netzwerk-Requests inspiziert (der Key steht dort sichtbar in jedem Request).

### Kritischer Zwischenfund während der Umsetzung
Nachdem der Key bereits in `config.js` committet und gepusht war (Commit `579ac25`), stellte
sich heraus: **das GitHub-Repo `tyronapp-dev/himusic` ist public**, und die App wird direkt per
**GitHub Pages aus diesem Repo** gehostet (kein separater Build-/Deploy-Schritt, kein
Hosting-Provider dazwischen). Das bedeutet:
- Der gerade gepushte Key war ab dem Push-Zeitpunkt öffentlich auf GitHub lesbar — **gilt als
  kompromittiert**, unabhängig davon, was als Nächstes passiert (siehe Security-Skill-Prinzip:
  "if a secret is ever committed, assume it's compromised — deleting the line is not enough").
- Dieselbe Einschränkung galt schon **vorher** für das Klartext-Login-Passwort in `login.html`
  (existiert unabhängig von dieser Session) — die "Passwort-Sperre" der App war nie wirksam,
  sobald das Repo public wurde, weil jeder das Passwort direkt im Repo lesen kann.
- Grundsätzliches Problem: Bei einer Datei, die per GitHub Pages direkt aus einem public Repo
  ausgeliefert wird, kann **keine** getrackte Datei je ein echtes Geheimnis enthalten — das ist
  keine Sache besserer Code-Struktur, sondern eine strukturelle Grenze dieses Hosting-Setups.
- Ob GitHub Pages von einem **privaten** Repo funktioniert, hängt vom GitHub-Plan ab (Free vs.
  Pro/Team/Enterprise) — für diesen Account laut Nutzer-Angabe **nicht auf dem aktuellen (Free-)
  Plan möglich**.

Nutzer-Entscheidung zum Zeitpunkt des Session-Endes: **Hosting-Anbieter wechseln**, um privates
Deployment zu ermöglichen (z. B. Cloudflare Pages mit privat verknüpftem Repo, Netlify, Vercel —
noch nicht final festgelegt). Diese Migration war zum Zeitpunkt dieses ADRs **noch nicht
begonnen**.

## Decision (bisher umgesetzter Teil)
1. Neue Helper-Funktion `_apiFetch(url, options)` in `app2.js` (~Zeile 9 ff.) — 1:1-Ersatz für
   `fetch()`, hängt automatisch den Header `X-Api-Key: <API_KEY>` an. `API_KEY` kommt aus
   `window.HiMusicConfig.apiKey` (`config.js`).
2. Alle 25 Stellen in `app2.js`, die den eigenen Worker aufrufen (`fetch(\`${API_URL}...\`)`),
   wurden auf `_apiFetch(...)` umgestellt. Aufrufe an fremde Hosts (iTunes-Suche) bleiben
   bewusst normales `fetch()` — der Key wird niemals an Dritte geschickt.
3. `local-import-watcher/watch.js` lädt den Key aus einer lokalen, **gitignorten** `.env`-Datei
   (`HIMUSIC_API_KEY=...`), nicht hardcoded im Skript — genau um den Fehler von Punkt 1 hier
   nicht zu wiederholen. Skript bricht mit klarer Fehlermeldung ab, wenn `.env` fehlt.
4. `sw.js`: `CACHE_NAME` auf `v1.4` gebumpt, damit die neue Client-Version zügig ausgeliefert
   wird.
5. Fertiger Worker-Code (mit Auth-Gate, siehe unten) wurde dem Nutzer zum manuellen Einfügen ins
   Cloudflare-Dashboard übergeben — **noch nicht bestätigt deployed**.

### Worker-seitige Auth-Gate-Logik (vorbereitet, siehe Chat-Verlauf für vollständigen Code)
Direkt nach der CORS/OPTIONS-Behandlung, vor dem restlichen Routing:
```js
const isMediaGet = url.pathname.startsWith("/media/") && request.method === "GET";
const isInternalRegister = url.pathname === "/internal/register";
if (!isMediaGet && !isInternalRegister) {
  if (!env.API_KEY || request.headers.get("X-Api-Key") !== env.API_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }
}
```
Ausnahmen bewusst gewählt:
- `/media/*` (GET): wird von `<img>`/`<audio>`-Tags und dem Service Worker als natives
  Ressourcen-Laden abgerufen — kann grundsätzlich keinen Custom-Header mitschicken. R2-
  Objektschlüssel sind bereits opake Zufallsstrings, nicht enumerierbar.
- `/internal/register`: hat schon eine eigene, unabhängige Bearer-Token-Prüfung (`D1_API_KEY`),
  wird ausschließlich vom GitHub-Actions-Import aufgerufen (siehe `src/extractor_worker.py`).
- `Access-Control-Allow-Headers` im Worker musste um `X-Api-Key` erweitert werden, sonst hätte
  der Browser den Header schon per CORS-Preflight blockiert.

## Alternatives Considered

### Echte serverseitige Sessions (Login prüft Passwort im Worker, gibt Token aus)
- Pros: Tatsächlich sicher, auch bei public Repo — der Token selbst müsste nicht im Code stehen.
- Cons: Deutlich größerer Umbau (Login-Flow + Worker-Routing + Session-Speicher, z. B. via
  Cloudflare KV).
- Nicht gewählt für diese Session — Nutzer entschied sich zunächst für den pragmatischen
  Mittelweg. Bleibt als Option, falls die Hosting-Migration allein nicht als ausreichend
  empfunden wird.

### Repo einfach public lassen, Risiko akzeptieren
- Wurde als dritte Option angeboten (nachdem der XSS-Fund entschärft war, ist "nur" eine offene
  API zu einer privaten Musikbibliothek ein deutlich geringeres Risiko als vorher).
- Nicht gewählt — Nutzer entschied sich für die Hosting-Migration.

## Consequences
- **Der aktuell in `config.js` stehende Key ist verbrannt** und muss rotiert werden, sobald die
  Hosting-Migration steht (neuer Key erst NACH dem Wechsel auf privates Deployment generieren
  und committen, sonst wiederholt sich das gleiche Problem).
- **Das Login-Passwort in `login.html` ist ebenfalls verbrannt** (war es schon vor dieser
  Session, sobald das Repo public wurde) — sollte im selben Zug wie der API-Key rotiert werden.
- **Korrektur (2026-07-10, kurz nach dem ursprünglichen Push):** Die Annahme "der alte Worker
  ignoriert den Header einfach, rein additiv" war **falsch** und hat die App produktiv kaputt
  gemacht (Speichern im Tag-Editor und der Background-Sync schlugen komplett fehl). Ursache:
  Sobald ein Custom-Header (`X-Api-Key`) mitgeschickt wird, erzwingt der Browser vor **jedem**
  Request — auch einfachen GETs, die vorher keinen brauchten — einen CORS-Preflight (OPTIONS).
  Der zu dem Zeitpunkt live laufende (alte) Worker erlaubte in seiner CORS-Antwort aber nur
  `Content-Type, Authorization`, nicht `X-Api-Key` — der Browser blockte dadurch **jeden**
  Request an den Worker, bevor er ihn überhaupt erreichte. Fix (Commit `753fc77`): `_apiFetch()`
  ist bis zum tatsächlichen Worker-Deploy ein reiner `fetch()`-Passthrough ohne den Header (Zeile
  mit dem Header-Merge ist auskommentiert, nicht gelöscht — beim Worker-Deploy einfach wieder
  aktivieren). **Lehre für den eigentlichen Rollout:** Client-seitige Header-Änderungen, die
  einen CORS-Preflight auslösen, dürfen erst NACH dem entsprechenden Worker-Deploy live gehen,
  nicht vorher — die Rollout-Reihenfolge aus diesem ADR (erst Client, dann Worker) war in dieser
  Hinsicht falsch herum gedacht.
- Separater, ungeklärter Fund aus derselben Session: der Worker-Code enthält **keine
  `/playlists`-Routen**, obwohl `app2.js` durchgehend `/playlists`, `/playlists/:id/songs` usw.
  aufruft. Nutzer war sich dessen nicht bewusst. Nicht untersucht, ob ein zweiter Worker
  existiert oder das Playlist-Feature aktuell serverseitig ins Leere läuft — **eigene
  Untersuchung nötig**, siehe Next Steps.

## Next Steps (für die nächste Session/den nächsten Agenten)
1. Hosting-Migration entscheiden und durchführen (privates Repo + Pages-fähiger Host).
2. NACH der Migration: neuen `API_KEY` generieren, in `config.js` UND als Cloudflare-Secret
   setzen (alten Wert nirgends wiederverwenden).
3. Login-Passwort in `login.html` im selben Zug rotieren.
4. Worker-Code mit dem Auth-Gate (siehe oben) im Cloudflare-Dashboard einfügen und deployen.
5. Kompletten Funktionstest nach Deploy: Songs laden, Tag-Editor speichern, YouTube-Suche/
   -Import, Sync, Duplikat-Cleaner, Playlists (siehe Punkt 6).
6. Der `/playlists`-Routen-Fund aufklären: existiert ein zweiter Worker? Falls ja, braucht der
   dieselbe Auth-Gate-Behandlung. Falls nein, ist das Playlist-Feature vermutlich aktuell defekt
   und müsste ohnehin gefixt werden — unabhängig von Auth.
