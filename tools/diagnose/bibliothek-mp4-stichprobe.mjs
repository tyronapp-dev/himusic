// Read-only: Stichprobe der .mp4-Dateien. Holt nur Anfang/Ende per Range (nie ganze Dateien), sucht im MP4-Container
// nach Handler-Typen: 'vide' = Videospur, 'soun' = Audiospur. Gibt nur Zaehlungen aus (keine Titel, kein Key).
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
const songs = await (await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } })).json();
const mp4 = songs.filter(s => /\.mp4(\?|$)/i.test(s.file_url) && s.file_size);
// 8 groesste + 12 zufaellige
const big = mp4.slice().sort((a, b) => b.file_size - a.file_size).slice(0, 8);
const rnd = mp4.slice().sort(() => Math.random() - 0.5).slice(0, 12);
const sample = [...new Map([...big, ...rnd].map(s => [s.id, s])).values()];
async function range(url, start, end) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  return Buffer.from(await r.arrayBuffer());
}
function handlers(buf) {
  const out = new Set(); let i = -1;
  while ((i = buf.indexOf('hdlr', i + 1, 'latin1')) !== -1) {
    const t = buf.slice(i + 12, i + 16).toString('latin1');   // hdlr: version/flags(4) pre_defined(4) handler_type(4)
    if (/^[a-z]{4}$/.test(t)) out.add(t);
  }
  return out;
}
let video = 0, audioOnly = 0, unknown = 0; const rows = [];
for (const s of sample) {
  const url = s.file_url;
  const head = await range(url, 0, 1024 * 1024 - 1);
  let h = handlers(head);
  if (!h.has('soun') && !h.has('vide')) { const tail = await range(url, Math.max(0, s.file_size - 2 * 1024 * 1024), s.file_size - 1); h = handlers(tail); }
  const kind = h.has('vide') ? 'VIDEO+Audio' : h.has('soun') ? 'nur Audio' : 'unbekannt';
  if (kind === 'VIDEO+Audio') video++; else if (kind === 'nur Audio') audioOnly++; else unknown++;
  rows.push(`${(s.file_size / 1048576).toFixed(1).padStart(6)} MB  ${kind}`);
}
console.log(rows.join('\n'));
console.log(`\nStichprobe ${sample.length} von ${mp4.length} mp4: mit Videospur ${video}, nur Audio ${audioOnly}, unbekannt ${unknown}`);
