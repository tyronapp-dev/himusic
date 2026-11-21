// Regressionstest: nach dem Erstellen eines Senders kommt die Rueckfrage.
//  - laeuft/liegt kein Song an  -> "jetzt abspielen?" und der Sender startet sofort
//  - laeuft/liegt ein Song an   -> "nach dem aktuellen Song abspielen?": der Sender wird HINTER den
//                                  laufenden Song eingereiht, der Song wird nicht unterbrochen
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

const serverSongs = Array.from({ length: 80 }, (_, i) => ({
    id: i + 1, title: `Song ${i + 1}`, artist: `Artist ${i % 3}`, cover_data: '',
    file_url: `https://himusic-api.tyron-app.workers.dev/media/s${i + 1}.mp3`,
    file_size: 1, duration: 100, created_at: '2026-01-01', vibes: JSON.stringify(['Rap']), content_hash: 'h' + i,
}));
let failed = 0;
const ok = (c, m, x = '') => { console.log(`${c ? 'OK  ' : 'FAIL'} ${m}${x ? ' — ' + x : ''}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
const hdr = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

// Frischer Kontext = frischer localStorage (ein Neuladen wuerde den gespeicherten Player-Zustand zurueckholen).
async function openApp({ fakeBridge = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('https://himusic-api.tyron-app.workers.dev/**', async route => {
        const req = route.request();
        const u = new URL(req.url());
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: hdr });
        if (u.pathname.startsWith('/media/')) return route.fulfill({ status: 200, body: 'x' });
        if (u.pathname === '/songs' && req.method() === 'GET') return route.fulfill({ status: 200, headers: hdr, body: JSON.stringify(serverSongs) });
        return route.fulfill({ status: 200, headers: hdr, body: '[]' });
    });
    await page.route(/mzstatic|youtube|googleapis/, r => r.fulfill({ status: 200, body: '' }));
    await page.addInitScript((bridge) => {
        localStorage.setItem('himusic_auth', 'true'); localStorage.setItem('himusic_api_key', 'test');
        if (bridge) {
            window.__posted = [];
            window.__himusicNativeShell = true; window.__himusicNativeCaps = ['queuePlayer', 'seekFraction'];
            window.webkit = { messageHandlers: { himusicNative: { postMessage: m => window.__posted.push(m) }, himusicHttp: { postMessage: async () => ({ ok: false }) } } };
        }
    }, fakeBridge);
    await page.goto('http://localhost:8767/index.html');
    await page.waitForFunction(() => window.globalSongsData && window.globalSongsData.length === 80, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    const t = {
        page,
        dialogOpen: () => page.evaluate(() => document.getElementById('station-play-overlay').classList.contains('active')),
        playingList: () => page.evaluate(() => window.currentPlayingPlaylistId),
        playingSong: () => page.evaluate(() => window.currentPlayingSongId),
        lastStationId: () => page.evaluate(() => (JSON.parse(localStorage.getItem('heatbox_stations') || '[]')[0] || {}).id),
        stationSongIds: (id) => page.evaluate((i) => (JSON.parse(localStorage.getItem('heatbox_stations') || '[]').find(s => s.id === i) || {}).songIds || [], id),
        // savePlayerState speichert verzoegert (800 ms Entprellung) - erst danach ist heatbox_state aktuell
        queueIds: async () => { await page.waitForTimeout(1000); return page.evaluate(() => (JSON.parse(localStorage.getItem('heatbox_state') || '{}').queue || []).map(s => s.id)); },
        create: (kind, songId = 3) => page.evaluate(([k, id]) => {
            window.currentContextSongId = id;
            document.getElementById(k === 'artist' ? 'ctx-create-artist-station' : 'ctx-create-station').click();
        }, [kind, songId]),
        yesText: () => page.textContent('#station-play-yes'),
        text: () => page.textContent('#station-play-text'),
    };
    return t;
}

// ── A. Nichts laeuft: "jetzt abspielen?" ──────────────────────────────────────────────────────
{
    const t = await openApp();
    ok(!(await t.dialogOpen()), 'A: Dialog ist vor dem Erstellen zu');
    await t.create('song');
    await t.page.waitForTimeout(300);
    ok(await t.dialogOpen(), 'A: Rueckfrage erscheint');
    ok(await t.playingList() == null, 'A: spielt vor der Antwort nicht', String(await t.playingList()));
    ok((await t.text()).includes('Song 3') && (await t.text()).includes('jetzt abspielen'), 'A: Frage nennt Sender und "jetzt abspielen"', await t.text());
    ok(await t.yesText() === 'Abspielen', 'A: Knopf heisst "Abspielen"', await t.yesText());

    await t.page.click('#station-play-no');
    await t.page.waitForTimeout(200);
    ok(!(await t.dialogOpen()), 'A: "Nicht jetzt" schliesst den Dialog');
    ok(await t.playingList() == null, 'A: "Nicht jetzt" startet keine Wiedergabe', String(await t.playingList()));
    ok(!!(await t.lastStationId()), 'A: Sender bleibt gespeichert');

    await t.create('song');
    await t.page.waitForTimeout(300);
    const id2 = await t.lastStationId();
    await t.page.click('#station-play-yes');
    await t.page.waitForTimeout(500);
    ok(!(await t.dialogOpen()), 'A: "Abspielen" schliesst den Dialog');
    ok(await t.playingList() === id2, 'A: "Abspielen" macht den neuen Sender zur Quelle', `${await t.playingList()} / ${id2}`);
    ok(!!(await t.playingSong()), 'A: ein Song des Senders laeuft');

    // ── B. Es laeuft schon ein Song: nach dem Ende einreihen, NICHT unterbrechen ──────────────
    const songBefore = await t.playingSong();
    await t.page.waitForTimeout(1100); // Date.now()-Ids muessen sich unterscheiden
    await t.create('song', 7);
    await t.page.waitForTimeout(300);
    const id3 = await t.lastStationId();
    ok(await t.dialogOpen(), 'B: Rueckfrage erscheint auch bei laufendem Song');
    ok((await t.text()).includes('nach dem aktuellen Song'), 'B: Frage sagt "nach dem aktuellen Song"', await t.text());
    ok(await t.yesText() === 'Als nächstes', 'B: Knopf heisst "Als nächstes"', await t.yesText());
    await t.page.click('#station-play-yes');
    await t.page.waitForTimeout(400);
    ok(!(await t.dialogOpen()), 'B: Dialog schliesst');
    ok(await t.playingSong() === songBefore, 'B: laufender Song wird NICHT unterbrochen', `${await t.playingSong()} / ${songBefore}`);
    ok(await t.playingList() === id2, 'B: Quelle bleibt der alte Sender bis zum Songende', `${await t.playingList()} / ${id2}`);
    const ids3 = await t.stationSongIds(id3);
    const q = await t.queueIds();
    ok(ids3.length > 1 && JSON.stringify(q.slice(0, ids3.length)) === JSON.stringify(ids3), 'B: Warteschlange beginnt mit den Songs des neuen Senders, in Reihenfolge', `${q.slice(0, 4)} / ${ids3.slice(0, 4)}`);

    // "Nicht jetzt" fuegt nichts ein
    const qLenBefore = (await t.queueIds()).length;
    await t.page.waitForTimeout(1100);
    await t.create('song', 9);
    await t.page.waitForTimeout(300);
    await t.page.click('#station-play-no');
    await t.page.waitForTimeout(200);
    ok((await t.queueIds()).length === qLenBefore, 'B: "Nicht jetzt" aendert die Warteschlange nicht', `${(await t.queueIds()).length} / ${qLenBefore}`);

    // Alter Handler darf nicht nachwirken: zwei Sender erstellen, erster "Nicht jetzt", zweiter "Als nächstes"
    await t.page.waitForTimeout(1100);
    await t.create('song', 11);
    await t.page.waitForTimeout(300);
    await t.page.click('#station-play-no');
    await t.page.waitForTimeout(1100);
    await t.create('song', 13);
    await t.page.waitForTimeout(300);
    const id5 = await t.lastStationId();
    await t.page.click('#station-play-yes');
    await t.page.waitForTimeout(300);
    const ids5 = await t.stationSongIds(id5);
    const q5 = await t.queueIds();
    ok(JSON.stringify(q5.slice(0, ids5.length)) === JSON.stringify(ids5), 'B: "Als nächstes" gilt dem zuletzt erstellten Sender, nicht einem alten', `${q5.slice(0, 3)} / ${ids5.slice(0, 3)}`);

    // Kuenstler-Sender: gleiche Rueckfrage
    await t.page.waitForTimeout(1100);
    await t.create('artist');
    await t.page.waitForTimeout(300);
    ok(await t.dialogOpen() && (await t.yesText()) === 'Als nächstes', 'B: Kuenstler-Sender: gleiche Rueckfrage ("Als nächstes")');
    // Tippen neben den Dialog = "Nicht jetzt"
    await t.page.evaluate(() => document.getElementById('station-play-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await t.page.waitForTimeout(200);
    ok(!(await t.dialogOpen()), 'B: Tippen daneben schliesst den Dialog');
    await t.page.context().close();
}

// ── C. Kuenstler-Sender, nichts laeuft: startet sofort ───────────────────────────────────────
{
    const t = await openApp();
    await t.create('artist');
    await t.page.waitForTimeout(300);
    const id = await t.lastStationId();
    ok(await t.dialogOpen() && (await t.yesText()) === 'Abspielen', 'C: Kuenstler-Sender ohne laufenden Song: "Abspielen"');
    await t.page.click('#station-play-yes');
    await t.page.waitForTimeout(500);
    ok(await t.playingList() === id, 'C: Kuenstler-Sender startet sofort', `${await t.playingList()} / ${id}`);
    await t.page.context().close();
}

// ── D. Native Huelle (gefaelschte Bruecke): insertNext hinter den laufenden Song, richtige Reihenfolge ──
{
    const t = await openApp({ fakeBridge: true });
    // Es "laeuft" ein Song: die Huelle meldet ihn ueber _applyNativeNowPlaying, hier direkt gesetzt.
    await t.page.evaluate(() => { window.currentPlayingSongId = 1; window.__posted.length = 0; });
    await t.create('song', 3);
    await t.page.waitForTimeout(300);
    const id = await t.lastStationId();
    const ids = await t.stationSongIds(id);
    ok(await t.dialogOpen() && (await t.yesText()) === 'Als nächstes', 'D: Huelle: Rueckfrage "Als nächstes"');
    await t.page.evaluate(() => { window.__posted.length = 0; });
    await t.page.click('#station-play-yes');
    await t.page.waitForTimeout(300);
    const msgs = (await t.page.evaluate(() => window.__posted)).map(m => JSON.parse(m)).filter(m => m.cmd === 'insertNext');
    const expectedCount = Math.min(50, ids.length);
    ok(msgs.length === expectedCount, `D: ${expectedCount} insertNext-Befehle (Deckel 50)`, String(msgs.length));
    // Jeder Befehl setzt direkt hinter den laufenden Song -> UMGEKEHRTE Reihenfolge senden, dann stimmt die Endreihenfolge
    const sent = msgs.map(m => m.item.id);
    ok(JSON.stringify(sent) === JSON.stringify(ids.slice(0, expectedCount).reverse()), 'D: Befehle in umgekehrter Reihenfolge (Endreihenfolge = Senderreihenfolge)', `${sent.slice(0, 3)} / ${ids.slice(0, 3)}`);
    ok(msgs.every(m => m.item.s === `Aus Sender: Song 3`), 'D: jeder Song traegt die Herkunft "Aus Sender: Song 3"', msgs[0] && msgs[0].item.s);
    ok(!(await t.page.evaluate(() => window.__posted)).map(m => JSON.parse(m)).some(m => m.cmd === 'toggle' || m.cmd === 'next' || m.cmd === 'jumpTo'), 'D: kein Toggle/Skip/Sprung - der laufende Song wird nicht angefasst');
    await t.page.context().close();
}

ok(errors.length === 0, 'keine Seitenfehler', errors.join(' | '));
await browser.close();
server.close();
console.log(failed ? `\n${failed} FEHLGESCHLAGEN` : '\nalles gruen');
process.exit(failed ? 1 : 0);
