// Himusic Cloud – YouTube-Import-Watcher (Windows-PC ODER Linux-Server, z.B. Oracle Cloud VM)
//
// Läuft auf einer normalen Internet-IP statt auf einem Cloud-CI-Runner. Der Grund: YouTubes
// Bot-Erkennung blockiert die Rechenzentrums-IPs von GitHub Actions zunehmend (bestätigt:
// mehrere Videos scheiterten dort 0/8 trotz PO-Token und TLS-Impersonation) – von einer
// normalen Heim- oder Server-IP aus gab es im Test keinen einzigen Bot-Block. Dieses Skript
// pollt die Cloud-Warteschlange und erledigt Download + Upload lokal.
//
// Voraussetzungen (einmalig):
//   Windows: yt-dlp.exe + ffmpeg.exe in DIESEN Ordner legen (siehe setup.bat)
//   Linux:   yt-dlp und ffmpeg systemweit installieren (z.B. per dnf/apt), dann läuft
//            dieses Skript unverändert – es erkennt das Betriebssystem automatisch.
//
// Start: node watch.js   (einfach laufen lassen, solange du Importe machen willst)

const { spawn } = require('child_process');
const dns = require('dns').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_URL = 'https://himusic-api.tyron-app.workers.dev';
// Der Worker prueft jetzt einen X-Api-Key-Header auf allen Routen ausser /media/* und
// /internal/register. Der Key steht NICHT hier im Code (das waere bei einem oeffentlichen Repo
// sofort geleakt), sondern in einer lokalen .env-Datei neben diesem Skript (Format:
// HIMUSIC_API_KEY=... auf einer Zeile) - .env ist in .gitignore und wird nie committet.
function _loadDotEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/i);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
_loadDotEnv();
const API_KEY = process.env.HIMUSIC_API_KEY || '';
if (!API_KEY) {
    console.error('HIMUSIC_API_KEY fehlt. Lege eine Datei ".env" neben watch.js an mit der Zeile:\nHIMUSIC_API_KEY=dein-key-hier');
    process.exit(1);
}
const API_HEADERS = { 'X-Api-Key': API_KEY };
const IS_WINDOWS = process.platform === 'win32';
// Windows: die mitgelieferten .exe-Dateien neben diesem Skript. Linux: die systemweit
// installierten Programme (liegen im PATH, z.B. nach "sudo dnf install yt-dlp ffmpeg").
const YTDLP_PATH = IS_WINDOWS ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
const FFMPEG_PATH = IS_WINDOWS ? path.join(__dirname, 'ffmpeg.exe') : 'ffmpeg';
const FFPROBE_PATH = IS_WINDOWS ? path.join(__dirname, 'ffprobe.exe') : 'ffprobe';
const POLL_INTERVAL_MS = 2000;
// Seit der Umstellung auf das native m4a-Format (siehe downloadAudio) faellt der CPU-teure
// opus->AAC-Transcode weg - die Arbeit ist jetzt fast nur noch Netzwerk-I/O, entsprechend
// vertraegt der PC mehr parallele Songs. Ueber .env (HIMUSIC_CONCURRENT=8) anpassbar, falls
// die eigene Leitung mehr hergibt oder YouTube bei zu vielen Parallelen zickt.
const CONCURRENT = parseInt(process.env.HIMUSIC_CONCURRENT, 10) || (IS_WINDOWS ? 5 : 2); // Server-VM hat oft weniger RAM/CPU als ein PC

function run(cmd, args, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { windowsHide: true });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { proc.kill(); reject(new Error('Zeitüberschreitung')); }, timeoutMs);
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`Exit-Code ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`));
        });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

// Community-Instanzen von cobalt.tools (Open-Source-Downloader, siehe ADR-009). Jede Instanz
// kontaktiert YouTube mit ihren EIGENEN Cookies/ihrer eigenen IP - wir schicken nur die Video-URL
// raus, nie eigene Zugangsdaten. Live getestet am 2026-07-26 (echter Audio-Download, ID3-Tag
// verifiziert), alle vier ohne Turnstile-Captcha (also automatisierbar). Reihenfolge wird pro
// Aufruf gemischt. Community-Betreiber koennen jederzeit abschalten/ueberlastet sein - deshalb
// bleibt yt-dlp als Sicherheitsnetz bestehen, wenn der ganze Pool scheitert (siehe processOne).
const COBALT_INSTANCES = [
    'https://api.cobalt.liubquanti.click',
    'https://cobaltapi.kittycat.boo',
    'https://rue-cobalt.xenon.zone',
    'https://cobaltapi.cjs.nz',
];
const YOUTUBE_URL_RE = /^https:\/\/(www\.|m\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/i;
const COBALT_MAX_BYTES = 60 * 1024 * 1024; // Sicherheitsnetz gegen eine fehlerhafte/kompromittierte Instanz

// Testphase (Nutzerwunsch 2026-07-26): yt-dlp-Fallback bewusst deaktiviert, damit die ECHTE
// Erfolgsquote des Cobalt-Pools sichtbar wird, statt von yt-dlp automatisch verdeckt zu werden.
// Scheitert der Cobalt-Pool, landet der Eintrag bewusst auf "failed" (manuell nachzuholen)
// statt automatisch auf yt-dlp+Cookies umzuschwenken. Zum Reaktivieren einfach auf false setzen.
const COBALT_ONLY_TESTING = true;

function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// SSRF-Schutz (siehe ADR-009-Review): eine boesartige/kompromittierte Cobalt-Instanz koennte
// statt einer echten Audio-Tunnel-URL ein internes Ziel zurueckgeben (Cloud-Metadaten-Dienst
// 169.254.169.254, localhost, Intranet-Host im Firmennetz dieses PCs) - dieser Watcher wuerde
// das sonst blind anfragen. YOUTUBE_URL_RE oben schuetzt nur die AUSGEHENDE Video-URL, nicht
// diese zurueckkommende. Kein Host-Allowlist (Tunnel liegen oft auf einem ANDEREN Host als die
// API-Instanz, live beobachtet), stattdessen: nur https, und die aufgeloeste IP darf nicht in
// einem privaten/reservierten Bereich liegen.
function isPrivateIp(ip, family) {
    if (family === 4) {
        const p = ip.split('.').map(Number);
        return p[0] === 10 || p[0] === 127 || p[0] === 0
            || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
            || (p[0] === 192 && p[1] === 168)
            || (p[0] === 169 && p[1] === 254); // link-local, deckt Cloud-Metadaten-IP ab
    }
    const lower = ip.toLowerCase();
    return lower === '::1' || /^fe[89ab][0-9a-f]:/.test(lower) /* fe80::/10 */ || /^f[cd][0-9a-f]{2}:/.test(lower) /* fc00::/7 */;
}

async function isSafeTunnelUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'https:') return false;
        const results = await dns.lookup(u.hostname, { all: true });
        return results.length > 0 && results.every((r) => !isPrivateIp(r.address, r.family));
    } catch (err) {
        return false;
    }
}

// Liest den Response-Body inkrementell und bricht SOFORT ab, sobald das Sicherheitslimit
// ueberschritten wird - anders als "erst voll in den Speicher laden, danach Groesse pruefen"
// (das wuerde eine boesartige Instanz trotzdem den vollen RAM fuellen lassen, bevor der Cap je
// greift).
async function readWithCap(response, maxBytes) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Tunnel lieferte mehr als ${(maxBytes / 1024 / 1024).toFixed(0)} MB, abgebrochen (Sicherheitslimit)`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

// Dauer per ffprobe - Cobalt liefert selbst keine Dauer in der Antwort. Fehlt ffprobe.exe (altere
// Windows-Installation vor diesem Update), liefert run() einen Spawn-Fehler, der hier abgefangen
// wird - Dauer faellt dann auf 0 zurueck statt den ganzen Import zu blockieren.
async function ffprobeDuration(filePath) {
    try {
        const { stdout } = await run(FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], 20000);
        return parseInt(parseFloat(stdout.trim()), 10) || 0;
    } catch (err) {
        return 0;
    }
}

async function tryCobaltDownload(youtubeUrl, outputDir) {
    if (!YOUTUBE_URL_RE.test(youtubeUrl)) return null; // Sicherheitsnetz: nur echte YouTube-URLs gehen an fremde Server raus

    for (const baseUrl of shuffled(COBALT_INSTANCES)) {
        try {
            const apiRes = await fetch(`${baseUrl}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                // audioBitrate explizit auf 320 (Cobalt-Default waere 128 kbit/s) - Cobalt ist seit
                // ADR-009 der primaere Importweg, Standard-Bitrate war unnoetig niedrig fuer Musik.
                body: JSON.stringify({ url: youtubeUrl, downloadMode: 'audio', audioFormat: 'mp3', audioBitrate: '320' }),
                signal: AbortSignal.timeout(20000),
            });
            if (!apiRes.ok) { console.log(`Cobalt-Instanz ${baseUrl}: HTTP ${apiRes.status}, naechste.`); continue; }
            const data = await apiRes.json();
            // Manche Instanzen liefern bei Fehlern gueltiges JSON, das aber kein Objekt ist
            // (z.B. eine leere Liste) - "data.status" waere dann nur undefined (kein Crash in
            // JS, anders als Pythons data.get() auf einer Liste), faellt also schon sauber in
            // die naechste Bedingung durch.
            if (!data || typeof data !== 'object' || data.status !== 'tunnel' || !data.url) { console.log(`Cobalt-Instanz ${baseUrl}: kein Download-Tunnel (status=${data && data.status}), naechste.`); continue; }
            if (!(await isSafeTunnelUrl(data.url))) { console.log(`Cobalt-Instanz ${baseUrl}: unsichere Tunnel-URL, naechste (SSRF-Schutz).`); continue; }

            const dlRes = await fetch(data.url, { signal: AbortSignal.timeout(60000) });
            if (!dlRes.ok) { console.log(`Cobalt-Tunnel ${baseUrl}: HTTP ${dlRes.status}, naechste.`); continue; }
            const buf = await readWithCap(dlRes, COBALT_MAX_BYTES);

            // Mini-Plausibilitaetscheck: echte MP3s beginnen mit "ID3" (v2-Tag) oder dem Frame-Sync
            // 0xFFFB/0xFFFA - schuetzt davor, eine HTML-Fehlerseite als "Song" hochzuladen.
            const isId3 = buf.length >= 3 && buf.toString('latin1', 0, 3) === 'ID3';
            const isFrameSync = buf.length >= 2 && buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xfa);
            if (buf.length < 10000 || !(isId3 || isFrameSync)) { console.log(`Cobalt-Instanz ${baseUrl}: keine plausible Audiodatei (${buf.length} Bytes), naechste.`); continue; }

            // Titel aus dem von Cobalt vorgeschlagenen Dateinamen ableiten (z.B. "Titel - Kanal.mp3"),
            // analog zur bisherigen Behandlung von YouTube-Titeln als freier Text (siehe ADR-004,
            // _esc() beim Rendern im Frontend) - hier nur auf sinnvolle Laenge begrenzt.
            const rawName = String(data.filename || 'cobalt_import.mp3');
            const title = rawName.replace(/\.mp3$/i, '').trim().slice(0, 300) || 'YouTube Import';

            const filePath = path.join(outputDir, 'cobalt_audio.mp3');
            fs.writeFileSync(filePath, buf);
            const duration = await ffprobeDuration(filePath);
            console.log(`Cobalt-Download ueber ${baseUrl} erfolgreich: ${title} (${(buf.length / 1024).toFixed(0)} KB, ${duration}s)`);
            return { filePath, title, duration };
        } catch (err) {
            console.log(`Cobalt-Instanz ${baseUrl} fehlgeschlagen (${err.message}), naechste.`);
        }
    }
    console.log('Alle Cobalt-Instanzen fehlgeschlagen - falle zurueck auf yt-dlp.');
    return null;
}

// Download UND Titel/Dauer in EINEM yt-dlp-Aufruf. Frueher lief davor ein separates getVideoInfo()
// (eigener voller YouTube-Abruf nur fuer den Titel) - das war ein zweiter Netzwerk-Roundtrip pro Song
// und eine zweite Gelegenheit fuer einen Bot-Block, ganz umsonst. "--no-simulate --print" laedt herunter
// und gibt gleichzeitig Titel+Dauer aus derselben Extraktion auf stdout aus.
async function downloadAudio(url, outputDir) {
    const outputTemplate = path.join(outputDir, '%(id)s.%(ext)s');
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const { stdout } = await run(YTDLP_PATH, [
                '--no-playlist',
                // WICHTIG fuer die Geschwindigkeit: ohne "-f" waehlt yt-dlp "bestaudio" = meist
                // opus/webm (Format 251). "--audio-format m4a" muss das dann per ffmpeg komplett
                // neu enkodieren (opus->AAC) - ein CPU-teurer Transcode pro Song, dessen Kosten mit
                // der Songlaenge wachsen. Format 140 ist bereits natives AAC im m4a-Container, yt-dlp
                // meldet dann "Not converting audio; file is already in target format m4a" und
                // ueberspringt ffmpeg ganz. Gemessen am selben Testvideo: 7,5s -> 4,2s, und Format 140
                // hat sogar die hoehere Bitrate (130 statt 106 kbit/s). Der "/bestaudio"-Zweig bleibt
                // als Rueckfall, falls ein Video ausnahmsweise kein m4a anbietet (dann wird konvertiert,
                // deshalb steht --audio-quality weiter unten drin).
                '-f', 'bestaudio[ext=m4a]/bestaudio',
                // Laedt die DASH-Fragmente parallel statt eins nach dem anderen - reine Netzwerk-
                // Beschleunigung, ohne mehr Songs gleichzeitig anzufassen.
                '--concurrent-fragments', '4',
                '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '0',
                '--ffmpeg-location', FFMPEG_PATH,
                '--output', outputTemplate,
                '--no-simulate', '--print', '%(title)s\t%(duration)s',
                '--no-progress', '--quiet', '--no-warnings',
                url,
            ]);
            const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.m4a'));
            if (files.length > 0) {
                const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
                const [title, duration] = line.split('\t');
                return {
                    filePath: path.join(outputDir, files[0]),
                    title: title || 'YouTube Import',
                    duration: parseInt(duration, 10) || 0,
                };
            }
        } catch (err) {
            lastErr = err;
            if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
        }
    }
    throw lastErr || new Error('Keine Audiodatei nach Download gefunden');
}

// Setzt den Status eines Warteschlangen-Eintrags im Worker (statt ihn wie frueher nach der
// Verarbeitung sofort zu loeschen) - so kann der Client in der App den echten Fortschritt
// anzeigen (wartet/laedt/fertig/fehlgeschlagen), statt raten zu muessen, ob gerade ein Watcher
// aktiv ist. Fehler beim Setzen selbst werden verschluckt (best effort, kein Grund den Import
// deswegen abzubrechen).
async function patchStatus(id, status, errorMessage) {
    try {
        await fetch(`${API_URL}/youtube-queue/${id}`, {
            method: 'PATCH',
            headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, error_message: errorMessage ?? null }),
        });
    } catch (err) {}
}

async function processOne(item) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-import-'));
    await patchStatus(item.id, 'processing');
    try {
        console.log(`[${item.id}] Download: ${item.youtube_url}`);
        // Cobalt-Pool zuerst versuchen (siehe ADR-009): kein Cookie-Bedarf, deren eigener Server
        // kontaktiert YouTube statt dieser IP. Nur bei Fehlschlag aller Instanzen folgt yt-dlp.
        const cobaltInfo = await tryCobaltDownload(item.youtube_url, tmpDir);
        if (!cobaltInfo && COBALT_ONLY_TESTING) {
            throw new Error('Cobalt-Pool fehlgeschlagen (yt-dlp-Fallback ist zur Testphase deaktiviert)');
        }
        const info = cobaltInfo || await downloadAudio(item.youtube_url, tmpDir);
        const isCobalt = !!cobaltInfo;
        const fileBuf = fs.readFileSync(info.filePath);

        console.log(`[${item.id}] Upload nach R2 (${(fileBuf.length / 1048576).toFixed(1)} MB)...`);
        const ext = isCobalt ? 'mp3' : 'm4a';
        const contentType = isCobalt ? 'audio/mpeg' : 'audio/mp4';
        const safeFilename = `fast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_local_yt.${ext}`;
        const uploadRes = await fetch(`${API_URL}/upload/${safeFilename}`, {
            method: 'PUT',
            headers: { ...API_HEADERS, 'Content-Type': contentType },
            body: fileBuf,
        });
        if (!uploadRes.ok) throw new Error(`Upload fehlgeschlagen: HTTP ${uploadRes.status}`);
        const { url: file_url } = await uploadRes.json();

        console.log(`[${item.id}] Registriere in der Datenbank...`);
        const songRes = await fetch(`${API_URL}/songs`, {
            method: 'POST',
            headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: info.title, artist: 'Unbekannt', cover_data: '',
                file_url, file_size: fileBuf.length, duration: info.duration, vibes: [],
            }),
        });
        const result = await songRes.json().catch(() => ({}));
        console.log(`[${item.id}] ${result.duplicate ? 'War inhaltlich schon vorhanden (Duplikat verworfen)' : '✅ Fertig: ' + info.title}`);
        await patchStatus(item.id, 'done');
    } catch (err) {
        console.error(`[${item.id}] ❌ Fehler: ${err.message}`);
        await patchStatus(item.id, 'failed', String(err.message || err).slice(0, 300));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// Auto-Beenden nach einer Weile Leerlauf: gedacht fuers "kurz vor dem Download anschalten, dann
// nicht mehr dran denken muessen"-Nutzungsmuster auf einem PC (nicht fuers dauerhafte Laufen auf
// einem Server, siehe unten). Der Leerlauf-Timer startet beim Programmstart neu (nicht sofort bei
// leerer Warteschlange), damit Zeit bleibt, nach dem Start noch Links in der App einzufuegen.
const AUTO_EXIT_WHEN_IDLE = IS_WINDOWS && process.env.HIMUSIC_NO_AUTO_EXIT !== '1';
const IDLE_EXIT_MS = 90000; // 90s ohne irgendetwas zu tun -> vermutlich fertig, sich selbst beenden
let lastActivityAt = Date.now();

let active = 0;
// Welche Eintraege dieser Watcher gerade selbst bearbeitet. Notwendig, weil der Server-Status erst
// dann von "pending" weggeht, wenn das patchStatus(...,'processing') angekommen ist - das ist ein
// eigener Netzwerk-Aufruf, dessen Fehler bewusst verschluckt werden (best effort). Ohne diese lokale
// Merkliste wuerde der naechste Poll (alle 2s) denselben Eintrag nochmal als "pending" sehen und ein
// ZWEITES Mal herunterladen; schlaegt der PATCH ganz fehl, sogar immer wieder. Das kostete genau die
// Bandbreite/CPU, die den Import langsam macht.
const inFlight = new Set();
async function poll() {
    try {
        const res = await fetch(`${API_URL}/youtube-queue`, { headers: API_HEADERS });
        if (!res.ok) return;
        const items = await res.json();
        // Nur wirklich wartende Eintraege beanspruchen - "!item.status" faengt alte Zeilen ab,
        // die vor der status-Spalte angelegt wurden.
        const claimable = items.filter((item) => (item.status === 'pending' || !item.status) && !inFlight.has(item.id));
        for (const item of claimable) {
            if (active >= CONCURRENT) break;
            active++;
            inFlight.add(item.id);
            lastActivityAt = Date.now();
            processOne(item).finally(() => { active--; inFlight.delete(item.id); lastActivityAt = Date.now(); });
        }
    } catch (err) {
        console.error('Konnte Warteschlange nicht abrufen:', err.message);
    }

    if (AUTO_EXIT_WHEN_IDLE && active === 0 && (Date.now() - lastActivityAt) > IDLE_EXIT_MS) {
        console.log('Seit einer Weile nichts mehr zu tun - beende mich automatisch. Einfach start.bat erneut doppelklicken, wenn wieder was ansteht.');
        process.exit(0);
    }
}

function startWatching() {
    console.log(`Himusic YouTube-Watcher gestartet (prüft alle ${POLL_INTERVAL_MS / 1000}s, bis zu ${CONCURRENT} parallel). Zum Beenden: Strg+C.`);
    if (AUTO_EXIT_WHEN_IDLE) console.log(`Beendet sich automatisch, wenn ${IDLE_EXIT_MS / 1000}s lang nichts zu tun war.`);
    setInterval(poll, POLL_INTERVAL_MS);
    poll();
}

if (IS_WINDOWS) {
    // Windows: die .exe-Dateien müssen als Dateien neben dem Skript liegen (setup.bat lädt sie).
    if (!fs.existsSync(YTDLP_PATH) || !fs.existsSync(FFMPEG_PATH)) {
        console.error('yt-dlp.exe und/oder ffmpeg.exe fehlen in diesem Ordner. Siehe Kommentar am Dateianfang.');
        process.exit(1);
    }
    startWatching();
} else {
    // Linux: liegen im PATH (Paketmanager) statt als Dateien hier – kurzer Check per "--version".
    let checked = 0;
    const fail = () => { console.error('yt-dlp und/oder ffmpeg sind nicht installiert oder nicht im PATH. Siehe Kommentar am Dateianfang.'); process.exit(1); };
    [[YTDLP_PATH, '--version'], [FFMPEG_PATH, '-version']].forEach(([bin, flag]) => {
        const proc = spawn(bin, [flag], { stdio: 'ignore' });
        proc.on('error', fail);
        proc.on('close', (code) => { if (code !== 0 && code !== null) return fail(); if (++checked === 2) startWatching(); });
    });
}
