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
const POLL_INTERVAL_MS = 5000;
const CONCURRENT = IS_WINDOWS ? 3 : 2; // Server-VM hat oft weniger RAM/CPU als ein PC

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

async function getVideoInfo(url) {
    try {
        const { stdout } = await run(YTDLP_PATH, ['--print', '%(title)s\t%(duration)s', '--no-download', '--quiet', '--no-warnings', url], 30000);
        const [title, duration] = stdout.trim().split('\t');
        return { title: title || 'YouTube Import', duration: parseInt(duration, 10) || 0 };
    } catch (err) {
        return { title: 'YouTube Import', duration: 0 };
    }
}

async function downloadAudio(url, outputDir) {
    const outputTemplate = path.join(outputDir, '%(id)s.%(ext)s');
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await run(YTDLP_PATH, [
                '--no-playlist', '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '0',
                '--ffmpeg-location', FFMPEG_PATH,
                '--output', outputTemplate,
                '--no-progress', '--quiet', '--no-warnings',
                url,
            ]);
            const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.m4a'));
            if (files.length > 0) return path.join(outputDir, files[0]);
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
        console.log(`[${item.id}] Metadaten abrufen: ${item.youtube_url}`);
        const info = await getVideoInfo(item.youtube_url);

        console.log(`[${item.id}] Download: "${info.title}"`);
        const filePath = await downloadAudio(item.youtube_url, tmpDir);
        const fileBuf = fs.readFileSync(filePath);

        console.log(`[${item.id}] Upload nach R2 (${(fileBuf.length / 1048576).toFixed(1)} MB)...`);
        const safeFilename = `fast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_local_yt.m4a`;
        const uploadRes = await fetch(`${API_URL}/upload/${safeFilename}`, {
            method: 'PUT',
            headers: { ...API_HEADERS, 'Content-Type': 'audio/mp4' },
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
async function poll() {
    try {
        const res = await fetch(`${API_URL}/youtube-queue`, { headers: API_HEADERS });
        if (!res.ok) return;
        const items = await res.json();
        // Nur wirklich wartende Eintraege beanspruchen - "!item.status" faengt alte Zeilen ab,
        // die vor der status-Spalte angelegt wurden.
        const claimable = items.filter((item) => item.status === 'pending' || !item.status);
        for (const item of claimable) {
            if (active >= CONCURRENT) break;
            active++;
            lastActivityAt = Date.now();
            processOne(item).finally(() => { active--; lastActivityAt = Date.now(); });
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
