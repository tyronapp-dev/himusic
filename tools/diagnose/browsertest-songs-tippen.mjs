// Prueft: Tipp auf Song N in der Songs-Seite -> erster Eintrag der Handoff-Warteschlange == angetippter Song.
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
await new Promise(r => server.listen(8766, r));

// Songs ABSTEIGEND nach id (wie der echte Worker: ORDER BY id DESC), gemischte Dauern/Cover/Vibes
const VIBES = [['Rap', 'LD'], ['RnB', 'Calm'], ['Afro', 'Summer'], ['Rap', 'Hard rap'], ['Dance', 'Summer']];
const songs = Array.from({ length: 400 }, (_, i) => ({
  id: 400 - i, title: `Song ${400 - i}`, artist: `Artist ${i % 9}`, cover_data: `https://is1-ssl.mzstatic.com/x/600x600bb.jpg?${i}`,
  file_url: `https://himusic-api.tyron-app.workers.dev/media/s${400 - i}.mp3`, file_size: 5e6, duration: i % 3 === 0 ? 200 : 0,
  created_at: '2026-01-01', vibes: i % 7 === 0 ? '[]' : JSON.stringify(VIBES[i % 5]), content_hash: 'h' + i,
}));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route('https://himusic-api.tyron-app.workers.dev/**', route => {
  const u = new URL(route.request().url());
  route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(u.pathname === '/songs' ? songs : []) });
});
await page.route(/mzstatic|youtube|googleapis/, route => route.fulfill({ status: 200, body: '' }));
await page.addInitScript(() => {
  localStorage.setItem('himusic_auth', 'true'); localStorage.setItem('himusic_api_key', 'test');
  window.__posted = []; window.__himusicNativeShell = true;
  window.__himusicNativeCaps = ['queuePlayer', 'seekFraction', 'journal', 'keyboard', 'cachedIds', 'cacheBackground', 'setCover'];
  window.webkit = { messageHandlers: { himusicNative: { postMessage: m => window.__posted.push(m) }, himusicHttp: { postMessage: async () => ({ ok: false }) } } };
});
await page.goto('http://localhost:8766/index.html');
await page.waitForFunction(() => window.globalSongsData && window.globalSongsData.length === 400, null, { timeout: 15000 });
await page.click('.nav-btn[data-target="view-songs"]');
await page.waitForTimeout(600);

let fails = 0, checks = 0;
async function tapAndVerify(label, locatorIndex) {
  const items = page.locator('#songs-list-container .song-item');
  const n = await items.count();
  const idx = Math.min(locatorIndex, n - 1);
  const el = items.nth(idx);
  await el.scrollIntoViewIfNeeded();
  const wantId = parseInt(await el.getAttribute('data-id'));
  await page.evaluate(() => { window.__posted.length = 0; });
  await el.click();
  await page.waitForTimeout(250);
  const q = await page.evaluate(() => { const m = window.__posted.map(x => JSON.parse(x)).filter(x => x.queue); return m.length ? m[m.length - 1] : null; });
  checks++;
  const gotId = q && q.queue[0] && q.queue[0].id;
  const ok = !!q && gotId === wantId && q.startIndex === 0;
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: angetippt id=${wantId}, gesendet id=${gotId}, startIndex=${q && q.startIndex}, Queue=${q && q.queue.length}`);
}
await tapAndVerify('1. Eintrag', 0);
await tapAndVerify('Eintrag 7', 6);
await tapAndVerify('Eintrag 25', 24);
await tapAndVerify('Eintrag 59 (letzter der ersten Charge)', 58);
await tapAndVerify('Eintrag 80 (zweite Charge, Lazy-Load)', 79);

// nach Suche + Tab-Reset
await page.fill('#songs-search-input', 'Song 3');
await page.waitForTimeout(500);
await tapAndVerify('Suchtreffer 3', 2);
await page.click('.nav-btn[data-target="view-songs"]');   // Reset
await page.waitForTimeout(700);
await tapAndVerify('nach Tab-Reset: Eintrag 1', 0);
await tapAndVerify('nach Tab-Reset: Eintrag 12', 11);
// Home -> Songs -> tippen
await page.click('.nav-btn[data-target="view-home"]'); await page.waitForTimeout(400);
await page.click('.nav-btn[data-target="view-songs"]'); await page.waitForTimeout(600);
await tapAndVerify('nach Home->Songs: Eintrag 5', 4);
// Zufall (Shuffle) an
await page.evaluate(() => document.getElementById('btn-shuffle')?.classList.add('ctrl-active'));
await tapAndVerify('Shuffle an: Eintrag 9', 8);
await page.evaluate(() => document.getElementById('btn-shuffle')?.classList.remove('ctrl-active'));
// Doppeltipp (zwei schnelle Tipps auf verschiedene Songs)
{
  const items = page.locator('#songs-list-container .song-item');
  const a = items.nth(3), b = items.nth(4);
  const idA = parseInt(await a.getAttribute('data-id')), idB = parseInt(await b.getAttribute('data-id'));
  await page.evaluate(() => { window.__posted.length = 0; });
  await a.click(); await b.click();
  await page.waitForTimeout(300);
  const qs = await page.evaluate(() => window.__posted.map(x => JSON.parse(x)).filter(x => x.queue).map(x => x.queue[0].id));
  console.log(`Info: Doppeltipp ${idA} dann ${idB} -> gesendete Starts: ${JSON.stringify(qs)}`);
}
console.log(errors.length ? 'JS-Fehler: ' + errors.join(' | ') : 'keine JS-Fehler');
console.log(fails === 0 ? `\nALLE ${checks} ZUORDNUNGEN KORREKT` : `\n${fails} von ${checks} FALSCH`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
