// Regressionstest: nach dem Erstellen eines Senders kommt die Rueckfrage "jetzt abspielen?".
// Aufruf: node tools/diagnose/browsertest-sender-abspielen.mjs   (gestubbte API, nie der echte Worker)
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
await new Promise(r => server.listen(8767, r));

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

const hdr = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
await page.route('https://himusic-api.tyron-app.workers.dev/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: hdr });
    if (u.pathname.startsWith('/media/')) return route.fulfill({ status: 200, body: 'x' });
    if (u.pathname === '/songs' && req.method() === 'GET') return route.fulfill({ status: 200, headers: hdr, body: JSON.stringify(serverSongs) });
    return route.fulfill({ status: 200, headers: hdr, body: '[]' });
});
await page.route(/mzstatic|youtube|googleapis/, r => r.fulfill({ status: 200, body: '' }));
await page.addInitScript(() => { localStorage.setItem('himusic_auth', 'true'); localStorage.setItem('himusic_api_key', 'test'); });
await page.goto(`http://localhost:8767/index.html`);
await page.waitForFunction(() => window.globalSongsData && window.globalSongsData.length === 20, null, { timeout: 15000 });
await page.waitForTimeout(300);

const dialogOpen = () => page.evaluate(() => document.getElementById('station-play-overlay').classList.contains('active'));
const playingList = () => page.evaluate(() => window.currentPlayingPlaylistId);
const lastStationId = () => page.evaluate(() => (JSON.parse(localStorage.getItem('heatbox_stations') || '[]')[0] || {}).id);
const create = (kind) => page.evaluate((k) => {
    window.currentContextSongId = 3;
    document.getElementById(k === 'artist' ? 'ctx-create-artist-station' : 'ctx-create-station').click();
}, kind);

ok(!(await dialogOpen()), 'Dialog ist vor dem Erstellen zu');

// 1. Song-Sender: Frage erscheint, Sender spielt noch NICHT
await create('song');
await page.waitForTimeout(300);
ok(await dialogOpen(), 'Song-Sender: Rueckfrage erscheint');
ok(await playingList() == null, 'Song-Sender: spielt vor der Antwort nicht', String(await playingList()));
const txt = await page.textContent('#station-play-text');
ok(txt.includes('Song 3'), 'Frage nennt den Sender-Namen', txt);

// 2. "Nicht jetzt": Dialog zu, nichts spielt, Sender bleibt erhalten
await page.click('#station-play-no');
await page.waitForTimeout(200);
ok(!(await dialogOpen()), '"Nicht jetzt" schliesst den Dialog');
ok(await playingList() == null, '"Nicht jetzt" startet keine Wiedergabe', String(await playingList()));
ok(!!(await lastStationId()), 'Sender bleibt gespeichert');

// 3. "Abspielen": Sender wird zur aktiven Quelle, ein Song laeuft
await create('song');
await page.waitForTimeout(300);
const id2 = await lastStationId();
ok(await dialogOpen(), 'zweiter Sender: Rueckfrage erscheint erneut');
await page.click('#station-play-yes');
await page.waitForTimeout(500);
ok(!(await dialogOpen()), '"Abspielen" schliesst den Dialog');
ok(await playingList() === id2, '"Abspielen" macht den neuen Sender zur Quelle', `${await playingList()} / ${id2}`);
ok(!!(await page.evaluate(() => window.currentPlayingSongId)), 'ein Song des Senders laeuft');

// 4. Alter Handler darf nicht nachwirken: Sender 3 erstellen, "Nicht jetzt", Sender 4 erstellen, "Abspielen" -> Sender 4, nicht 3
await create('song'); await page.waitForTimeout(300);
await page.click('#station-play-no');
await page.waitForTimeout(1100); // Date.now()-Ids muessen sich unterscheiden
await create('song'); await page.waitForTimeout(300);
const id4 = await lastStationId();
await page.click('#station-play-yes');
await page.waitForTimeout(500);
ok(await playingList() === id4, 'Abspielen gilt dem zuletzt erstellten Sender, nicht einem alten', `${await playingList()} / ${id4}`);

// 5. Kuenstler-Sender: gleiche Rueckfrage
await page.waitForTimeout(1100);
await create('artist'); await page.waitForTimeout(300);
const id5 = await lastStationId();
ok(await dialogOpen(), 'Kuenstler-Sender: Rueckfrage erscheint');
await page.click('#station-play-yes');
await page.waitForTimeout(500);
ok(await playingList() === id5, 'Kuenstler-Sender: Abspielen startet ihn', `${await playingList()} / ${id5}`);

// 6. Tippen neben den Dialog = "Nicht jetzt"
await page.waitForTimeout(1100);
await create('song'); await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('station-play-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(200);
ok(!(await dialogOpen()), 'Tippen daneben schliesst den Dialog');

ok(errors.length === 0, 'keine Seitenfehler', errors.join(' | '));
await browser.close();
server.close();
console.log(failed ? `\n${failed} FEHLGESCHLAGEN` : '\nalles gruen');
process.exit(failed ? 1 : 0);
