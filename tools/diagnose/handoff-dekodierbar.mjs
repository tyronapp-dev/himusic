// Read-only, nur Zaehlungen + ids (nie Titel, nie Key). Bildet nach, was _tryNativePlayerHandoff
// pro Song sendet, und prueft, was die strikte Swift-Dekodierung (QueueItem) ablehnen wuerde.
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
// Repo-Wurzel relativ zu dieser Datei (tools/diagnose/ -> ../..), damit die Skripte auf jedem Rechner laufen.
const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '../..');
import fs from 'node:fs';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const key = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
const songs = await (await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': key } })).json();
console.log('Songs:', songs.length);

const typ = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
for (const f of ['id', 'title', 'artist', 'file_url', 'duration']) {
  const c = {};
  for (const s of songs) { const t = typ(s[f]); c[t] = (c[t] || 0) + 1; }
  console.log(f.padEnd(9), JSON.stringify(c));
}

// Nachbau von toItem() aus app2.js (Zeile 2056ff)
const toItem = s => ({ id: s.id ?? 0, t: s.title || 'Unbekannt', a: s.artist || '', u: s.file_url, d: s.duration > 0 ? s.duration : undefined });

const hasLoneSurrogate = str => {
  if (typeof str !== 'string') return false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) { const n = str.charCodeAt(i + 1); if (n >= 0xDC00 && n <= 0xDFFF) { i++; continue; } return true; }
    if (c >= 0xDC00 && c <= 0xDFFF) return true;
  }
  return false;
};
const hasControl = str => typeof str === 'string' && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(str);
const hasBidiOrNonChar = str => typeof str === 'string' && /[\ufdd0-\ufdef\ufffe\uffff]/.test(str);

const problems = { idNotInt: [], tNotString: [], aNotString: [], uNotString: [], dNotNumber: [], loneSurrogate: [], control: [], nonChar: [] };
songs.forEach((s, i) => {
  const it = toItem(s);
  const rec = i; // Position in der API-Reihenfolge
  if (!Number.isInteger(it.id)) problems.idNotInt.push([rec, s.id]);
  if (typeof it.t !== 'string') problems.tNotString.push([rec, s.id, typ(s.title)]);
  if (typeof it.a !== 'string') problems.aNotString.push([rec, s.id, typ(s.artist)]);
  if (typeof it.u !== 'string') problems.uNotString.push([rec, s.id]);
  if (it.d !== undefined && typeof it.d !== 'number') problems.dNotNumber.push([rec, s.id, typ(s.duration)]);
  if (hasLoneSurrogate(it.t) || hasLoneSurrogate(it.a) || hasLoneSurrogate(it.u)) problems.loneSurrogate.push([rec, s.id]);
  if (hasControl(it.t) || hasControl(it.a) || hasControl(it.u)) problems.control.push([rec, s.id]);
  if (hasBidiOrNonChar(it.t) || hasBidiOrNonChar(it.a)) problems.nonChar.push([rec, s.id]);
});
console.log('\n--- Eintraege, die die strikte Dekodierung brechen koennten (Position in API-Reihenfolge, id) ---');
for (const [k, v] of Object.entries(problems)) console.log(k.padEnd(14), v.length, v.length ? JSON.stringify(v.slice(0, 15)) : '');

// Eindeutigkeit
const byId = new Map(), byUrl = new Map();
for (const s of songs) { byId.set(s.id, (byId.get(s.id) || 0) + 1); byUrl.set(s.file_url, (byUrl.get(s.file_url) || 0) + 1); }
const dupIds = [...byId].filter(([, n]) => n > 1), dupUrls = [...byUrl].filter(([, n]) => n > 1);
console.log('\ndoppelte ids:', dupIds.length, JSON.stringify(dupIds.slice(0, 10)));
console.log('doppelte file_url:', dupUrls.length);
const ids = songs.map(s => s.id);
console.log('id min/max:', Math.min(...ids), Math.max(...ids));
