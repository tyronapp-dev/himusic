#!/usr/bin/env node
/**
 * Veroeffentlicht eine neue Fassung des Cloudflare-Workers `himusic-api` - mit Sicherungen.
 * (Erlaubnis von Tyron am 22.10.2026, siehe Vault-Akte; gilt nur fuer diesen einen Worker.)
 *
 * Was hier ABSICHTLICH so gemacht wird:
 *  - Ein roher Upload wuerde alle Bindings samt Secrets (API_KEY, LOGIN_PASSWORD, D1_API_KEY, R2, D1 ...)
 *    loeschen. Deshalb: Einstellungen vorher lesen, `keep_bindings` mit allen vorhandenen Typen setzen,
 *    Kompatibilitaetsdatum/-flags und Beobachtbarkeit unveraendert mitgeben.
 *  - Danach werden die Einstellungen erneut gelesen und MUESSEN identisch sein (Binding-Namen + Typen).
 *  - Danach laufen Proben: Login-Route (401 bei falschem Passwort = Secrets da, 500 = Secrets weg), GET /songs mit
 *    Schluessel, optional Range-Test. Scheitert etwas, wird SOFORT die gesicherte alte Fassung hochgeladen.
 *  - Der Quelltext enthaelt die Zugriffslogik: Sicherungen NIE in dieses (oeffentliche) Repo legen.
 *
 * Aufruf (Token aus tools/.env: CF_API_TOKEN, Rechte: Account | Workers Scripts | Edit):
 *   node tools/worker-deploy.mjs <neue-worker.js> <sicherung-alte-worker.js> [--dry] [--expect-range]
 *   node tools/worker-deploy.mjs --rollback <sicherung-alte-worker.js>
 */
import fs from 'node:fs';
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';

const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';
const WORKER = 'himusic-api';
const BASE = 'https://himusic-api.tyron-app.workers.dev';

const envText = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const TOKEN = ((envText.match(/^\s*CF_API_TOKEN\s*=\s*(.+)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
const APIKEY = ((envText.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1] || '').trim();
if (!TOKEN) { console.error('CF_API_TOKEN fehlt in tools/.env'); process.exit(1); }

async function cf(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(60000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error(`${path} -> HTTP ${res.status} ${(j.errors || []).map(e => e.code + ' ' + e.message).join('; ')}`);
  return j.result;
}

async function accountId() {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  for (const k of await cf('/accounts')) {
    try { const list = await cf(`/accounts/${k.id}/workers/scripts`); if (list.some(s => s.id === WORKER)) return k.id; } catch {}
  }
  throw new Error('Konto mit dem Worker nicht gefunden');
}

// Nur Felder, die wir mitgeben bzw. vergleichen. Secrets erscheinen hier nur als NAME + Typ, nie mit Wert.
const settingsView = s => ({
  bindings: (s.bindings || []).map(b => ({ name: b.name, type: b.type, bucket_name: b.bucket_name, id: b.id, database_id: b.database_id })).sort((a, b) => a.name.localeCompare(b.name)),
  compatibility_date: s.compatibility_date ?? null,
  compatibility_flags: s.compatibility_flags || [],
  usage_model: s.usage_model ?? null,
  placement: s.placement ?? null,
  observability: s.observability ?? null,
  logpush: s.logpush ?? null,
  tail_consumers: s.tail_consumers ?? null,
});

function metadataFrom(settings) {
  const v = settingsView(settings);
  const meta = {
    main_module: 'worker.js',
    keep_bindings: [...new Set((settings.bindings || []).map(b => b.type))],
    compatibility_flags: v.compatibility_flags,
  };
  if (v.compatibility_date) meta.compatibility_date = v.compatibility_date;
  const leer = x => typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0;   // z. B. placement: {}
  for (const k of ['usage_model', 'placement', 'observability', 'logpush', 'tail_consumers']) if (v[k] != null && !leer(v[k])) meta[k] = v[k];
  return meta;
}

async function upload(acc, code, meta) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
  await cf(`/accounts/${acc}/workers/scripts/${WORKER}`, { method: 'PUT', body: form });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (path, init = {}) => fetch(BASE + path, { ...init, signal: AbortSignal.timeout(30000) });

// Proben nach dem Veroeffentlichen; gibt eine Liste von Fehlern zurueck (leer = alles gut).
async function probes({ expectRange, keyWorks = true, probeUrl = null }) {
  const errors = [];
  const lg = await get('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }) });
  if (lg.status !== 401) errors.push(`Login-Probe: HTTP ${lg.status} (erwartet 401; 500 hiesse: Secrets fehlen)`);
  const noKey = await get('/songs');
  if (noKey.status !== 401) errors.push(`GET /songs ohne Schluessel: HTTP ${noKey.status} (erwartet 401)`);
  let songs = [];
  if (keyWorks) {
    const songsRes = await get('/songs', { headers: { 'X-Api-Key': APIKEY } });
    if (songsRes.status !== 200) errors.push(`GET /songs mit Schluessel: HTTP ${songsRes.status} (erwartet 200)`);
    else { songs = await songsRes.json(); if (!Array.isArray(songs) || songs.length < 100) errors.push('GET /songs: unplausible Antwort'); }
  } else console.log('  (Schluessel aus tools/.env funktionierte schon VOR dem Deploy nicht - GET-/songs-Probe uebersprungen)');
  const withUrl = probeUrl ? { file_url: probeUrl } : songs.find(s => /\.(mp3|m4a)$/i.test(s.file_url || ''));
  if (withUrl) {
    const full = await get(withUrl.file_url.replace(/^https?:\/\/[^/]+/, ''));
    const fullLen = (await full.arrayBuffer()).byteLength;
    if (full.status !== 200 || fullLen < 1000) errors.push(`/media ohne Range: HTTP ${full.status}, ${fullLen} Bytes`);
    const rg = await get(withUrl.file_url.replace(/^https?:\/\/[^/]+/, ''), { headers: { Range: 'bytes=0-1' } });
    const rgLen = (await rg.arrayBuffer()).byteLength;
    const ok = rg.status === 206 && /^bytes 0-1\/\d+$/.test(rg.headers.get('content-range') || '') && rgLen === 2;
    if (expectRange && !ok) errors.push(`Range-Probe: HTTP ${rg.status}, Content-Range=${rg.headers.get('content-range')}, ${rgLen} Bytes (erwartet 206, bytes 0-1/N, 2 Bytes)`);
    console.log(`  Range-Probe: HTTP ${rg.status}, Content-Range=${rg.headers.get('content-range')}, ${rgLen} Bytes`);
  } else errors.push('keine Probe-Datei gefunden (--probe-url angeben)');
  return errors;
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const expectRange = args.includes('--expect-range');
const pu = args.indexOf('--probe-url');
const probeUrl = pu >= 0 ? args[pu + 1] : null;
const pos = args.filter((a, i) => !a.startsWith('--') && !(pu >= 0 && i === pu + 1));
const rollbackMode = args.includes('--rollback');
const [newPath, oldPath] = rollbackMode ? [null, pos[0]] : pos;
if (!oldPath || (!rollbackMode && !newPath)) { console.error('Aufruf: node tools/worker-deploy.mjs <neu.js> <sicherung-alt.js> [--dry] [--expect-range]  |  --rollback <sicherung-alt.js>'); process.exit(1); }

const acc = await accountId();
// Funktioniert der Schluessel aus tools/.env ueberhaupt? Nur dann gilt eine spaetere 401 als Fehler des Deploys.
const keyWorks = (await get('/songs', { headers: { 'X-Api-Key': APIKEY } })).status === 200;
console.log('Schluessel aus tools/.env gueltig:', keyWorks);
const before = await cf(`/accounts/${acc}/workers/scripts/${WORKER}/settings`);
const beforeView = JSON.stringify(settingsView(before));
const meta = metadataFrom(before);
console.log('Einstellungen vorher:', (before.bindings || []).map(b => `${b.name}:${b.type}`).join(', '));
console.log('Metadaten fuer den Upload:', JSON.stringify({ ...meta }));
const sched = await cf(`/accounts/${acc}/workers/scripts/${WORKER}/schedules`).catch(() => null);
const schedBefore = JSON.stringify(sched);

if (dry) { console.log('--dry: nichts hochgeladen.'); process.exit(0); }

const oldCode = fs.readFileSync(oldPath, 'utf8');
async function rollback(why) {
  console.error('ROLLBACK:', why);
  await upload(acc, oldCode, meta);
  await sleep(4000);
  const errs = await probes({ expectRange: false, keyWorks, probeUrl });
  console.error(errs.length ? 'ROLLBACK-Proben mit Auffaelligkeiten: ' + errs.join(' | ') : 'Rollback erfolgreich, Proben ok.');
  process.exit(errs.length ? 3 : 2);
}

const code = rollbackMode ? oldCode : fs.readFileSync(newPath, 'utf8');
try { await upload(acc, code, meta); } catch (e) { console.error('Upload fehlgeschlagen:', e.message); process.exit(4); }
console.log(rollbackMode ? 'Alte Fassung hochgeladen.' : 'Neue Fassung hochgeladen.');
await sleep(4000);   // Verbreitung am Cloudflare-Rand

const after = await cf(`/accounts/${acc}/workers/scripts/${WORKER}/settings`);
if (JSON.stringify(settingsView(after)) !== beforeView) {
  console.error('Einstellungen vorher:', beforeView, '\nEinstellungen nachher:', JSON.stringify(settingsView(after)));
  await rollback('Einstellungen/Bindings haben sich veraendert');
}
const schedAfter = JSON.stringify(await cf(`/accounts/${acc}/workers/scripts/${WORKER}/schedules`).catch(() => null));
if (schedAfter !== schedBefore) await rollback('Cron-Trigger haben sich veraendert');

let errors = [];
for (let t = 0; t < 3; t++) { errors = await probes({ expectRange, keyWorks, probeUrl }); if (!errors.length) break; await sleep(4000); }
if (errors.length && !rollbackMode) await rollback(errors.join(' | '));
console.log(errors.length ? 'Proben mit Auffaelligkeiten: ' + errors.join(' | ') : 'ALLE PROBEN OK - Einstellungen, Secrets-Namen und Cron unveraendert.');
process.exit(errors.length ? 5 : 0);
