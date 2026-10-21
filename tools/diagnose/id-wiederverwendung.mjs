// Read-only, nur Zaehlungen. Frage: gibt es Hinweise, dass Song-IDs wiederverwendet oder die Datei eines
// Songs ersetzt wurde (dann koennte ein nur nach id indizierter Cache eine fremde Datei ausliefern)?
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
const songs = await (await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } })).json();
console.log('Felder eines Songs:', Object.keys(songs[0]).join(', '));

const name = s => decodeURIComponent((s.file_url || '').split('/').pop() || '');
// Dateinamen-Muster zaehlen (ohne Titel auszugeben): Praefix bis zur ersten Ziffernfolge
const pat = {};
for (const s of songs) {
  const n = name(s);
  const k = n.replace(/\d{6,}/g, '<TS>').replace(/[A-Za-z0-9]{6,}(?=\.)/, '<X>').replace(/^[^_]*$/, '<ohne _>').slice(0, 40);
  pat[k] = (pat[k] || 0) + 1;
}
console.log('\nDateinamen-Muster (Top 12):');
for (const [k, v] of Object.entries(pat).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(String(v).padStart(5), k);

// Zeitstempel im Dateinamen: fast_<ts>_...
const withTs = songs.map(s => { const m = name(s).match(/(?:^|_)(1[5-9]\d{11})(?:_|\.)/); return m ? { id: s.id, ts: +m[1] } : null; }).filter(Boolean);
console.log('\nSongs mit Zeitstempel im Dateinamen:', withTs.length);
withTs.sort((a, b) => a.id - b.id);
let inversions = 0, examples = [];
for (let i = 1; i < withTs.length; i++) {
  if (withTs[i].ts < withTs[i - 1].ts - 60_000) { inversions++; if (examples.length < 8) examples.push([withTs[i - 1].id, withTs[i].id, Math.round((withTs[i - 1].ts - withTs[i].ts) / 86400000) + ' Tage']); }
}
console.log('Inversionen (hoehere id, aber aelterer Dateistempel > 1 min):', inversions, JSON.stringify(examples));

// Wieviele ids fehlen im Bereich (geloeschte Songs)?
const ids = new Set(songs.map(s => s.id));
const max = Math.max(...ids);
let missing = 0; for (let i = 1; i <= max; i++) if (!ids.has(i)) missing++;
console.log('\nids 1..' + max + ': fehlend (geloescht)', missing);
// Lücken am oberen Ende (dort wuerde SQLite ohne AUTOINCREMENT ids wiederverwenden)
const top = [...ids].sort((a, b) => b - a).slice(0, 5);
console.log('hoechste 5 ids:', top.join(', '));
