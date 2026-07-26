# ADR-009: Cobalt-Instanz-Pool als erster Versuch vor yt-dlp+Cookies

## Status
Accepted

## Date
2026-07-26

## Context
Beide bestehenden Import-Pfade haben denselben Kern-Schmerzpunkt: **irgendwer muss YouTube
direkt kontaktieren**, und das Ergebnis hängt an fragilen, sich ständig ändernden
Gegenmaßnahmen:

- **GitHub Actions** (`src/extractor_worker.py`): Rechenzentrums-IPs werden von YouTube
  zunehmend geblockt, trotz PO-Token-Server und `--impersonate chrome`. Einzige wirklich
  tragende Abwehr sind angemeldete `YOUTUBE_COOKIES` — die aber nach einigen Wochen ablaufen
  und manuell neu exportiert werden müssen. Nutzer hat das als "zu unzuverlässig" eingestuft
  und will *keinen* Rhythmus, der öfter als alle paar Monate Cookie-Export verlangt.
- **Lokaler Watcher** (`local-import-watcher/watch.js`): läuft stabil, aber nur solange ein
  Rechner mit Wohnungs-/Server-IP tatsächlich an ist und das Skript läuft.
- Bereits verworfen: YouTube-Cookie-Erneuerung als alleinige Lösung (verfällt in Stunden bei
  Datacenter-IPs, 2x erfolglos probiert), Oracle-VPS/jeder andere Cloud-Mietserver (dieselbe
  IP-Reputations-Blockade wie GitHub Actions).

Recherche nach Alternativen (Invidious, Piped) ergab: beide Ökosysteme sterben selbst am
IP-Block-Problem — Invidious hat nur noch 8 öffentliche Instanzen (API bei allen getesteten
abgeschaltet), Piped nur noch 1 funktionierende Instanz mit kaputten Audio-Streams (Workaround
über 360p-Video-Tonspur, hörbar schlechtere Qualität).

**Cobalt** (cobalt.tools, Open-Source) hat dasselbe Community-Instanz-Modell, aber einen
entscheidenden architektonischen Unterschied: die Instanz selbst kontaktiert YouTube mit ihren
eigenen Cookies/ihrer eigenen IP und liefert bereits eine fertige MP3 über eine signierte
Tunnel-URL zurück. Unsere Seite (GitHub-Runner oder Watcher) kontaktiert nie YouTube direkt,
sondern nur den Cobalt-Server per normalem JSON-Request.

Live verifiziert am 2026-07-26 (echter Download, ID3-Tag-Header geprüft, kein Fake/Fehlerseite):
vier Community-Instanzen funktionieren ohne Turnstile-Captcha (also automatisierbar ohne
Browser) und unterstützen YouTube:
`api.cobalt.liubquanti.click`, `cobaltapi.kittycat.boo`, `rue-cobalt.xenon.zone`,
`cobaltapi.cjs.nz`.

Bekanntes Risiko (aus eigener Recherche, nicht nur Annahme): Bad Actors scrapen öffentliche
Cobalt-Instanzen massenhaft, was Bandbreite/Cookie-Vorrat der Betreiber aufbraucht — genau das
Schicksal, das Invidious fast komplett getroffen hat. Einzelne Instanzen können jederzeit
abschalten oder überlastet sein.

## Decision
In beiden Extraktions-Pfaden (`src/extractor_worker.py` und
`local-import-watcher/watch.js`) wird **zuerst ein Pool aus vier Cobalt-Instanzen probiert**,
randomisiert durchgemischt pro Lauf. Nur wenn **alle vier** scheitern, fällt der Job auf den
bisherigen yt-dlp-Weg zurück (mit Cookies bei GitHub Actions, ohne bei watch.js, wie vorher).

Konkret pro Instanz-Versuch:
1. `POST {instanz}/` mit `{"url": <youtube_url>, "downloadMode": "audio", "audioFormat": "mp3"}`
   (Timeout 20s).
2. Bei `status: "tunnel"` wird die zurückgegebene, zeitlich begrenzte Tunnel-URL heruntergeladen
   (Timeout 60s, Obergrenze 60 MB gegen eine fehlerhafte Instanz, die endlos/riesige Daten
   streamt).
3. Plausibilitätscheck der Antwort: mindestens 10 KB **und** gültiger MP3-Header (`ID3`-Tag
   oder Frame-Sync `0xFFFB`/`0xFFFA`) — verhindert, dass eine HTML-Fehlerseite als "Song"
   hochgeladen wird.
4. Titel wird aus dem von Cobalt vorgeschlagenen Dateinamen abgeleitet (kein zusätzlicher
   yt-dlp-Metadaten-Aufruf nötig — spart einen weiteren YouTube-Kontaktpunkt).
5. Dauer wird per `ffprobe` aus der fertigen MP3 ermittelt, da Cobalts Antwort selbst keine
   Dauer enthält.

Zusätzliche Sicherheitsmaßnahmen (siehe Code-Kommentare in beiden Dateien):
- **SSRF-Sicherheitsnetz, ausgehend**: Nur URLs, die dem Muster `youtube.com/watch?v=...` oder
  `youtu.be/...` entsprechen, werden überhaupt an eine Cobalt-Instanz geschickt.
- **SSRF-Sicherheitsnetz, zurückkommend** (nachträglich per Security-Review gefunden und
  gefixt, 2026-07-26): das ausgehende Netz allein reicht nicht — eine böswillige/kompromittierte
  Instanz könnte in ihrer Antwort eine Tunnel-URL zurückgeben, die auf ein internes Ziel zeigt
  (Cloud-Metadaten-Dienst `169.254.169.254`, `localhost`, Intranet-Host), und Runner/Watcher
  hätten das blind angefragt. `_is_safe_tunnel_url()` / `isSafeTunnelUrl()` prüft die
  zurückgegebene Tunnel-URL vor dem Fetch: nur `https`, und die aufgelöste IP darf nicht in
  einem privaten/reservierten Bereich liegen (RFC1918, loopback, link-local). Bewusst **kein**
  Host-Allowlist (nur derselbe Host wie die API-Instanz), da Cobalt-Tunnel live beobachtet
  häufig auf einem anderen Host als die angefragte API-Instanz liegen.
- **Streaming-Downloadgrenze inkrementell durchgesetzt** (60 MB) in *beiden* Sprachen — der
  erste Node-Entwurf hatte die Antwort erst komplett in den Speicher gepuffert und *danach*
  die Größe geprüft (wirkungslos gegen eine Instanz, die endlos Daten sendet); jetzt bricht
  `readWithCap()` den Stream ab, sobald das Limit während des Lesens überschritten wird, analog
  zu Pythons `iter_content`-Zähler.
- **Robuste Antwortverarbeitung**: eine Instanz kann technisch gültiges JSON liefern, das aber
  kein Objekt ist (Liste, `null`, String). Python prüft das explizit (`isinstance(data, dict)`),
  da `data.get(...)` sonst mit einem unabgefangenen `AttributeError` den ganzen Job statt nur
  diese eine Instanz hätte scheitern lassen — der Sinn des Fallback-Designs (nächste Instanz
  bzw. yt-dlp) wäre damit für genau den Fall unterlaufen worden, in dem er am wichtigsten ist.
- Kein eigenes Secret/API-Key wird an Cobalt gesendet — nur die Video-URL, nichts
  Vertrauliches.
- R2-Upload und Datenbank-Eintrag unterscheiden jetzt zwischen `.mp3`/`audio/mpeg`
  (Cobalt-Pfad) und `.m4a`/`audio/mp4` (yt-dlp-Pfad wie bisher).

`local-import-watcher/setup.bat` und `setup-linux.sh` laden jetzt zusätzlich `ffprobe`
herunter (vorher nur `ffmpeg`). Fehlt `ffprobe` auf einer bereits bestehenden Installation
(altes Setup, noch nicht aktualisiert), degradiert die Dauer-Ermittlung graceful auf `0`
statt den Import zu blockieren — kein Breaking Change für bestehende Watcher-Installationen.

## Alternatives Considered

### Cobalt als zusätzlichen dritten Fallback NACH GitHub Actions/Cookies
- Pros: bestehende, bewährte Pfade bleiben unverändert primär.
- Rejected: verfehlt den eigentlichen Zweck. Der Cookie-Export-Rhythmus wird nur dann seltener,
  wenn Cobalt im Normalfall VOR den Cookies greift, nicht nur als letzte Reserve nach zwei
  bereits gescheiterten, langsamen Versuchen.

### Nur eine einzelne Cobalt-Instanz fest verdrahten
- Pros: einfacher Code.
- Rejected: Community-Instanzen sind nachweislich volatil (siehe Invidious-Sterben). Eine
  einzelne Instanz wäre ein Single Point of Failure, der das ganze Feature lahmlegt, sobald
  ihr Betreiber abschaltet oder überlastet ist.

### Invidious oder Piped statt Cobalt
- Pros: bereits vorher evaluiert, ähnliches Konzept.
- Rejected: Invidious-API bei allen getesteten Instanzen 401/403 (praktisch tot). Piped hat nur
  noch eine funktionierende Instanz, deren Audio-Streams kaputt sind (Workaround nur über
  360p-Video mit hörbar schlechterer Tonqualität als Cobalts direkter MP3-Export).

### Eigene Cobalt-Instanz selbst hosten (Docker, eigener Server)
- Pros: keine Abhängigkeit von fremden Betreibern, volle Kontrolle.
- Rejected (vorerst): würde denselben "eigener Server nötig"-Aufwand zurückbringen, den der
  Nutzer explizit vermeiden wollte (kein Laptop, keine Dauer-Wartung). Bleibt eine mögliche
  spätere Eskalationsstufe, falls der öffentliche Instanz-Pool sich als zu unzuverlässig
  erweist.

## Consequences
- Im Erfolgsfall (Cobalt-Pfad greift) wird für GitHub Actions **kein** `YOUTUBE_COOKIES`-Secret
  mehr gebraucht — Cookie-Export wird zur reinen Rückfalloption für Videos, bei denen der
  gesamte Cobalt-Pool scheitert, nicht mehr zur täglichen Notwendigkeit.
  Dieser Erwartungswert ist noch NICHT über Wochen im Produktivbetrieb verifiziert
  (Live-Tests am 2026-07-26 waren Einzelabfragen, kein Dauerbetrieb) — bei Bedarf beobachten,
  ob der Pool tatsächlich so oft greift wie erhofft.
- Neue, nicht selbst kontrollierte Abhängigkeit: vier Community-Server ohne SLA. Fällt der
  gesamte Pool aus (z.B. alle vier gleichzeitig überlastet), verhält sich das System exakt wie
  vor diesem ADR (yt-dlp+Cookies) — kein Totalausfall, nur ein Rückfall auf den alten Zustand.
- Songs, die über Cobalt importiert wurden, landen als `.mp3`/`audio/mpeg` in R2 statt wie
  bisher als `.m4a`/`audio/mp4` — für die App unsichtbar (Audio-Element spielt beides ab),
  aber relevant für jeden künftigen Code, der Dateiendungen aus R2-Keys ableitet.
- Der Instanz-Pool (`COBALT_INSTANCES`) ist hart im Code verdrahtet, nicht dynamisch über
  `cobalt.directory` abgefragt — bewusst einfach gehalten für ein privates Ein-Nutzer-Projekt.
  Sollten mehrere der vier Instanzen dauerhaft ausfallen, muss die Liste manuell aktualisiert
  werden (neue Kandidaten lassen sich über `https://cobalt.directory/__data.json` oder manuelles
  Testen finden — Kriterium: `services` enthält `"youtube"`, keine `turnstileSitekey` gesetzt).
