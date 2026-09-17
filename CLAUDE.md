# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Himusic Cloud** is a vanilla JS Progressive Web App (PWA) for personal music management and playback. No build step, no bundler, no package manager — files are edited and served directly.

## Running the App

Open `index.html` in a browser or serve the directory with any static file server:

```
npx serve .
# or
python -m http.server 8080
```

The Service Worker requires HTTPS or `localhost` to register. For local testing, `localhost` is sufficient.

## Architecture

### File structure
- `index.html` / `login.html` — HTML shells (all UI markup is inline)
- `app2.js` — entire application logic (~3500+ lines, single file)
- `style2.css` — all styles
- `sw.js` — service worker
- `config.js` — sets `window.HiMusicConfig.apiBaseUrl` and `apiKey` (override the backend URL / API key here)
- `manifest.json` — PWA manifest
- `docs/decisions/` — Architecture Decision Records (ADRs). Check here before re-deciding something that was already deliberated — especially [ADR-005](docs/decisions/ADR-005-worker-api-authentication.md), which documents an **unfinished** migration (see Deployment / hosting below).

### Hosting & deployment
The app is served via **GitHub Pages directly from this repo** (no build step, no separate host) — whatever is committed to `main` is what's live. The repo is currently **public**. This has a hard consequence: **no file that GitHub Pages serves can ever contain a real secret** (it's world-readable the moment it's pushed, and public repos are actively scanned for exactly this). `login.html` and `config.js` no longer contain any secret at all as of [ADR-006](docs/decisions/ADR-006-server-side-login.md) (password check moved server-side, API key fetched at login time instead of committed) — but the underlying hosting gap (source code, including the Worker URL, still world-readable) is unchanged; see [ADR-005](docs/decisions/ADR-005-worker-api-authentication.md) for that still-pending migration.

### Backend
REST API on Cloudflare Workers: `https://himusic-api.tyron-app.workers.dev` (Worker source lives only in the Cloudflare Dashboard, not in this repo — always ask for/paste the full current source before editing it, and hand back the complete file, not a diff).
Endpoints: `GET/POST /songs`, `PUT/DELETE /songs/:id`, `GET/POST /playlists`, `GET/POST /playlists/:id/songs`, `DELETE /playlists/:id/songs/:songId`, `POST /playlists/:id/reorder`.
**Open question (unresolved as of ADR-005):** the Worker source seen during the 2026-07-10 audit had no `/playlists*` routes at all, despite the client calling them constantly — never investigated whether a second Worker handles them or the feature is currently broken server-side.

All client-side calls to this Worker go through `_apiFetch()` (app2.js, drop-in `fetch()` replacement, sends `X-Api-Key: <key from localStorage>` on every call, and bounces to `login.html` on a 401 response) rather than raw `fetch()` — use it for any new call to `${API_URL}`. Calls to third-party hosts (iTunes search, etc.) must stay plain `fetch()`, never `_apiFetch()`, so the key is never sent to them. The Worker enforces this on every route except `/media/*` (GET), `/internal/register`, `/internal/queue-status` (both POST, own `Authorization: Bearer <D1_API_KEY>` check instead), and `/auth/login` (POST) — verified live via curl (401 without the header, 200 with it). `/internal/queue-status` (added 2026-08-28) lets the GitHub-Actions import report a per-`job_id` outcome (`done`/`failed`) back onto its `youtube_queue` row, so the client sees the real status of that specific import instead of guessing by count. See ADR-005 for the original rollout story (three bugs hit along the way: CORS preflight block, stale Service-Worker cache, a trailing-newline secret) and [ADR-006](docs/decisions/ADR-006-server-side-login.md) for the login/key-sourcing change below — useful context if API calls ever start failing again after a similar change.

### Authentication
Single flow as of ADR-006 (2026-07-12) — the two layers below are no longer independent:
1. **App login** (`login.html`): POSTs the entered password to the Worker's `POST /auth/login`, which checks it server-side against a `LOGIN_PASSWORD` secret (never shipped to the client). On success the Worker returns the current `API_KEY`, which the client stores in `localStorage` (`himusic_api_key`) alongside the existing `himusic_auth` flag — never in a tracked file.
2. **Worker API auth** (`X-Api-Key` header): the key used here is the one obtained from step 1, not a hardcoded value from `config.js` (which no longer has an `apiKey` field at all). Rotating `API_KEY` or `LOGIN_PASSWORD` in the Worker logs out every device on their next 401 (handled automatically by `_apiFetch()`).

Residual, consciously accepted trade-off (see ADR-006): the key is still one long-lived shared secret with no per-device revocation — rotation is the only way to invalidate it, and it logs out all devices at once. `/auth/login` itself has no rate limit, so its safety currently rests entirely on `LOGIN_PASSWORD` being high-entropy (a Cloudflare rate-limiting rule on that route is recommended but not yet set up). The public-repo/GitHub-Pages hosting gap from ADR-005 (source code itself, including the Worker URL, still readable by anyone) is unrelated to this fix and remains open.

### Global state (on `window`)
Key runtime state lives on `window` so UI fragments in `app2.js` can share it:
- `window.globalSongsData` — full song list array
- `window._songIndex` — `Map<id, song>` for O(1) lookups
- `window.currentPlayingSongId` / `window.currentPlayingPlaylistId`
- `window.currentSongData` — song metadata for the now-playing UI
- `window.playSong(title, artist, coverUrl, fileUrl)` — main playback entry point
- `window.playNextSong()` / `window.playPrevSong()` / `window.togglePlayPause()`
- `window.hbLocal` — offline audio helpers (`downloadToLocal`, `clearLocalAudio`, etc.)

### Offline / caching layers (three separate stores)
1. **Service Worker Cache API** — 3 named caches:
   - `himusic-app-shell-v1.4` — HTML/JS/CSS, stale-while-revalidate
   - `himusic-covers-v1` — album art, cache-first with SVG fallback
   - `himusic-audio-v1` — audio files, cache-first + manual Range-request handling for iOS seeking
2. **IndexedDB** (`HeatBoxAudio` / `audioFiles` store) — audio blobs for true offline playback. `startBackgroundCacheQueue()` now runs automatically after every library load (not just when the offline toggle is on), throttled to 1 parallel download and paused while a song is actively playing — see [ADR-002](docs/decisions/ADR-002-automatic-offline-caching.md) for why (a 3-parallel unconditional version previously pulled ~14 GB at once on large libraries and made the app sluggish). The manual "download everything now" button stays fast (12 parallel) since it's an explicit one-off action.
3. **localStorage** — `himusic_auth` (login flag), `heatbox_state` (player state: current song, queue, volume, EQ settings), `himusic_sync_giveup` (song IDs the background metadata sync gave up on — see below)

### YouTube Import
Songs can be added by pasting a YouTube URL or by name search (`app2.js` ~line 6619: `yt-search-input` → `GET /youtube-search?q=` → result list with thumbnail/title/channel/duration). Each result row has a play button (embedded hidden YouTube IFrame player + seek bar, `_toggleYtPreview`/`_stopYtPreview` ~line 6527) to preview before committing, and a separate download button that stops the preview and enqueues that video via the same path as URL paste.

The import runs **entirely on the device**. `_ytImportQueue()` (`app2.js` ~line 1073, wired to `#btn-yt-import-now`, also auto-triggered when the app becomes visible or right after links are pasted, throttled to one auto-run per 90 s) walks the local queue and hands each entry to `_ytImportOne()` (~line 914):

1. `_ytExtract()` (~line 508) asks YouTube's InnerTube player API, trying the clients in `_YT_CLIENTS` (~line 364) in order. **VISIONOS is the primary client** since 2026-08-30: it returns plain audio URLs with no PO token, no n-sig decryption, and without the `sps=2`/1 MiB 403 wall the IOS client hits on protected music videos. Its one requirement is a `visitorData` value scraped from a real `watch?v=` page (`_ytVisitorData`, cached ~30 min) — a freshly bootstrapped one gets flagged as a bot. "Made for kids" videos aren't served by this client and fall through to IOS.
2. The audio is fetched in 512 KB chunks, then `_ytRemuxToProgressiveMp4()` (~line 640) rebuilds YouTube's fragmented MP4 into a progressive one — purely byte-level, no re-encode, `edts`/`elst` deliberately dropped — because the native AVPlayer won't play a fragmented file.
3. `_probeAudioPlayable()` (~line 888) decodes the result end-to-end **on the device** before anything is registered, and again on the bytes R2 actually serves back. A song is created only if both probes pass; otherwise the import fails (retryable) instead of leaving a half-dead song in the library.
4. Upload via `PUT /upload/:name`, verify with Range requests against `/media/:name`, then `POST /songs` plus a native `cacheNow` so the first tap plays from disk. After a successful run in the shell the page reloads once (audio keeps playing natively).

Limits: 20 MB per file (`_YT_IMPORT_MAX_BYTES`), 20 songs per run (`_YT_IMPORT_RUN_CAP`), 1.5 s between songs — the last two deliberately keep the traffic from looking like a bot burst.

**The import only works inside the native shell** (`window.__himusicNativeShell` + `webkit.messageHandlers.himusicHttp`), because the InnerTube calls go through `_nativeHttp` — a browser `fetch` can't set the required headers cross-origin. In a plain browser the button shows a toast saying so and does nothing else.

The queue is **local only** (`himusic_yt_queue` in localStorage): device state, not a server job list. `himusic_yt_imported_urls` holds the "already imported" history that keeps overlapping playlist dumps from re-downloading the same video.

**Removed on 2026-09-17:** the earlier server-side import paths — `POST /youtube-queue` polled by `local-import-watcher/watch.js` on a home IP, and the `POST /dispatch-import` → `repository_dispatch` → GitHub Actions fallback (Cobalt instance pool + yt-dlp + `YOUTUBE_COOKIES`). The cookie path had been failing continuously since those cookies expired, and the client-side liveness check kept auto-firing it after 30 s without a watcher. [ADR-009](docs/decisions/ADR-009-cobalt-instance-pool-fallback.md) and [ADR-010](docs/decisions/ADR-010-youtube-import-audio-quality.md) describe that removed pipeline and are marked superseded. The Cloudflare Worker still carries the now-unused `/youtube-queue` and `/dispatch-import` routes and the `GH_PAT` secret — its source is not in this repo.

### Background metadata sync
`processBackgroundSync()` (`app2.js`) fills in cover/artist for songs imported without clean metadata (mainly YouTube imports). Tries iTunes first, Spotify only as a fallback when iTunes finds nothing (rate-limit-sensitive, see [ADR-001](docs/decisions/ADR-001-background-sync-giveup-strategy.md)). If neither finds a match after a few attempts, the song is marked given-up (`himusic_sync_giveup` in localStorage) and stops being auto-retried — fix those manually in the tag editor instead of expecting the sync to eventually succeed.

### Song vibes field
The `vibes` column from the API can arrive as a JSON string, a JS array, or null. Always use `_parseVibes(value)` to normalize it before using. A song with an empty vibes array gets a small red `.no-vibes-dot` badge on its cover (song list + big player) so it's visually obvious which songs still need tagging; disappears the moment `vibes` is saved non-empty.

### Songs list scrollbar
The Songs page has a plain draggable scrollbar on the right edge (`#songs-scrollbar` / `.songs-scrollbar-thumb` in app2.js/style2.css) — deliberately **not** an A-Z jump index, which was built first and then explicitly rejected (see [ADR-003](docs/decisions/ADR-003-songs-list-scrollbar.md)). Don't reintroduce a letter-based index here without re-reading that ADR.

### Rendering song/playlist/YouTube data — always escape
Song titles, artist names, playlist/station/vibe-mix names, and YouTube search results (title, channel, thumbnail URL) are attacker-influenceable (YouTube titles are free text set by any uploader) and get inserted into the DOM via `innerHTML` template strings in many places (`updateSongDOM`, `buildQueueItem`, `renderHomeSections`, the YouTube search results renderer, the duplicate cleaner, playlist list items). **Always wrap these values in `_esc()`** (defined near the top of `app2.js`) before interpolating them into an `innerHTML` string — see [ADR-004](docs/decisions/ADR-004-xss-hardening-html-escaping.md) for the stored-XSS this fixed. `alert()`/`confirm()` calls don't need escaping (plain-text dialogs, can't execute markup).

### Service Worker update
Bumping `CACHE_NAME` in `sw.js` triggers cache invalidation on next load. The SW uses `skipWaiting()` + `clients.claim()` so updates apply immediately. Currently at `v1.4`.

## Native Hülle (iOS) — ADR-007

Seit 2026-08-07 gibt es unter `native-player/` eine kleine native iOS-App, die **diese
PWA in einem WKWebView trägt und den Ton nativ abspielt**. Grund: iOS gewährt Web-Apps
kein `UIBackgroundModes: audio` — im Hintergrund friert die Wiedergabe ein und das
Control Center zeigt die falsche App. Vorgeschichte, verworfene Alternativen und die
Revision vom 07.08. (weg von zwei getrennten Apps): `docs/decisions/ADR-007-native-player-companion-app.md`.

**Aufteilung:** Oberfläche = diese Webseite, unverändert, wird live von GitHub Pages
geladen. Ton = `AVPlayer` in der App. **UI-Änderungen brauchen deshalb keinen
App-Neubau** — nur Änderungen unter `native-player/` tun das.

**Brücke:** `_tryNativePlayerHandoff()` (oben in app2.js) prüft
`window.webkit.messageHandlers.himusicNative`. Existiert sie, läuft die Seite in der
Hülle → Wiedergabe geht **immer** nativ, `himusic_native_player_enabled` ist dann
irrelevant. Der Schalter betrifft nur den alten Weg aus Safari über
`himusicplayer://`, der absichtlich als Rückfallebene erhalten bleibt (falls die
7-Tage-Signatur der Hülle abläuft). Übergeben wird `{queue: [{id,t,a,u,c}], startIndex}`
als JSON-String, maximal 25 Einträge.

**Nie eine `blob:`-URL übergeben.** Offline gecachte Songs spielt die PWA aus IndexedDB
über `blob:` — solche URLs existieren nur im Browser, der native AVPlayer kann sie nicht
lesen (solche Songs wären stumm geblieben). `remoteUrl()` schlägt deshalb immer die
Netz-Adresse nach, notfalls über `window._songIndex`. Folge: gecachte Songs werden nativ
**gestreamt**. Echtes Offline-Abspielen im Hintergrund braucht einen eigenen nativen
Datei-Cache — bewusst offen.

**Release-Schleife:**
1. Änderung unter `native-player/` committen und pushen → `.github/workflows/build-native-player.yml`
   baut auf einem macOS-Runner ein unsigniertes `.ipa` (~40 s).
2. Artefakt `HimusicPlayer-unsigned-ipa` holen: `gh run download <run-id> --repo tyronapp-dev/himusic`.
3. **Immer im gebauten Paket nachsehen, nicht in der Quelldatei.** Ein grüner Build
   beweist nur, dass der Code kompiliert. Am 07.08. fehlten `CFBundleURLTypes` und
   `UIBackgroundModes` im Artefakt, weil XcodeGen die `Info.plist` aus
   `project.yml → info.properties` **erzeugt** und eine dort liegende handgeschriebene
   Datei überschreibt. Alle Plist-Schlüssel gehören deshalb in `project.yml`.
4. `.ipa` aufs iPhone, in SideStore über „+" über die alte Fassung installieren.

**Wird `app2.js` oder `index.html` geändert, `CACHE_NAME` in `sw.js` hochzählen** —
sonst serviert der Service Worker weiter die alte Oberfläche.

**Stolpersteine beim Übertragen aufs Gerät, alle real passiert:** Proton VPN zieht
lokalen Verkehr in den Tunnel → LocalSend scheitert, VPN aus oder LAN erlauben. Die
Datei landet je nach Weg als `HimusicPlayer.zip` → in `.ipa` umbenennen, SideStore nimmt
nur `.ipa`. Auf dem Gerät entpacken (`Payload/`, `.app`) ist ein Irrweg — die IPA muss
verpackt bleiben. Und der PC braucht Apples USB-Treiber: ohne den meldet Windows
„Fehler beim Anfordern einer Gerätebeschreibung" und iloader sieht das iPhone nicht.

## Git workflow
The user has authorized automatic `git add` / `git commit` / `git push` to `origin/main` after making requested code changes in this repo, without asking for confirmation each time. Still confirm before destructive/irreversible git operations (force-push, reset --hard, history rewrites, deleting branches).
