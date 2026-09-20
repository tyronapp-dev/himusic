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
 *   node rotate-api-key.js
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

async function main() {
    const token = tokenLesen();
    if (!token) {
        console.error('Kein CF_API_TOKEN in tools/.env gefunden.');
        process.exit(1);
    }

    // 32 zufaellige Bytes, hex-kodiert - bleibt ausschliesslich in dieser Variable, wird nie
    // console.log't, nie in eine Datei geschrieben.
    const neuerWert = crypto.randomBytes(32).toString('hex');

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
        process.exit(1);
    }

    console.log('\nErfolgreich gesetzt.');
    console.log('Naechster Schritt: auf dem Handy in der App einmal aus- und mit dem');
    console.log('LOGIN_PASSWORD wieder einloggen - die App holt sich den neuen Schluessel');
    console.log('dann automatisch. Du musst den Wert nirgends selbst eintragen.');
}

main().catch(e => { console.error('Abbruch:', e.message); process.exit(1); });
