// Read-only: laedt GET /songs mit dem Key aus tools/.env und druckt NUR Aggregate (nie den Key, nie Titel).
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
if (!key) { console.log('kein Key'); process.exit(1); }
const r = await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } });
console.log('HTTP', r.status);
const songs = await r.json();
console.log('Songs:', songs.length, '| Felder:', Object.keys(songs[0] || {}).join(','));
const ext = {}; let dur0 = 0, durNull = 0, dataCover = 0, dataBytes = 0, httpCover = 0, noCover = 0, maxData = 0, sizeSum = 0, sizeKnown = 0;
const durs = [];
for (const s of songs) {
  const u = (s.file_url || '').split('?')[0]; const e = (u.match(/\.([a-z0-9]{2,4})$/i) || [,'?'])[1].toLowerCase();
  ext[e] = (ext[e] || 0) + 1;
  if (s.duration === 0) dur0++; else if (s.duration == null) durNull++; else durs.push(s.duration);
  const c = s.cover_data || '';
  if (c.startsWith('data:')) { dataCover++; dataBytes += c.length; maxData = Math.max(maxData, c.length); }
  else if (c.startsWith('http')) httpCover++; else noCover++;
  if (typeof s.file_size === 'number') { sizeSum += s.file_size; sizeKnown++; }
}
console.log('Formate:', JSON.stringify(ext));
console.log('duration==0:', dur0, '| null:', durNull, '| >0:', durs.length);
console.log('Cover: data-URI', dataCover, '(', Math.round(dataBytes/1024), 'KB gesamt, max', Math.round(maxData/1024), 'KB ) | http', httpCover, '| keins', noCover);
if (sizeKnown) console.log('file_size bekannt bei', sizeKnown, '=', (sizeSum/1073741824).toFixed(1), 'GB');
// Queue-Gewicht wie im Handoff: nur Cover <=250KB
let qBytes = 0; for (const s of songs) { const c = s.cover_data || ''; const cc = (c.startsWith('http') || (c.startsWith('data:image/') && c.length <= 250*1024)) ? c : ''; qBytes += 250 + (s.title||'').length + (s.artist||'').length + (s.file_url||'').length + cc.length; }
console.log('Geschaetzte Handoff-JSON-Groesse (volle Bibliothek):', (qBytes/1048576).toFixed(1), 'MB');
