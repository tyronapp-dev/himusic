// Read-only: Datentypen der Felder, die in den Handoff gehen. Nur Zaehlungen.
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
const songs = await (await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } })).json();
const typ = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
for (const f of ['id', 'title', 'artist', 'file_url', 'cover_data', 'duration', 'file_size', 'vibes']) {
  const c = {};
  for (const s of songs) { const t = typ(s[f]); c[t] = (c[t] || 0) + 1; }
  console.log(f.padEnd(10), JSON.stringify(c));
}
const strDur = songs.filter(s => typeof s.duration === 'string');
console.log('\nduration als TEXT:', strDur.length, '| Beispielwerte (max 5):', JSON.stringify(strDur.slice(0, 5).map(s => s.duration)));
const nonNum = songs.filter(s => typeof s.duration === 'number' && !Number.isFinite(s.duration));
console.log('duration NaN/Infinity:', nonNum.length);
// Wuerde JS "durationSec > 0 ? durationSec : undefined" einen Text durchlassen?
const wuerdeText = songs.filter(s => s.duration > 0 && typeof s.duration !== 'number');
console.log('Songs, bei denen der Handoff ein TEXT-d schickt:', wuerdeText.length);
