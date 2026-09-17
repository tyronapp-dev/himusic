#!/usr/bin/env node
/**
 * Sichert die EIGENTLICHE Sammlung: Songliste und Playlists aus D1, dazu die Audiodateien aus R2.
 *
 * Warum es das gibt: der Backup-Knopf in der App sichert nur, was im Browser liegt (Sender,
 * Vibe-Mixe, Einstellungen). Songs, Playlists und die Musik selbst existierten bis dahin genau
 * EINMAL - in einem einzigen Cloudflare-Konto. Kontosperre, Zahlungsproblem oder ein versehentlich
 * geleerter Bucket hiessen: alles weg, ohne zweites Exemplar.
 *
 * Eigenschaften, auf die es hier ankommt:
 *  - INKREMENTELL: vorhandene Dateien mit passender Groesse werden uebersprungen. Ein zweiter Lauf
 *    ueber eine grosse Bibliothek dauert Sekunden statt Stunden.
 *  - LOESCHT NIE etwas im Zielordner. Verschwindet ein Song in der Cloud, bleibt die Sicherung.
 *    Genau darum geht es ja.
 *  - Bricht bei einem einzelnen Fehlschlag nicht ab, sondern sammelt und berichtet am Ende.
 *
 * Aufruf:
 *   HIMUSIC_API_KEY=... node tools/backup-cloud.js "D:/himusic-backup"
 *   node tools/backup-cloud.js "D:/himusic-backup"      (Schluessel dann aus tools/.env)
 *
 * Der Schluessel steht NIE in dieser Datei - das Repo ist oeffentlich. tools/.env ist gitignoriert.
 * Den Wert findet man im Browser der App unter localStorage["himusic_api_key"].
 */

const fs = require('fs');
const path = require('path');

const API_URL = process.env.HIMUSIC_API_URL || 'https://himusic-api.tyron-app.workers.dev';
const ZIEL = process.argv[2];
const PARALLEL = 4;          // gleichzeitige Downloads - bewusst zahm, das ist kein Wettrennen
const TIMEOUT_MS = 120000;

function schluesselLesen() {
    if (process.env.HIMUSIC_API_KEY) return process.env.HIMUSIC_API_KEY.trim();
    const envDatei = path.join(__dirname, '.env');
    if (fs.existsSync(envDatei)) {
        const treffer = fs.readFileSync(envDatei, 'utf8').match(/^\s*HIMUSIC_API_KEY\s*=\s*(.+)$/m);
        if (treffer) return treffer[1].trim().replace(/^["']|["']$/g, '');
    }
    return null;
}

async function holeJson(pfad, key) {
    const res = await fetch(`${API_URL}${pfad}`, {
        headers: { 'X-Api-Key': key },
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`GET ${pfad} -> HTTP ${res.status}`);
    return res.json();
}

function dateinameAus(fileUrl, songId) {
    let basis = '';
    try { basis = decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() || ''); } catch (e) {}
    basis = basis.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    if (!basis || basis === '_') basis = `song_${songId}`;
    // Song-ID voranstellen: zwei Songs koennen denselben Dateinamen tragen, und die Zuordnung
    // zur songs.json soll ohne Raten funktionieren.
    return `${songId}__${basis}`;
}

async function ladeDatei(fileUrl, zielDatei, key) {
    // /media/* ist unauthentifiziert, der Schluessel schadet aber nicht - manche Wege verlangen ihn.
    const res = await fetch(fileUrl, { headers: { 'X-Api-Key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const puffer = Buffer.from(await res.arrayBuffer());
    if (puffer.length < 1024) throw new Error(`verdaechtig klein (${puffer.length} Bytes)`);
    // Erst vollstaendig daneben schreiben, dann umbenennen: ein abgebrochener Lauf hinterlaesst
    // so keine halbe Datei, die beim naechsten Mal als "schon vorhanden" durchginge.
    const temp = `${zielDatei}.teil`;
    fs.writeFileSync(temp, puffer);
    fs.renameSync(temp, zielDatei);
    return puffer.length;
}

async function main() {
    if (!ZIEL) {
        console.error('Zielordner fehlt. Je nachdem, wo das Terminal steht:');
        console.error('  im Projektordner:  node tools/backup-cloud.js "D:/himusic-backup"');
        console.error('  im tools-Ordner:   node backup-cloud.js "D:/himusic-backup"');
        process.exit(1);
    }
    const key = schluesselLesen();
    if (!key) {
        console.error('Kein API-Schluessel. Entweder HIMUSIC_API_KEY setzen oder tools/.env anlegen:');
        console.error('  HIMUSIC_API_KEY=dein-schluessel');
        console.error('Den Wert findest du in der App unter localStorage["himusic_api_key"].');
        process.exit(1);
    }

    const audioOrdner = path.join(ZIEL, 'audio');
    fs.mkdirSync(audioOrdner, { recursive: true });

    console.log(`Ziel: ${ZIEL}`);
    console.log('Hole Songliste …');
    const songs = await holeJson('/songs', key);
    if (!Array.isArray(songs)) throw new Error('/songs lieferte keine Liste');
    console.log(`  ${songs.length} Songs`);

    console.log('Hole Playlists …');
    let playlists = [];
    try {
        const rohe = await holeJson('/playlists', key);
        playlists = await Promise.all((Array.isArray(rohe) ? rohe : []).map(async pl => {
            try { return { ...pl, songs: await holeJson(`/playlists/${pl.id}/songs`, key) }; }
            catch (e) { return { ...pl, songs: [], fehler: e.message }; }
        }));
        console.log(`  ${playlists.length} Playlists`);
    } catch (e) {
        console.warn(`  Playlists nicht abrufbar: ${e.message} (Songs werden trotzdem gesichert)`);
    }

    const stempel = new Date().toISOString();
    fs.writeFileSync(path.join(ZIEL, 'songs.json'), JSON.stringify(songs, null, 2));
    fs.writeFileSync(path.join(ZIEL, 'playlists.json'), JSON.stringify(playlists, null, 2));

    // Audiodateien
    const aufgaben = songs.filter(s => s && s.file_url).map(s => ({
        song: s, datei: path.join(audioOrdner, dateinameAus(s.file_url, s.id)),
    }));
    let geladen = 0, uebersprungen = 0, bytes = 0;
    const fehler = [];
    let i = 0;

    async function bahn() {
        while (i < aufgaben.length) {
            const { song, datei } = aufgaben[i++];
            const nummer = i;
            if (fs.existsSync(datei) && fs.statSync(datei).size > 1024) {
                // Groesse als Kriterium: der Server liefert file_size mit. Stimmt sie, ist die
                // Datei vollstaendig da und muss nicht erneut uebertragen werden.
                if (!song.file_size || Math.abs(fs.statSync(datei).size - song.file_size) <= 8) {
                    uebersprungen++; continue;
                }
            }
            try {
                const groesse = await ladeDatei(song.file_url, datei, key);
                geladen++; bytes += groesse;
                if (geladen % 25 === 0) console.log(`  … ${nummer}/${aufgaben.length}`);
            } catch (e) {
                fehler.push({ id: song.id, titel: song.title, grund: e.message });
            }
        }
    }
    console.log(`Sichere Audiodateien (${aufgaben.length}) …`);
    await Promise.all(Array.from({ length: Math.min(PARALLEL, aufgaben.length) }, bahn));

    fs.writeFileSync(path.join(ZIEL, 'manifest.json'), JSON.stringify({
        zeitpunkt: stempel, api: API_URL,
        songs: songs.length, playlists: playlists.length,
        dateienNeu: geladen, dateienVorhanden: uebersprungen, fehlgeschlagen: fehler.length, fehler,
    }, null, 2));

    const mb = Math.round(bytes / 1048576);
    console.log('\nFertig.');
    console.log(`  Songliste + Playlists: songs.json, playlists.json`);
    console.log(`  Audiodateien: ${geladen} neu (${mb} MB), ${uebersprungen} schon vorhanden`);
    if (fehler.length > 0) {
        console.log(`  ${fehler.length} fehlgeschlagen - Einzelheiten in manifest.json:`);
        fehler.slice(0, 5).forEach(f => console.log(`    #${f.id} ${f.titel}: ${f.grund}`));
        process.exitCode = 2;   // fuer geplante Laeufe erkennbar
    }
}

main().catch(e => { console.error(`\nAbbruch: ${e.message}`); process.exit(1); });
