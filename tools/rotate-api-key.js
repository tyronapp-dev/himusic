#!/usr/bin/env node
/**
 * Setzt einen neuen, zufaelligen Wert fuer API_KEY im himusic-api-Worker.
 *
 * Der Wert wird HIER erzeugt und NIRGENDS ausgegeben - nicht im Terminal, nicht in einer Datei.
 * Grund: alles, was auf dem Bildschirm steht oder in einen Chat getippt wird, kann in Verlaeufen
 * landen. Der Client holt sich den neuen Wert automatisch beim naechsten Login (POST /auth/login
 * gibt ihn zurueck) - du musst ihn also nie selbst sehen oder abtippen.
 *
 * Aufruf (im tools-Ordner):
 *   node rotate-api-key.js            (Wert nirgends gespeichert; der Client holt ihn beim Login)
 *   node rotate-api-key.js --in-env   (zusaetzlich HIMUSIC_API_KEY in tools/.env setzen - fuer die Werkzeuge
 *                                      in tools/ und tools/diagnose/; Wert wird trotzdem NIE ausgegeben)
 *
 * Braucht CF_API_TOKEN in tools/.env mit dem Recht "Account | Workers Scripts | Edit".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KONTO_ID = '5a57b0c04945e7cb352e7892e0a539c3';   // Popandcandy - nicht geheim, nur eine ID
const WORKER = 'himusic-api';

function tokenLesen() {
    const envDatei = path.join(__dirname, '.env');
    if (fs.existsSync(envDatei)) {
        const treffer = fs.readFileSync(envDatei, 'utf8').match(/^\s*CF_API_TOKEN\s*=\s*(.+)$/m);
        if (treffer) return treffer[1].trim().replace(/^["']|["']$/g, '');
    }
    return (process.env.CF_API_TOKEN || '').trim();
}

// Ersetzt/ergaenzt HIMUSIC_API_KEY und fuehrt ein "CF_API_TOKEN=" mit dem Token in der FOLGEZEILE zusammen
// (so wurde es versehentlich eingefuegt; die Regex der Werkzeuge hat es zufaellig trotzdem gefunden).
function envMitSchluessel(text, wert) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let gesetzt = false;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*HIMUSIC_API_KEY\s*=/.test(l)) { if (!gesetzt) { out.push('HIMUSIC_API_KEY=' + wert); gesetzt = true; } continue; }
        if (/^\s*CF_API_TOKEN\s*=\s*$/.test(l) && i + 1 < lines.length && lines[i + 1].trim() && !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(lines[i + 1])) {
            out.push('CF_API_TOKEN=' + lines[i + 1].trim()); i++; continue;
        }
        out.push(l);
    }
    if (!gesetzt) out.unshift('HIMUSIC_API_KEY=' + wert);
    return out.join('\n').replace(/\n*$/, '\n');
}

async function main() {
    const inEnv = process.argv.includes('--in-env');
    const token = tokenLesen();
    if (!token) {
        console.error('Kein CF_API_TOKEN in tools/.env gefunden.');
        process.exit(1);
    }

    // 32 zufaellige Bytes, hex-kodiert - bleibt ausschliesslich in dieser Variable, wird nie
    // console.log't, nie in eine Datei geschrieben.
    const neuerWert = crypto.randomBytes(32).toString('hex');

    // Mit --in-env ZUERST in die .env (mit Sicherung), DANN im Worker: scheitert das Setzen, wird die
    // Sicherung zurueckgespielt - der Wert kann nie verloren gehen (Worker neu, .env alt).
    const envDatei = path.join(__dirname, '.env');
    const sicherung = path.join(__dirname, '.env.vor-rotation');   // von .gitignore (tools/.env*) erfasst
    if (inEnv) {
        if (!fs.existsSync(sicherung)) fs.copyFileSync(envDatei, sicherung);
        fs.writeFileSync(envDatei, envMitSchluessel(fs.readFileSync(envDatei, 'utf8'), neuerWert));
    }

    console.log(`Setze neuen API_KEY fuer ${WORKER} ...`);
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${KONTO_ID}/workers/scripts/${WORKER}/secrets`,
        {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'API_KEY', text: neuerWert, type: 'secret_text' }),
        }
    );
    const daten = await res.json();

    if (!daten.success) {
        console.error('Fehlgeschlagen:', JSON.stringify(daten.errors));
        if (inEnv) { fs.copyFileSync(sicherung, envDatei); console.error('.env aus der Sicherung wiederhergestellt.'); }
        process.exit(1);
    }

    console.log('\nErfolgreich gesetzt.');
    if (inEnv) {
        // Gegenprobe mit dem neuen Wert (Verbreitung am Cloudflare-Rand dauert einige Sekunden).
        let status = 0;
        for (let t = 0; t < 8 && status !== 200; t++) {
            if (t) await new Promise(r => setTimeout(r, 3000));
            status = (await fetch('https://himusic-api.tyron-app.workers.dev/songs', { headers: { 'X-Api-Key': neuerWert } })).status;
        }
        console.log(`.env aktualisiert (Sicherung: tools/.env.vor-rotation). Server akzeptiert den neuen Schluessel: ${status === 200} (HTTP ${status})`);
        if (status !== 200) process.exitCode = 2;
    }
    console.log('Naechster Schritt: auf dem Handy in der App einmal aus- und mit dem');
    console.log('LOGIN_PASSWORD wieder einloggen - die App holt sich den neuen Schluessel');
    console.log('dann automatisch. Du musst den Wert nirgends selbst eintragen.');
}

main().catch(e => { console.error('Abbruch:', e.message); process.exit(1); });
