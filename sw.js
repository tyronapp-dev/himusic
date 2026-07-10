// Himusic Cloud - Service Worker v1.0
// Komplett optimiert für das neue Cloudflare / Firebase Setup

const CACHE_NAME  = 'himusic-app-shell-v1.3';
const COVER_CACHE = 'himusic-covers-v1';
const AUDIO_CACHE = 'himusic-audio-v1';

// Diese Dateien müssen offline verfügbar sein, damit die App startet.
// login.js/firebase-config.js gab es nach der Firebase-Entfernung nie/nicht mehr im Repo –
// jeder Install-Versuch loggte für die beiden einen Cache-Miss-404 ins Leere.
const APP_SHELL = [
    './',
    './index.html',
    './login.html',
    './app2.js',
    './style2.css',
    './manifest.json',
    './config.js',
    './icon-180.png',
    './icon-192.png',
    './icon-512.png',
    'https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js'
];

// ──────────────────────────────────────────────────────────
// INSTALL – App-Shell vollständig cachen
// ──────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.allSettled(APP_SHELL.map(url =>
                cache.add(url).catch(() => console.warn('[SW] Cache miss:', url))
            ))
        ).then(() => self.skipWaiting())
    );
});

// ──────────────────────────────────────────────────────────
// ACTIVATE – Alte Caches löschen, sofort übernehmen
// ──────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(names =>
            Promise.all(names
                .filter(n => n !== CACHE_NAME && n !== COVER_CACHE && n !== AUDIO_CACHE)
                .map(n => caches.delete(n))
            )
        ).then(() => self.clients.claim())
    );
});

// ──────────────────────────────────────────────────────────
// MESSAGE – Bulk-Download & Cache-Management
// ──────────────────────────────────────────────────────────
self.addEventListener('message', async (event) => {
    if (!event.data) return;
    const client = event.source;

    if (event.data.type === 'CLEAR_AUDIO_CACHE') {
        await caches.delete(AUDIO_CACHE);
        if (client) client.postMessage({ type: 'CACHE_CLEARED' });
    }

    if (event.data.type === 'GET_CACHE_INFO') {
        const audioCache = await caches.open(AUDIO_CACHE);
        const keys = await audioCache.keys();
        if (client) client.postMessage({ type: 'CACHE_INFO', count: keys.length });
    }
});

// ──────────────────────────────────────────────────────────
// FETCH – Request-Strategien
// ──────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. Audio – Cache-first mit Range-Request-Support (für Seeking auf iOS!)
    if (
        event.request.destination === 'audio' ||
        url.pathname.endsWith('.mp3') ||
        url.pathname.endsWith('.flac') ||
        url.pathname.endsWith('.m4a') ||
        url.hostname.includes('r2.cloudflarestorage') ||
        url.hostname.includes('workers.dev')
    ) {
        event.respondWith(
            caches.open(AUDIO_CACHE).then(async (cache) => {
                const cached = await cache.match(event.request.url);
                if (cached) {
                    const rangeHeader = event.request.headers.get('range');
                    if (rangeHeader) {
                        const buf   = await cached.clone().arrayBuffer();
                        const total = buf.byteLength;
                        const m     = rangeHeader.match(/bytes=(\d+)-(\d*)/);
                        const start = parseInt(m[1], 10);
                        const end   = m[2] ? parseInt(m[2], 10) : total - 1;
                        return new Response(buf.slice(start, end + 1), {
                            status: 206, statusText: 'Partial Content',
                            headers: {
                                'Content-Type':  cached.headers.get('Content-Type') || 'audio/mpeg',
                                'Content-Range': `bytes ${start}-${end}/${total}`,
                                'Content-Length': String(end - start + 1),
                                'Accept-Ranges': 'bytes',
                                // CORS-Header nötig, damit der Web-Audio-Equalizer (crossOrigin) den
                                // gecachten Range-Response nicht als "tainted" verwirft → sonst Stille
                                'Access-Control-Allow-Origin': '*',
                                'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
                            }
                        });
                    }
                    return cached;
                }
                return fetch(event.request).catch(() =>
                    new Response('', { status: 503, statusText: 'Offline' })
                );
            })
        );
        return;
    }

    // 2. Cover-Bilder – Cache-first, Fallback auf leeres SVG
    if (
        event.request.destination === 'image' ||
        url.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/) ||
        url.hostname.includes('mzstatic.com')
    ) {
        event.respondWith(
            caches.open(COVER_CACHE).then(async (cache) => {
                const cached = await cache.match(event.request);
                if (cached) return cached;
                try {
                    const response = await fetch(event.request);
                    if (response.status === 200) cache.put(event.request, response.clone());
                    return response;
                } catch (e) {
                    return new Response(
                        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="#1c1c1e" width="1" height="1"/></svg>',
                        { headers: { 'Content-Type': 'image/svg+xml' } }
                    );
                }
            })
        );
        return;
    }

    // 3. App-Shell & CDN – Cache-FIRST (sofort offline ladbar!)
    if (
        url.hostname === self.location.hostname ||
        url.hostname.includes('cdn.jsdelivr.net') ||
        url.hostname.includes('firebase')
    ) {
        event.respondWith(
            caches.match(event.request).then(async (cached) => {
                // Gefunden → sofort ausliefern, Hintergrund-Update starten
                if (cached) {
                    fetch(event.request).then(r => {
                        if (r && r.status === 200)
                            caches.open(CACHE_NAME).then(c => c.put(event.request, r.clone()));
                    }).catch(() => {});
                    return cached;
                }
                // Nicht gecacht → Netzwerk versuchen
                try {
                    const response = await fetch(event.request);
                    if (response && response.status === 200)
                        caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
                    return response;
                } catch(e) {
                    // Offline + nicht gecacht → Login.html als Fallback
                    return caches.match('./login.html');
                }
            })
        );
        return;
    }

    // 4. API (Cloudflare) – Netzwerk mit Timeout, graceful offline
    event.respondWith(
        Promise.race([
            fetch(event.request),
            new Promise((_, reject) => setTimeout(() => reject(), 8000))
        ]).catch(() =>
            new Response(JSON.stringify({ error: 'offline' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            })
        )
    );
});