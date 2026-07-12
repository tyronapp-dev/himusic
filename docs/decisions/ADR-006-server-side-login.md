# ADR-006: Serverseitige Login-Prüfung statt Klartext-Passwort im Client

## Status
Accepted — deployed und verifiziert (2026-07-12). `POST /auth/login` live im Worker, per curl
gegen den echten Worker geprüft (401 bei falschem/fehlendem Passwort und bei GET, 401 unverändert
auf bestehenden Routen ohne `X-Api-Key`).

## Date
2026-07-12

## Context
ADR-005 löste "Worker hat keine Auth", ließ aber zwei Folgeprobleme offen (dort unter
"Consequences" dokumentiert):
1. `login.html` prüfte das App-Passwort komplett clientseitig:
   `const APP_PASSWORD = "Kakalika";` stand im Klartext im JS — lesbar für JEDEN, der die Seite
   lädt und "Seitenquelltext anzeigen" macht, unabhängig davon, ob das Repo public oder privat
   ist. Das ist strukturell schlimmer als das API-Key-Problem aus ADR-005, weil es keine
   Netzwerk-Inspektion braucht, nur einen Blick in den HTML-Quelltext.
2. Der Worker-`API_KEY` stand fest in `config.js`, einer getrackten Datei — bei jedem Commit
   erneut potenziell exponiert, egal wie oft rotiert.

Verifiziert vor dieser Session: Repo war weiterhin public, `config.js` enthielt noch den in
ADR-005 als "verbrannt" markierten Key, `login.html` noch das Klartext-Passwort — keine der
beiden Rotationen aus ADR-005 "Next Steps" war bis dahin passiert.

## Decision
Bewusst **kein** großer Umbau (keine private-Repo-/Hosting-Migration, keine
Cloudflare-KV-Session mit Ablauf/Widerruf) — User-Entscheidung für den chirurgischen Fix, der die
tatsächlich schlimmere Lücke (Klartext-Passwort) schließt, ohne Hosting/DNS anzufassen. Die
private-Repo-Migration aus ADR-005 bleibt als optionaler, nicht-dringender Folgeschritt bestehen.

### Neuer Worker-Endpoint `POST /auth/login`
Ausgenommen vom bestehenden `X-Api-Key`-Gate, gleiches Pattern wie `/media/*` GET und
`/internal/register`:
```js
const isAuthLogin = url.pathname === "/auth/login" && request.method === "POST";
if (!isMediaGet && !isInternalRegister && !isAuthLogin) { /* X-Api-Key-Pflicht */ }
```
Handler vergleicht `body.password` gegen neues Secret `env.LOGIN_PASSWORD`; bei Treffer liefert er
`{ apiKey: env.API_KEY }` zurück — der bestehende, bei diesem Rollout gleichzeitig rotierte
statische Key. Bewusst kein neuer Session-Mechanismus: reine Wiederverwendung der bestehenden
`X-Api-Key`-Infrastruktur aus ADR-005, nur nicht mehr hartcodiert im Client.

### Client
- `config.js` enthält kein `apiKey`-Feld mehr, nur noch `apiBaseUrl` (öffentliche Info, kein
  Geheimnis).
- `login.html` POSTet das eingegebene Passwort an `/auth/login`, speichert den zurückgegebenen Key
  ausschließlich in `localStorage` (`himusic_api_key`), nie mehr in einer getrackten Datei.
- `app2.js`: `API_KEY`-Konstante liest jetzt aus `localStorage` statt `window.HiMusicConfig`.
  `_apiFetch()` erkennt 401-Antworten und wirft die Session automatisch zurück zu `login.html`
  (Selbstheilung bei rotiertem/ungültigem Key statt stillem Fehlschlagen jedes Requests).
- `sw.js`: `CACHE_NAME` v1.5 → v1.6 (Lehre aus ADR-005: sonst hängt die alte Login-Version noch
  mehrere Reloads im Service-Worker-Cache).

### Rotation
Im selben Dashboard-Besuch wie das Worker-Deploy: neuer `API_KEY`, neues `LOGIN_PASSWORD` (ersetzt
`Kakalika`) — beide nur als Cloudflare-Secrets gesetzt, nie im Repo.

## Security-Review (code-ultra-security, vor Deploy)
Pflicht-Review vor jedem Auth-Pfad-Deploy (siehe globale Vorgabe). Ergebnis: Gate-Logik korrekt
(`/auth/login` schwächt keine andere Route), keine Secrets in den vier geänderten Dateien, kein
Blocker. Ein Punkt als "vor Deploy beachten" markiert, kein Fix am Code, sondern eine
Betriebsanforderung:

- **`/auth/login` ist öffentlich, unauthentifiziert, ohne Rate-Limit — die Sicherheit hängt
  direkt an der Passwort-Entropie.** Mit einem kurzen/schwachen Passwort ist Brute-Force
  realistisch; mit einem hochentropischen Passwort (empfohlen und verwendet: 32 zufällige
  Hex-Zeichen) praktisch nicht. **Lehre für zukünftige Rotationen: `LOGIN_PASSWORD` muss immer
  hochentropisch sein, nie mehr ein einzelnes Wort** — es ist jetzt die tatsächliche
  Sicherheitsgrenze, nicht mehr nur eine UX-Bremse.
- Empfohlen, nicht blockierend: Cloudflare Rate-Limiting-Regel auf `POST /auth/login` als
  Verteidigung gegen verteilten Brute-Force (CORS `Access-Control-Allow-Origin: "*"` erlaubt
  theoretisch, Anfragen über fremde Browser zu streuen) und gegen Kosten-/Kontingent-Verbrauch
  durch sinnloses Fluten des Endpoints.

## Alternatives Considered
### Private-Repo-Migration allein (ADR-005-Original-Plan)
Verworfen als alleinige Lösung für diese Session — löst "jemand liest das Repo", nicht "Passwort
steht in an jeden Browser ausgeliefertem Klartext-JS". Bleibt als unabhängiger, additiver
Folgeschritt sinnvoll (Defense-in-Depth), ist aber nicht mehr die dringendste Lücke.

### Cloudflare-KV-Session mit Ablauf/Widerruf
Pros: echte, einzeln widerrufbare Sessions statt eines langlebigen, geteilten Master-Keys.
Cons: deutlich größerer Umbau für eine Einzelnutzer-App. Nicht gewählt — User entschied sich
bewusst für den chirurgischen Fix und akzeptiert den langlebigen Key als Trade-off (siehe
Consequences).

## Consequences
- Passwort steht nirgendwo mehr im Klartext im Repo oder im ausgelieferten Client-Code.
- `config.js` enthält kein Geheimnis mehr — kann committet werden, ohne dass je wieder ein Key
  "verbrennt".
- **Bewusst akzeptierter Rest-Trade-off:** Der von `/auth/login` zurückgegebene `API_KEY` ist
  weiterhin ein einzelner, langlebiger Master-Key ohne granulare Widerrufbarkeit — Rotation loggt
  alle Geräte gleichzeitig aus. Kein Session-Ablauf, keine Multi-Device-Verwaltung. Für die
  Einzelnutzer-Nutzung dieser App als ausreichend bewertet.
- Der öffentliche Repo-Status selbst bleibt unverändert (siehe ADR-005 "Next Steps", weiterhin
  offen, nicht mehr die dringendste Lücke).
- `local-import-watcher/.env` muss nach dieser Rotation manuell mit dem neuen `API_KEY`
  aktualisiert werden (gitignored, lokaler Wert, nicht Teil dieses Commits).

## Next Steps
1. (Optional, niedrige Priorität) Private-Repo-Migration aus ADR-005 nachholen, falls zusätzliche
   Verteidigungsebene gewünscht.
2. (Empfohlen) Cloudflare Rate-Limiting-Regel auf `POST /auth/login` einrichten.
3. `local-import-watcher/.env` mit dem neuen `API_KEY` aktualisieren (manueller User-Schritt).
