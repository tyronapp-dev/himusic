// Read-only: nur Aggregate, nie Titel/Key. Groessen- und Bitraten-Verteilung der Bibliothek.
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
const r = await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } });
const songs = await r.json();
const GB = 1073741824, MB = 1048576;
const ext = s => ((s.file_url || '').split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [, '?'])[1].toLowerCase();
const pct = (arr, p) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
const by = {};
for (const s of songs) { (by[ext(s)] ||= []).push(s.file_size || 0); }
console.log('--- je Format: Anzahl | GB | Mittel MB | P90 MB | Max MB');
for (const [e, a] of Object.entries(by)) {
  const sum = a.reduce((x, y) => x + y, 0);
  console.log(e.padEnd(4), String(a.length).padStart(5), (sum / GB).toFixed(2).padStart(7), (sum / a.length / MB).toFixed(1).padStart(7), (pct(a, 0.9) / MB).toFixed(1).padStart(7), (Math.max(...a) / MB).toFixed(1).padStart(7));
}
const sizes = songs.map(s => s.file_size || 0).sort((a, b) => b - a);
const total = sizes.reduce((x, y) => x + y, 0);
let acc = 0, n = 0; for (const z of sizes) { acc += z; n++; if (acc >= total * 0.25) break; }
console.log(`\ngroesste ${n} Songs (${(n / songs.length * 100).toFixed(1)} %) machen 25 % der Gesamtgroesse aus`);
for (const t of [10, 15, 20, 30]) { const big = sizes.filter(z => z > t * MB); console.log(`> ${t} MB: ${big.length} Songs, ${(big.reduce((x, y) => x + y, 0) / GB).toFixed(2)} GB`); }
// Bitrate-Schaetzung wo Dauer bekannt
const br = songs.filter(s => s.duration > 30 && s.file_size).map(s => s.file_size * 8 / s.duration / 1000);
console.log(`\nBitrate (kbit/s, ${br.length} Songs mit Dauer): Median ${pct(br, 0.5).toFixed(0)}, P90 ${pct(br, 0.9).toFixed(0)}, Max ${Math.max(...br).toFixed(0)}; > 256: ${br.filter(b => b > 256).length}`);
const brByExt = {};
for (const s of songs) if (s.duration > 30 && s.file_size) (brByExt[ext(s)] ||= []).push(s.file_size * 8 / s.duration / 1000);
for (const [e, a] of Object.entries(brByExt)) console.log(`  ${e}: ${a.length} Songs, Median ${pct(a, 0.5).toFixed(0)} kbit/s`);
// Duplikate ueber content_hash
const groups = {};
for (const s of songs) if (s.content_hash) (groups[s.content_hash] ||= []).push(s.file_size || 0);
const dups = Object.values(groups).filter(g => g.length > 1);
const wasted = dups.reduce((x, g) => x + g.slice(1).reduce((a, b) => a + b, 0), 0);
console.log(`\nDuplikate (gleicher content_hash): ${dups.length} Gruppen, ${(wasted / MB).toFixed(0)} MB doppelt`);
// Wie viel Prozent der Songs passt bei Cache-Obergrenzen?
const sorted = songs.map(s => s.file_size || 0).sort((a, b) => a - b);
for (const cap of [7, 8, 12.5, 16]) { let a = 0, c = 0; for (const z of sorted) { if (a + z > cap * GB) break; a += z; c++; } console.log(`bei ${cap} GB passen max. ${c} von ${songs.length} Songs (${(c / songs.length * 100).toFixed(0)} %, wenn man die kleinsten nimmt)`); }
