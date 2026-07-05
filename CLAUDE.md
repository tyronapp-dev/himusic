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
- `app2.js` — entire application logic (~3000+ lines, single file)
- `style2.css` — all styles
- `sw.js` — service worker
- `config.js` — sets `window.HiMusicConfig.apiBaseUrl` (override the backend URL here)
- `manifest.json` — PWA manifest

### Backend
REST API on Cloudflare Workers: `https://himusic-api.tyron-app.workers.dev`  
Endpoints: `GET/POST /songs`, `PUT/DELETE /songs/:id`, `GET/POST /playlists`, `GET/POST /playlists/:id/songs`, `DELETE /playlists/:id/songs/:songId`, `POST /playlists/:id/reorder`

### Authentication
Simple flag: `localStorage.getItem('himusic_auth') === 'true'`. If not set, redirects to `login.html`. No JWT or session tokens — just the flag.

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
   - `himusic-app-shell-v1.0` — HTML/JS/CSS, stale-while-revalidate
   - `himusic-covers-v1` — album art, cache-first with SVG fallback
   - `himusic-audio-v1` — audio files, cache-first + manual Range-request handling for iOS seeking
2. **IndexedDB** (`HeatBoxAudio` / `audioFiles` store) — audio blobs for true offline playback. Audio is downloaded to IDB after first play via `downloadToLocal()`.
3. **localStorage** — `himusic_auth` (login flag), `heatbox_state` (player state: current song, queue, volume, EQ settings)

### YouTube Import
Songs can be added by pasting a YouTube URL or by name search (`app2.js` ~line 3085: `yt-search-input` → `GET /youtube-search?q=` → result list with thumbnail/title/channel/duration, no audio preview player yet → click imports via the same path as URL paste).

`startYoutubeImport()` (`app2.js` ~line 3012) tries two paths in order:
1. **Primary:** `POST /youtube-queue` — polled by `local-import-watcher/watch.js` running on a normal (non-datacenter) IP, since YouTube's bot detection blocks cloud/datacenter IPs far more often. No watcher is guaranteed to be running at any given time.
2. **Fallback:** `POST /dispatch-import` → Cloudflare Worker fires a `repository_dispatch` to `.github/workflows/audio-worker.yml`, which runs the import as a chain of up to 8 jobs (`.github/actions/yt-import`), each on a fresh runner/IP. `src/extractor_worker.py` treats YouTube cookies (`YOUTUBE_COOKIES` repo secret, Netscape format) as the primary defense against bot-detection, not just for age-restricted content — cookies from datacenter IPs have previously been observed to expire within hours, so re-export periodically if the fallback starts failing again.

The `repository_dispatch` route requires a valid `GH_PAT` secret in the Cloudflare Worker (rotate at github.com/settings/tokens, scope `repo`, if it starts returning auth errors).

### Song vibes field
The `vibes` column from the API can arrive as a JSON string, a JS array, or null. Always use `_parseVibes(value)` to normalize it before using.

### Service Worker update
Bumping `CACHE_NAME` in `sw.js` triggers cache invalidation on next load. The SW uses `skipWaiting()` + `clients.claim()` so updates apply immediately.

## Git workflow
The user has authorized automatic `git add` / `git commit` / `git push` to `origin/main` after making requested code changes in this repo, without asking for confirmation each time. Still confirm before destructive/irreversible git operations (force-push, reset --hard, history rewrites, deleting branches).
