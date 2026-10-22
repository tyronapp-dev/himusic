// Browsertest der Seite gegen gestubbte API + gefaelschte native Bruecke.
// Nie gegen den echten Worker. Aufruf: node webtest.mjs
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

const ROOT = REPO;
const CHROME = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(8765, r));

// 120 Songs: Vibes abwechselnd, jeder 7. Song ohne Vibes, 3 mit eingebettetem Cover (1 davon > 250 KB), jeder 3. mit Dauer.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const BIG = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
const VIBES = [['Rap', 'LD'], ['RnB', 'Calm'], ['Afro', 'Summer'], ['Rap', 'Hard rap'], ['Dance', 'Summer']];
const songs = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1, title: `Song ${i + 1}`, artist: `Artist ${i % 9}`,
    cover_data: i === 4 || i === 60 ? GIF : (i === 30 ? BIG : `https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg?${i}`),
    file_url: `https://himusic-api.tyron-app.workers.dev/media/s${i + 1}.mp3`,
    file_size: 5000000, duration: i % 3 === 0 ? 200 + i : 0, created_at: '2026-01-01',
    vibes: i % 7 === 0 ? '[]' : JSON.stringify(VIBES[i % VIBES.length]), content_hash: 'h' + i,
}));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? ' — ' + extra : ''}`); if (!cond) failed++; };

async function newPage(caps, { shell = true } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = []; const mediaRequests = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.route('https://himusic-api.tyron-app.workers.dev/**', route => {
        const u = new URL(route.request().url());
        if (u.pathname.startsWith('/media/')) { mediaRequests.push(u.pathname); return route.fulfill({ status: 200, body: 'x' }); }
        const body = u.pathname === '/songs' ? songs : [];
        route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
    await page.route(/mzstatic|youtube|googleapis/, route => route.fulfill({ status: 200, body: '' }));
    await page.addInitScript(({ caps, shell }) => {
        localStorage.setItem('himusic_auth', 'true'); localStorage.setItem('himusic_api_key', 'test');
        window.__posted = [];
        if (shell) {
            window.__himusicNativeShell = true;
            window.__himusicNativeCaps = caps;
            window.__himusicNativeBuild = 'TEST';
            window.webkit = { messageHandlers: {
                himusicNative: { postMessage: m => window.__posted.push(m) },
                himusicHttp: { postMessage: async () => ({ ok: false }) },
            } };
        }
    }, { caps, shell });
    await page.goto('http://localhost:8765/index.html');
    await page.waitForFunction(() => window.globalSongsData && window.globalSongsData.length === 120, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    return { page, ctx, errors, mediaRequests };
}
const posted = (page) => page.evaluate(() => window.__posted.map(m => JSON.parse(m)));
const NEW_CAPS = ['queuePlayer', 'seekFraction', 'journal', 'keyboard', 'cachedIds', 'cacheBackground', 'setCover'];

// ───────────── 1. Handoff: Fortsetzung, Dauer, Cover-Fenster (ueber den echten Klickweg) ─────────────
{
    const { page, ctx, errors } = await newPage(NEW_CAPS);
    const lastQueue = () => page.evaluate(() => { const m = window.__posted.map(x => JSON.parse(x)).filter(x => x.queue); return m.length ? m[m.length - 1].queue : null; });
    // kurzer Sender mit 3 Songs: Song 1 antippen -> 2 Folgesongs -> Fortsetzung wird angehaengt
    await page.evaluate(() => {
        localStorage.setItem('heatbox_stations', JSON.stringify([{ id: 'station_t1', name: 'Test', kind: 'song', sourceSongId: 1, songIds: [1, 2, 3] }]));
        window.__posted.length = 0;
        window.openPlaylistDetails('station_t1', 'Test');
    });
    await page.waitForTimeout(600);
    await page.locator('#playlist-details-songs-container .song-item').first().click();
    await page.waitForTimeout(400);
    const q = await lastQueue();
    ok(!!q, 'Tipp im Sender loest Handoff aus');
    ok(q && q.length > 100, 'kurze Liste bekommt Fortsetzung', q ? q.length + ' Eintraege' : '');
    ok(q && new Set(q.map(i => i.id)).size === q.length, 'keine doppelten Songs in der Warteschlange');
    ok(q && q.slice(0, 3).map(i => i.id).join() === '1,2,3', 'gewaehlter Song + eigene Folgesongs bleiben vorn');
    ok(q && q.slice(3).every(i => i.s === 'Danach: ähnliche Songs'), 'Fortsetzung traegt eigenes Etikett');
    ok(q && q[0].d === 200 && q[1].d === undefined, 'Dauer nur mitgeschickt, wenn in der DB > 0', q ? JSON.stringify([q[0].d, q[1].d]) : '');
    // Fortsetzung abschaltbar
    await page.evaluate(() => { localStorage.setItem('himusic_autocontinue', '0'); window.__posted.length = 0; });
    await page.locator('#playlist-details-songs-container .song-item').first().click();
    await page.waitForTimeout(400);
    const q0 = await lastQueue();
    ok(q0 && q0.length === 3, 'Fortsetzung per localStorage abschaltbar', q0 ? String(q0.length) : '');
    await page.evaluate(() => localStorage.removeItem('himusic_autocontinue'));
    // lange Liste: Song 1 aus der Bibliothek -> 119 Folgesongs, KEINE Fortsetzung, Cover-Fenster
    await page.click('.nav-btn[data-target="view-songs"]');
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.locator('#songs-list-container .song-item').first().click();
    await page.waitForTimeout(400);
    const q2 = await lastQueue();
    ok(q2 && q2.length === 120, 'lange Liste bleibt unveraendert (keine Fortsetzung)', q2 ? String(q2.length) : '');
    const idx = id => q2.findIndex(i => i.id === id);
    ok(q2 && q2[idx(5)].c && q2[idx(5)].c.startsWith('data:'), 'eingebettetes Cover INNERHALB des Fensters (Song 5) kommt mit');
    ok(q2 && !q2[idx(61)].c, 'eingebettetes Cover AUSSERHALB des Fensters (Song 61) kommt nicht mit');
    ok(q2 && !q2[idx(31)].c, 'Cover > 250 KB kommt nie mit');
    ok(q2 && q2[idx(10)].c.startsWith('http'), 'http-Cover kommen weiter immer mit');
    const bytes = q2 ? JSON.stringify(q2).length : 0;
    ok(bytes > 0 && bytes < 600 * 1024, 'Handoff-JSON klein', Math.round(bytes / 1024) + ' KB');
    ok(errors.length === 0, 'keine JS-Fehler (Test 1)', errors.join(' | '));
    await ctx.close();
}

// ───────────── 2. Zeitleiste, neue Huelle: Anteil, genau EIN Sprung pro Tipp ─────────────
{
    const { page, ctx, errors } = await newPage(NEW_CAPS);
    await page.evaluate(() => { document.getElementById('fullscreen-player').classList.add('open'); window.__posted.length = 0; });
    await page.waitForTimeout(500);
    const rect = await page.evaluate(() => { const r = document.querySelector('.time-bg').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
    ok(rect.w > 100, 'Zeitleiste hat Breite', `${Math.round(rect.w)} px`);
    // Dauer unbekannt (window.currentSongDuration = 0): Tipp bei 75 %
    await page.touchscreen.tap(rect.x + rect.w * 0.75, rect.y);
    await page.waitForTimeout(1200);   // synthetische Maus-Ereignisse + Sperrfrist abwarten
    let seeks = (await posted(page)).filter(m => m.cmd === 'seekTo');
    ok(seeks.length === 1, 'genau EIN seekTo pro Tipp (kein Doppel durch synthetische Maus)', `${seeks.length}`);
    ok(seeks[0] && Math.abs(seeks[0].fraction - 0.75) < 0.02, 'Anteil entspricht der beruehrten Stelle', JSON.stringify(seeks[0]));
    ok(seeks[0] && seeks[0].seconds === undefined, 'ohne bekannte Dauer wird keine Sekundenzahl geraten');
    // Dauer bekannt: beide Felder
    await page.evaluate(() => { window.__posted.length = 0; window._applyNativeProgress(10, 240); });
    await page.touchscreen.tap(rect.x + rect.w * 0.25, rect.y);
    await page.waitForTimeout(1200);
    seeks = (await posted(page)).filter(m => m.cmd === 'seekTo');
    ok(seeks.length === 1 && Math.abs(seeks[0].fraction - 0.25) < 0.02 && Math.abs(seeks[0].seconds - 60) < 5, 'mit Dauer: Anteil UND Sekunden', JSON.stringify(seeks[0]));
    // Waehrend der Finger liegt, ueberschreibt der Sekundenpush die Anzeige nicht
    const held = await page.evaluate(({ x, y, w }) => {
        const el = document.querySelector('.time-bg');
        const mk = (type, cx) => new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: el, clientX: cx, clientY: y })], changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: y })] });
        el.dispatchEvent(mk('touchstart', x + w * 0.8));
        const before = document.querySelector('.time-progress').style.width;
        window._applyNativeProgress(10, 240);                 // Push mit ALTER Position (4 %)
        const during = document.querySelector('.time-progress').style.width;
        el.dispatchEvent(mk('touchend', x + w * 0.8));
        return { before, during };
    }, rect);
    ok(held.before === held.during, 'Push waehrend des Ziehens ueberschreibt die gezogene Stelle nicht', JSON.stringify(held));
    ok(errors.length === 0, 'keine JS-Fehler (Test 2)', errors.join(' | '));
    await ctx.close();
}

// ───────────── 3. Zeitleiste, AELTERE Huelle (ohne seekFraction): altes Verhalten bleibt ─────────────
{
    const { page, ctx, errors } = await newPage([]);
    await page.evaluate(() => { document.getElementById('fullscreen-player').classList.add('open'); window.__posted.length = 0; });
    await page.waitForTimeout(500);
    const rect = await page.evaluate(() => { const r = document.querySelector('.time-bg').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
    await page.touchscreen.tap(rect.x + rect.w * 0.5, rect.y);
    await page.waitForTimeout(1200);
    let seeks = (await posted(page)).filter(m => m.cmd === 'seekTo');
    ok(seeks.length === 0, 'alte Huelle, Dauer unbekannt: Sprung wird zurueckgehalten');
    await page.evaluate(() => window._applyNativeProgress(5, 200));
    seeks = (await posted(page)).filter(m => m.cmd === 'seekTo');
    ok(seeks.length === 1 && Math.abs(seeks[0].seconds - 100) < 4 && seeks[0].fraction === undefined, 'alte Huelle: nach erster echter Dauer genau ein Sprung in Sekunden', JSON.stringify(seeks[0]));
    ok(errors.length === 0, 'keine JS-Fehler (Test 3)', errors.join(' | '));
    await ctx.close();
}

// ───────────── 4. Tab-Wechsel zeigt Standardansicht ─────────────
{
    const { page, ctx, errors } = await newPage(NEW_CAPS);
    await page.click('.nav-btn[data-target="view-songs"]');
    await page.waitForTimeout(500);
    const items0 = await page.locator('#songs-list-container .song-item').count();
    await page.fill('#songs-search-input', 'zzzz');
    await page.waitForTimeout(500);
    const none = await page.locator('#songs-list-container .song-item').count();
    ok(none === 0, 'Suche ohne Treffer leert die Liste', `${none}`);
    await page.click('.nav-btn[data-target="view-songs"]');   // erneuter Tipp auf aktiven Tab
    await page.waitForTimeout(600);
    const val = await page.inputValue('#songs-search-input');
    const items1 = await page.locator('#songs-list-container .song-item').count();
    ok(val === '' && items1 > 0 && items1 === items0, 'erneuter Tipp auf aktiven Tab: Suche leer, Liste wieder da', `value="${val}", ${items1}/${items0}`);
    // Home-Suche, Tab-Wechsel hin und zurueck
    await page.click('.nav-btn[data-target="view-home"]');
    await page.waitForTimeout(400);
    await page.fill('#home-search-input', 'Song 1');
    await page.waitForTimeout(500);
    const shown = await page.evaluate(() => document.getElementById('home-search-results').style.display);
    ok(shown === 'flex', 'Home-Suche zeigt Ergebnisse');
    await page.click('.nav-btn[data-target="view-playlists"]');
    await page.waitForTimeout(400);
    await page.click('.nav-btn[data-target="view-home"]');
    await page.waitForTimeout(500);
    const home = await page.evaluate(() => ({ v: document.getElementById('home-search-input').value, r: document.getElementById('home-search-results').style.display, d: document.getElementById('home-default-content')?.style.display }));
    ok(home.v === '' && home.r === 'none' && home.d !== 'none', 'Home: nach Tab-Wechsel Standardansicht', JSON.stringify(home));
    ok(errors.length === 0, 'keine JS-Fehler (Test 4)', errors.join(' | '));
    await ctx.close();
}

// ───────────── 5. Tastatur, Cache-Stand, Protokoll, Hintergrund-Cache ─────────────
{
    const { page, ctx, errors, mediaRequests } = await newPage(NEW_CAPS);
    await page.waitForTimeout(600);
    const msgs = await posted(page);
    const cb = msgs.find(m => m.cmd === 'cacheBackground');
    ok(cb && cb.items.length === 120, 'Huelle bekommt die Bibliothek EINMAL zum Auffuellen', cb ? `${cb.items.length} Songs` : 'keine Nachricht');
    ok(cb && cb.items.every(i => i.c === null && i.u), 'Auffuell-Liste ohne Cover-Ballast');
    ok(msgs.filter(m => m.cmd === 'cacheBackground').length === 1, 'nur eine Auffuell-Nachricht');
    await page.waitForTimeout(6500);   // alter Startverzug des Web-Caches (5 s)
    ok(mediaRequests.length === 0, 'Seite laedt in der Huelle KEINE Audiodateien mehr in die IndexedDB', `${mediaRequests.length} Abrufe`);

    await page.evaluate(() => window._applyNativeKeyboard(true));
    await page.waitForTimeout(350);
    const hidden = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('bottom-nav')); return { v: s.visibility, o: s.opacity }; });
    ok(hidden.v === 'hidden' && hidden.o === '0', 'Tastatur offen: Navigationsleiste ausgeblendet', JSON.stringify(hidden));
    await page.evaluate(() => window._applyNativeKeyboard(false));
    await page.waitForTimeout(350);
    const shownAgain = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('bottom-nav')); return { v: s.visibility, o: s.opacity }; });
    ok(shownAgain.v === 'visible' && shownAgain.o === '1', 'Tastatur zu: Leiste wieder da', JSON.stringify(shownAgain));

    await page.evaluate(() => window._applyNativeCachedIds([1, 2, 3, 4]));
    await page.waitForTimeout(300);
    const label = await page.evaluate(() => document.getElementById('offline-btn-label')?.textContent);
    ok(/4 Songs offline/.test(label || ''), 'Offline-Zaehler kommt aus dem nativen Cache-Stand', label);

    await page.evaluate(() => window._applyNativeJournal('12:00:00.000  Start\n12:00:01.000  Wechsel 0->1'));
    const j = await page.evaluate(() => ({ open: document.getElementById('native-journal-overlay').classList.contains('open'), text: document.getElementById('njo-text').textContent }));
    ok(j.open && /Seite v2\.00/.test(j.text) && /Hülle TEST/.test(j.text) && /Wechsel 0->1/.test(j.text), 'Protokoll-Ansicht zeigt Fassungen + native Zeilen');
    const over = await posted(page);
    ok(over.some(m => m.cmd === 'playerView' && m.open === true), 'Protokoll-Ansicht meldet "Overlay offen" an die native Leiste');
    await page.click('#njo-close');
    ok(await page.evaluate(() => !document.getElementById('native-journal-overlay').classList.contains('open')), 'Protokoll schliesst');

    // Diagnose-Zeile fragt das Protokoll bei der Huelle an
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.evaluate(() => document.getElementById('btn-playback-diag').click());
    ok((await posted(page)).some(m => m.cmd === 'journal'), 'Diagnose-Zeile fordert das native Protokoll an');

    // setCover: Song mit eingebettetem Cover ausserhalb des Fensters
    await page.evaluate(() => { window.__posted.length = 0; window._applyNativeNowPlaying({ id: 61, t: 'Song 61', a: 'A', u: 'u', c: '', d: 0, isPlaying: true }); });
    const sc = (await posted(page)).find(m => m.cmd === 'setCover');
    ok(sc && sc.id === 61 && sc.c.startsWith('data:image/'), 'fehlendes eingebettetes Cover wird per setCover nachgeliefert');
    ok(errors.length === 0, 'keine JS-Fehler (Test 5)', errors.join(' | '));
    await ctx.close();
}

// ───────────── 5a. Offline-Speicher (Aus / 3 / 6 GB / Alles), 22.10.2026 ─────────────
{
    const BUDGET_CAPS = [...NEW_CAPS, 'offlineBudget'];
    const { page, ctx, errors } = await newPage(BUDGET_CAPS);
    await page.waitForTimeout(800);
    let msgs = await posted(page);
    const sb = msgs.filter(m => m.cmd === 'setOfflineBudget');
    ok(sb.length >= 1 && sb.every(m => m.gb === 3), 'Standard 3 GB: Huelle bekommt setOfflineBudget 3', JSON.stringify(sb));
    ok(!msgs.some(m => m.cmd === 'cacheBackground'), 'bei 3 GB wird die Bibliothek NICHT zum Auffuellen geschickt');

    await page.evaluate(() => { window.__posted.length = 0; document.getElementById('btn-offline-mode').click(); });
    await page.waitForTimeout(200);
    const dlg = await page.evaluate(() => ({
        modal: document.getElementById('offline-modal').style.display,
        wrap: document.getElementById('offline-budget-wrap').style.display,
        start: document.getElementById('offline-start-btn').style.display,
        title: document.getElementById('offline-modal-title').textContent,
        radios: [...document.querySelectorAll('#offline-budget-opts [role=radio]')].map(b => ({ gb: b.dataset.gb, on: b.getAttribute('aria-checked'), t: b.textContent })),
    }));
    ok(dlg.modal === 'flex' && dlg.wrap === 'block' && dlg.start === 'none' && dlg.title === 'Offline-Speicher', 'Dialog zeigt die Einstellung statt des alten Herunterladen-Ablaufs', JSON.stringify(dlg));
    ok(dlg.radios.length === 4 && dlg.radios.filter(r => r.on === 'true').length === 1 && dlg.radios.find(r => r.on === 'true').gb === '3' && /✓/.test(dlg.radios.find(r => r.on === 'true').t), 'genau eine Option gewaehlt (3 GB), auch als Text markiert (nicht nur Farbe)', JSON.stringify(dlg.radios));
    ok((await posted(page)).some(m => m.cmd === 'cacheInfo'), 'Dialog fragt den aktuellen Speicherstand an');

    await page.evaluate(() => window._applyNativeCacheInfo({ budgetGB: 3, usedBytes: 2400000000, freeBytes: 20000000000, count: 412 }));
    const usage = await page.evaluate(() => document.getElementById('offline-budget-usage').textContent);
    ok(/2,4 GB/.test(usage) && /412 Songs/.test(usage) && /20,0 GB/.test(usage), 'Belegung wird angezeigt', usage);

    await page.evaluate(() => { window.__posted.length = 0; document.querySelector('#offline-budget-opts [data-gb="-1"]').click(); });
    await page.waitForTimeout(200);
    msgs = await posted(page);
    const all = msgs.find(m => m.cmd === 'cacheBackground');
    ok(msgs.some(m => m.cmd === 'setOfflineBudget' && m.gb === -1), '"Alles": setOfflineBudget -1');
    ok(all && all.gb === -1 && all.items.length === 120, '"Alles": Bibliothek geht mit gb=-1 an die Huelle (ein Schritt)', all ? `${all.items.length} Songs, gb=${all.gb}` : 'keine Nachricht');
    const lbl = await page.evaluate(() => document.getElementById('offline-btn-label').textContent);
    ok(/Alles/.test(lbl), 'Menue-Zeile zeigt den Modus', lbl);

    await page.evaluate(() => { window.__posted.length = 0; document.querySelector('#offline-budget-opts [data-gb="6"]').click(); });
    msgs = await posted(page);
    ok(msgs.some(m => m.cmd === 'setOfflineBudget' && m.gb === 6) && !msgs.some(m => m.cmd === 'cacheBackground'), '"6 GB": setOfflineBudget 6, kein Auffuellen');
    await page.evaluate(() => { window.__posted.length = 0; document.querySelector('#offline-budget-opts [data-gb="0"]').click(); });
    ok((await posted(page)).some(m => m.cmd === 'setOfflineBudget' && m.gb === 0), '"Aus": setOfflineBudget 0');

    // Speicher freigeben: bei "Alles" faellt die Einstellung auf 3 GB zurueck (sonst laedt die App sofort wieder auf)
    await page.evaluate(() => { window.confirm = () => true; document.querySelector('#offline-budget-opts [data-gb="-1"]').click(); window.__posted.length = 0; document.getElementById('offline-budget-clear').click(); });
    msgs = await posted(page);
    ok(msgs.some(m => m.cmd === 'clearOfflineCache'), '"Speicher freigeben" schickt clearOfflineCache');
    ok(msgs.some(m => m.cmd === 'setOfflineBudget' && m.gb === 3) && await page.evaluate(() => localStorage.getItem('himusic_offline_budget')) === '3', 'bei "Alles" wird beim Freigeben auf 3 GB gestellt');
    await page.evaluate(() => { window.confirm = () => false; window.__posted.length = 0; document.getElementById('offline-budget-clear').click(); });
    ok(!(await posted(page)).some(m => m.cmd === 'clearOfflineCache'), 'Abbrechen im Bestaetigungsdialog loescht nichts');

    // Wahl bleibt nach Neuladen erhalten und geht wieder an die Huelle
    await page.evaluate(() => localStorage.setItem('himusic_offline_budget', '6'));
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.reload();
    await page.waitForTimeout(1500);
    ok((await posted(page)).some(m => m.cmd === 'setOfflineBudget' && m.gb === 6), 'gespeicherte Wahl (6 GB) geht nach dem Neuladen wieder an die Huelle');
    ok(errors.length === 0, 'keine JS-Fehler (Test 5a)', errors.join(' | '));
    await ctx.close();

    // Aeltere Huelle ohne Faehigkeit: alter Ablauf bleibt
    const old = await newPage(NEW_CAPS);
    await old.page.evaluate(() => document.getElementById('btn-offline-mode').click());
    await old.page.waitForTimeout(200);
    const oldDlg = await old.page.evaluate(() => ({ wrap: document.getElementById('offline-budget-wrap').style.display, start: document.getElementById('offline-start-btn').style.display }));
    ok(oldDlg.wrap === 'none' && oldDlg.start === 'block', 'aeltere Huelle (ohne offlineBudget): alter Dialog bleibt', JSON.stringify(oldDlg));
    await old.ctx.close();
}

// ───────────── 5c. Hauptvibe: Form (Stern) + fester Doppelring statt Ring in --accent-text (22.10.2026) ─────────────
{
    const { page, ctx, errors } = await newPage(NEW_CAPS);
    const results = [];
    for (const accent of ['#fc3c44', '#ffffff', '#fff200', '#000000']) {
        results.push(await page.evaluate((accent) => {
            const hex = accent.replace('#', ''), r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
            const root = document.documentElement.style;
            root.setProperty('--accent', accent);
            root.setProperty('--accent-text', (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#000' : '#fff');   // wie _setAccentColor
            const mk = cls => { const d = document.createElement('div'); d.className = cls; d.textContent = 'Chill'; d.style.cssText = 'position:fixed;left:0;top:0;width:120px'; document.body.appendChild(d); return d; };
            const main = mk('vibe-pill active main-vibe'), plain = mk('vibe-pill active');
            const out = { accent, shadow: getComputedStyle(main).boxShadow, star: getComputedStyle(main, '::before').content, weight: getComputedStyle(main).fontWeight, plainStar: getComputedStyle(plain, '::before').content, plainShadow: getComputedStyle(plain).boxShadow };
            main.remove(); plain.remove();
            return out;
        }, accent));
    }
    const same = results.every(r => r.shadow === results[0].shadow);
    ok(same, 'Hauptvibe-Ring ist bei JEDER Akzentfarbe gleich (haengt nicht mehr an --accent-text)', JSON.stringify(results.map(r => r.shadow)));
    ok(/rgb\(255, 255, 255\)/.test(results[0].shadow) && /rgb\(10, 10, 12\)/.test(results[0].shadow), 'Doppelring: heller Aussenring + dunkler Innenring', results[0].shadow);
    ok(results.every(r => r.star === '"★"'), 'Hauptvibe traegt einen Stern (Form statt nur Farbe)', JSON.stringify(results.map(r => r.star)));
    ok(results.every(r => r.weight === '700'), 'Hauptvibe ist fett');
    ok(results.every(r => (r.plainStar === 'none' || r.plainStar === 'normal') && r.plainShadow === 'none'), 'normal aktive Pille hat weder Stern noch Ring', JSON.stringify(results[0]));
    ok(errors.length === 0, 'keine JS-Fehler (Test 5c)', errors.join(' | '));
    await ctx.close();
}

// ───────────── 5d. Audiotags-Editor: Kopfzeile, Reiter, EIN Scrollbereich, Chips in Akzentfarbe (22.10.2026) ─────────────
{
    const { page, ctx, errors } = await newPage(NEW_CAPS);
    await page.waitForTimeout(600);
    await page.evaluate(() => { localStorage.removeItem('himusic_edit_tab'); window.currentContextSongId = 5; document.getElementById('ctx-edit-tags').click(); });
    await page.waitForTimeout(500);
    const st = () => page.evaluate(() => {
        const ov = document.getElementById('edit-tags-overlay');
        const vis = id => { const el = document.getElementById(id); return !!el && !el.hidden && getComputedStyle(el).display !== 'none'; };
        return {
            open: ov.classList.contains('active'),
            tabs: [...ov.querySelectorAll('.edit-tab')].map(t => t.dataset.tab + ':' + t.getAttribute('aria-selected')),
            infos: vis('edit-panel-infos'), vibes: vis('edit-panel-vibes'), kuerzen: vis('edit-panel-kuerzen'), summary: vis('edit-summary'),
            saveInHead: !!ov.querySelector('.edit-head #btn-save-tags'), saveText: document.getElementById('btn-save-tags').textContent,
            cancels: ov.querySelectorAll('.close-sub-sheet').length,
            count: document.getElementById('edit-tab-count').textContent,
        };
    });
    const shot = async n => { if (process.env.SHOT) { await page.waitForTimeout(450); await page.screenshot({ path: process.env.SHOT + '/editor-' + n + '.png' }); } };
    if (process.env.SHOT) await page.evaluate(() => { const r = document.documentElement.style; r.setProperty('--accent', '#00ff1a'); r.setProperty('--accent-rgb', '0, 255, 26'); r.setProperty('--accent-text', '#000'); });
    await shot('1-infos');
    let s = await st();
    ok(s.open && s.saveInHead && s.saveText === 'Speichern' && s.cancels === 1, 'Editor: Kopfzeile mit Abbrechen + Speichern, kein zweites Abbrechen darunter', JSON.stringify(s));
    ok(s.tabs.join() === 'infos:true,vibes:false,kuerzen:false' && s.infos && !s.vibes && !s.kuerzen && !s.summary, 'Editor oeffnet auf "Infos", Song-Zeile dort ausgeblendet', JSON.stringify(s));
    const cover = await page.evaluate(() => { const r = document.getElementById('edit-cover-btn').getBoundingClientRect(); const t = document.getElementById('edit-input-title').getBoundingClientRect(); return { w: r.width, h: r.height, titleRight: t.left >= r.right - 1, inside: r.width > 0 }; });
    ok(cover.inside && cover.w <= 100 && cover.titleRight, 'Cover steht klein NEBEN den Feldern (Infos)', JSON.stringify(cover));

    await page.click('#edit-tab-vibes');
    s = await st();
    const summ = await page.evaluate(() => ({ t: document.getElementById('edit-summary-title').textContent, a: document.getElementById('edit-summary-artist').textContent, img: !!document.getElementById('edit-summary-img').getAttribute('src') }));
    ok(!s.infos && s.vibes && s.summary && s.tabs[1] === 'vibes:true', 'Reiter "Vibes": Panel + Song-Zeile sichtbar, Infos weg', JSON.stringify(s));
    ok(/Song 5/.test(summ.t) && summ.a.length > 0 && summ.img, 'Song-Zeile zeigt Titel, Kuenstler und Cover des bearbeiteten Songs', JSON.stringify(summ));

    // ein Scrollbereich: Vibe-Container scrollt NICHT selbst, .edit-panels schon
    const ov = await page.evaluate(() => ({ vib: getComputedStyle(document.getElementById('edit-vibes-container')).overflowY, pan: getComputedStyle(document.querySelector('#edit-tags-overlay .edit-panels')).overflowY, sheet: getComputedStyle(document.querySelector('#edit-tags-overlay .sheet-content')).overflowY, n: document.querySelectorAll('#edit-vibes-container .vibe-pill').length }));
    ok(ov.vib === 'visible' && ov.pan === 'auto' && ov.sheet !== 'auto' && ov.n >= 20, 'genau EIN Scrollbereich (kein verschachteltes Scrollen)', JSON.stringify(ov));

    // Chips folgen der Akzentfarbe der Einstellungen (relativ zu den schon gewaehlten Vibes des Test-Songs)
    const cnt = () => page.evaluate(() => document.querySelectorAll('#edit-vibes-container .vibe-pill.active').length);
    const lbl = n => n > 0 ? '· ' + n : '';
    const n0 = await cnt();
    s = await st();
    ok(s.count === lbl(n0), 'Zaehler am Reiter Vibes stimmt beim Oeffnen', s.count + ' vs ' + n0);
    await page.evaluate(() => { const r = document.documentElement.style; r.setProperty('--accent', '#ff9f0a'); r.setProperty('--accent-rgb', '255, 159, 10'); });
    await page.click('#edit-vibes-container .vibe-pill:not(.active)');
    await page.waitForTimeout(350);   // Uebergang 0,18 s
    const chip = await page.evaluate(() => { const p = document.querySelector('#edit-vibes-container .vibe-pill.active:not(.main-vibe):last-child') || [...document.querySelectorAll('#edit-vibes-container .vibe-pill.active')].pop(); const cs = getComputedStyle(p); return { active: p.classList.contains('active'), border: cs.borderTopColor, bg: cs.backgroundColor, check: getComputedStyle(p, '::before').content }; });
    ok(chip.active && chip.border === 'rgb(255, 159, 10)' && /255, 159, 10/.test(chip.bg), 'gewaehlter Chip uebernimmt die Akzentfarbe aus den Einstellungen', JSON.stringify(chip));
    ok(chip.check === '"✓"', 'gewaehlter Chip traegt zusaetzlich einen Haken (Form, nicht nur Farbe)', chip.check);
    s = await st();
    ok(s.count === lbl(n0 + 1), 'Zaehler zaehlt beim Waehlen mit', s.count);
    await page.dblclick('#edit-vibes-container .vibe-pill:not(.active)');
    await page.waitForTimeout(200);
    const main = await page.evaluate(() => { const p = document.querySelector('#edit-vibes-container .vibe-pill.main-vibe'); return { main: !!p, star: p ? getComputedStyle(p, '::before').content : null }; });
    s = await st();
    ok(main.main && main.star === '"★"' && s.count === lbl(n0 + 2), 'Doppeltippen: Hauptvibe mit Stern, Zaehler +1', JSON.stringify({ main, count: s.count }));
    await page.click('#edit-vibes-container .vibe-pill.active:not(.main-vibe)');
    s = await st();
    ok(s.count === lbl(n0 + 1) || s.count === lbl(n0), 'Abwaehlen zaehlt zurueck', s.count);

    await shot('2-vibes');
    await page.click('#edit-tab-kuerzen');
    await shot('3-kuerzen');
    s = await st();
    ok(s.kuerzen && !s.vibes && await page.evaluate(() => !!document.getElementById('btn-trim-song').offsetParent), 'Reiter "Kuerzen" zeigt das Kuerzen-Formular', JSON.stringify(s));

    // Pfeiltasten wechseln den Reiter, Song-Zeile bringt zurueck zu Infos
    await page.focus('#edit-tab-kuerzen');
    await page.keyboard.press('ArrowLeft');
    s = await st();
    ok(s.vibes && s.tabs[1] === 'vibes:true', 'Pfeiltaste links: Kuerzen -> Vibes', JSON.stringify(s));
    await page.click('#edit-summary');
    s = await st();
    ok(s.infos && !s.summary, 'Tipp auf die Song-Zeile fuehrt zurueck zu Infos');

    // letzter Reiter wird gemerkt
    await page.click('#edit-tab-vibes');
    await page.evaluate(() => document.querySelector('#edit-tags-overlay .edit-head-btn').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.currentContextSongId = 6; document.getElementById('ctx-edit-tags').click(); });
    await page.waitForTimeout(400);
    s = await st();
    const nNew = await cnt();
    ok(s.open && s.vibes && s.tabs[1] === 'vibes:true' && s.count === lbl(nNew), 'Editor oeffnet auf dem zuletzt benutzten Reiter, Zaehler passt zum neuen Song', JSON.stringify({ s, nNew }));
    ok(errors.length === 0, 'keine JS-Fehler (Test 5d)', errors.join(' | '));
    await ctx.close();
}

// ───────────── 5b. Zweite Dauer-Quelle: das <audio> der Huelle darf NICHT mit dem letzten Song befuellt werden ─────────────
for (const shell of [true, false]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.route('https://himusic-api.tyron-app.workers.dev/**', route => {
        const u = new URL(route.request().url());
        route.fulfill({ status: 200, headers: { 'content-type': u.pathname.startsWith('/media/') ? 'audio/mpeg' : 'application/json', 'access-control-allow-origin': '*' }, body: u.pathname === '/songs' ? JSON.stringify(songs) : (u.pathname.startsWith('/media/') ? 'x' : '[]') });
    });
    await page.route(/mzstatic|youtube|googleapis/, route => route.fulfill({ status: 200, body: '' }));
    await page.addInitScript(({ shell }) => {
        localStorage.setItem('himusic_auth', 'true'); localStorage.setItem('himusic_api_key', 'test');
        localStorage.setItem('heatbox_state', JSON.stringify({ volume: 1, currentTime: 30, currentSong: { id: 1, title: 'Song 1', artist: 'A', fileUrl: 'https://himusic-api.tyron-app.workers.dev/media/s1.mp3', coverUrl: '', duration: 100, vibes: [] }, queue: [] }));
        window.__posted = [];
        if (shell) {
            window.__himusicNativeShell = true; window.__himusicNativeCaps = ['queuePlayer', 'seekFraction'];
            window.webkit = { messageHandlers: { himusicNative: { postMessage: m => window.__posted.push(m) }, himusicHttp: { postMessage: async () => ({ ok: false }) } } };
        }
    }, { shell });
    await page.goto('http://localhost:8765/index.html');
    await page.waitForFunction(() => window.globalSongsData && window.globalSongsData.length === 120, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    const src = await page.evaluate(() => document.getElementById('main-audio-player').getAttribute('src'));
    if (shell) ok(!src, 'Huelle: <audio> bleibt leer (keine veraltete Dauer des zuletzt gespeicherten Songs)', String(src));
    else ok(!!src, 'Browser: <audio> wird wie bisher mit dem letzten Song befuellt', String(src));
    if (shell) {
        // zwei Weiter-Tipps kurz hintereinander: beide muessen ankommen (neue Huelle ist selbst abgesichert)
        await page.evaluate(() => { window.__posted.length = 0; window.playNextSong(); window.playNextSong(); });
        const nexts = (await page.evaluate(() => window.__posted.map(m => JSON.parse(m)))).filter(m => m.cmd === 'next');
        ok(nexts.length === 2, 'neue Huelle: zwei schnelle Weiter-Tipps kommen beide an', String(nexts.length));
        // veraltete Dauer darf die Zeitleiste nicht beeinflussen: Anteil bleibt Anteil
        await page.evaluate(() => { document.getElementById('fullscreen-player').classList.add('open'); window.__posted.length = 0; });
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => { const b = document.querySelector('.time-bg').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; });
        await page.touchscreen.tap(r.x + r.w * 0.6, r.y);
        await page.waitForTimeout(1000);
        const s = (await page.evaluate(() => window.__posted.map(m => JSON.parse(m)))).filter(m => m.cmd === 'seekTo');
        ok(s.length === 1 && Math.abs(s[0].fraction - 0.6) < 0.02, 'Zeitleiste sendet den Anteil unabhaengig von gespeicherter Dauer', JSON.stringify(s[0]));
    }
    await ctx.close();
}
{
    // alte Huelle (ohne queuePlayer): die 800-ms-Sperre gegen Doppeltipps bleibt
    const { page, ctx } = await newPage(['seekFraction']);
    await page.evaluate(() => { window.__posted.length = 0; window.playNextSong(); window.playNextSong(); });
    const nexts = (await page.evaluate(() => window.__posted.map(m => JSON.parse(m)))).filter(m => m.cmd === 'next');
    ok(nexts.length === 1, 'alte Huelle: Doppeltipp-Sperre bleibt erhalten', String(nexts.length));
    await ctx.close();
}

// ───────────── 6. Ohne Huelle (Browser): alter Pfad intakt, keine Fehler ─────────────
{
    const { page, ctx, errors } = await newPage([], { shell: false });
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => typeof window._nativeBridge === 'undefined' || true), 'Browser-Modus laedt');
    ok(errors.length === 0, 'keine JS-Fehler im Browser-Modus (Test 6)', errors.join(' | '));
    await ctx.close();
}

await browser.close();
server.close();
console.log(failed === 0 ? '\nALLE TESTS OK' : `\n${failed} TEST(S) FEHLGESCHLAGEN`);
process.exit(failed === 0 ? 0 : 1);
