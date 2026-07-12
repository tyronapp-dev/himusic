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

All client-side calls to this Worker go through `_apiFetch()` (app2.js, drop-in `fetch()` replacement, sends `X-Api-Key: <key from localStorage>` on every call, and bounces to `login.html` on a 401 response) rather than raw `fetch()` — use it for any new call to `${API_URL}`. Calls to third-party hosts (iTunes search, etc.) must stay plain `fetch()`, never `_apiFetch()`, so the key is never sent to them. The Worker enforces this on every route except `/media/*` (GET), `/internal/register`, and `/auth/login` (POST) — verified live via curl (401 without the header, 200 with it). See ADR-005 for the original rollout story (three bugs hit along the way: CORS preflight block, stale Service-Worker cache, a trailing-newline secret) and [ADR-006](docs/decisions/ADR-006-server-side-login.md) for the login/key-sourcing change below — useful context if API calls ever start failing again after a similar change.

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
Songs can be added by pasting a YouTube URL or by name search (`app2.js` ~line 3085: `yt-search-input` → `GET /youtube-search?q=` → result list with thumbnail/title/channel/duration, no audio preview player yet → click imports via the same path as URL paste).

`startYoutubeImport()` (`app2.js` ~line 3012) tries two paths in order:
1. **Primary:** `POST /youtube-queue` — polled by `local-import-watcher/watch.js` running on a normal (non-datacenter) IP, since YouTube's bot detection blocks cloud/datacenter IPs far more often. No watcher is guaranteed to be running at any given time. Since ADR-005, `watch.js` needs a local, gitignored `.env` file next to it (`HIMUSIC_API_KEY=...`) — it refuses to start without one.
2. **Fallback:** `POST /dispatch-import` → Cloudflare Worker fires a `repository_dispatch` to `.github/workflows/audio-worker.yml`, which runs the import as a chain of up to 8 jobs (`.github/actions/yt-import`), each on a fresh runner/IP. `src/extractor_worker.py` treats YouTube cookies (`YOUTUBE_COOKIES` repo secret, Netscape format) as the primary defense against bot-detection, not just for age-restricted content — cookies from datacenter IPs have previously been observed to expire within hours, so re-export periodically if the fallback starts failing again.

The `repository_dispatch` route requires a valid `GH_PAT` secret in the Cloudflare Worker (rotate at github.com/settings/tokens, scope `repo`, if it starts returning auth errors).

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

## Git workflow
The user has authorized automatic `git add` / `git commit` / `git push` to `origin/main` after making requested code changes in this repo, without asking for confirmation each time. Still confirm before destructive/irreversible git operations (force-push, reset --hard, history rewrites, deleting branches).
