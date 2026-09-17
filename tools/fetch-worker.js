#!/usr/bin/env node
/**
 * Zieht den Quelltext des Cloudflare Workers aus dem Konto heraus, damit er versioniert werden
 * kann.
 *
 * Warum es das gibt: die komplette Server-Logik (Auth, Routing, R2-Anbindung, das Range-Handling
 * fuer /media) existiert nur im Cloudflare-Dashboard. Wird sie ueberschrieben oder das Konto
 * gesperrt, ist sie unwiederbringlich weg und muss aus dem Gedaechtnis nachgebaut werden. Ein
 * einmaliges Kopieren von Hand loest das nur bis zur naechsten Aenderung - deshalb ein Skript,
 * das man wiederholt laufen lassen kann.
 *
 * WICHTIG: Das Ergebnis gehoert NICHT in dieses Repo - es ist oeffentlich, und der Worker enthaelt
 * die Zugriffslogik. Standardziel ist deshalb ein Ordner ausserhalb. Von dort in ein PRIVATES Repo
 * committen.
 *
 * Aufruf:
 *   CF_API_TOKEN=... node tools/fetch-worker.js                 (listet die Worker des Kontos auf)
 *   CF_API_TOKEN=... node tools/fetch-worker.js <name> <ziel>   (laedt einen bestimmten herunter)
 *
 * Token anlegen: Cloudflare-Dashboard -> My Profile -> API Tokens -> Create Token.
 * Es genuegt LESEN: Permission "Account | Workers Scripts | Read". Kein Schreibrecht noetig -
 * dieses Skript aendert nichts, es liest nur.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.cloudflare.com/client/v4';

// Token bevorzugt aus tools/.env statt aus der Befehlszeile. Grund: alles, was in einem Terminal
// oder Chat getippt wird, landet in Verlaeufen und Sitzungs-Mitschriften und ist dort dauerhaft
// nicht mehr einzufangen. Eine gitignorierte Datei bleibt lokal.
function tokenLesen() {
    const envDatei = path.join(__dirname, '.env');
    if (fs.existsSync(envDatei)) {
        const treffer = fs.readFileSync(envDatei, 'utf8').match(/^\s*CF_API_TOKEN\s*=\s*(.+)$/m);
        if (treffer) return treffer[1].trim().replace(/^["']|["']$/g, '');
    }
    return (process.env.CF_API_TOKEN || '').trim();
}

const TOKEN = tokenLesen();
const NAME = process.argv[2] || null;
const ZIEL = process.argv[3] || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'himusic-worker-backup');

async function cf(pfad, alsText = false) {
    const res = await fetch(`${API}${pfad}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(30000),
    });
    const typ = res.headers.get('content-type') || '';
    if (alsText && !typ.includes('application/json')) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { text: await res.text(), typ };
    }
    const daten = await res.json();
    if (!res.ok || daten.success === false) {
        const grund = (daten.errors || []).map(e => `${e.code} ${e.message}`).join('; ') || `HTTP ${res.status}`;
        throw new Error(grund);
    }
    return daten;
}

async function main() {
    if (!TOKEN) {
        console.error('Kein Token. Bevorzugt in tools/.env hinterlegen (gitignoriert, bleibt lokal):');
        console.error('  CF_API_TOKEN=dein-token');
        console.error('Alternativ: CF_API_TOKEN=... node tools/fetch-worker.js');
        console.error('Anlegen unter Cloudflare -> My Profile -> API Tokens, Recht: Account | Workers Scripts | Read');
        process.exit(1);
    }

    const konten = (await cf('/accounts')).result || [];
    if (konten.length === 0) throw new Error('Keine Konten sichtbar - hat das Token das Recht "Workers Scripts | Read"?');

    for (const konto of konten) {
        let skripte = [];
        try { skripte = (await cf(`/accounts/${konto.id}/workers/scripts`)).result || []; }
        catch (e) { console.warn(`Konto ${konto.name}: ${e.message}`); continue; }

        if (!NAME) {
            console.log(`\nKonto ${konto.name} (${konto.id}) - ${skripte.length} Worker:`);
            skripte.forEach(s => console.log(`  ${s.id}    zuletzt geaendert: ${s.modified_on || 'unbekannt'}`));
            continue;
        }

        const treffer = skripte.find(s => s.id === NAME);
        if (!treffer) continue;

        const { text, typ } = await cf(`/accounts/${konto.id}/workers/scripts/${NAME}`, true);
        fs.mkdirSync(ZIEL, { recursive: true });

        // Module-Worker kommen als multipart zurueck, klassische als reines JavaScript. Beides
        // wird roh gesichert - lieber eine Datei zu viel als eine zerschnittene.
        const endung = typ.includes('multipart') ? 'multipart.txt' : 'js';
        const datei = path.join(ZIEL, `${NAME}.${endung}`);
        fs.writeFileSync(datei, text);
        fs.writeFileSync(path.join(ZIEL, `${NAME}.meta.json`), JSON.stringify({
            geholt: new Date().toISOString(), konto: konto.name, kontoId: konto.id,
            name: NAME, geaendert: treffer.modified_on, contentType: typ, zeichen: text.length,
        }, null, 2));

        console.log(`Gesichert: ${datei} (${text.length} Zeichen)`);
        console.log(`Zuletzt in Cloudflare geaendert: ${treffer.modified_on || 'unbekannt'}`);
        console.log('\nNaechster Schritt: diesen Ordner in ein PRIVATES Repo committen.');
        console.log('Nicht in tyronapp-dev/himusic - das ist oeffentlich.');
        return;
    }

    if (NAME) { console.error(`Worker "${NAME}" in keinem Konto gefunden.`); process.exit(1); }
    console.log('\nZum Sichern:  CF_API_TOKEN=... node tools/fetch-worker.js <name> "D:/worker-backup"');
}

main().catch(e => { console.error(`Abbruch: ${e.message}`); process.exit(1); });
