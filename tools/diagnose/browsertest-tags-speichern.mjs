// Regressionstest: Speichern im Audiotags-Editor darf nicht von einer aelteren GET-/songs-Antwort
// optisch zurueckgesetzt werden (Wettlauf: GET startet VOR dem Speichern, kommt NACH dem Klick an).
// Aufruf: node tools/diagnose/browsertest-tags-speichern.mjs   (gestubbte API, nie der echte Worker)
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const ROOT = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
const CHROME = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(8766, r));

const serverSongs = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, title: `Song ${i + 1}`, artist: `Artist ${i % 3}`, cover_data: '',
    file_url: `https://himusic-api.tyron-app.workers.dev/media/s${i + 1}.mp3`,
    file_size: 1, duration: 100, created_at: '2026-01-01', vibes: JSON.stringify(['Rap']), content_hash: 'h' + i,
}));
let failed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${m}${x ? ' — ' + x : ''}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

let putFails = false;
// Schranken statt Wartezeiten: die Reihenfolge der Antworten wird vom Test bestimmt, nicht vom Zufall.
let getGate = null, putGate = null; // Promise, auf das die naechste GET-/PUT-Antwort wartet (null = sofort)
const hdr = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
await page.route('https://himusic-api.tyron-app.workers.dev/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: hdr });
    if (u.pathname.startsWith('/media/')) return route.fulfill({ status: 200, body: 'x' });
    if (u.pathname === '/songs' && req.method() === 'GET') {
        const body = JSON.stringify(serverSongs); // Stand ZUM ANFRAGEZEITPUNKT, Antwort kommt spaeter
        if (getGate) await getGate;
        return route.fulfill({ status: 200, headers: hdr, body });
    }
    if (/^\/songs\/\d+$/.test(u.pathname) && req.method() === 'PUT') {
        if (putGate) await putGate;
        if (putFails) return route.fulfill({ status: 500, headers: hdr, body: '{}' });
        const s = serverSongs.find(x => x.id == u.pathname.split('/')[2]);
        const b = JSON.parse(req.postData());
        Object.assign(s, { title: b.title, artist: b.artist, vibes: JSON.stringify(b.vibes) });
        return route.fulfill({ status: 200, headers: hdr, body: '{}' });
    }
    return route.fulfill({ status: 200, headers: hdr, body: '[]' });
});
await page.route(/mzstatic|youtube|googleapis/, r => r.fulfill({ status: 200, body: '' }));
await page.addInitScript(() => { localStorage.setItem('himusic_auth', 'true'); localStorage.setItem('himusic_api_key', 'test'); });
await page.goto(`http://localhost:8766/index.html`);
await page.waitForFunction(() => window.globalSongsData && window.globalSongsData.length === 20, null, { timeout: 15000 });
await page.waitForTimeout(300);

const titleOf = (id) => page.evaluate((i) => window._songIndex.get(i)?.title, id);
const editAndSave = async (id, title) => {
    await page.evaluate((i) => { window.currentContextSongId = i; document.getElementById('ctx-edit-tags').click(); }, id);
    await page.fill('#edit-input-title', title);
    await page.click('#btn-save-tags');
};

// 1. Wettlauf: GET startet VOR dem Speichern (alter Stand), seine Antwort kommt NACH dem Klick, aber VOR der PUT-Bestaetigung
let openGet, openPut;
getGate = new Promise(r => { openGet = r; });
putGate = new Promise(r => { openPut = r; });
await page.evaluate(() => { window.__staleFetch = window.fetchSongsFromDatabase(true); });
await page.waitForTimeout(150); // GET ist beim Server angekommen und haengt an der Schranke
getGate = null; // spaetere GETs (Folge-GET nach dem PUT) laufen sofort
await editAndSave(5, 'NEU Song 5');
openGet(); // alte Antwort trifft jetzt ein
await page.evaluate(() => window.__staleFetch);
await page.waitForTimeout(200);
ok(await titleOf(5) === 'NEU Song 5', 'alte GET-Antwort setzt gespeicherten Titel NICHT zurueck', await titleOf(5));
putGate = null; openPut(); // PUT wird bestaetigt, Folge-GET laeuft
await page.waitForTimeout(800);
ok(await titleOf(5) === 'NEU Song 5', 'nach Bestaetigung steht der neue Titel weiter', await titleOf(5));
ok(serverSongs[4].title === 'NEU Song 5', 'Server hat den neuen Titel');

// 2. PUT scheitert: Anzeige bleibt auf neuem Stand, auch wenn danach frische Daten vom Server kommen
putFails = true;
await editAndSave(6, 'NEU Song 6');
await page.waitForTimeout(500);
await page.evaluate(() => window.fetchSongsFromDatabase(true));
await page.waitForTimeout(500);
ok(await titleOf(6) === 'NEU Song 6', 'fehlgeschlagenes PUT: Pending-Edit ueberlagert die Server-Liste', await titleOf(6));
const pend = await page.evaluate(() => JSON.parse(localStorage.getItem('heatbox_pending_edits') || '[]').length);
ok(pend === 1, 'Edit liegt als Pending-Edit', String(pend));

// 3. Netz wieder da: Pending-Edit wird nachgetragen
putFails = false;
await page.evaluate(() => window._flushPendingEdits());
await page.waitForTimeout(600);
ok(serverSongs[5].title === 'NEU Song 6', 'Pending-Edit wurde nachgetragen');
ok(await titleOf(6) === 'NEU Song 6', 'Titel nach Nachtragen korrekt', await titleOf(6));

// 4. Spaetere Aenderung von anderer Stelle (anderes Geraet) wird nach Bestaetigung wieder uebernommen
serverSongs[4].title = 'Vom anderen Geraet';
await page.evaluate(() => window.fetchSongsFromDatabase(true));
await page.waitForTimeout(500);
ok(await titleOf(5) === 'Vom anderen Geraet', 'bestaetigte Edits ueberlagern spaetere Serverstaende nicht dauerhaft', await titleOf(5));

ok(errors.length === 0, 'keine Seitenfehler', errors.join(' | '));
await browser.close();
server.close();
console.log(failed ? `\n${failed} FEHLGESCHLAGEN` : '\nalles gruen');
process.exit(failed ? 1 : 0);
