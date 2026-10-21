// Read-only: welche file_urls enthalten Zeichen, die eine strenge URL-Pruefung (RFC 3986) ablehnt? Nur Zaehlungen + Zeichenklassen.
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
const songs = await (await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } })).json();
const bad = [];
const classes = {};
for (const s of songs) {
  const u = s.file_url || '';
  const m = u.match(/[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/g);
  if (m) { bad.push(s); for (const c of new Set(m)) classes[c === ' ' ? '(Leerzeichen)' : c] = (classes[c === ' ' ? '(Leerzeichen)' : c] || 0) + 1; }
  // ungueltige %-Kodierung
}
const badPct = songs.filter(s => /%(?![0-9A-Fa-f]{2})/.test(s.file_url || ''));
console.log('URLs mit nicht erlaubten Zeichen:', bad.length, 'von', songs.length, JSON.stringify(classes));
console.log('URLs mit ungueltiger %-Kodierung:', badPct.length);
// Pfadlaenge/Endungen auffaellig?
const noExt = songs.filter(s => !/\.[a-z0-9]{2,4}$/i.test((s.file_url || '').split('?')[0]));
console.log('ohne Dateiendung:', noExt.length);
const q = songs.filter(s => (s.file_url || '').includes('?'));
console.log('mit Query-Teil (?):', q.length);
// Beispiel (nur Muster, keine Titel): Dateiname-Struktur der ersten auffaelligen
if (bad.length) console.log('Muster-Beispiel (Dateiname, max 3):', JSON.stringify(bad.slice(0, 3).map(s => decodeURIComponent((s.file_url.split('/').pop() || '').slice(0, 60)))));
