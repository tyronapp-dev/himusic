#!/usr/bin/env node
/**
 * Loest die Audiospur aus den als "Song" hochgeladenen .mp4-VIDEODATEIEN heraus - OHNE Neukodierung
 * (ffmpeg -vn -c:a copy). Hintergrund (ADR-015, Messung 21.10.2026): 396 .mp4 = 5,14 GB = 42 % des
 * Speichers bei 18 % der Songs; jeder Start/Download traegt die ganze Videospur mit.
 *
 * SICHERHEIT (das aendert Daten auf dem Worker):
 *  - `plan` legt ein Backup ALLER betroffenen Zeilen an (nie ueberschrieben) und aendert nichts.
 *  - Die ORIGINAL-Dateien bleiben im Speicher des Workers liegen; es werden nur file_url / file_size /
 *    duration der Zeile umgestellt. `rollback` stellt sie aus dem Backup wieder her.
 *  - Jede neue Datei wird geprueft: genau EINE Audiospur, Dauer weicht < 1 s vom Original ab, vollstaendig
 *    dekodierbar, nach dem Upload byte-genau zurueckgelesen, danach Zeile gelesen und gegen das Backup verglichen.
 *  - Codecs ausser aac/alac werden NICHT angefasst (kein Neukodieren), sondern gemeldet.
 *
 * Aufruf (Key aus tools/.env, ffmpeg per winget Gyan.FFmpeg):
 *   node tools/audio-aus-video.mjs plan
 *   node tools/audio-aus-video.mjs pilot <id>
 *   node tools/audio-aus-video.mjs all [--limit N]
 *   node tools/audio-aus-video.mjs verify
 *   node tools/audio-aus-video.mjs rollback [<id>]
 * Umgebung: FFMPEG_DIR (Ordner mit ffmpeg.exe/ffprobe.exe), BACKUP_DIR (Standard: MEGA\Claude\himusic-metadaten\audio-aus-video).
 */
import __p from 'node:path';
import { fileURLToPath as __f } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const REPO = __p.resolve(__p.dirname(__f(import.meta.url)), '..');
const API = 'https://himusic-api.tyron-app.workers.dev';
const env = fs.readFileSync(REPO + '/tools/.env', 'utf8');
const KEY = (env.match(/^HIMUSIC_API_KEY=(.*)$/m) || [])[1]?.trim();
if (!KEY) { console.error('HIMUSIC_API_KEY fehlt in tools/.env'); process.exit(1); }

const BACKUP_DIR = process.env.BACKUP_DIR || 'C:/Users/tyron/MEGA/Claude/himusic-metadaten/audio-aus-video';
const BACKUP_FILE = BACKUP_DIR + '/backup-rows.json';
const STATE_FILE = BACKUP_DIR + '/state.json';

function findFfmpegDir() {
  if (process.env.FFMPEG_DIR) return process.env.FFMPEG_DIR;
  const pk = __p.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages');
  for (const d of fs.existsSync(pk) ? fs.readdirSync(pk) : []) {
    if (!d.startsWith('Gyan.FFmpeg')) continue;
    for (const sub of fs.readdirSync(__p.join(pk, d))) {
      const bin = __p.join(pk, d, sub, 'bin');
      if (fs.existsSync(__p.join(bin, 'ffmpeg.exe'))) return bin;
    }
  }
  throw new Error('ffmpeg nicht gefunden (winget install Gyan.FFmpeg oder FFMPEG_DIR setzen)');
}
const FFDIR = findFfmpegDir();
const FFMPEG = __p.join(FFDIR, 'ffmpeg.exe');
const FFPROBE = __p.join(FFDIR, 'ffprobe.exe');

const H = { 'X-Api-Key': KEY };
const run = (bin, args) => new Promise((res, rej) =>
  execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => err ? rej(new Error((stderr || err.message).slice(0, 300))) : res({ stdout, stderr })));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const probe = async p => JSON.parse((await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,duration,bit_rate:format=duration', '-of', 'json', p])).stdout);

async function getSongs() {
  const r = await fetch(`${API}/songs`, { headers: H });
  if (!r.ok) throw new Error('GET /songs ' + r.status);
  return r.json();
}
const normVibes = v => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return JSON.stringify(Array.isArray(a) ? a : []); } catch { return 'UNLESBAR:' + String(v); } };
const isMp4 = s => /\.mp4$/i.test((s.file_url || '').split('?')[0]);
const readJson = (f, d) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
const writeJson = (f, o) => { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };

async function putSong(id, body) {
  const r = await fetch(`${API}/songs/${id}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('PUT /songs/' + id + ' ' + r.status);
}

async function processSong(row, tmp) {
  const inP = __p.join(tmp, `${row.id}.in.mp4`), outP = __p.join(tmp, `${row.id}.out.m4a`);
  try {
    // --- Vorab: Vibes muessen unveraendert zurueckschreibbar sein (Marker wie '*' und '!meta-ok' liegen darin)
    let vibes = row.vibes;
    if (typeof vibes === 'string') { try { vibes = JSON.parse(vibes); } catch { throw new Error('vibes nicht lesbar - uebersprungen, um nichts zu verlieren'); } }
    if (vibes == null) vibes = [];
    if (!Array.isArray(vibes)) throw new Error('vibes hat unerwartetes Format');

    const r = await fetch(row.file_url);
    if (!r.ok) throw new Error('Download ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 16384) throw new Error('Original zu klein (' + buf.length + ' B)');
    fs.writeFileSync(inP, buf);

    const pin = await probe(inP);
    const a = (pin.streams || []).find(s => s.codec_type === 'audio');
    if (!a) return { id: row.id, status: 'skip', reason: 'keine Audiospur' };
    if (!['aac', 'alac'].includes(a.codec_name)) return { id: row.id, status: 'skip', reason: 'Codec ' + a.codec_name + ' (kein Neukodieren)' };
    const dIn = num(a.duration) ?? num(pin.format?.duration);
    if (!dIn || dIn < 1) throw new Error('Dauer des Originals unbekannt');

    await run(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', inP, '-map', '0:a:0', '-vn', '-c:a', 'copy', '-movflags', '+faststart', '-map_metadata', '-1', outP]);
    const pout = await probe(outP);
    if ((pout.streams || []).length !== 1 || pout.streams[0].codec_type !== 'audio') throw new Error('Ergebnis hat nicht genau eine Audiospur');
    const dOut = num(pout.streams[0].duration) ?? num(pout.format?.duration);
    if (!dOut || Math.abs(dOut - dIn) > 1.0) throw new Error(`Dauer weicht ab (${dIn} -> ${dOut})`);
    const dec = await run(FFMPEG, ['-nostdin', '-v', 'error', '-i', outP, '-f', 'null', '-']);
    if (dec.stderr.trim()) throw new Error('Dekodierfehler: ' + dec.stderr.trim().slice(0, 120));
    const outBuf = fs.readFileSync(outP);
    if (outBuf.length < 16384 || outBuf.length >= buf.length) throw new Error(`Groesse unplausibel (${buf.length} -> ${outBuf.length})`);
    if (outBuf.slice(4, 8).toString('latin1') !== 'ftyp') throw new Error('Ergebnis ohne ftyp');

    // --- Hochladen + byte-genau zurueckpruefen
    const name = `audioonly_${Date.now()}_${row.id}.m4a`;
    let newUrl = null;
    for (let t = 0; t < 3 && !newUrl; t++) {
      const up = await fetch(`${API}/upload/${name}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'audio/mp4' }, body: outBuf });
      if (!up.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
      const ud = await up.json().catch(() => null);
      if (!ud?.url) continue;
      const back = await fetch(ud.url);
      const bb = back.ok ? Buffer.from(await back.arrayBuffer()) : null;
      if (bb && bb.length === outBuf.length && bb.equals(outBuf)) newUrl = ud.url;
    }
    if (!newUrl) throw new Error('Upload nicht byte-genau bestaetigt');

    const duration = Math.round(dOut * 100) / 100;
    await putSong(row.id, { title: row.title, artist: row.artist, cover_data: row.cover_data, vibes, file_url: newUrl, file_size: outBuf.length, duration });
    return { id: row.id, status: 'ok', old_url: row.file_url, new_url: newUrl, in_bytes: buf.length, out_bytes: outBuf.length, duration, codec: a.codec_name };
  } catch (e) {
    return { id: row.id, status: 'fail', reason: String(e.message || e).slice(0, 200) };
  } finally {
    for (const p of [inP, outP]) try { fs.unlinkSync(p); } catch {}
  }
}

// Vergleicht den Serverstand mit dem Backup: nur file_url/file_size/duration der erledigten Songs duerfen abweichen.
async function verify() {
  const backup = readJson(BACKUP_FILE, null); const state = readJson(STATE_FILE, { done: {} });
  if (!backup) throw new Error('Kein Backup - erst `plan`');
  const now = new Map((await getSongs()).map(s => [s.id, s]));
  let ok = 0; const problems = [];
  for (const b of backup) {
    const n = now.get(b.id); const d = state.done[b.id];
    if (!n) { problems.push([b.id, 'Zeile fehlt']); continue; }
    const diffs = [];
    for (const f of ['title', 'artist', 'cover_data', 'created_at', 'content_hash']) if ((n[f] ?? null) !== (b[f] ?? null)) diffs.push(f);
    if (normVibes(n.vibes) !== normVibes(b.vibes)) diffs.push('vibes');
    if (d) {
      if (n.file_url !== d.new_url) diffs.push('file_url!=neu');
      // Der Worker ignoriert file_size bei PUT /songs/:id (Pilot 22.10.2026; "Song kuerzen" setzt es auch nie neu):
      // bleibt der alte Wert stehen, ist das erwartet - nur ein Anzeigewert (Duplikat-Erkennung), nicht die Datei.
      if (n.file_size !== d.out_bytes && n.file_size !== (b.file_size ?? null)) diffs.push('file_size');
      if (d.duration && Math.abs((n.duration ?? 0) - d.duration) > 0.05) diffs.push('duration');
    } else {
      for (const f of ['file_url', 'file_size', 'duration']) if ((n[f] ?? null) !== (b[f] ?? null)) diffs.push(f);
    }
    if (diffs.length) problems.push([b.id, diffs.join(',')]); else ok++;
  }
  console.log(`verify: ${ok} von ${backup.length} Zeilen wie erwartet, ${problems.length} Abweichungen`, problems.length ? JSON.stringify(problems.slice(0, 15)) : '');
  return problems.length === 0;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'plan') {
  if (fs.existsSync(BACKUP_FILE)) { console.error('Backup existiert schon (wird nie ueberschrieben): ' + BACKUP_FILE); process.exit(1); }
  const rows = (await getSongs()).filter(isMp4);
  writeJson(BACKUP_FILE, rows);
  const bytes = rows.reduce((a, s) => a + (s.file_size || 0), 0);
  console.log(`Backup: ${rows.length} .mp4-Zeilen (${(bytes / 1e9).toFixed(2)} GB laut DB) -> ${BACKUP_FILE}\nNichts veraendert.`);
} else if (cmd === 'pilot' || cmd === 'all') {
  const backup = readJson(BACKUP_FILE, null);
  if (!backup) { console.error('Erst `plan` ausfuehren (Backup).'); process.exit(1); }
  const state = readJson(STATE_FILE, { done: {}, skipped: {}, failed: {} });
  const live = new Map((await getSongs()).map(s => [s.id, s]));
  let todo = cmd === 'pilot' ? backup.filter(b => b.id === Number(arg)) : backup.filter(b => !state.done[b.id] && !state.skipped[b.id]);
  if (cmd === 'all') { const li = process.argv.indexOf('--limit'); if (li > 0) todo = todo.slice(0, Number(process.argv[li + 1])); }
  if (!todo.length) { console.log('Nichts zu tun.'); process.exit(0); }
  const tmp = fs.mkdtempSync(__p.join(os.tmpdir(), 'himusic-av-'));
  let idx = 0, consecutiveFail = 0, stop = false, okCount = 0, saved = 0;
  const worker = async () => {
    while (!stop && idx < todo.length) {
      const b = todo[idx++]; const cur = live.get(b.id);
      if (!cur || !isMp4(cur)) { state.skipped[b.id] = 'schon umgestellt oder entfernt'; continue; }
      const res = await processSong(cur, tmp);
      if (res.status === 'ok') { state.done[b.id] = res; delete state.failed[b.id]; consecutiveFail = 0; okCount++; saved += res.in_bytes - res.out_bytes; }
      else if (res.status === 'skip') { state.skipped[b.id] = res.reason; }
      else { state.failed[b.id] = res.reason; if (++consecutiveFail >= 5) { stop = true; console.error('5 Fehler in Folge - angehalten.'); } }
      writeJson(STATE_FILE, state);
      console.log(`[${Object.keys(state.done).length}/${backup.length}] id=${b.id} ${res.status}${res.reason ? ' - ' + res.reason : ''}${res.status === 'ok' ? ` ${(res.in_bytes / 1e6).toFixed(1)} -> ${(res.out_bytes / 1e6).toFixed(1)} MB` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: cmd === 'pilot' ? 1 : 2 }, worker));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nfertig: ${okCount} umgestellt, gespart ${(saved / 1e9).toFixed(2)} GB; gesamt erledigt ${Object.keys(state.done).length}, uebersprungen ${Object.keys(state.skipped).length}, Fehler ${Object.keys(state.failed).length}`);
  await verify();
} else if (cmd === 'verify') {
  process.exit((await verify()) ? 0 : 2);
} else if (cmd === 'rollback') {
  const backup = readJson(BACKUP_FILE, null); const state = readJson(STATE_FILE, { done: {} });
  if (!backup) { console.error('Kein Backup'); process.exit(1); }
  const ids = arg ? [Number(arg)] : Object.keys(state.done).map(Number);
  for (const id of ids) {
    const b = backup.find(x => x.id === id); if (!b) continue;
    let vibes = b.vibes; if (typeof vibes === 'string') vibes = JSON.parse(vibes); if (vibes == null) vibes = [];
    await putSong(id, { title: b.title, artist: b.artist, cover_data: b.cover_data, vibes, file_url: b.file_url, file_size: b.file_size, duration: b.duration });
    delete state.done[id]; writeJson(STATE_FILE, state);
    console.log('zurueckgesetzt: id=' + id);
  }
} else {
  console.log('Aufruf: plan | pilot <id> | all [--limit N] | verify | rollback [<id>]');
}
