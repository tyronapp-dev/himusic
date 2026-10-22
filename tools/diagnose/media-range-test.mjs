// Read-only: wie antwortet /media/* auf die Anfragen, die AVPlayer beim Streamen stellt (Range)? Keine Titel, kein Key in der Ausgabe.
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
const songs = await (await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } })).json();
const ext = s => ((s.file_url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1] || '?').toLowerCase();
const byExt = {};
for (const s of songs) (byExt[ext(s)] ||= []).push(s);
const pick = (arr, n) => arr.map(v => [Math.random(), v]).sort((a, b) => a[0] - b[0]).slice(0, n).map(x => x[1]);
const rows = [];
for (const [e, arr] of Object.entries(byExt)) {
  for (const s of pick(arr, 4)) {
    const t0 = Date.now();
    let r1, r2;
    try {
      r1 = await fetch(s.file_url, { headers: { Range: 'bytes=0-1' } });          // wie AVPlayers erste Anfrage
      await r1.arrayBuffer();
      r2 = await fetch(s.file_url, { headers: { Range: `bytes=${Math.max(0, (s.file_size || 1000000) - 1024)}-` } }); // Dateiende (moov/ID3v1)
      await r2.arrayBuffer();
    } catch (err) { rows.push([e, 'FEHLER', String(err).slice(0, 40)]); continue; }
    const h = (r, n) => r.headers.get(n) || '-';
    rows.push([e, `Range0-1: ${r1.status}`, `Ende: ${r2.status}`, `CT=${h(r1, 'content-type')}`, `AR=${h(r1, 'accept-ranges')}`, `CR=${h(r1, 'content-range')}`, `cache=${h(r1, 'cf-cache-status')}`, `${Date.now() - t0}ms`]);
  }
}
console.log('Formate:', Object.fromEntries(Object.entries(byExt).map(([k, v]) => [k, v.length])));
for (const r of rows) console.log(r.join(' | '));
// Ohne Range (wie der Download)
const s = pick(songs, 1)[0]; const r = await fetch(s.file_url);
console.log('\nohne Range:', r.status, 'CT=' + r.headers.get('content-type'), 'AR=' + r.headers.get('accept-ranges'), 'CL=' + r.headers.get('content-length'));
