const API_URL = window.HiMusicConfig?.apiBaseUrl || 'https://heatbox-api.tyron-app.workers.dev';
const API_KEY = localStorage.getItem('himusic_api_key') || '';

// Ersetzt fetch() 1:1 an allen Stellen, die UNSEREN Worker (himusic-api) aufrufen (Aufrufe an
// fremde Hosts wie iTunes bleiben normales fetch()). Der Worker verlangt X-Api-Key auf jeder
// Route außer /media/*, /internal/register und /auth/login. Der Key selbst kommt seit ADR-006
// nicht mehr aus config.js, sondern wird nach erfolgreichem Login vom Worker geholt und nur in
// localStorage gehalten. Liefert der Worker 401 (Key fehlt/ungültig/rotiert), wird die Session
// verworfen und zurück zum Login geschickt, statt dass jeder folgende Request still ins Leere
// läuft.
function _apiFetch(url, options = {}) {
    return fetch(url, { ...options, headers: { ...(options.headers || {}), 'X-Api-Key': API_KEY } })
        .then(response => {
            if (response.status === 401) {
                localStorage.removeItem('himusic_auth');
                localStorage.removeItem('himusic_api_key');
                window.location.replace('login.html');
            }
            return response;
        });
}

function _parseVibes(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch(e) { return []; } }
    return [];
}

// Song-Titel/Künstler etc. können aus externen Quellen kommen (YouTube-Videotitel, von jedem
// frei wählbar) und landen an vielen Stellen per innerHTML im DOM. Ohne Escaping wäre ein
// Videotitel wie `<img src=x onerror=...>` gespeicherter XSS, der bei jedem Rendern der Liste
// ausgeführt wird. IMMER durch diese Funktion schicken, bevor Songdaten in innerHTML landen.
function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Kurzer haptischer Tick (Vibration API). Funktioniert nur auf Android-Browsern – iOS Safari/
// PWAs unterstützen navigator.vibrate() nicht (Apple bietet dafür keine Web-API). Dort greift
// automatisch nur das visuelle Feedback (Puls-Animation), ganz ohne Fehler oder Crash.
function _hapticTick(ms = 12) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch(e) {} }

async function apiGetAllSongs() {
  const response = await _apiFetch(`${API_URL}/songs`);
  if (!response.ok) throw new Error('Failed to fetch songs');
  return await response.json();
}

async function apiCreateSong(songData) {
  const response = await _apiFetch(`${API_URL}/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(songData) });
  if (!response.ok) throw new Error('Failed to create song');
  return await response.json();
}

async function apiUpdateSong(songId, updates) {
  const response = await _apiFetch(`${API_URL}/songs/${songId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  if (!response.ok) throw new Error('Failed to update song');
  return await response.json();
}

async function apiDeleteSong(songId) {
  const response = await _apiFetch(`${API_URL}/songs/${songId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete song');
  return await response.json();
}

async function apiGetAllPlaylists() {
  const response = await _apiFetch(`${API_URL}/playlists`);
  if (!response.ok) throw new Error('Failed to fetch playlists');
  return await response.json();
}

async function apiCreatePlaylist(name) {
  const response = await _apiFetch(`${API_URL}/playlists`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server blockiert (Status ${response.status}): ${errText}`);
  }
  return await response.json();
}

async function apiDeletePlaylist(playlistId) {
  const response = await _apiFetch(`${API_URL}/playlists/${playlistId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete playlist');
  return await response.json();
}

async function apiGetPlaylistSongs(playlistId) {
  const response = await _apiFetch(`${API_URL}/playlists/${playlistId}/songs`);
  if (!response.ok) throw new Error('Failed to fetch playlist songs');
  return await response.json();
}

async function apiAddSongsToPlaylist(playlistId, songIds) {
  const response = await _apiFetch(`${API_URL}/playlists/${playlistId}/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ song_ids: songIds }) });
  if (!response.ok) throw new Error('Failed to add songs to playlist');
  return await response.json();
}

async function apiRemoveSongFromPlaylist(playlistId, songId) {
  const response = await _apiFetch(`${API_URL}/playlists/${playlistId}/songs/${songId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to remove song from playlist');
  return await response.json();
}

async function apiUpdatePlaylist(playlistId, updates) {
  const response = await _apiFetch(`${API_URL}/playlists/${playlistId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  if (!response.ok) throw new Error('Failed to update playlist');
  return await response.json();
}

async function apiReorderPlaylistSongs(playlistId, updates) {
  const response = await _apiFetch(`${API_URL}/playlists/${playlistId}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }) });
  if (!response.ok) throw new Error('Failed to reorder playlist songs');
  return await response.json();
}

// Setzt die Akzentfarbe UND berechnet daraus die passende Schriftfarbe für Elemente, die die
// Akzentfarbe als Hintergrund nutzen (Buttons, Vibe-Pills, Checkboxen). Bei heller Akzentfarbe
// (z.B. Weiß) wird die Schrift schwarz, bei dunkler weiß – so bleibt Text immer lesbar.
function _setAccentColor(color) {
    document.documentElement.style.setProperty('--accent', color);
    let r = 0, g = 0, b = 0;
    const hex = (color || '').replace('#', '');
    if (hex.length === 6) { r = parseInt(hex.slice(0,2),16); g = parseInt(hex.slice(2,4),16); b = parseInt(hex.slice(4,6),16); }
    else if (hex.length === 3) { r = parseInt(hex[0]+hex[0],16); g = parseInt(hex[1]+hex[1],16); b = parseInt(hex[2]+hex[2],16); }
    // Wahrgenommene Helligkeit (0–255). Über ~150 = helle Farbe → dunkle Schrift.
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    document.documentElement.style.setProperty('--accent-text', luminance > 150 ? '#000' : '#fff');
}

function updatePlayerBackground(color1, color2) {
    const bg = document.querySelector('.dynamic-bg');
    if (!bg) return;
    bg.style.backgroundImage = `radial-gradient(at 0% 10%, ${color1}66 0px, transparent 60%), radial-gradient(at 100% 20%, ${color2}44 0px, transparent 60%), radial-gradient(at 50% 100%, rgba(0, 0, 0, 1) 0px, transparent 100%)`;
    _setAccentColor(color1);
}

function formatDuration(totalSeconds) {
    if (!totalSeconds) return "0min";
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${m < 10 ? '0' : ''}${m}min`;
    return `${m}min`;
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

const getDuration = (file) => new Promise((resolve) => {
    const audio = new Audio(URL.createObjectURL(file));
    audio.onloadedmetadata = () => resolve(Math.round(audio.duration));
    audio.onerror = () => resolve(0);
});

function addLongPressListener(element, callback) {
    let pressTimer;
    const start = (e) => {
        if (e.type === 'click' && e.button !== 0) return; 
        pressTimer = window.setTimeout(() => { callback(e); }, 600); 
    };
    const cancel = () => { clearTimeout(pressTimer); };
    element.addEventListener('mousedown', start);
    element.addEventListener('touchstart', start, {passive: true});
    element.addEventListener('mouseup', cancel);
    element.addEventListener('mouseleave', cancel);
    element.addEventListener('touchend', cancel);
    element.addEventListener('touchcancel', cancel);
}

// Baut aus Titel + Künstler einen sauberen Suchbegriff. Rohe Import-Titel wie
// "Chris_Brown___Gimme_That___ezmp3.cc__" scheitern sonst besonders bei Spotify (strenge Suche):
// Unterstriche/Bindestriche → Leerzeichen, Download-Seiten-Müll und "(Official Video)"-Zusätze weg,
// und Platzhalter-Künstler ("Unbekannt"/"Unbekannter Künstler") werden NIE mitgesucht.
function _cleanSearchTerm(title, artist) {
    let t = (title || '').replace(/\.[^/.]+$/, '');
    t = t.replace(/[_\-]+/g, ' ');
    t = t.replace(/\b(ezmp3|ytmp3|y2mate|mp3juice|flvto|snappea)(\s*\.?\s*(cc|com|net|org|io))?\b/gi, '');
    t = t.replace(/[\(\[][^\)\]]*(official|video|audio|lyric|visuali|clip|prod\.?|hd|4k|remaster)[^\)\]]*[\)\]]/gi, '');
    t = t.replace(/\bofficial\s+(music\s+)?(video|audio|visualizer|lyric(s)?(\s+video)?)\b/gi, '');
    t = t.replace(/\s{2,}/g, ' ').trim();
    let a = (artist || '').trim();
    if (/^unbekannt/i.test(a)) a = '';
    return (t + ' ' + a).trim();
}

// Spotify-Suche über den Worker. Liefert das volle Metadaten-Objekt {title, artist, cover}
// oder null. data.error === "rate_limited" → Spotify drosselt gerade unsere App-Kennung;
// der Aufrufer kann das anzeigen bzw. auf iTunes ausweichen.
async function searchSongMetaSpotify(title, artist, retryCount = 0) {
    const q = _cleanSearchTerm(title, artist);
    if (!q) return null;
    try {
        const response = await _apiFetch(`${API_URL}/spotify-search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.error === 'rate_limited') { window._spotifyCooldownUntil = Date.now() + 15 * 60 * 1000; return { rateLimited: true }; }
        if (!data.result) return null;
        return { title: data.result.title, artist: data.result.artist, album: data.result.album || "", cover: data.result.cover_data || null };
    } catch (e) {
        if (retryCount < 2 && (e.name === 'AbortError' || e.message.includes('Failed to fetch'))) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return searchSongMetaSpotify(title, artist, retryCount + 1);
        }
        return null;
    }
}

// iTunes-Suche (direkt, kein Key). Liefert {title, artist, cover} oder null.
async function searchSongMetaItunes(title, artist, retryCount = 0) {
    const q = _cleanSearchTerm(title, artist);
    if (!q) return null;
    try {
        const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const t = data.results && data.results[0];
        if (!t) return null;
        return { title: t.trackName, artist: t.artistName, album: t.collectionName || "", cover: (t.artworkUrl100 || '').replace('100x100bb', '600x600bb') || null };
    } catch (e) {
        if (retryCount < 2 && (e.name === 'AbortError' || e.message.includes('Failed to fetch'))) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return searchSongMetaItunes(title, artist, retryCount + 1);
        }
        return null;
    }
}

async function fetchCoverFromSpotify(title, artist) {
    const meta = await searchSongMetaSpotify(title, artist);
    return (meta && !meta.rateLimited && meta.cover) ? meta.cover : null;
}

async function fetchCoverFromiTunes(title, artist) {
    const meta = await searchSongMetaItunes(title, artist);
    return (meta && meta.cover) ? meta.cover : null;
}

const AVAILABLE_VIBES = ["Afro", "Ghana", "RnB", "Old School", "Deepdream", "LD", "Calm", "SAD", "Gym", "HYPE", "Carpool", "Amapiano", "Hard rap", "Dancehall", "Rap", "Summer", "Latenight", "Dance", "Christ", "Soul", "Exotic", "N-rei", "ODS", "G-Nrei","POP","OGG"];

function addClearButton(inputElement) {
    if (!inputElement || inputElement.dataset.hasClearBtn) return;
    inputElement.dataset.hasClearBtn = 'true';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'input-clear-btn';
    clearBtn.innerHTML = '×';
    clearBtn.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:20px;height:20px;color:#fff;font-size:18px;line-height:1;cursor:pointer;display:none;padding:0;';
    let wrapper = inputElement.parentElement;
    if (!wrapper.classList.contains('input-wrapper')) {
        wrapper = document.createElement('div');
        wrapper.className = 'input-wrapper';
        wrapper.style.cssText = 'position:relative;width:100%;';
        inputElement.parentNode.insertBefore(wrapper, inputElement);
        wrapper.appendChild(inputElement);
    }
    wrapper.appendChild(clearBtn);
    const toggleClearBtn = () => { clearBtn.style.display = inputElement.value.length > 0 ? 'block' : 'none'; };
    inputElement.addEventListener('input', toggleClearBtn);
    inputElement.addEventListener('focus', toggleClearBtn);
    clearBtn.addEventListener('click', () => {
        inputElement.value = '';
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.focus();
        clearBtn.style.display = 'none';
    });
    toggleClearBtn();
}

// ---------------------------------------------------------
// LOKALER LOGIN CHECK (FIREBASE ENTFERNT)
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('himusic_auth') !== 'true') {
        window.location.replace("login.html");
        return;
    }
    initApp(); 
});

function initApp() {
    console.log('Cloudflare D1 API bereit!'); 
    
    const songsContainer = document.getElementById('songs-list-container');
    const stationsContainer = document.getElementById('stations-container');
    const actionSheetOverlay = document.getElementById('action-sheet-overlay');
    const songContextOverlay = document.getElementById('song-context-overlay');
    const playlistSelectionOverlay = document.getElementById('playlist-selection-overlay');
    const selectionToolbar = document.getElementById('selection-toolbar');
    
    let currentMode = 'normal'; 
    let selectedSongs = new Set();
    let allSongsElements = [];
    window.globalSongsData = []; 
    let playbackQueue = [];   
    let playbackHistory = []; 
    window.currentContextSongId = null;
    window.currentEditSongId = null; // Schnappschuss: welcher Song ist GERADE im Tag-Editor offen (siehe ctxEditTags)
    window.currentContextPlaylistId = null;
    window.currentOpenPlaylistId = null; 
    window.currentPlaylistSongs = [];
    window.currentSongDuration = 0;
    
    let _saveTimer = null;
    function savePlayerState() {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(_doSavePlayerState, 800);
    }
    function _doSavePlayerState() {
        const state = {
            currentSong: window.currentSongData || null,
            playingSongId: window.currentPlayingSongId || null,
            playingPlaylistId: window.currentPlayingPlaylistId || null,
            currentTime: document.getElementById('main-audio-player')?.currentTime || 0,
            queue: (playbackQueue || []).slice(0, 100),
            volume: document.getElementById('volume-slider')?.value || 1
        };
        try { localStorage.setItem('heatbox_state', JSON.stringify(state)); } catch(e) {}
    }

    function loadPlayerState() {
        try {
            const saved = localStorage.getItem('heatbox_state');
            if(!saved) return;
            const state = JSON.parse(saved);

            if (state.volume !== undefined) {
                const volSlider = document.getElementById('volume-slider');
                if(volSlider) { volSlider.value = state.volume; updateSliderFill(volSlider, 0, 1); }
                const audio = document.getElementById('main-audio-player');
                if(audio) audio.volume = state.volume;
            }

            if (state.currentSong) {
                window.currentSongData = state.currentSong;
                window.currentSongDuration = state.currentSong.duration; 
                
                window.currentPlayingSongId = state.playingSongId || null;
                window.currentPlayingPlaylistId = state.playingPlaylistId || null;
                if(typeof window.updateActiveHighlights === 'function') setTimeout(window.updateActiveHighlights, 100);

                const audio = document.getElementById('main-audio-player');
                if(audio) {
                    const songUrl = state.currentSong.fileUrl || state.currentSong.file_url;
                    if (songUrl) {
                        audio.src = songUrl;
                        if (state.currentTime && state.currentTime > 1) {
                            const restoreTime = state.currentTime;
                            const onCanPlay = () => {
                                audio.currentTime = restoreTime;
                                audio.removeEventListener('canplay', onCanPlay);
                            };
                            audio.addEventListener('canplay', onCanPlay);
                        }
                        audio.load();
                    }
                }
                
                const miniTitle = document.querySelector('.mini-title');
                if(miniTitle) miniTitle.innerText = state.currentSong.title;
                const miniArtist = document.querySelector('.mini-artist');
                if(miniArtist) miniArtist.innerText = state.currentSong.artist || '—';
                const mpEl = document.getElementById('mini-player');
                if(mpEl) { mpEl.style.display = 'flex'; mpEl.style.transform = 'none'; mpEl.style.opacity = '1'; }
                
                const bpTitle = document.getElementById('bp-song-name');
                const bpArtist = document.getElementById('bp-artist-name');
                if(bpTitle) bpTitle.innerText = state.currentSong.title;
                if(bpArtist) bpArtist.innerText = state.currentSong.artist;

                const bpHv = document.getElementById('bp-header-vibes');
                if (bpHv) {
                    if (_parseVibes(state.currentSong.vibes).length > 0) {
                        bpHv.innerText = _parseVibes(state.currentSong.vibes).join(' • ');
                    } else {
                        bpHv.innerText = "Aktueller Titel";
                    }
                }

                const coverUrl = state.currentSong.coverUrl || state.currentSong.cover_data;
                const bgStyle = coverUrl && coverUrl.length > 10 ? `url('${coverUrl}')` : 'none';

                const dynamicBg = document.querySelector('.dynamic-bg');
                if(dynamicBg) dynamicBg.style.backgroundImage = bgStyle;
                
                const mCover = document.querySelector('.mini-cover');
                const lCover = document.querySelector('.large-cover');
                if(mCover) { mCover.style.backgroundImage = bgStyle !== 'none' ? bgStyle : 'var(--accent)'; mCover.style.backgroundSize = 'cover'; mCover.style.backgroundPosition = 'center'; }
                if(lCover) { lCover.style.backgroundImage = bgStyle !== 'none' ? bgStyle : 'var(--accent)'; lCover.style.backgroundSize = 'cover'; lCover.style.backgroundPosition = 'center'; }

                const timeTotalEl = document.querySelector('.time-total');
                if(state.currentSong.duration && timeTotalEl) timeTotalEl.innerText = formatTime(state.currentSong.duration);
            }

            if (state.queue) playbackQueue = state.queue;
        } catch(e) {}
    }

    loadPlayerState();

    window.currentPlayingSongId = null;
    window.currentPlayingPlaylistId = null;

    window.togglePlaylistPlayback = async function(e, listId, songsArray = null) {
        if(e) e.stopPropagation();
        const audioPlayer = document.getElementById('main-audio-player');
        
        if (window.currentPlayingPlaylistId === listId) {
            if (audioPlayer.paused) { audioPlayer.play(); if(typeof updatePlayPauseIcons === 'function') updatePlayPauseIcons(true); } 
            else { window._userPausedManually = true; audioPlayer.pause(); if(typeof updatePlayPauseIcons === 'function') updatePlayPauseIcons(false); }
            window.updateActiveHighlights();
            return;
        }

        let queueToPlay = [];
        if (songsArray) {
            queueToPlay = [...songsArray];
        } else {
            const songsData = await apiGetPlaylistSongs(listId);
            queueToPlay = songsData.filter(s => s !== null);
        }

        if (!queueToPlay || queueToPlay.length === 0) return alert("Diese Liste ist leer!");

        window.currentPlayingPlaylistId = listId;
        const isShuffle = document.getElementById('btn-shuffle')?.classList.contains('ctrl-active');
        if (isShuffle) queueToPlay = queueToPlay.sort(() => 0.5 - Math.random());

        const first = queueToPlay[0];
        playbackQueue = queueToPlay.slice(1);
        
        window.playSong(first.title, first.artist, first.cover_data, first.file_url || first.fileUrl);
        savePlayerState();
    };

    window.updateActiveHighlights = function() {
        document.querySelectorAll('.song-item.playing-active, .station-card.playing-active').forEach(el => el.classList.remove('playing-active'));
        let activeVibes = null;

        if (window.currentPlayingSongId) {
            document.querySelectorAll(`.song-item[data-id="${window.currentPlayingSongId}"]`).forEach(el => {
                if (!el.querySelector('.playlist-checkbox')) el.classList.add('playing-active');
            });
            if (window.globalSongsData && window.globalSongsData.length > 0) {
                const currentSong = ( window._songIndex?.get(window.currentPlayingSongId) );
                if (currentSong && currentSong.vibes && currentSong.vibes.length > 0) {
                    activeVibes = _parseVibes(currentSong.vibes).join(' • ');
                }
            }
        }

        const bpHv = document.getElementById('bp-header-vibes');
        if (bpHv) {
            if (activeVibes) { bpHv.innerText = activeVibes; } 
            else if (window.currentSongData && window.currentSongData.vibes && window.currentSongData.vibes.length > 0) { bpHv.innerText = _parseVibes(window.currentSongData.vibes).join(' • '); } 
            else { bpHv.innerText = "Aktueller Titel"; }
        }
        
        if (window.currentPlayingPlaylistId) {
            document.querySelectorAll(`.song-item[data-id="${window.currentPlayingPlaylistId}"]`).forEach(el => {
                if (el.querySelector('.playlist-checkbox')) el.classList.add('playing-active');
            });
            document.querySelectorAll(`.station-card[data-id="${window.currentPlayingPlaylistId}"]`).forEach(el => {
                el.classList.add('playing-active');
            });
        }

        document.querySelectorAll('.cover-play-btn, .list-play-btn').forEach(btn => {
            const parentId = btn.closest('.station-card')?.dataset.id || btn.closest('.song-item')?.dataset.id;
            const audioPlayer = document.getElementById('main-audio-player');
            const isListBtn = btn.classList.contains('list-play-btn');
            const size = isListBtn ? "24" : "14"; 
            
            if (parentId === String(window.currentPlayingPlaylistId) && audioPlayer && !audioPlayer.paused) {
                btn.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
            } else {
                btn.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
            }
        });
    };

    const memAudio = document.getElementById('main-audio-player');
    if (memAudio) memAudio.addEventListener('pause', savePlayerState);
    window.addEventListener('beforeunload', savePlayerState);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            savePlayerState();
        } else {
            // iOS braucht mehrere Versuche nach dem Entsperren
            const tryResume = (attempts) => {
                if (!audioPlayer || !window._shouldBePlaying || !audioPlayer.src) return;
                if (!audioPlayer.paused) return;
                audioPlayer.play().catch(() => {
                    if (attempts > 0) setTimeout(() => tryResume(attempts - 1), 800);
                });
            };
            setTimeout(() => tryResume(4), 300);
        }
    });
    setInterval(() => { if (memAudio && !memAudio.paused && memAudio.currentTime > 0) _doSavePlayerState(); }, 5000);

    const navButtons = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');
    const navPill = document.querySelector('.nav-pill');
    // Misst die echte Bounding-Box des Buttons statt fixer CSS-Werte zu raten - sonst passt
    // die Pille nicht zu Icon+Label. Einheitlicher Rand auf allen Seiten (nicht X != Y), damit
    // die Pille sauber genormt aussieht statt oben/unten gequetscht zu wirken. --nav-h wurde
    // dafür von 49px auf 56px angehoben, sonst reicht der Platz für Icon+Label+aktives
    // Scaling(1.08) plus gleichmäßigen Rand nicht aus. Deckelung bleibt als Sicherheitsnetz.
    const NAV_PILL_PAD = 6;
    function _moveNavPill(btn) {
        if (!navPill || !btn) return;
        const bar = navPill.parentElement;
        const maxH = bar ? bar.clientHeight - NAV_PILL_PAD : Infinity;
        const h = Math.min(btn.offsetHeight + NAV_PILL_PAD * 2, maxH);
        navPill.style.width = (btn.offsetWidth + NAV_PILL_PAD * 2) + 'px';
        navPill.style.height = h + 'px';
        navPill.style.transform = `translate(${btn.offsetLeft - NAV_PILL_PAD}px, ${btn.offsetTop - (h - btn.offsetHeight) / 2}px)`;
    }
    _moveNavPill(document.querySelector('.nav-btn.active') || navButtons[0]);
    window.addEventListener('resize', () => _moveNavPill(document.querySelector('.nav-btn.active') || navButtons[0]));
    navButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            navButtons.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            _moveNavPill(e.currentTarget);
            const targetId = e.currentTarget.getAttribute('data-target');
            window.currentOpenPlaylistId = null; 
            if (targetId === 'view-settings' && typeof window.updateAppStats === 'function') window.updateAppStats();
            views.forEach(view => {
                if (view.id === targetId) {
                    view.classList.remove('hidden');
                    setTimeout(() => view.classList.add('active'), 10);
                } else {
                    view.classList.remove('active');
                    view.classList.add('hidden');
                }
            });
        });
    });

    const audioPlayer = document.getElementById('main-audio-player');
    const playPauseBtns = [document.querySelector('#mini-player .mini-play-icon'), document.querySelector('.play-large'), document.getElementById('home-np-playpause')];
    const timeCurrentEl = document.querySelector('.time-current');
    const timeTotalEl = document.querySelector('.time-total');
    const progressBar = document.querySelector('.time-progress');
    const progressContainer = document.querySelector('.time-bg');

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    window.updatePlayPauseIcons = function(isPlaying) {
        const pauseSvg = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
        const playSvg = `<path d="M8 5v14l11-7z"/>`;
        playPauseBtns.forEach(btn => { 
            if(btn) {
                if (btn.tagName.toLowerCase() === 'svg') btn.innerHTML = isPlaying ? pauseSvg : playSvg;
                else if (btn.querySelector('svg')) btn.querySelector('svg').innerHTML = isPlaying ? pauseSvg : playSvg;
            } 
        });
        if(typeof window.updateActiveHighlights === 'function') window.updateActiveHighlights(); 
    };

    window.togglePlayPause = async function(e) {
        if(e) e.stopPropagation();
        if(!audioPlayer.src) return;
        if (audioPlayer.paused) {
            window._userPausedManually = false;
            window._shouldBePlaying = true;
            try { await audioPlayer.play(); } catch(err){}
        } else {
            window._userPausedManually = true;
            window._shouldBePlaying = false;
            audioPlayer.pause();
        }
    };
    playPauseBtns.forEach(btn => { if(btn) btn.addEventListener('click', window.togglePlayPause); });

    audioPlayer.addEventListener('play', () => {
        window._shouldBePlaying = true;
        window._userPausedManually = false;
        window.updatePlayPauseIcons(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "playing";
    });

    audioPlayer.addEventListener('pause', () => {
        // Nur als "gewollt pausiert" markieren wenn der User es selbst getan hat.
        // iOS pausiert den Player beim Sperren des Bildschirms unfreiwillig —
        // in diesem Fall bleibt _shouldBePlaying true damit die Recovery greift.
        if (window._userPausedManually) {
            window._shouldBePlaying = false;
        }
        window.updatePlayPauseIcons(false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "paused";
    });

    function _tryRecoverPlayback() {
        setTimeout(() => {
            if (audioPlayer.paused && window._shouldBePlaying && audioPlayer.networkState !== 3) {
                audioPlayer.play().catch(() => {});
            }
        }, 2000);
    }
    audioPlayer.addEventListener('stalled', _tryRecoverPlayback);
    audioPlayer.addEventListener('waiting', _tryRecoverPlayback);

    const HB_DB_NAME = 'HeatBoxAudio';
    const HB_STORE   = 'audioFiles';
    let   _hbDb      = null;

    function openHBDatabase() {
        return new Promise((resolve, reject) => {
            if (_hbDb) { resolve(_hbDb); return; }
            const req = indexedDB.open(HB_DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(HB_STORE)) db.createObjectStore(HB_STORE, { keyPath: 'fileUrl' });
            };
            req.onsuccess = (e) => { _hbDb = e.target.result; resolve(_hbDb); };
            req.onerror   = () => reject(req.error);
        });
    }

    async function getLocalAudio(fileUrl) {
        try {
            const db  = await openHBDatabase();
            const tx  = db.transaction(HB_STORE, 'readonly');
            return new Promise((resolve) => {
                const req = tx.objectStore(HB_STORE).get(fileUrl);
                req.onsuccess = () => resolve(req.result?.blob ? URL.createObjectURL(req.result.blob) : null);
                req.onerror   = () => resolve(null);
            });
        } catch(e) { return null; }
    }

    async function saveLocalAudio(fileUrl, blob) {
        try {
            const db  = await openHBDatabase();
            const tx  = db.transaction(HB_STORE, 'readwrite');
            tx.objectStore(HB_STORE).put({ fileUrl, blob, savedAt: Date.now() });
        } catch(e) {}
    }

    async function isLocalAudio(fileUrl) {
        try {
            const db = await openHBDatabase();
            const tx = db.transaction(HB_STORE, 'readonly');
            return new Promise((resolve) => {
                const req = tx.objectStore(HB_STORE).count(fileUrl);
                req.onsuccess = () => resolve(req.result > 0);
                req.onerror   = () => resolve(false);
            });
        } catch(e) { return false; }
    }

    async function getAllLocalUrls() {
        try {
            const db = await openHBDatabase();
            const tx = db.transaction(HB_STORE, 'readonly');
            return new Promise((resolve) => {
                const req = tx.objectStore(HB_STORE).getAllKeys();
                req.onsuccess = () => resolve(new Set(req.result));
                req.onerror   = () => resolve(new Set());
            });
        } catch(e) { return new Set(); }
    }

    async function downloadToLocal(fileUrl, title) {
        try {
            if (await isLocalAudio(fileUrl)) return;
            const resp = await fetch(fileUrl);
            if (!resp.ok) return;
            const blob = await resp.blob();
            await saveLocalAudio(fileUrl, blob);
            const song = window.globalSongsData.find(s => s.file_url === fileUrl);
            if (song) {
                document.querySelectorAll(`.song-item[data-id="${song.id}"] .offline-badge`).forEach(b => b.style.display = 'inline');
            }
        } catch(e) {}
    }

let _bgCacheActive = false;
    let _bgCacheQueue = [];
    let _bgActiveCount = 0;

    function startBackgroundCacheQueue(songs) {
        const newUrls = songs.filter(s => s.file_url).map(s => s.file_url);
        const existing = new Set(_bgCacheQueue);
        newUrls.forEach(url => { if (!existing.has(url)) _bgCacheQueue.push(url); });

        if (_bgCacheActive) return;
        _bgCacheActive = true;
        // Nur 1 Spur: läuft jetzt IMMER automatisch (nicht mehr an den Offline-Schalter gekoppelt),
        // daher bewusst gedrosselt statt 3 parallel – bei 2000+ Songs sonst sofort mehrere GB
        // Bandbreite/Speicher am Stück. So tröpfelt der Download im Hintergrund über längere Zeit.
        const IDLE_PARALLEL = 1;

        async function processNext() {
            if (_bgCacheQueue.length === 0) {
                if (_bgActiveCount === 0) _bgCacheActive = false;
                return;
            }
            if (_bgActiveCount >= IDLE_PARALLEL) return;

            const player = document.getElementById('main-audio-player');
            if (player && !player.paused) { 
                setTimeout(processNext, 3000); 
                return; 
            }

            _bgActiveCount++;
            const url = _bgCacheQueue.shift();
            
            await downloadToLocal(url, '').catch(() => {});
            
            _bgActiveCount--;
            // Sobald fertig, sofort den nächsten starten:
            setTimeout(processNext, 100); 
        }

        setTimeout(() => {
            // Alle Spuren gleichzeitig anwerfen
            for(let i=0; i<IDLE_PARALLEL; i++) processNext();
        }, 5000);
    }

    async function clearLocalAudio() {
        try {
            const db = await openHBDatabase();
            db.transaction(HB_STORE, 'readwrite').objectStore(HB_STORE).clear();
        } catch(e) {}
    }

    async function getLocalStorageInfo() {
        try {
            if (navigator.storage?.estimate) {
                const est = await navigator.storage.estimate();
                return { usedMB: Math.round((est.usage || 0) / 1024 / 1024), quotaMB: Math.round((est.quota || 0) / 1024 / 1024) };
            }
        } catch(e) {}
        return { usedMB: 0, quotaMB: 0 };
    }

    setTimeout(async () => {
        const localUrls = await getAllLocalUrls();
        if (localUrls.size === 0) return;
        document.querySelectorAll('.song-item').forEach(el => {
            const song = window._songIndex?.get(parseInt(el.dataset.id));
            if (song && localUrls.has(song.file_url)) {
                const badge = el.querySelector('.offline-badge');
                if (badge) badge.style.display = 'inline';
            }
        });
        const offlineBtn = document.getElementById('btn-offline-mode');
        if (offlineBtn) {
            const label = document.getElementById('offline-btn-label');
            offlineBtn.style.setProperty('background', 'rgba(48,209,88,0.18)', 'important');
            offlineBtn.style.setProperty('border-color', '#30d158', 'important');
            offlineBtn.style.setProperty('color', '#30d158', 'important');
            const validOfflineCount = window.globalSongsData ? window.globalSongsData.filter(s => s.file_url && localUrls.has(s.file_url)).length : localUrls.size;
            if (label) label.textContent = `${validOfflineCount} Songs offline ✓`;
        }
    }, 1500);

    window.hbLocal = { clearLocalAudio, getLocalStorageInfo, getAllLocalUrls, downloadToLocal };

    let _skipNextHistoryPush = false;
    window.playSong = function(title, artist, coverUrl, fileUrl) {
        if (!audioPlayer) return;
        const _oldSongData = window.currentSongData;
        if (!_skipNextHistoryPush && _oldSongData && _oldSongData.fileUrl && _oldSongData.fileUrl !== fileUrl) {
            if (playbackHistory.length === 0 || playbackHistory[playbackHistory.length - 1]?.fileUrl !== _oldSongData.fileUrl) {
                playbackHistory.push(_oldSongData);
            }
            if (playbackHistory.length > 100) playbackHistory.shift();
        }
        _skipNextHistoryPush = false; 

        let foundSong = window.globalSongsData.find(s => s.file_url === fileUrl) || window.globalSongsData.find(s => s.title === title && s.artist === artist);
        window.currentPlayingSongId = foundSong ? foundSong.id : null;
        window.currentSongDuration = foundSong ? foundSong.duration : 0;
        
        window.currentSongData = { id: window.currentPlayingSongId, title, artist, coverUrl, fileUrl, duration: window.currentSongDuration, vibes: _parseVibes(foundSong?.vibes) };
        audioPlayer.src = fileUrl;
        
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', async () => {
                if (audioPlayer.src && audioPlayer.src !== window.location.href) { try { await audioPlayer.play(); } catch(err) {} } 
                else if (window.currentSongData) { const s = window.currentSongData; window.playSong(s.title, s.artist, s.cover_data || s.coverUrl, s.file_url || s.fileUrl); }
            });
            navigator.mediaSession.setActionHandler('pause', () => { window._userPausedManually = true; audioPlayer.pause(); });
            navigator.mediaSession.setActionHandler('previoustrack', () => window.playPrevSong());
            navigator.mediaSession.setActionHandler('nexttrack', () => window.playNextSong());
            try { navigator.mediaSession.setActionHandler('seekforward', null); } catch(e) {}
            try { navigator.mediaSession.setActionHandler('seekbackward', null); } catch(e) {}
            try { navigator.mediaSession.setActionHandler('seekto', (details) => { if (details.fastSeek && 'fastSeek' in audioPlayer) { audioPlayer.fastSeek(details.seekTime); } else { audioPlayer.currentTime = details.seekTime; } }); } catch(e) {}
            
            navigator.mediaSession.metadata = new MediaMetadata({ title: title || 'Unbekannter Song', artist: artist || 'Unbekannter Künstler', album: 'Himusic Cloud' });
            (async () => {
                let artworkSrc = null;
                if (coverUrl && coverUrl.startsWith('http')) { artworkSrc = coverUrl; } 
                else if (coverUrl && coverUrl.startsWith('data:')) {
                    try {
                        if (window._lastCoverBlobUrl) { URL.revokeObjectURL(window._lastCoverBlobUrl); window._lastCoverBlobUrl = null; }
                        const [header, b64] = coverUrl.split(',');
                        const mime = header.match(/:(.*?);/)[1];
                        const bytes = atob(b64);
                        const arr = new Uint8Array(bytes.length);
                        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                        artworkSrc = URL.createObjectURL(new Blob([arr], { type: mime }));
                        window._lastCoverBlobUrl = artworkSrc;
                    } catch(e) {}
                }
                if (artworkSrc) { navigator.mediaSession.metadata = new MediaMetadata({ title: title || 'Unbekannter Song', artist: artist || 'Unbekannter Künstler', album: 'Himusic Cloud', artwork: [ { src: artworkSrc, sizes: '512x512', type: 'image/jpeg' }, { src: artworkSrc, sizes: '192x192', type: 'image/jpeg' } ] }); }
            })();
        }

        let playPromise = audioPlayer.play();
        getLocalAudio(fileUrl).then(localUrl => {
            if (localUrl) {
                if (!audioPlayer.paused) {
                    const t = audioPlayer.currentTime;
                    audioPlayer.src = localUrl;
                    audioPlayer.load();
                    audioPlayer.addEventListener('canplay', function swap() { audioPlayer.currentTime = t; audioPlayer.play().catch(() => {}); audioPlayer.removeEventListener('canplay', swap); });
                } else { audioPlayer.src = localUrl; audioPlayer.load(); }
            } else if (localStorage.getItem('himusic_offline') === '1') {
                // Nur im Offline-Modus im Hintergrund cachen. Sonst lud jeder gespielte Song
                // parallel komplett herunter und konkurrierte mit dem Streaming um Bandbreite →
                // Ursache fürs Stocken/Einschlafen. Ohne Offline-Modus wird jetzt nur gestreamt.
                downloadToLocal(fileUrl, title);
            }
        });

        if (playPromise === undefined) playPromise = Promise.resolve();
        if (playPromise !== undefined) { playPromise.then(() => { window.updatePlayPauseIcons(true); }).catch(e => console.log("iOS Play blockiert", e)); }

        const mp = document.getElementById('mini-player');
        if(mp) { mp.style.display = 'flex'; setTimeout(() => { mp.style.transform = 'none'; mp.style.opacity = '1'; }, 10); }

        const bgStyle = coverUrl && coverUrl.length > 10 ? `url('${coverUrl}')` : 'none';
        const dynamicBg = document.querySelector('.dynamic-bg');
        if(dynamicBg) dynamicBg.style.backgroundImage = bgStyle;
        const miniCover = document.querySelector('.mini-cover');
        const miniTitle = document.querySelector('.mini-title');
        const miniArtist = document.querySelector('.mini-artist');
        if(miniCover) { miniCover.style.backgroundImage = bgStyle !== 'none' ? bgStyle : 'var(--accent)'; miniCover.style.backgroundSize = 'cover'; }
        if(miniTitle) miniTitle.innerText = title;
        if(miniArtist) miniArtist.innerText = artist || '—';

        const bpTitle = document.getElementById('bp-song-name');
        const bpArtist = document.getElementById('bp-artist-name');
        const largeCover = document.querySelector('.large-cover');
        const bpHv = document.getElementById('bp-header-vibes');
        
        if(bpTitle) bpTitle.innerText = title;
        if(bpArtist) bpArtist.innerText = artist;
        if(largeCover) { largeCover.style.backgroundImage = bgStyle !== 'none' ? bgStyle : 'var(--accent)'; largeCover.style.backgroundSize = 'cover'; }
        if(bpHv) bpHv.innerText = window.currentSongData.vibes?.join(' • ') || "Aktueller Titel";
        const bpNoVibesDot = document.getElementById('bp-no-vibes-dot');
        if (bpNoVibesDot) bpNoVibesDot.style.display = (window.currentSongData.vibes && window.currentSongData.vibes.length > 0) ? 'none' : 'block';

        const homeNpCover = document.getElementById('home-np-cover');
        const homeNpTitle = document.getElementById('home-np-title');
        const homeNpArtist = document.getElementById('home-np-artist');
        const homeNowPlayingSection = document.getElementById('home-now-playing-section');
        if(homeNowPlayingSection) homeNowPlayingSection.style.display = 'block';
        if(homeNpCover) homeNpCover.style.backgroundImage = bgStyle !== 'none' ? bgStyle : 'var(--accent)';
        if(homeNpTitle) homeNpTitle.innerText = title;
        if(homeNpArtist) homeNpArtist.innerText = artist;

        if(typeof window.updateActiveHighlights === 'function') window.updateActiveHighlights();
        savePlayerState();
    };

    let isChangingSong = false; 
    window.playNextSong = function() {
        if (isChangingSong) return; 
        isChangingSong = true;
        setTimeout(() => isChangingSong = false, 800);
        if (!playbackQueue || playbackQueue.length === 0) {
            if (window.globalSongsData && window.globalSongsData.length > 0) { playbackQueue = [...window.globalSongsData].sort(() => 0.5 - Math.random()); } else return;
        }
        const nextSong = playbackQueue.shift();
        window.currentContextSongId = nextSong.id || window.currentContextSongId;
        window.playSong(nextSong.title, nextSong.artist, nextSong.cover_data || nextSong.coverUrl, nextSong.file_url || nextSong.fileUrl);
    };

    let _lastPrevTap = 0;
    window.playPrevSong = function() {
        if (isChangingSong) return;
        const now = Date.now();
        const isDoubleTap = (now - _lastPrevTap) < 600;
        _lastPrevTap = now;
        if (isDoubleTap) {
            isChangingSong = true;
            setTimeout(() => isChangingSong = false, 800);
            if (playbackHistory && playbackHistory.length > 0) {
                const prevSong = playbackHistory.pop();
                if (window.currentSongData) playbackQueue.unshift(window.currentSongData);
                window.currentContextSongId = prevSong.id || window.currentContextSongId;
                _skipNextHistoryPush = true;
                window.playSong(prevSong.title, prevSong.artist, prevSong.cover_data || prevSong.coverUrl, prevSong.file_url || prevSong.fileUrl);
            } else { audioPlayer.currentTime = 0; audioPlayer.play(); }
        } else { audioPlayer.currentTime = 0; audioPlayer.play(); }
    };

    function setupSmartSkipButton(btnId, isNext) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        let pressTimer;
        let seekInterval;
        let isLongPress = false;
        const start = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return;
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                if (audioPlayer) audioPlayer.currentTime += (isNext ? 10 : -10);
                seekInterval = setInterval(() => { if (audioPlayer) audioPlayer.currentTime += (isNext ? 10 : -10); }, 300);
            }, 400); 
        };
        const cancel = () => { clearTimeout(pressTimer); clearInterval(seekInterval); };
        btn.addEventListener('mousedown', start);
        btn.addEventListener('touchstart', start, {passive: true});
        btn.addEventListener('mouseup', cancel);
        btn.addEventListener('mouseleave', cancel);
        btn.addEventListener('touchend', cancel);
        btn.addEventListener('touchcancel', cancel);
        btn.addEventListener('click', (e) => {
            if (isLongPress) { e.preventDefault(); e.stopPropagation(); return; }
            if (isNext) window.playNextSong(); else window.playPrevSong();
        });
    }

    setupSmartSkipButton('btn-next', true);
    setupSmartSkipButton('btn-prev', false);

    audioPlayer.addEventListener('ended', () => {
        const btnRepeat = document.getElementById('btn-repeat');
        if (btnRepeat && btnRepeat.classList.contains('ctrl-active')) { audioPlayer.currentTime = 0; audioPlayer.play(); } else { window.playNextSong(); }
    });

    let isDraggingTime = false;
    function updateTimeUI(current, duration) {
        if (timeCurrentEl) timeCurrentEl.innerText = formatTime(current);
        if (duration && duration > 0) {
            if (progressBar) progressBar.style.width = ((current / duration) * 100) + '%';
            if (timeTotalEl) timeTotalEl.innerText = "-" + formatTime(duration - current);
            const miniProgressFill = document.querySelector('.mini-player-progress-fill');
            if (miniProgressFill) miniProgressFill.style.width = ((current / duration) * 100) + '%';
        }
    }

    function syncLockscreenPosition() {
        if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
            let duration = audioPlayer.duration || window.currentSongDuration;
            if (duration > 0 && !isNaN(duration)) { navigator.mediaSession.setPositionState({ duration: duration, playbackRate: audioPlayer.playbackRate || 1, position: audioPlayer.currentTime || 0 }); }
        }
    }

    audioPlayer.addEventListener('timeupdate', () => {
        if (isDraggingTime) return; 
        let duration = audioPlayer.duration || window.currentSongDuration;
        updateTimeUI(audioPlayer.currentTime || 0, duration);
    });
    audioPlayer.addEventListener('loadedmetadata', () => {
        if (audioPlayer.duration && !isNaN(audioPlayer.duration) && audioPlayer.duration !== Infinity) {
            window.currentSongDuration = audioPlayer.duration;
            updateTimeUI(0, audioPlayer.duration);
            syncLockscreenPosition();
        }
    });
    audioPlayer.addEventListener('playing', syncLockscreenPosition);
    audioPlayer.addEventListener('seeked', syncLockscreenPosition);

    if (progressContainer) {
        const handleScrub = (e) => {
            let duration = audioPlayer.duration || window.currentSongDuration;
            if (!duration) return 0;
            const rect = progressContainer.getBoundingClientRect();
            let clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : (e.changedTouches ? e.changedTouches[0].clientX : e.clientX);
            let percent = (clientX - rect.left) / rect.width;
            percent = Math.max(0, Math.min(1, percent)); 
            const newTime = percent * duration;
            updateTimeUI(newTime, duration); 
            return newTime;
        };
        progressContainer.addEventListener('touchstart', (e) => { isDraggingTime = true; handleScrub(e); }, {passive: true});
        progressContainer.addEventListener('touchmove', (e) => { if(isDraggingTime) handleScrub(e); }, {passive: true});
        progressContainer.addEventListener('touchend', (e) => { if(isDraggingTime) { isDraggingTime = false; audioPlayer.currentTime = handleScrub(e); } });
        progressContainer.addEventListener('mousedown', (e) => { isDraggingTime = true; handleScrub(e); });
        document.addEventListener('mousemove', (e) => { if (isDraggingTime) handleScrub(e); });
        document.addEventListener('mouseup', (e) => { if (isDraggingTime) { isDraggingTime = false; audioPlayer.currentTime = handleScrub(e); } });
    }

    const miniPlayer = document.getElementById('mini-player');
    const fullscreenPlayer = document.getElementById('fullscreen-player');
    const homeNowPlayingCard = document.getElementById('home-now-playing-card');
    const bpContainer = document.getElementById('fullscreen-player');

    if (miniPlayer && fullscreenPlayer) {
        miniPlayer.addEventListener('click', (e) => { if(e.target.closest('svg')) return; fullscreenPlayer.classList.add('open'); });
        let mpStartX = 0, mpStartY = 0;
        miniPlayer.addEventListener('touchstart', (e) => { mpStartX = e.touches[0].clientX; mpStartY = e.touches[0].clientY; }, {passive: true});
        miniPlayer.addEventListener('touchend', (e) => {
            if(!mpStartX || !mpStartY) return;
            let diffX = mpStartX - e.changedTouches[0].clientX;
            let diffY = e.changedTouches[0].clientY - mpStartY;
            if(diffY > 40 || diffX > 40) {
                window._userPausedManually = true; 
                audioPlayer.pause();
                window.updatePlayPauseIcons(false);
                miniPlayer.style.transform = 'translateY(150%)';
                miniPlayer.style.opacity = '0';
                setTimeout(() => { miniPlayer.style.display = 'none'; }, 300);
            }
            mpStartX = 0; mpStartY = 0;
        });
    }

    if (homeNowPlayingCard && fullscreenPlayer) homeNowPlayingCard.addEventListener('click', () => fullscreenPlayer.classList.add('open'));
    document.getElementById('close-player')?.addEventListener('click', () => fullscreenPlayer.classList.remove('open'));

    let bpStartX = 0, bpStartY = 0;
    if (bpContainer) {
        bpContainer.addEventListener('touchstart', (e) => { bpStartX = e.touches[0].clientX; bpStartY = e.touches[0].clientY; }, {passive: true});
        bpContainer.addEventListener('touchend', (e) => {
            if (!bpStartX || !bpStartY) return;
            let diffX = bpStartX - e.changedTouches[0].clientX;
            let diffY = bpStartY - e.changedTouches[0].clientY;
            if (Math.abs(diffX) > Math.abs(diffY)) { if (Math.abs(diffX) > 60) { if (diffX > 0) window.playNextSong(); else window.playPrevSong(); } } 
            else { if (diffY < -60 && bpStartY < window.innerHeight / 2) { document.getElementById('close-player')?.click(); } }
            bpStartX = 0; bpStartY = 0;
        });
    }

    const LAZY_BATCH = 60;
    let lazyAllSongs  = [];
    let lazyRendered  = 0;
    let lazySentinel  = null;
    let _currentFilteredSongs = null; 
    let _existingPlaylistIds = new Set(); 
    
    function _countAvailableSelectedSongs() {
        let count = 0;
        selectedSongs.forEach(songId => { if (!_existingPlaylistIds.has(String(songId))) { count++; } });
        return count;
    }
    
    let lazyObserver  = null;

    function lazyRenderBatch() {
        const end = Math.min(lazyRendered + LAZY_BATCH, lazyAllSongs.length);
        if (lazyRendered >= end) return;
        const frag = document.createDocumentFragment();
        for (let i = lazyRendered; i < end; i++) {
            const song = lazyAllSongs[i];
            const div = document.createElement('div');
            div.className = 'song-item';
            div.dataset.id = song.id;
            updateSongDOM(div, song);
            if (_existingPlaylistIds.has(String(song.id))) div.classList.add('disabled-song');
            frag.appendChild(div);
            allSongsElements.push(div);
        }
        if (lazySentinel && lazySentinel.parentNode) lazySentinel.remove();
        songsContainer.appendChild(frag);
        lazyRendered = end;

        if (lazyRendered < lazyAllSongs.length) {
            lazySentinel = document.createElement('div');
            lazySentinel.style.height = '1px';
            songsContainer.appendChild(lazySentinel);
            if (lazyObserver) lazyObserver.disconnect();
            lazyObserver = new IntersectionObserver(entries => { if (entries[0].isIntersecting) lazyRenderBatch(); }, { rootMargin: '500px' });
            lazyObserver.observe(lazySentinel);
        } else {
            if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
        }
        if (typeof window.updateActiveHighlights === 'function') window.updateActiveHighlights();
    }

    function rerenderSongsList(songsArr) {
        if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
        allSongsElements = [];
        lazyRendered = 0;
        lazyAllSongs = songsArr;
        songsContainer.innerHTML = '';
        if (!songsArr.length) {
            songsContainer.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-secondary);">Keine Songs gefunden. Importiere jetzt Musik!</div>';
            return;
        }
        lazyRenderBatch();
        if (typeof window.updateAppStats === 'function') window.updateAppStats();
    }

    // ─── Songs-Scrollbar ─────────────────────────────────────────────────────
    // Schlichter, ziehbarer Scrollbar-Griff statt eines Buchstaben-Index (User
    // wollte explizit KEINE Nav-/Sprungleiste, sondern eine normale Scrollbar,
    // die die Position in der Liste zeigt und zum schnellen Scrollen gezogen
    // werden kann).
    const songsScrollTrack = document.getElementById('songs-scrollbar');
    const songsScrollThumb = document.getElementById('songs-scrollbar-thumb');
    const songsScrollView = document.getElementById('view-songs');

    if (songsScrollTrack && songsScrollThumb && songsScrollView) {
        const MIN_THUMB = 30;
        let hideTimer = null;
        let dragging = false;

        function updateThumb() {
            const trackH = songsScrollTrack.clientHeight;
            const contentH = songsScrollView.scrollHeight;
            const visibleH = songsScrollView.clientHeight;
            if (contentH <= visibleH) { songsScrollThumb.classList.remove('visible'); return; }
            const thumbH = Math.max(MIN_THUMB, trackH * (visibleH / contentH));
            const maxThumbTop = trackH - thumbH;
            const scrollRatio = songsScrollView.scrollTop / (contentH - visibleH);
            songsScrollThumb.style.height = thumbH + 'px';
            songsScrollThumb.style.top = (maxThumbTop * scrollRatio) + 'px';
        }

        function showThumb() {
            songsScrollThumb.classList.add('visible');
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { if (!dragging) songsScrollThumb.classList.remove('visible'); }, 900);
        }

        songsScrollView.addEventListener('scroll', () => { updateThumb(); showThumb(); }, { passive: true });

        function _thumbYToScrollTop(clientY) {
            const rect = songsScrollTrack.getBoundingClientRect();
            const trackH = rect.height;
            const contentH = songsScrollView.scrollHeight;
            const visibleH = songsScrollView.clientHeight;
            const thumbH = Math.max(MIN_THUMB, trackH * (visibleH / contentH));
            const maxThumbTop = trackH - thumbH;
            const ratio = maxThumbTop > 0 ? Math.min(1, Math.max(0, (clientY - rect.top - thumbH / 2) / maxThumbTop)) : 0;
            return ratio * (contentH - visibleH);
        }

        function dragMove(e) {
            if (!dragging) return;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            // Lange Listen sind lazy gerendert – genug Batches nachladen, bis der
            // Ziel-Scrollbereich tatsächlich im DOM existiert.
            while (songsScrollView.scrollHeight - songsScrollView.clientHeight < _thumbYToScrollTop(clientY) && lazyRendered < lazyAllSongs.length) lazyRenderBatch();
            songsScrollView.scrollTop = _thumbYToScrollTop(clientY);
            updateThumb();
        }
        function dragEnd() {
            if (!dragging) return;
            dragging = false;
            songsScrollThumb.classList.remove('dragging');
            hideTimer = setTimeout(() => songsScrollThumb.classList.remove('visible'), 600);
        }
        function dragStart(e) {
            dragging = true;
            songsScrollThumb.classList.add('dragging', 'visible');
            clearTimeout(hideTimer);
            dragMove(e);
        }

        songsScrollThumb.addEventListener('touchstart', dragStart, { passive: true });
        songsScrollTrack.addEventListener('touchstart', dragStart, { passive: true });
        document.addEventListener('touchmove', dragMove, { passive: true });
        document.addEventListener('touchend', dragEnd);
        songsScrollThumb.addEventListener('mousedown', dragStart);
        songsScrollTrack.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', dragMove);
        document.addEventListener('mouseup', dragEnd);
        window.addEventListener('resize', updateThumb);
        setTimeout(updateThumb, 500);
    }

    const SONGS_CACHE_KEY = 'heatbox_songs_snapshot';
    const SONGS_CACHE_TS  = 'heatbox_songs_snapshot_ts';

    function saveSongsSnapshot(songs) {
        try { localStorage.setItem(SONGS_CACHE_KEY, JSON.stringify(songs)); localStorage.setItem(SONGS_CACHE_TS, Date.now().toString()); } 
        catch(e) {
            try {
                const slim = songs.map(s => ({ ...s, cover_data: s.cover_data?.startsWith('http') ? s.cover_data : '' }));
                localStorage.setItem(SONGS_CACHE_KEY, JSON.stringify(slim)); localStorage.setItem(SONGS_CACHE_TS, Date.now().toString());
            } catch(e2) {}
        }
    }

    function loadSongsSnapshot() { try { const raw = localStorage.getItem(SONGS_CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch(e) { return null; } }

    async function fetchSongsFromDatabase(silent = false) {
        if (!songsContainer) return;
        try {
            const all = await apiGetAllSongs();
            if (all) {
                all.forEach(s => { s.vibes = _parseVibes(s.vibes); });
                window.globalSongsData = all;
                window._songIndex = new Map(all.map(s => [s.id, s]));
                rerenderSongsList(window.globalSongsData);
                saveSongsSnapshot(all);
                // Läuft jetzt immer automatisch, nicht mehr nur bei aktivem Offline-Schalter.
                // IDLE_PARALLEL=1 + Pause während aktivem Abspielen (siehe startBackgroundCacheQueue)
                // hält das bewusst gedrosselt, damit 2000+ Songs (~14 GB) die App nicht ausbremsen.
                startBackgroundCacheQueue(all);
            }
        } catch (error) {
            const snapshot = loadSongsSnapshot();
            if (snapshot && snapshot.length > 0) {
                window.globalSongsData = snapshot;
                window._songIndex = new Map(snapshot.map(s => [s.id, s]));
                rerenderSongsList(snapshot);
                if (!silent) _showToast('⚠️ Offline – Songs aus Cache geladen', 3000);
            } else if (!silent) {
                songsContainer.innerHTML = `<div style="color:#ff3b30;text-align:center;">API-Fehler: Verbindung fehlgeschlagen.</div>`;
            }
        }
        if (typeof window.updateAppStats === 'function') window.updateAppStats();
    }
    window.fetchSongsFromDatabase = fetchSongsFromDatabase;
    fetchSongsFromDatabase();

    function updateSongDOM(songDiv, song, playlistSongId = null) {
        // Roter Punkt = Song hat noch keine Vibe-Tags gesetzt (siehe [[feedback]] Wunsch: sofort
        // erkennbar, sowohl in der Liste als auch im großen Player, verschwindet sobald Vibes da sind.
        const hasVibes = _parseVibes(song.vibes).length > 0;
        const noVibesDotHtml = hasVibes ? '' : '<span class="no-vibes-dot"></span>';
        let coverHtml = '';
        if (song.cover_data && song.cover_data.length > 10) { coverHtml = `<div class="song-cover" style="background-image: url('${song.cover_data}'); background-size: cover; background-position: center; border-radius: 6px;">${noVibesDotHtml}</div>`; }
        else { const hue = Math.floor(Math.random() * 360); coverHtml = `<div class="song-cover" style="background: hsl(${hue}, 70%, 50%); display:flex; justify-content:center; align-items:center; border-radius: 6px;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>${noVibesDotHtml}</div>`; }

        songDiv.innerHTML = `
            <div class="song-checkbox"></div>
            ${coverHtml}
            <div class="song-info">
                <div class="song-title">${_esc(song.title)}</div>
                <div class="song-artist">${_esc(song.artist)}</div>
            </div>
            <div class="drag-handle">≡</div>
            <button class="song-context-btn icon-btn" style="margin-left: auto; padding: 10px; color: var(--text-secondary);">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.5"></circle><circle cx="12" cy="12" r="2.5"></circle><circle cx="12" cy="19" r="2.5"></circle></svg>
            </button>
            <span class="offline-badge" style="display:none;font-size:9px;color:#30d158;font-weight:700;flex-shrink:0;padding:2px 4px;border:1px solid #30d158;border-radius:5px;margin-left:2px;">✓</span>
        `;

        const coverEl = songDiv.querySelector('.song-cover');
        addLongPressListener(coverEl, (e) => { e.preventDefault(); e.stopPropagation(); window.currentContextSongId = song.id; document.getElementById('ctx-edit-tags').click(); });

        if (playlistSongId) songDiv.dataset.psId = playlistSongId;

        let songStartX = 0; let isSwiping = false; let queueArmed = false;
        songDiv.addEventListener('touchstart', (e) => { songStartX = e.touches[0].clientX; isSwiping = false; queueArmed = false; }, {passive: true});
        songDiv.addEventListener('touchmove', (e) => {
            if (!songStartX) return;
            const diffX = songStartX - e.touches[0].clientX;
            if (Math.abs(diffX) > 20) isSwiping = true;
            // Rechts-Swipe (diffX < 0) über der Aktions-Schwelle: genau JETZT vibrieren, wie bei
            // Spotify – nicht erst beim Loslassen. Zieht der Finger wieder zurück, wird scharf
            // gestellt für einen erneuten Tick, falls die Schwelle nochmal überschritten wird.
            if (diffX < -60 && !queueArmed) { queueArmed = true; _hapticTick(); songDiv.classList.add('song-item-armed'); }
            else if (diffX >= -60 && queueArmed) { queueArmed = false; songDiv.classList.remove('song-item-armed'); }
        }, {passive: true});
        songDiv.addEventListener('touchend', (e) => {
            songDiv.classList.remove('song-item-armed');
            if (!songStartX || !isSwiping) return;
            let diffX = songStartX - e.changedTouches[0].clientX;
            if (Math.abs(diffX) > 60) {
                if (diffX < 0) {
                    playbackQueue.unshift(song); savePlayerState();
                    songDiv.classList.remove('song-item-added'); void songDiv.offsetWidth; // Reflow: Animation erneut abspielbar machen
                    songDiv.classList.add('song-item-added');
                    setTimeout(() => songDiv.classList.remove('song-item-added'), 400);
                } else {
                    const titleDiv = songDiv.querySelector('.song-title');
                    const vibesText = song.vibes && song.vibes.length > 0 ? _parseVibes(song.vibes).join(' • ') : 'Keine Vibes';
                    if (!titleDiv.dataset.originalTitle) { titleDiv.dataset.originalTitle = titleDiv.innerText; titleDiv.innerHTML = `${titleDiv.dataset.originalTitle} <span style="color: var(--accent); font-size: 11px; margin-left: 8px; font-weight: 500; border: 1px solid var(--accent); padding: 1px 6px; border-radius: 10px;">${vibesText}</span>`; } 
                    else { titleDiv.innerText = titleDiv.dataset.originalTitle; delete titleDiv.dataset.originalTitle; }
                }
            }
            songStartX = 0; setTimeout(() => isSwiping = false, 50); 
        });

        songDiv.addEventListener('click', (e) => {
            if (isSwiping) { e.preventDefault(); e.stopPropagation(); return; }
            if (songDiv.classList.contains('disabled-song')) return;
            if (e.target.closest('.song-context-btn')) {
                e.stopPropagation(); window.currentContextSongId = song.id; 
                if (window.currentOpenPlaylistId) { document.getElementById('ctx-delete').style.display = 'none'; document.getElementById('ctx-remove-from-playlist').style.display = 'flex'; } 
                else { document.getElementById('ctx-delete').style.display = 'flex'; document.getElementById('ctx-remove-from-playlist').style.display = 'none'; }
                if(songContextOverlay) songContextOverlay.classList.add('active');
                return;
            }
            if (currentMode !== 'normal' && currentMode !== 'reorder') {
                const checkbox = songDiv.querySelector('.song-checkbox');
                if (checkbox.classList.toggle('checked')) selectedSongs.add(String(song.id)); else selectedSongs.delete(String(song.id));
                const selCount = document.getElementById('sel-count'); const count = _countAvailableSelectedSongs(); if(selCount) selCount.innerText = `${count} ausgewählt`;
            } else if (currentMode === 'normal') {
                window.currentPlayingPlaylistId = window.currentOpenPlaylistId || null; 
                window.playSong(song.title, song.artist, song.cover_data, song.file_url);
                if (window.currentOpenPlaylistId && window.currentPlaylistSongs) {
                    const songIndex = window.currentPlaylistSongs.findIndex(s => s.id === song.id);
                    if (songIndex > -1) { playbackQueue = window.currentPlaylistSongs.slice(songIndex + 1); }
                } else if (window.globalSongsData && window.globalSongsData.length > 0) {
                    const otherSongs = window.globalSongsData.filter(s => s.id !== song.id);
                    playbackQueue = otherSongs.sort(() => 0.5 - Math.random());
                }
                savePlayerState(); 
            }
        });
    }

    const btnAddSongs = document.getElementById('btn-add-songs');
    const fileUploadInput = document.getElementById('native-file-upload');
    const jsmediatags = window.jsmediatags;

const UPLOAD_CONFIG = { PARALLEL_UPLOADS: 4, MAX_RETRIES: 3, WORKER_URL: `${API_URL}/upload`, ITUNES_TIMEOUT: 4000 };    let _uploadQueue = []; let _uploadRunning = false; let _uploadStats = { total: 0, success: 0, failed: 0, skipped: 0 }; let _inFlightKeys = new Set();

    async function _uploadSingleFile(file, retryCount = 0) {
        try {
            const fallbackName = file.name.replace(/\.[^/.]+$/, '');
            let title = fallbackName; let artist = 'Unbekannter Künstler';
            try {
                const tags = await new Promise((resolve, reject) => { jsmediatags.read(file, { onSuccess: (t) => resolve(t.tags), onError: reject }); });
                if (tags.title) title = tags.title.trim(); if (tags.artist) artist = tags.artist.trim();
            } catch (e) { }
const titleNorm = title.toLowerCase().trim();
            const artistNorm = artist.toLowerCase().trim();

            const isDup = window.globalSongsData.some(s => {
                const sTitle = (s.title || '').toLowerCase().trim();
                const sArtist = (s.artist || '').toLowerCase().trim();
                // Datei ist nur ein Duplikat, wenn Bytegröße UND Titel exakt stimmen
                return (s.file_size === file.size && sTitle === titleNorm) || 
                       (sTitle === titleNorm && sArtist === artistNorm && sArtist !== 'unbekannter künstler' && s.file_size === file.size);
            });

            if (isDup) { _uploadStats.skipped++; return { success: false, skipped: true }; }
            const safeFileName = `${Date.now()}_${Math.random().toString(36).substr(2, 5)}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
            const uploadResponse = await fetch(`${UPLOAD_CONFIG.WORKER_URL}/${safeFileName}`, { method: 'PUT', body: file, signal: AbortSignal.timeout(60000) });
            if (!uploadResponse.ok) throw new Error(`HTTP ${uploadResponse.status}`);
            const fileUrl = (await uploadResponse.json()).url;

            const fileDuration = await getDuration(file).catch(() => 0);
            let finalCoverUrl = await fetchCoverFromiTunes(title, artist);

            const created = await apiCreateSong({ title, artist, cover_data: finalCoverUrl || '', file_url: fileUrl, vibes: [], file_size: file.size, duration: fileDuration || 0 });
            if (created?.id) {
                const newSong = { ...created, vibes: [] };
                window.globalSongsData.push(newSong);
                if (window._songIndex) window._songIndex.set(created.id, newSong);
            }
            _uploadStats.success++; return { success: true };
        } catch (err) {
            if (retryCount < UPLOAD_CONFIG.MAX_RETRIES) { await new Promise(resolve => setTimeout(resolve, 1000)); return _uploadSingleFile(file, retryCount + 1); }
            _uploadStats.failed++; return { success: false, error: err.message };
        }
    }
    
    async function _processUploadQueue() {
        if (_uploadRunning) return;
        _uploadRunning = true; _uploadStats = { total: _uploadQueue.length, success: 0, failed: 0, skipped: 0 };
        try {
            while (_uploadQueue.length > 0) {
                const batch = _uploadQueue.splice(0, UPLOAD_CONFIG.PARALLEL_UPLOADS);
                const processed = _uploadStats.success + _uploadStats.failed + _uploadStats.skipped;
                if (btnAddSongs) btnAddSongs.innerHTML = `⏳ ${processed}/${_uploadStats.total} | noch ${_uploadQueue.length}...`;
                await Promise.all(batch.map(file => _uploadSingleFile(file)));
            }
            try { await fetchSongsFromDatabase(); } catch(e) {}
            const summary = `✅ ${_uploadStats.success} importiert | ⏭️ ${_uploadStats.skipped} übersprungen | ❌ ${_uploadStats.failed} Fehler`;
            if (typeof _showToast === 'function') _showToast(summary, 4000);
        } catch(err) {
            if (typeof _showToast === 'function') _showToast('❌ Import-Fehler – bitte erneut versuchen');
        } finally {
            _uploadRunning = false; _inFlightKeys.clear(); 
            if (btnAddSongs) { btnAddSongs.innerHTML = 'Musik importieren'; btnAddSongs.disabled = false; }
            if (fileUploadInput) fileUploadInput.value = '';
        }
    }

    if (btnAddSongs && fileUploadInput) {
        btnAddSongs.addEventListener('click', () => { fileUploadInput.value = ''; fileUploadInput.click(); });
        fileUploadInput.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;
            _uploadQueue.push(...files);
            btnAddSongs.disabled = true; btnAddSongs.innerHTML = `⏳ ${_uploadQueue.length} Songs in Queue...`;
            if (!_uploadRunning) _processUploadQueue();
        });
    }

    document.getElementById('action-find-missing')?.addEventListener('click', () => { actionSheetOverlay.classList.remove('active'); setTimeout(() => document.getElementById('missing-songs-input')?.click(), 300); });
    document.getElementById('missing-songs-input')?.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        const overlay = document.getElementById('missing-songs-overlay');
        const listEl = document.getElementById('missing-songs-list');
        const titleEl = document.getElementById('missing-songs-title');
        const uploadAllBtn = document.getElementById('missing-songs-upload-all');

        overlay.classList.add('active'); overlay.style.display = '';
        listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);">⏳ Vergleiche...</div>';
        titleEl.innerText = 'Analysiere...'; uploadAllBtn.style.display = 'none';

        const knownSizes = new Set(window.globalSongsData.map(s => s.file_size).filter(Boolean));
        const missing = files.filter(f => !knownSizes.has(f.size));

        titleEl.innerText = `${missing.length} fehlende Songs (von ${files.length})`;

        if (missing.length === 0) { listEl.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#30d158;">✅ Alle Songs sind bereits hochgeladen!</div>'; e.target.value = ''; return; }

        listEl.innerHTML = '';
        missing.forEach((file, idx) => {
            const name = file.name.replace(/\.[^/.]+$/, '');
            const sizeMB = (file.size / 1024 / 1024).toFixed(1);
            const div = document.createElement('div');
            div.style.cssText = 'display:flex;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);gap:12px;';
            div.innerHTML = `<div style="width:36px;height:36px;border-radius:8px;background:rgba(255,159,10,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff9f0a" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div><div style="font-size:12px;color:var(--text-secondary);">${sizeMB} MB</div></div>`;
            listEl.appendChild(div);
        });

        uploadAllBtn.style.display = 'block';
        uploadAllBtn.onclick = async () => {
            uploadAllBtn.disabled = true; uploadAllBtn.innerText = '⏳ Lädt hoch...';
            let uploaded = 0;
            for (const file of missing) {
                uploadAllBtn.innerText = `⏳ ${uploaded + 1}/${missing.length} hochladen...`;
                const fallbackName = file.name.replace(/\.[^/.]+$/, '');
                const safeFileName = `${Date.now()}_${Math.random().toString(36).substr(2,9)}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                const fileDuration = await getDuration(file);
                try {
                    const uploadResponse = await _apiFetch(`${API_URL}/upload/${safeFileName}`, { method: 'PUT', body: file });
                    if (!uploadResponse.ok) throw new Error(`Upload fehlgeschlagen`);
                    const fileUrl = (await uploadResponse.json()).url;
                    await new Promise((resolve) => {
                        jsmediatags.read(file, {
                            onSuccess: async (tag) => {
                                const tags = tag.tags; const title = tags.title?.trim() || fallbackName; const artist = tags.artist?.trim() || 'Unbekannter Künstler';
                                let finalCoverUrl = await fetchCoverFromiTunes(title, artist);
                                await apiCreateSong({ title, artist, cover_data: finalCoverUrl || '', file_url: fileUrl, vibes: [], file_size: file.size, duration: fileDuration });
                                resolve();
                            },
                            onError: async () => {
                                let finalCoverUrl = await fetchCoverFromiTunes(fallbackName, '');
                                await apiCreateSong({ title: fallbackName, artist: 'Unbekannter Künstler', cover_data: finalCoverUrl || '', file_url: fileUrl, vibes: [], file_size: file.size, duration: fileDuration });
                                resolve();
                            }
                        });
                    });
                    uploaded++;
                } catch(err) { uploaded++; }
            }
            uploadAllBtn.innerText = `✅ ${uploaded} Songs hochgeladen!`;
            fetchSongsFromDatabase();
            setTimeout(() => { overlay.classList.remove('active'); e.target.value = ''; }, 2000);
        };
        e.target.value = '';
    });
    document.getElementById('missing-songs-close')?.addEventListener('click', () => { document.getElementById('missing-songs-overlay').classList.remove('active'); });

    const ctxAddQueue = document.getElementById('ctx-add-queue');
    const ctxAddPlaylist = document.getElementById('ctx-add-playlist');
    const ctxEditTags = document.getElementById('ctx-edit-tags');
    const ctxDelete = document.getElementById('ctx-delete');
    const ctxCreateStation = document.getElementById('ctx-create-station');
    const confirmOverlay = document.getElementById('confirm-dialog-overlay');

    if(ctxAddQueue) { ctxAddQueue.addEventListener('click', () => { const song = (window._songIndex?.get(window.currentContextSongId)); if (song) { playbackQueue.unshift(song); alert(`"${song.title}" spielt als nächstes.`); } songContextOverlay.classList.remove('active'); }); }
    if(ctxAddPlaylist) { ctxAddPlaylist.addEventListener('click', () => { selectedSongs.clear(); window.openPlaylistSelection(); }); }
    if(ctxDelete) { ctxDelete.addEventListener('click', () => { songContextOverlay.classList.remove('active'); selectedSongs.clear(); selectedSongs.add(String(window.currentContextSongId)); if(confirmOverlay) confirmOverlay.classList.add('active'); }); }
    const ctxRemoveFromPlaylist = document.getElementById('ctx-remove-from-playlist');
    if(ctxRemoveFromPlaylist) { ctxRemoveFromPlaylist.addEventListener('click', async () => { songContextOverlay.classList.remove('active'); try { await apiRemoveSongFromPlaylist(window.currentOpenPlaylistId, window.currentContextSongId); const el = document.querySelector(`#playlist-details-songs-container .song-item[data-id="${window.currentContextSongId}"]`); if(el) el.remove(); window.fetchPlaylistsForPage(true); } catch (error) { alert('Fehler beim Entfernen: ' + error.message); } }); }

    if(ctxCreateStation) {
        ctxCreateStation.addEventListener('click', () => {
            songContextOverlay.classList.remove('active');
            const song = (window._songIndex?.get(window.currentContextSongId));
            if (!song) return;
            const sourceVibes = song.vibes || [];
            let stationSongs = window.globalSongsData.filter(s => {
                if (s.id === song.id) return true; 
                const sVibes = s.vibes || [];
                const matchCount = sVibes.filter(v => sourceVibes.includes(v)).length;
                return matchCount >= 2;
            });
            if (stationSongs.length <= 1) {
                const randomFill = [...window.globalSongsData].sort(() => 0.5 - Math.random()).slice(0, 5);
                stationSongs = Array.from(new Set([...stationSongs, ...randomFill]));
            }
            stationSongs = stationSongs.sort(() => 0.5 - Math.random());
            const newStation = { id: 'station_' + Date.now(), name: "Sender: " + song.title, cover_data: song.cover_data, songs: stationSongs, expires: Date.now() + (24 * 60 * 60 * 1000) };
            const savedStations = JSON.parse(localStorage.getItem('heatbox_stations') || '[]');
            savedStations.unshift(newStation); localStorage.setItem('heatbox_stations', JSON.stringify(savedStations));
            if (typeof window.renderHomeSections === 'function') window.renderHomeSections();
            alert(`Sender für "${song.title}" wurde auf der Startseite erstellt!`);
        });
    }

    const editOverlay = document.getElementById('edit-tags-overlay');
    const editTitle = document.getElementById('edit-input-title');
    const editArtist = document.getElementById('edit-input-artist');
    const editCoverPreview = document.getElementById('edit-cover-preview');
    const editCoverBtn = document.getElementById('edit-cover-btn');
    const editCoverUpload = document.getElementById('edit-cover-upload');
    const editVibesContainer = document.getElementById('edit-vibes-container');
    const btnSearchItunes = document.getElementById('btn-search-itunes');
    const btnSearchSpotify = document.getElementById('btn-search-spotify');
    const btnSaveTags = document.getElementById('btn-save-tags');

    let currentEditCoverData = "";

    if(ctxEditTags) {
        ctxEditTags.addEventListener('click', () => {
            if(songContextOverlay) songContextOverlay.classList.remove('active');
            let song = (window._songIndex?.get(window.currentContextSongId)) || (window._songIndex?.get(parseInt(window.currentContextSongId)));
            if (!song && window.currentSongData && window.currentSongData.id == window.currentContextSongId) { song = window.currentSongData; }
            if (!song) { alert("Lied noch nicht vollständig geladen. Bitte kurz warten."); return; }

            // Schnappschuss auf DIESEN Song, unabhängig von window.currentContextSongId: das teilt
            // sich mit der Wiedergabe (playNextSong/playPrevSong überschreiben es beim Songwechsel),
            // sodass ein im Hintergrund weiterlaufender Song beim Speichern sonst versehentlich die
            // Änderungen des gerade bearbeiteten Songs abbekommen hätte.
            window.currentEditSongId = song.id;
            editTitle.value = song.title || ''; editArtist.value = song.artist || '';
            currentEditCoverData = song.cover_data || song.coverUrl || '';
            editCoverPreview.src = currentEditCoverData.length > 10 ? currentEditCoverData : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

            let songVibes = song.vibes || [];
            if (typeof songVibes === 'string') { try { songVibes = JSON.parse(songVibes); } catch(e) { songVibes = []; } }
            if (!Array.isArray(songVibes)) songVibes = [];
            editVibesContainer.innerHTML = '';
            AVAILABLE_VIBES.forEach(vibe => {
                const pill = document.createElement('div');
                pill.className = `vibe-pill ${songVibes.includes(vibe) ? 'active' : ''}`;
                pill.innerText = vibe; pill.dataset.vibe = vibe;
                pill.addEventListener('click', () => pill.classList.toggle('active'));
                editVibesContainer.appendChild(pill);
            });
            editOverlay.classList.add('active');
        });
    }

    if (editCoverBtn) editCoverBtn.addEventListener('click', () => editCoverUpload.click());
    if (editCoverUpload) {
        editCoverUpload.addEventListener('change', (e) => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = function(event) { currentEditCoverData = event.target.result; editCoverPreview.src = currentEditCoverData; };
            reader.readAsDataURL(file);
        });
    }

    const ITUNES_BTN_HTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>iTunes`;
    const SPOTIFY_BTN_HTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="#1DB954" style="vertical-align: middle; margin-right: 4px; margin-top: -2px;"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.32 9.719-.66 13.439 1.621.361.181.54.78.301 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.1 9.301c-.6.18-1.2-.181-1.38-.721-.18-.6.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>Spotify`;

    // Ein Treffer füllt ALLE Felder: Songname + Künstler werden in die Eingabefelder
    // geschrieben, das Cover in die Vorschau. Gesucht wird mit dem bereinigten Inhalt
    // beider Felder – egal in welchem Feld etwas steht.
    function _applyEditorMeta(meta) {
        if (!meta) return false;
        if (meta.title) editTitle.value = meta.title;
        if (meta.artist) editArtist.value = meta.artist;
        if (meta.cover) { currentEditCoverData = meta.cover; editCoverPreview.src = meta.cover; }
        return !!(meta.title || meta.artist || meta.cover);
    }

    if (btnSearchItunes) {
        btnSearchItunes.addEventListener('click', async () => {
            btnSearchItunes.innerText = "Suche...";
            const meta = await searchSongMetaItunes(editTitle.value, editArtist.value);
            btnSearchItunes.innerText = _applyEditorMeta(meta) ? "Gefunden!" : "Nichts gefunden";
            setTimeout(() => btnSearchItunes.innerHTML = ITUNES_BTN_HTML, 2000);
        });
    }

    if (btnSearchSpotify) {
        btnSearchSpotify.addEventListener('click', async () => {
            btnSearchSpotify.innerText = "Suche...";
            const meta = await searchSongMetaSpotify(editTitle.value, editArtist.value);
            if (meta && meta.rateLimited) {
                // Spotify drosselt gerade → dem Nutzer sagen, was los ist, statt "nichts gefunden"
                btnSearchSpotify.innerText = "Spotify überlastet – nutze iTunes";
                setTimeout(() => btnSearchSpotify.innerHTML = SPOTIFY_BTN_HTML, 3000);
                return;
            }
            btnSearchSpotify.innerText = _applyEditorMeta(meta) ? "Gefunden!" : "Nichts gefunden";
            setTimeout(() => btnSearchSpotify.innerHTML = SPOTIFY_BTN_HTML, 2000);
        });
    }

    function _savePendingEdit(songId, changes) {
        const pending = JSON.parse(localStorage.getItem('heatbox_pending_edits') || '[]');
        const idx = pending.findIndex(e => e.id == songId);
        const entry = { id: songId, changes, savedAt: Date.now() };
        if (idx >= 0) pending[idx] = entry; else pending.push(entry);
        localStorage.setItem('heatbox_pending_edits', JSON.stringify(pending));
    }
    async function _flushPendingEdits() {
        const pending = JSON.parse(localStorage.getItem('heatbox_pending_edits') || '[]');
        if (pending.length === 0) return;
        let flushed = 0;
        for (const entry of pending) { try { await apiUpdateSong(entry.id, entry.changes); flushed++; } catch (error) {} }
        if (flushed > 0) { localStorage.removeItem('heatbox_pending_edits'); fetchSongsFromDatabase(true); }
    }
    window.addEventListener('online', _flushPendingEdits);
    setTimeout(_flushPendingEdits, 3000);

    function _showToast(msg, duration = 3000) {
        let toast = document.getElementById('hb-toast');
        if (!toast) {
            toast = document.createElement('div'); toast.id = 'hb-toast';
            toast.style.cssText = 'position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:rgba(40,40,40,0.95);color:#fff;padding:10px 18px;border-radius:20px;font-size:14px;font-weight:500;z-index:9999;backdrop-filter:blur(10px);transition:opacity 0.3s;pointer-events:none;white-space:nowrap;';
            document.body.appendChild(toast);
        }
        toast.innerText = msg; toast.style.opacity = '1';
        clearTimeout(toast._t); toast._t = setTimeout(() => { toast.style.opacity = '0'; }, duration);
    }

    if (btnSaveTags) {
        btnSaveTags.addEventListener('click', async () => {
            btnSaveTags.innerText = "Speichere...";
            const selectedVibes = [];
            document.querySelectorAll('#edit-tags-overlay .vibe-pill.active').forEach(pill => selectedVibes.push(pill.dataset.vibe));
            const changes = { title: editTitle.value, artist: editArtist.value, cover_data: currentEditCoverData, vibes: selectedVibes };

            const song = window._songIndex?.get(window.currentEditSongId) || window._songIndex?.get(parseInt(window.currentEditSongId));
            if (song) Object.assign(song, changes);

            if (!navigator.onLine) {
                _savePendingEdit(window.currentEditSongId, changes);
                editOverlay.classList.remove('active'); btnSaveTags.innerText = "Speichern"; _showToast('✈️ Offline gespeichert – wird synchronisiert wenn online');
                return;
            }

            try {
                await apiUpdateSong(window.currentEditSongId, changes);
                editOverlay.classList.remove('active');

                const songId = window.currentEditSongId;
                const hasVibesNow = selectedVibes.length > 0;
                document.querySelectorAll(`.song-item[data-id="${songId}"] .song-cover`).forEach(c => {
                    let dot = c.querySelector('.no-vibes-dot');
                    if (hasVibesNow && dot) dot.remove();
                    else if (!hasVibesNow && !dot) { dot = document.createElement('span'); dot.className = 'no-vibes-dot'; c.appendChild(dot); }
                });
                const songElement = document.querySelector(`.song-item[data-id="${songId}"]`);
                if (songElement) {
                    const coverImg = songElement.querySelector('.song-cover img');
                    if (coverImg && changes.cover_data) coverImg.src = changes.cover_data;
                    const titleEl = songElement.querySelector('.song-title');
                    const artistEl = songElement.querySelector('.song-artist');
                    if (titleEl) titleEl.textContent = changes.title;
                    if (artistEl) artistEl.textContent = changes.artist;

                    if (window.currentPlayingSongId == songId) {
                        const bpNoVibesDot = document.getElementById('bp-no-vibes-dot');
                        if (bpNoVibesDot) bpNoVibesDot.style.display = hasVibesNow ? 'none' : 'block';
                        if (window.currentSongData) window.currentSongData.vibes = selectedVibes;
                        const playerCover = document.querySelector('#fullscreen-player .cover img');
                        if (playerCover && changes.cover_data) playerCover.src = changes.cover_data;
                        const playerTitle = document.querySelector('#fullscreen-player .song-title');
                        const playerArtist = document.querySelector('#fullscreen-player .song-artist');
                        if (playerTitle) playerTitle.textContent = changes.title;
                        if (playerArtist) playerArtist.textContent = changes.artist;
                        if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
                            navigator.mediaSession.metadata = new MediaMetadata({ title: changes.title, artist: changes.artist, album: 'HeaTBox Cloud', artwork: changes.cover_data ? [ { src: changes.cover_data, sizes: '512x512', type: 'image/jpeg' } ] : [] });
                        }
                    }
                }
                if (typeof window.updateActiveHighlights === 'function') window.updateActiveHighlights();
                fetchSongsFromDatabase(true); _showToast('✅ Gespeichert');
            } catch (error) { _savePendingEdit(window.currentEditSongId, changes); _showToast('⚠️ Fehler – lokal gesichert'); }
            btnSaveTags.innerText = "Speichern";
        });
    }

    document.getElementById('action-delete')?.addEventListener('click', () => {
        actionSheetOverlay.classList.remove('active'); currentMode = 'delete'; selectedSongs.clear();
        songsContainer.classList.add('selection-mode'); selectionToolbar.classList.remove('hidden'); setTimeout(() => selectionToolbar.classList.add('visible'), 10);
        document.getElementById('sel-action').innerText = 'Löschen'; document.getElementById('sel-action').className = 'sel-btn text-danger';
        const countEl = document.getElementById('sel-count'); if (countEl) countEl.innerText = '0 ausgewählt';
    });

    document.getElementById('action-add-playlist')?.addEventListener('click', () => {
        actionSheetOverlay.classList.remove('active'); currentMode = 'playlist'; selectedSongs.clear();
        songsContainer.classList.add('selection-mode'); selectionToolbar.classList.remove('hidden'); setTimeout(() => selectionToolbar.classList.add('visible'), 10);
        document.getElementById('sel-action').innerText = 'Hinzufügen'; document.getElementById('sel-action').className = 'sel-btn';
        const countEl = document.getElementById('sel-count'); if (countEl) countEl.innerText = '0 ausgewählt';
    });

    document.getElementById('sel-cancel')?.addEventListener('click', () => {
        currentMode = 'normal'; songsContainer.classList.remove('selection-mode'); selectionToolbar.classList.remove('visible'); setTimeout(() => selectionToolbar.classList.add('hidden'), 300);
        document.querySelectorAll('.song-checkbox').forEach(cb => cb.classList.remove('checked'));
        _existingPlaylistIds = new Set(); document.querySelectorAll('.disabled-song').forEach(el => el.classList.remove('disabled-song'));
    });

    document.getElementById('sel-all')?.addEventListener('click', () => {
        const selectableSongs = Array.from(songsContainer.querySelectorAll('.song-item:not(.disabled-song)'));
        const allSelected = selectableSongs.length > 0 && selectableSongs.every(el => selectedSongs.has(el.dataset.id));
        if (allSelected) { selectableSongs.forEach(el => { el.querySelector('.song-checkbox')?.classList.remove('checked'); selectedSongs.delete(el.dataset.id); }); if (_currentFilteredSongs) { _currentFilteredSongs.forEach(s => { if (!_existingPlaylistIds.has(String(s.id))) selectedSongs.delete(String(s.id)); }); } } 
        else { selectableSongs.forEach(el => { el.querySelector('.song-checkbox')?.classList.add('checked'); selectedSongs.add(el.dataset.id); }); const sourceList = _currentFilteredSongs || lazyAllSongs; sourceList.forEach(s => { if (!_existingPlaylistIds.has(String(s.id))) selectedSongs.add(String(s.id)); }); }
        const countEl = document.getElementById('sel-count'); const count = _countAvailableSelectedSongs(); if (countEl) countEl.innerText = `${count} ausgewählt`;
    });

    const selAction = document.getElementById('sel-action');
    if(selAction) {
        selAction.addEventListener('click', () => {
            if (selectedSongs.size === 0) return; 
            if (currentMode === 'delete' && confirmOverlay) confirmOverlay.classList.add('active'); 
            else if (currentMode === 'playlist') window.openPlaylistSelection();
            else if (currentMode === 'add-to-specific-playlist') { const targetPlaylist = window.globalPlaylistsData.find(p => p.id === window.currentContextPlaylistId); if (targetPlaylist) addSelectedSongsToPlaylist(targetPlaylist.id, targetPlaylist.name); }
        });
    }

    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', async () => {
            confirmDeleteBtn.innerText = 'Lösche...'; 
            const idsToDelete = Array.from(selectedSongs);
            try {
                await Promise.all(idsToDelete.map(id => apiDeleteSong(id)));
                allSongsElements.forEach(el => { if(idsToDelete.includes(el.dataset.id)) el.remove(); });
                const confirmOverlay = document.getElementById('confirm-dialog-overlay'); if(confirmOverlay) confirmOverlay.classList.remove('active');
                document.getElementById('sel-cancel')?.click();
            } catch (error) { alert("Fehler beim Löschen: " + error.message); }
            confirmDeleteBtn.innerText = 'Löschen';
        });
    }

    const sortOverlay = document.getElementById('sort-sheet-overlay');
    window.currentSortTarget = 'songs'; 

    document.getElementById('action-sort')?.addEventListener('click', () => { actionSheetOverlay.classList.remove('active'); sortOverlay.classList.add('active'); window.currentSortTarget = 'songs'; });

    let sortAscending = true; 
    document.getElementById('sort-asc')?.addEventListener('click', (e) => { e.target.classList.add('active'); document.getElementById('sort-desc').classList.remove('active'); sortAscending = true; });
    document.getElementById('sort-desc')?.addEventListener('click', (e) => { e.target.classList.add('active'); document.getElementById('sort-asc').classList.remove('active'); sortAscending = false; });

    document.querySelectorAll('#sort-sheet-overlay .sort-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const criteria = e.target.getAttribute('data-sort'); 
            let targetElements = []; let targetContainer = null;
            if (window.currentSortTarget === 'playlist') { targetContainer = document.getElementById('playlist-details-songs-container'); targetElements = Array.from(targetContainer.querySelectorAll('.song-item')); } 
            else { targetContainer = songsContainer; targetElements = allSongsElements; }

            if (window.currentSortTarget !== 'playlist') {
                // Die Songs-Seite ist lazy-gerendert (immer nur die ersten paar Batches stehen im
                // DOM). Vorher sortierte "Titel"/"Künstler" nur targetElements = die aktuell
                // sichtbaren DOM-Elemente – alles, was erst beim Weiterscrollen nachgeladen wurde,
                // hängte sich danach unsortiert wieder an. Sortieren muss daher auf den vollständigen
                // Rohdaten (lazyAllSongs) passieren und die Liste komplett neu rendern, wie es der
                // created_at-Zweig schon immer richtig gemacht hat.
                const sorted = [...lazyAllSongs].sort((a, b) => {
                    let valA, valB;
                    if (criteria === 'title') { valA = (a.title || '').toLowerCase(); valB = (b.title || '').toLowerCase(); }
                    else if (criteria === 'artist') { valA = (a.artist || '').toLowerCase(); valB = (b.artist || '').toLowerCase(); }
                    else { valA = parseInt(a.id); valB = parseInt(b.id); }
                    if (valA < valB) return sortAscending ? -1 : 1;
                    if (valA > valB) return sortAscending ? 1 : -1;
                    return 0;
                });
                rerenderSongsList(sorted); sortOverlay.classList.remove('active'); return;
            }

            targetElements.sort((a, b) => {
                let valA, valB;
                if (criteria === 'title') { valA = a.querySelector('.song-title').innerText.toLowerCase(); valB = b.querySelector('.song-title').innerText.toLowerCase(); } 
                else if (criteria === 'artist') { valA = a.querySelector('.song-artist').innerText.toLowerCase(); valB = b.querySelector('.song-artist').innerText.toLowerCase(); } 
                else if (criteria === 'created_at') { valA = parseInt(a.dataset.id); valB = parseInt(b.dataset.id); }
                if (valA < valB) return sortAscending ? -1 : 1;
                if (valA > valB) return sortAscending ? 1 : -1;
                return 0;
            });
            targetContainer.innerHTML = ''; targetElements.forEach(el => targetContainer.appendChild(el)); sortOverlay.classList.remove('active');
        });
    });

    const viewOverlay = document.getElementById('view-sheet-overlay');
    document.getElementById('action-view')?.addEventListener('click', () => { actionSheetOverlay.classList.remove('active'); viewOverlay.classList.add('active'); });
    document.getElementById('set-view-list')?.addEventListener('click', () => { songsContainer.className = 'song-container list-view'; const pldContainer = document.getElementById('playlist-details-songs-container'); if(pldContainer) pldContainer.className = 'song-container list-view'; viewOverlay.classList.remove('active'); });
    document.getElementById('set-view-grid')?.addEventListener('click', () => { songsContainer.className = 'song-container grid-view'; const pldContainer = document.getElementById('playlist-details-songs-container'); if(pldContainer) pldContainer.className = 'song-container grid-view'; viewOverlay.classList.remove('active'); });

    const actionFilterVibeBtn = document.getElementById('action-filter-vibe');
    const vibeFilterOverlay = document.getElementById('vibe-filter-overlay');
    const filterVibesContainer = document.getElementById('filter-vibes-container');
    const btnApplyVibeFilter = document.getElementById('btn-apply-vibe-filter');
    const btnClearVibeFilter = document.getElementById('btn-clear-vibe-filter');

    let _noVibeFilterActive = false;
    document.getElementById('action-filter-no-vibe')?.addEventListener('click', async () => {
        actionSheetOverlay.classList.remove('active');
        if (_noVibeFilterActive) { _noVibeFilterActive = false; _currentFilteredSongs = null; songsContainer.innerHTML = ''; allSongsElements.forEach(el => songsContainer.appendChild(el)); return; }
        _noVibeFilterActive = true; songsContainer.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">Lade Songs ohne Vibe...</div>';

        const noVibeSongs = window.globalSongsData.filter(song => {
            let vibes = song.vibes;
            if (typeof vibes === 'string') { try { vibes = JSON.parse(vibes); } catch(e) { vibes = []; } }
            if (!Array.isArray(vibes)) vibes = []; return vibes.length === 0;
        });

        if (noVibeSongs.length === 0) { songsContainer.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-secondary);">Alle Songs haben bereits einen Vibe 🎉</div>'; return; }

        songsContainer.innerHTML = '';
        noVibeSongs.forEach(song => {
            const existing = allSongsElements.find(el => parseInt(el.dataset.id) === song.id);
            if (existing) { songsContainer.appendChild(existing); }
            else { const div = document.createElement('div'); div.className = 'song-item'; div.dataset.id = song.id; updateSongDOM(div, song); if (_existingPlaylistIds.has(String(song.id))) div.classList.add('disabled-song'); allSongsElements.push(div); songsContainer.appendChild(div); }
        });
        _currentFilteredSongs = noVibeSongs;
    });

    if(actionFilterVibeBtn && vibeFilterOverlay) {
        actionFilterVibeBtn.addEventListener('click', () => {
            actionSheetOverlay.classList.remove('active');
            if(filterVibesContainer.innerHTML === '') {
                const noVibePill = document.createElement('div'); noVibePill.className = 'vibe-pill'; noVibePill.innerText = 'Kein Vibe'; noVibePill.dataset.vibe = '__no_vibe__';
                noVibePill.addEventListener('click', () => noVibePill.classList.toggle('active')); filterVibesContainer.appendChild(noVibePill);
                AVAILABLE_VIBES.forEach(vibe => { const pill = document.createElement('div'); pill.className = 'vibe-pill'; pill.innerText = vibe; pill.dataset.vibe = vibe; pill.addEventListener('click', () => pill.classList.toggle('active')); filterVibesContainer.appendChild(pill); });
            }
            vibeFilterOverlay.classList.add('active');
        });
    }

    if(btnApplyVibeFilter) {
        btnApplyVibeFilter.addEventListener('click', () => {
            const selectedFilterVibes = []; filterVibesContainer.querySelectorAll('.vibe-pill.active').forEach(pill => selectedFilterVibes.push(pill.dataset.vibe));
            songsContainer.innerHTML = '';
            if(selectedFilterVibes.length === 0) { allSongsElements = []; lazyRendered = 0; _currentFilteredSongs = null; lazyRenderBatch(); vibeFilterOverlay.classList.remove('active'); return; }

            const filterNoVibe = selectedFilterVibes.includes('__no_vibe__'); const realVibes = selectedFilterVibes.filter(v => v !== '__no_vibe__');
            const matched = lazyAllSongs.filter(song => {
                let vibes = song.vibes; if (typeof vibes === 'string') { try { vibes = JSON.parse(vibes); } catch(e) { vibes = []; } }
                if (!Array.isArray(vibes)) vibes = []; const clean = vibes.filter(v => v && v.toString().trim() !== '');
                const hasNoVibes = clean.length === 0; const hasRealVibe = realVibes.length > 0 && clean.some(v => realVibes.includes(v));
                return (filterNoVibe && hasNoVibes) || hasRealVibe;
            });

            if (matched.length === 0) { songsContainer.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-secondary);">Keine Songs mit diesem Vibe gefunden.</div>'; vibeFilterOverlay.classList.remove('active'); return; }

            const frag = document.createDocumentFragment();
            matched.forEach(song => {
                let el = allSongsElements.find(e => parseInt(e.dataset.id) === song.id);
                if (!el) { el = document.createElement('div'); el.className = 'song-item'; el.dataset.id = song.id; updateSongDOM(el, song); if (_existingPlaylistIds.has(String(song.id))) el.classList.add('disabled-song'); allSongsElements.push(el); }
                frag.appendChild(el);
            });
            songsContainer.appendChild(frag); _currentFilteredSongs = matched; vibeFilterOverlay.classList.remove('active');
        });
    }

    if(btnClearVibeFilter) {
        btnClearVibeFilter.addEventListener('click', () => {
            filterVibesContainer.querySelectorAll('.vibe-pill.active').forEach(pill => pill.classList.remove('active'));
            songsContainer.innerHTML = ''; allSongsElements = []; lazyRendered = 0; _currentFilteredSongs = null; lazyRenderBatch(); vibeFilterOverlay.classList.remove('active');
        });
    }

    const playlistsPageContainer = document.getElementById('playlists-page-container');
    const availablePlaylistsContainer = document.getElementById('available-playlists-container');
    const btnCreatePlaylistPage = document.getElementById('btn-create-playlist-page');
    const btnCreateNewPlaylistPopup = document.getElementById('btn-create-new-playlist');
    
    let currentPlaylistMode = 'normal';
    let selectedPlaylists = new Set();
    let allPlaylistsElements = [];
    let _fetchPlaylistsRunning = false;
    let _playlistsLastFetched = 0;

    window.fetchPlaylistsForPage = async function(force = false) {
        const cachedPlaylists = (() => { try { const r = localStorage.getItem('heatbox_playlists_snapshot'); return r ? JSON.parse(r) : null; } catch(e) { return null; } })();
        const cachedPs = (() => { try { const r = localStorage.getItem('heatbox_ps_snapshot'); return r ? JSON.parse(r) : []; } catch(e) { return []; } })();
        if (cachedPlaylists && cachedPlaylists.length > 0) { window.globalPlaylistsData = cachedPlaylists; if (typeof window.renderHomeSections === 'function') window.renderHomeSections(); _renderPlaylistsUI(cachedPlaylists, cachedPs); }

        const now = Date.now();
        if (_fetchPlaylistsRunning) return; if (!force && cachedPlaylists && (now - _playlistsLastFetched) < 60000) return;
        _fetchPlaylistsRunning = true;

        try {
            const playlists = await apiGetAllPlaylists();
            window.globalPlaylistsData = playlists; _playlistsLastFetched = Date.now();
            try { localStorage.setItem('heatbox_playlists_snapshot', JSON.stringify(playlists)); } catch(e) {}

            const psLists = await Promise.all(playlists.map(pl => apiGetPlaylistSongs(pl.id)
                .then(songs => (songs || []).filter(s => s !== null).map(s => ({ playlist_id: pl.id, song_id: s.id })))
                .catch(() => [])));
            const allPlaylistSongs = psLists.flat();
            try { localStorage.setItem('heatbox_ps_snapshot', JSON.stringify(allPlaylistSongs)); } catch(e) {}

            if (typeof window.renderHomeSections === 'function') window.renderHomeSections();
            if (typeof window.updateAppStats === 'function') window.updateAppStats();
            _renderPlaylistsUI(playlists, allPlaylistSongs);
        } catch (error) { } finally { _fetchPlaylistsRunning = false; }
    };

    function _renderPlaylistsUI(playlists, allPlaylistSongs) {
        allPlaylistsElements = [];
        const durMap = {}; if (window.globalSongsData) window.globalSongsData.forEach(s => { durMap[s.id] = s.duration || 0; });
        const playlistSongSets = {}; allPlaylistSongs.forEach(ps => { if (!playlistSongSets[ps.playlist_id]) playlistSongSets[ps.playlist_id] = new Set(); playlistSongSets[ps.playlist_id].add(ps.song_id); });
        const playlistSongCountMap = {}; Object.keys(playlistSongSets).forEach(pid => { playlistSongCountMap[pid] = playlistSongSets[pid].size; });

        if (playlistsPageContainer) {
            playlistsPageContainer.innerHTML = '';
            if (playlists.length === 0) { playlistsPageContainer.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-secondary);">Keine Playlists gefunden.</div>'; } 
            else {
                playlists.forEach(playlist => {
                    const pDiv = document.createElement('div'); pDiv.className = 'song-item'; pDiv.dataset.id = playlist.id;
                    let bgStyle = playlist.cover_data && playlist.cover_data.length > 10 ? `background-image: url('${playlist.cover_data}'); background-size: cover; background-position: center;` : `background: hsl(${Math.floor(Math.random() * 360)}, 40%, 30%); display:flex; justify-content:center; align-items:center;`;
                    let innerSvg = playlist.cover_data && playlist.cover_data.length > 10 ? '' : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;

                    let coverHtml = `<div class="song-cover" style="${bgStyle} border-radius: 6px;">${innerSvg}</div>`;
                    let count = playlistSongCountMap[playlist.id] || 0; let dur = 0; allPlaylistSongs.forEach(ps => { if (ps.playlist_id == playlist.id) dur += durMap[ps.song_id] || 0; });
                    let statText = `${count} Songs`; if (dur > 0) statText += ` • ${formatDuration(dur)}`;
                    
                    pDiv.innerHTML = `<div class="song-checkbox playlist-checkbox"></div>${coverHtml}<div class="song-info"><div class="song-title">${_esc(playlist.name)}</div><div class="song-artist">Playlist • ${statText}</div></div><button class="list-play-btn icon-btn" style="margin-left: auto; padding: 10px; color: var(--accent);"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><button class="playlist-context-btn icon-btn" style="padding: 10px; color: var(--text-secondary);"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.5"></circle><circle cx="12" cy="12" r="2.5"></circle><circle cx="12" cy="19" r="2.5"></circle></svg></button>`;

                    const pCoverEl = pDiv.querySelector('.song-cover');
                    if (typeof addLongPressListener === 'function') { addLongPressListener(pCoverEl, (e) => { e.preventDefault(); e.stopPropagation(); window.currentContextPlaylistId = playlist.id; document.getElementById('ctx-pl-edit').click(); }); }
                    const playBtn = pDiv.querySelector('.list-play-btn'); if (playBtn) playBtn.addEventListener('click', (e) => window.togglePlaylistPlayback(e, playlist.id));

                    pDiv.addEventListener('click', (e) => {
                        if (e.target.closest('.playlist-context-btn')) { e.stopPropagation(); window.currentContextPlaylistId = playlist.id; const plContextOverlay = document.getElementById('playlist-context-overlay'); if(plContextOverlay) plContextOverlay.classList.add('active'); return; }
                        if (currentPlaylistMode !== 'normal') { const checkbox = pDiv.querySelector('.playlist-checkbox'); if (checkbox.classList.toggle('checked')) selectedPlaylists.add(playlist.id); else selectedPlaylists.delete(playlist.id); const countEl = document.getElementById('sel-count-playlist'); if(countEl) countEl.innerText = `${selectedPlaylists.size} ausgewählt`; } 
                        else { window.openPlaylistDetails(playlist.id, playlist.name); }
                    });
                    playlistsPageContainer.appendChild(pDiv); allPlaylistsElements.push(pDiv);
                });
            }
        }

        if (availablePlaylistsContainer) {
            availablePlaylistsContainer.innerHTML = '';
            if (playlists.length === 0) { availablePlaylistsContainer.innerHTML = '<div style="padding: 15px 20px; color: var(--text-secondary); font-size: 14px;">Noch keine Playlists vorhanden.</div>'; } 
            else { playlists.forEach(playlist => { const btn = document.createElement('button'); btn.className = 'sheet-btn'; btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-secondary);"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg> ${_esc(playlist.name)}`; btn.addEventListener('click', () => addSelectedSongsToPlaylist(playlist.id, playlist.name)); availablePlaylistsContainer.appendChild(btn); }); }
        }
    } 

    setTimeout(() => window.fetchPlaylistsForPage(), 0);

    window.openPlaylistSelection = function() {
        if (!playlistSelectionOverlay) return; playlistSelectionOverlay.classList.add('active');
        const stale = (Date.now() - _playlistsLastFetched) > 60000;
        if (!window.globalPlaylistsData || window.globalPlaylistsData.length === 0 || stale) { window.fetchPlaylistsForPage(true); }
    };

async function createNewPlaylistProcess() {
        const playlistName = prompt('Name der neuen Playlist:'); 
        if (!playlistName || playlistName.trim() === '') return;
        
        try { 
            const newPlaylist = await apiCreatePlaylist(playlistName.trim()); 
            await window.fetchPlaylistsForPage(true); 
            
            // Fallback, falls die API die ID als Array oder anders benennt
            let createdId = newPlaylist.id || newPlaylist.playlistId || (Array.isArray(newPlaylist) && newPlaylist[0]?.id) || null;
            
            // Sicherstellen, dass alte/falsche Song-IDs nicht aus Versehen hinzugefügt werden
            if (createdId && (currentMode === 'playlist' || currentMode === 'add-to-specific-playlist') && selectedSongs.size > 0) { 
                await addSelectedSongsToPlaylist(createdId, playlistName); 
            } else if (createdId && document.getElementById('song-context-overlay')?.classList.contains('active') && window.currentContextSongId) {
                await addSelectedSongsToPlaylist(createdId, playlistName);
            }
        } 
        catch (error) { 
            alert('Fehler beim Erstellen:\n' + error.message); 
            console.error(error);
        }
    }

    if (btnCreatePlaylistPage) btnCreatePlaylistPage.addEventListener('click', createNewPlaylistProcess);
    if (btnCreateNewPlaylistPopup) btnCreateNewPlaylistPopup.addEventListener('click', createNewPlaylistProcess);

    async function addSelectedSongsToPlaylist(playlistId, playlistName) {
        const isContextMode = selectedSongs.size === 0 && window.currentContextSongId; const idsToAdd = isContextMode ? [window.currentContextSongId] : Array.from(selectedSongs);
        try {
            const playlistSongs = await apiGetPlaylistSongs(playlistId); const existingIds = playlistSongs.map(s => s.id); const newIds = idsToAdd.filter(id => !existingIds.includes(parseInt(id)));
            if (newIds.length === 0) { _showToast('Alle ausgewählten Songs sind bereits in der Playlist'); document.getElementById('sel-cancel')?.click(); return; }
            await apiAddSongsToPlaylist(playlistId, newIds.map(id => parseInt(id)));
            if (playlistSelectionOverlay) playlistSelectionOverlay.classList.remove('active'); if (songContextOverlay) songContextOverlay.classList.remove('active'); if (currentMode !== 'normal') document.getElementById('sel-cancel')?.click();
            localStorage.removeItem(`heatbox_playlist_${playlistId}_songs`); localStorage.removeItem(`heatbox_playlist_${playlistId}_ts`);
            try { const snap = JSON.parse(localStorage.getItem('heatbox_ps_snapshot') || '[]'); const newEntries = newIds.map(songId => ({ playlist_id: playlistId, song_id: parseInt(songId) })); localStorage.setItem('heatbox_ps_snapshot', JSON.stringify([...snap, ...newEntries])); } catch(e) { localStorage.removeItem('heatbox_ps_snapshot'); }
            _existingPlaylistIds = new Set(); window.fetchPlaylistsForPage(true);
            setTimeout(() => { document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active')); const plNavBtn = document.querySelector('.nav-btn[data-target="view-playlists"]'); if (plNavBtn) plNavBtn.classList.add('active'); if (typeof window.openPlaylistDetails === 'function') { window.openPlaylistDetails(playlistId, playlistName, true); } }, 300);
        } catch (error) { alert("Fehler beim Hinzufügen: " + error.message); }
    }

    const playlistActionOverlay = document.getElementById('playlist-action-sheet');
    const playlistSortOverlay = document.getElementById('playlist-sort-overlay');
    const playlistViewOverlay = document.getElementById('playlist-view-overlay');
    const playlistToolbar = document.getElementById('playlist-selection-toolbar');
    const confirmDeletePlaylistOverlay = document.getElementById('confirm-delete-playlist-overlay');

    document.getElementById('playlist-options-btn')?.addEventListener('click', () => playlistActionOverlay.classList.add('active'));
    document.getElementById('action-view-playlist')?.addEventListener('click', () => { playlistActionOverlay.classList.remove('active'); playlistViewOverlay.classList.add('active'); });
    document.getElementById('set-view-list-playlist')?.addEventListener('click', () => { if(playlistsPageContainer) playlistsPageContainer.className = 'song-container list-view'; playlistViewOverlay.classList.remove('active'); });
    document.getElementById('set-view-grid-playlist')?.addEventListener('click', () => { if(playlistsPageContainer) playlistsPageContainer.className = 'song-container grid-view'; playlistViewOverlay.classList.remove('active'); });
    document.getElementById('action-sort-playlist')?.addEventListener('click', () => { playlistActionOverlay.classList.remove('active'); playlistSortOverlay.classList.add('active'); });

    let sortAscPlaylist = true;
    document.getElementById('sort-asc-playlist')?.addEventListener('click', (e) => { e.target.classList.add('active'); document.getElementById('sort-desc-playlist').classList.remove('active'); sortAscPlaylist = true; });
    document.getElementById('sort-desc-playlist')?.addEventListener('click', (e) => { e.target.classList.add('active'); document.getElementById('sort-asc-playlist').classList.remove('active'); sortAscPlaylist = false; });

    document.querySelectorAll('.sort-btn-playlist').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const criteria = e.target.getAttribute('data-sort');
            allPlaylistsElements.sort((a, b) => {
                let valA, valB;
                if (criteria === 'name') { valA = a.querySelector('.song-title').innerText.toLowerCase(); valB = b.querySelector('.song-title').innerText.toLowerCase(); } 
                else if (criteria === 'created_at') { valA = parseInt(a.dataset.id); valB = parseInt(b.dataset.id); }
                if (valA < valB) return sortAscPlaylist ? -1 : 1; if (valA > valB) return sortAscPlaylist ? 1 : -1; return 0;
            });
            if(playlistsPageContainer) { playlistsPageContainer.innerHTML = ''; allPlaylistsElements.forEach(el => playlistsPageContainer.appendChild(el)); }
            playlistSortOverlay.classList.remove('active');
        });
    });

    function endPlaylistSelectionMode() {
        currentPlaylistMode = 'normal'; if(playlistsPageContainer) playlistsPageContainer.classList.remove('selection-mode');
        if(playlistToolbar) { playlistToolbar.classList.remove('visible'); setTimeout(() => playlistToolbar.classList.add('hidden'), 300); }
        document.querySelectorAll('.playlist-checkbox').forEach(cb => cb.classList.remove('checked'));
    }

    document.getElementById('action-delete-playlist')?.addEventListener('click', () => {
        playlistActionOverlay.classList.remove('active'); currentPlaylistMode = 'delete'; selectedPlaylists.clear();
        if(playlistsPageContainer) playlistsPageContainer.classList.add('selection-mode'); if(playlistToolbar) { playlistToolbar.classList.remove('hidden'); setTimeout(() => playlistToolbar.classList.add('visible'), 10); }
        const countEl = document.getElementById('sel-count-playlist'); if (countEl) countEl.innerText = '0 ausgewählt';
    });

    document.getElementById('sel-cancel-playlist')?.addEventListener('click', endPlaylistSelectionMode);
    document.getElementById('sel-all-playlist')?.addEventListener('click', () => {
        const allSelected = selectedPlaylists.size === allPlaylistsElements.length; selectedPlaylists.clear();
        allPlaylistsElements.forEach(el => { const cb = el.querySelector('.playlist-checkbox'); if (!allSelected) { cb.classList.add('checked'); selectedPlaylists.add(el.dataset.id); } else { cb.classList.remove('checked'); } });
        const countEl = document.getElementById('sel-count-playlist'); if(countEl) countEl.innerText = `${selectedPlaylists.size} ausgewählt`;
    });

    document.getElementById('sel-action-playlist')?.addEventListener('click', () => { if (selectedPlaylists.size > 0 && confirmDeletePlaylistOverlay) confirmDeletePlaylistOverlay.classList.add('active'); });

    const confirmDeletePlaylistBtn = document.getElementById('confirm-delete-playlist-btn');
    if (confirmDeletePlaylistBtn) {
        confirmDeletePlaylistBtn.addEventListener('click', async () => {
            confirmDeletePlaylistBtn.innerText = 'Lösche...'; const idsToDelete = Array.from(selectedPlaylists);
            try { for (const id of idsToDelete) { await apiDeletePlaylist(id); } window.fetchPlaylistsForPage(true); const confirmDeletePlaylistOverlay = document.getElementById('confirm-delete-playlist-overlay'); if(confirmDeletePlaylistOverlay) confirmDeletePlaylistOverlay.classList.remove('active'); if(typeof endPlaylistSelectionMode === 'function') endPlaylistSelectionMode(); } 
            catch (error) { alert("Fehler beim Löschen: " + error.message); }
            confirmDeletePlaylistBtn.innerText = 'Löschen';
        });
    }

    document.getElementById('ctx-pl-delete')?.addEventListener('click', () => {
        document.getElementById('playlist-context-overlay')?.classList.remove('active'); selectedPlaylists.clear(); selectedPlaylists.add(window.currentContextPlaylistId); 
        const confirmDelOverlay = document.getElementById('confirm-delete-playlist-overlay'); if(confirmDelOverlay) confirmDelOverlay.classList.add('active'); 
    });

    let currentEditPlaylistCoverData = "";
    document.getElementById('ctx-pl-edit')?.addEventListener('click', () => {
        document.getElementById('playlist-context-overlay')?.classList.remove('active');
        const playlist = window.globalPlaylistsData.find(p => p.id === window.currentContextPlaylistId); if(!playlist) return;
        document.getElementById('edit-playlist-name').value = playlist.name || ''; currentEditPlaylistCoverData = playlist.cover_data || '';
        document.getElementById('edit-playlist-cover-preview').src = currentEditPlaylistCoverData.length > 10 ? currentEditPlaylistCoverData : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        document.getElementById('edit-playlist-overlay').classList.add('active');
    });

    document.getElementById('edit-playlist-cover-btn')?.addEventListener('click', () => document.getElementById('edit-playlist-cover-upload').click());
    document.getElementById('edit-playlist-cover-upload')?.addEventListener('change', (e) => {
        const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = function(event) { currentEditPlaylistCoverData = event.target.result; document.getElementById('edit-playlist-cover-preview').src = currentEditPlaylistCoverData; }; reader.readAsDataURL(file);
    });

    document.getElementById('btn-save-playlist')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-save-playlist'); btn.innerText = "Speichere..."; const newName = document.getElementById('edit-playlist-name').value;
        try { await apiUpdatePlaylist(window.currentContextPlaylistId, { name: newName, cover_data: currentEditPlaylistCoverData }); document.getElementById('edit-playlist-overlay').classList.remove('active'); window.fetchPlaylistsForPage(true); } 
        catch (error) { alert("Fehler: " + error.message); } btn.innerText = "Speichern";
    });

    document.getElementById('ctx-pl-add-queue')?.addEventListener('click', async () => {
        document.getElementById('playlist-context-overlay')?.classList.remove('active'); const playlist = window.globalPlaylistsData.find(p => p.id === window.currentContextPlaylistId);
        try { const songs = await apiGetPlaylistSongs(window.currentContextPlaylistId); if(!songs || songs.length === 0) { alert("Playlist ist leer oder konnte nicht geladen werden."); return; } let songsInPl = songs.filter(s => s !== null); songsInPl = songsInPl.sort(() => 0.5 - Math.random()); playbackQueue.push(...songsInPl); alert(`${songsInPl.length} Songs aus "${playlist.name}" gemischt zur Warteschlange hinzugefügt!`); } 
        catch (error) { alert("Fehler beim Laden: " + error.message); }
    });

    document.getElementById('ctx-pl-add-songs')?.addEventListener('click', async () => {
        document.getElementById('playlist-context-overlay')?.classList.remove('active');
        try {
            const playlistSongs = await apiGetPlaylistSongs(window.currentContextPlaylistId); const existingIds = playlistSongs.map(s => s.id);
            document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); }); const viewSongs = document.getElementById('view-songs'); viewSongs.classList.remove('hidden'); setTimeout(() => viewSongs.classList.add('active'), 10);
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active')); document.querySelector('.nav-btn[data-target="view-songs"]')?.classList.add('active');
            currentMode = 'add-to-specific-playlist'; selectedSongs.clear(); songsContainer.classList.add('selection-mode'); _existingPlaylistIds = new Set(existingIds.map(id => String(id)));
            allSongsElements.forEach(el => { if (existingIds.includes(parseInt(el.dataset.id))) { el.classList.add('disabled-song'); } });
            const selToolbar = document.getElementById('selection-toolbar'); selToolbar.classList.remove('hidden'); setTimeout(() => selToolbar.classList.add('visible'), 10);
            document.getElementById('sel-action').innerText = 'Hinzufügen'; document.getElementById('sel-action').className = 'sel-btn'; document.getElementById('sel-count').innerText = '0 ausgewählt';
        } catch (error) { alert('Fehler beim Laden: ' + error.message); }
    });

    window.renderHomeSections = function() {
        const recentId = localStorage.getItem('heatbox_last_playlist'); const recentContainer = document.getElementById('home-recent-playlist');
        if(recentContainer && window.globalPlaylistsData) {
            const rp = window.globalPlaylistsData.find(p => p.id == recentId);
            if (rp) {
                recentContainer.innerHTML = ''; const card = document.createElement('div'); card.className = 'station-card'; card.dataset.id = rp.id; 
                const bgImage = rp.cover_data && rp.cover_data.length > 10 ? `url('${rp.cover_data}')` : '';
                card.innerHTML = `<div class="station-cover" style="background-image: ${bgImage};"><button class="cover-play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div><div class="station-title">${_esc(rp.name)}</div>`;
                const playBtn = card.querySelector('.cover-play-btn'); if (playBtn) playBtn.addEventListener('click', (e) => window.togglePlaylistPlayback(e, rp.id));
                card.addEventListener('click', () => window.openPlaylistDetails(rp.id, rp.name)); recentContainer.appendChild(card);
            }
        }

        const mixContainer = document.getElementById('home-vibe-mixes');
        if(mixContainer) {
            let mixes = JSON.parse(localStorage.getItem('heatbox_vibe_mixes') || '[]'); const now = Date.now(); mixes = mixes.filter(m => m.expires > now); localStorage.setItem('heatbox_vibe_mixes', JSON.stringify(mixes));
            if(mixes.length === 0) { mixContainer.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px;">Keine aktiven Vibe Mixe.</div>'; } 
            else {
                mixContainer.innerHTML = '';
                mixes.forEach(mix => {
                    const card = document.createElement('div'); card.className = 'station-card'; card.dataset.id = mix.id; const bgImage = mix.cover_data && mix.cover_data.length > 10 ? `url('${mix.cover_data}')` : '';
                    card.innerHTML = `<div class="station-cover" style="background-image: ${bgImage};"><button class="cover-play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div><div class="station-title">${_esc(mix.name)}</div>`;
                    const playBtn = card.querySelector('.cover-play-btn'); if (playBtn) playBtn.addEventListener('click', (e) => { const ids = mix.songIds || (mix.songs || []).map(s => s.id); const songs = ids.map(id => window._songIndex?.get(id)).filter(Boolean); const shuffled = [...songs].sort(() => Math.random() - 0.5); window.togglePlaylistPlayback(e, mix.id, shuffled); });
                    card.addEventListener('click', () => window.openPlaylistDetails(mix.id, mix.name));
                    if (typeof addLongPressListener === 'function') { addLongPressListener(card, (e) => { e.preventDefault(); e.stopPropagation(); if (confirm(`"${mix.name}" löschen?`)) { let saved = JSON.parse(localStorage.getItem('heatbox_vibe_mixes') || '[]'); saved = saved.filter(m => m.id !== mix.id); localStorage.setItem('heatbox_vibe_mixes', JSON.stringify(saved)); window.renderHomeSections(); } }); }
                    mixContainer.appendChild(card);
                });
            }
        }

        const stationsContainer = document.getElementById('stations-container');
        if(stationsContainer) {
            let stations = JSON.parse(localStorage.getItem('heatbox_stations') || '[]'); const now = Date.now(); stations = stations.filter(s => s.expires > now); localStorage.setItem('heatbox_stations', JSON.stringify(stations));
            if(stations.length === 0) { stationsContainer.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px;">Keine Sender vorhanden. Erstelle einen aus deinen Songs!</div>'; } 
            else {
                stationsContainer.innerHTML = '';
                stations.forEach(station => {
                    const card = document.createElement('div'); card.className = 'station-card'; card.dataset.id = station.id; const bgImage = station.cover_data && station.cover_data.length > 10 ? `url('${station.cover_data}')` : '';
                    card.innerHTML = `<div class="station-cover" style="background-image: ${bgImage};"><button class="cover-play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div><div class="station-title">${_esc(station.name)}</div>`;
                    const playBtn = card.querySelector('.cover-play-btn'); if (playBtn) playBtn.addEventListener('click', (e) => window.togglePlaylistPlayback(e, station.id, station.songs));
                    card.addEventListener('click', () => { window.currentPlayingPlaylistId = station.id; if (station.songs.length > 0) { const firstSong = station.songs[0]; window.playSong(firstSong.title, firstSong.artist, firstSong.cover_data, firstSong.file_url); playbackQueue = station.songs.slice(1); savePlayerState(); } });
                    stationsContainer.appendChild(card);
                });
            }
        }
    }

    const homeSearchInput = document.getElementById('home-search-input');
    const homeSearchResults = document.getElementById('home-search-results');
    const homeDefaultContent = document.getElementById('home-default-content');

    if(homeSearchInput) {
        homeSearchInput.addEventListener('input', debounce((e) => {
            const query = e.target.value.toLowerCase().trim();
            if (query === '') { homeSearchResults.style.display = 'none'; if(homeDefaultContent) homeDefaultContent.style.display = 'block'; homeSearchResults.innerHTML = ''; } 
            else {
                homeSearchResults.style.display = 'flex'; if(homeDefaultContent) homeDefaultContent.style.display = 'none'; homeSearchResults.innerHTML = '';
                const matchedSongs = window.globalSongsData.filter(song => (song.title && song.title.toLowerCase().includes(query)) || (song.artist && song.artist.toLowerCase().includes(query)));
                if (matchedSongs.length === 0) { homeSearchResults.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-secondary);">Keine Songs gefunden.</div>'; } 
                else { matchedSongs.forEach(song => { const songDiv = document.createElement('div'); songDiv.className = 'song-item'; songDiv.dataset.id = song.id; updateSongDOM(songDiv, song); homeSearchResults.appendChild(songDiv); }); }
            }
        }, 300));
    }

    const songsSearchInput = document.getElementById('songs-search-input');
    if (songsSearchInput) {
        songsSearchInput.addEventListener('input', debounce((e) => {
            const query = e.target.value.toLowerCase().trim();
            if (query === '') { songsContainer.innerHTML = ''; allSongsElements = []; lazyRendered = 0; lazyRenderBatch(); return; }
            const matched = lazyAllSongs.filter(song => (song.title?.toLowerCase().includes(query)) || (song.artist?.toLowerCase().includes(query)));
            songsContainer.innerHTML = '';
            if (matched.length === 0) { songsContainer.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text-secondary);">Keine Songs gefunden.</div>'; return; }
            const frag = document.createDocumentFragment();
            matched.forEach(song => { let el = allSongsElements.find(e => parseInt(e.dataset.id) === song.id); if (!el) { el = document.createElement('div'); el.className = 'song-item'; el.dataset.id = song.id; updateSongDOM(el, song); } frag.appendChild(el); });
            songsContainer.appendChild(frag);
        }, 250));
    }

    document.getElementById('btn-home-random')?.addEventListener('click', () => {
        if(window.globalSongsData.length === 0) return alert("Noch keine Songs geladen!");
        const shuffled = [...window.globalSongsData].sort(() => 0.5 - Math.random()); const first = shuffled[0];
        window.playSong(first.title, first.artist, first.cover_data, first.file_url); playbackQueue = shuffled.slice(1); savePlayerState();
    });

    document.getElementById('btn-home-vibemix')?.addEventListener('click', () => {
        const cont = document.getElementById('mix-vibes-container');
        if(cont && cont.innerHTML === '') {
            const noVibePill = document.createElement('div'); noVibePill.className = 'vibe-pill'; noVibePill.innerText = '🚫 Kein Vibe'; noVibePill.dataset.vibe = '__no_vibe__';
            noVibePill.addEventListener('click', () => { noVibePill.classList.toggle('active'); if (noVibePill.classList.contains('active')) { cont.querySelectorAll('.vibe-pill:not([data-vibe="__no_vibe__"])').forEach(p => p.classList.remove('active')); } }); cont.appendChild(noVibePill);
            AVAILABLE_VIBES.forEach(vibe => { const pill = document.createElement('div'); pill.className = 'vibe-pill'; pill.innerText = vibe; pill.dataset.vibe = vibe; pill.addEventListener('click', () => { pill.classList.toggle('active'); if (pill.classList.contains('active')) { cont.querySelector('[data-vibe="__no_vibe__"]')?.classList.remove('active'); } }); cont.appendChild(pill); });
        }
        document.getElementById('vibe-mix-overlay')?.classList.add('active');
    });

    document.getElementById('btn-create-vibe-mix')?.addEventListener('click', () => {
        const selectedVibes = []; document.querySelectorAll('#mix-vibes-container .vibe-pill.active').forEach(p => selectedVibes.push(p.dataset.vibe));
        if(selectedVibes.length === 0) return alert('Wähle mindestens einen Vibe!');
        const isNoVibe = selectedVibes.includes('__no_vibe__'); let matchedSongs;
        if (isNoVibe) { matchedSongs = window.globalSongsData.filter(s => !s.vibes || s.vibes.length === 0); } 
        else { matchedSongs = window.globalSongsData.filter(song => selectedVibes.every(v => song.vibes && song.vibes.includes(v))); }
        if (matchedSongs.length === 0) return alert('Keine passenden Songs gefunden.');

        const mixName = 'Vibe Mix: ' + (isNoVibe ? 'Ohne Vibe' : selectedVibes.join(', ')); const shuffledIds = [...matchedSongs].sort(() => Math.random() - 0.5).map(s => s.id);
        const newMix = { id: 'temp_' + Date.now(), name: mixName, cover_data: matchedSongs[0].cover_data || '', songIds: shuffledIds, expires: Date.now() + 86400000 };
        const mixes = JSON.parse(localStorage.getItem('heatbox_vibe_mixes') || '[]'); mixes.unshift(newMix); localStorage.setItem('heatbox_vibe_mixes', JSON.stringify(mixes));
        
        document.getElementById('vibe-mix-overlay')?.classList.remove('active'); window.renderHomeSections();
        const songCount = shuffledIds.length; _showToast(`🎵 Vibe Mix erstellt – ${songCount} ${songCount === 1 ? 'Lied' : 'Lieder'}`, 3000);
    });

    const viewPlaylistDetails = document.getElementById('view-playlist-details');
    const playlistDetailsSongsContainer = document.getElementById('playlist-details-songs-container');
    let playlistSortable = null;

    document.getElementById('btn-back-to-playlists')?.addEventListener('click', () => {
        window.currentOpenPlaylistId = null; viewPlaylistDetails.classList.remove('active'); viewPlaylistDetails.classList.add('hidden');
        const viewPlaylists = document.getElementById('view-playlists'); viewPlaylists.classList.remove('hidden'); setTimeout(() => viewPlaylists.classList.add('active'), 10);
    });

    window.openPlaylistDetails = async function(playlistId, playlistName, force = false) {
        window.currentOpenPlaylistId = playlistId; document.getElementById('detail-playlist-title').innerText = playlistName;
        document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); }); viewPlaylistDetails.classList.remove('hidden'); setTimeout(() => viewPlaylistDetails.classList.add('active'), 10);
        playlistDetailsSongsContainer.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">Lade Songs...</div>';
        
        let playlist = null; let validItems = []; let isTemp = playlistId.toString().startsWith('temp_');
        if (isTemp) {
            const mixes = JSON.parse(localStorage.getItem('heatbox_vibe_mixes') || '[]'); playlist = mixes.find(m => m.id === playlistId);
            if(playlist) { const ids = playlist.songIds || (playlist.songs || []).map(s => s.id); const songs = ids.map(id => window._songIndex?.get(id)).filter(Boolean); validItems = songs.map((song, i) => ({ id: 't_'+i, song_id: song.id, sort_order: i, songs: song })); }
        } else {
            localStorage.setItem('heatbox_last_playlist', playlistId); if (typeof window.renderHomeSections === 'function') window.renderHomeSections();
            playlist = window.globalPlaylistsData?.find(p => p.id === playlistId);
            if (!playlist) { playlistDetailsSongsContainer.innerHTML = '<div style="color:#ff3b30;text-align:center;padding:20px;">Playlist nicht gefunden. Bitte neu laden.</div>'; return; }
            
            const cacheKey = `heatbox_playlist_${playlistId}_songs`; const globalPsCache = (() => { try { const r = localStorage.getItem('heatbox_ps_snapshot'); return r ? JSON.parse(r) : null; } catch(e) { return null; } })();
            if (globalPsCache) {
                const playlistSongs = globalPsCache.filter(ps => ps.playlist_id === playlistId).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
                validItems = playlistSongs.map((ps, index) => ({ id: ps.id || `temp_${index}`, song_id: ps.song_id, sort_order: ps.sort_order || 0, songs: window._songIndex?.get(ps.song_id) })).filter(item => item.songs); 
                try { localStorage.setItem(cacheKey, JSON.stringify(playlistSongs.map(ps => ({ id: ps.id, song_id: ps.song_id, sort_order: ps.sort_order })))); localStorage.setItem(`${cacheKey}_ts`, Date.now().toString()); } catch(e) {}
            } else {
                try {
                    const playlistSongs = await apiGetPlaylistSongs(playlistId);
                    validItems = playlistSongs.map((song, index) => ({ id: song.id, song_id: song.id, sort_order: index, songs: song })).filter(item => item.songs);
                } catch (e) { playlistDetailsSongsContainer.innerHTML = `<div style="color:#ff3b30;text-align:center;padding:20px;">Fehler: ${e.message}</div>`; return; }
            }
        }

        const renderPlaylistDetailsUI = () => {
            const coverDiv = document.getElementById('detail-playlist-cover');
            if (playlist && playlist.cover_data && playlist.cover_data.length > 10) { coverDiv.style.backgroundImage = `url('${playlist.cover_data}')`; coverDiv.innerHTML = ''; } 
            else { coverDiv.style.backgroundImage = 'none'; coverDiv.innerHTML = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2" style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line></svg>`; coverDiv.style.position = 'relative'; }
            
            window.currentPlaylistSongs = validItems.map(item => item.songs); playlistDetailsSongsContainer.innerHTML = '';
            let currentCount = window.currentPlaylistSongs.length; let currentDur = 0; window.currentPlaylistSongs.forEach(s => { if(s.duration) currentDur += s.duration; });
            let freshStatText = `${currentCount} Songs`; if (currentDur > 0) freshStatText += ` • ${formatDuration(currentDur)}`; document.getElementById('detail-playlist-stats').innerText = freshStatText;

            if (validItems.length === 0) { playlistDetailsSongsContainer.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: var(--text-secondary);">Diese Playlist ist leer.</div>'; return; }

            playlistDetailsSongsContainer.innerHTML = ''; const PL_BATCH = 50; let plRendered = 0; let plSentinel = null; let plObserver = null;
            function renderPlaylistBatch() {
                const end = Math.min(plRendered + PL_BATCH, validItems.length); const frag = document.createDocumentFragment();
                for (let i = plRendered; i < end; i++) { const item = validItems[i]; const songDiv = document.createElement('div'); songDiv.className = 'song-item'; songDiv.dataset.id = item.song_id; updateSongDOM(songDiv, item.songs, item.id); frag.appendChild(songDiv); }
                if (plSentinel && plSentinel.parentNode) plSentinel.remove(); playlistDetailsSongsContainer.appendChild(frag); plRendered = end;
                if (plRendered < validItems.length) { plSentinel = document.createElement('div'); plSentinel.style.height = '1px'; playlistDetailsSongsContainer.appendChild(plSentinel); if (plObserver) plObserver.disconnect(); plObserver = new IntersectionObserver(entries => { if (entries[0].isIntersecting) renderPlaylistBatch(); }, { rootMargin: '400px' }); plObserver.observe(plSentinel); } 
                else { if (plObserver) { plObserver.disconnect(); plObserver = null; } }
            }
            renderPlaylistBatch();

            if (playlistSortable) playlistSortable.destroy();
            playlistSortable = new Sortable(playlistDetailsSongsContainer, {
                animation: 150, handle: '.drag-handle', disabled: true, ghostClass: 'sortable-ghost',
                onEnd: async function () {
                    const items = document.querySelectorAll('#playlist-details-songs-container .song-item');
                    if (isTemp) {
                        const mixes = JSON.parse(localStorage.getItem('heatbox_vibe_mixes') || '[]'); const mixIdx = mixes.findIndex(m => m.id === playlistId);
                        if (mixIdx > -1) { const newOrder = Array.from(items).map(item => mixes[mixIdx].songs.find(s => s.id == item.dataset.id)); mixes[mixIdx].songs = newOrder; localStorage.setItem('heatbox_vibe_mixes', JSON.stringify(mixes)); }
                    } else {
                        const updates = Array.from(items).map((item, index) => ({ song_id: parseInt(item.dataset.id), sort_order: index }));
                        await apiReorderPlaylistSongs(playlistId, updates);
                    }
                }
            });
        };
        renderPlaylistDetailsUI();
    };

    document.getElementById('btn-pld-play')?.addEventListener('click', () => {
        if(window.currentPlaylistSongs.length === 0) return; window.currentPlayingPlaylistId = window.currentOpenPlaylistId; 
        const first = window.currentPlaylistSongs[0]; window.playSong(first.title, first.artist, first.cover_data, first.file_url); playbackQueue = window.currentPlaylistSongs.slice(1); savePlayerState();
    });

    document.getElementById('btn-pld-shuffle')?.addEventListener('click', () => {
        if(window.currentPlaylistSongs.length === 0) return; window.currentPlayingPlaylistId = window.currentOpenPlaylistId; 
        const shuffled = [...window.currentPlaylistSongs].sort(() => 0.5 - Math.random()); const first = shuffled[0]; window.playSong(first.title, first.artist, first.cover_data, first.file_url); playbackQueue = shuffled.slice(1); savePlayerState();
    });

    document.getElementById('btn-pld-search')?.addEventListener('click', () => {
        const cont = document.getElementById('pld-search-container');
        if(cont.style.display === 'none' || !cont.style.display) { cont.style.display = 'block'; document.getElementById('pld-search-input').focus(); } 
        else { cont.style.display = 'none'; }
    });

    document.getElementById('pld-search-input')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll('#playlist-details-songs-container .song-item').forEach(el => {
            const title = el.querySelector('.song-title').innerText.toLowerCase(); const artist = el.querySelector('.song-artist').innerText.toLowerCase();
            if(title.includes(query) || artist.includes(query)) el.style.display = 'flex'; else el.style.display = 'none';
        });
    });

    document.getElementById('playlist-detail-options-btn')?.addEventListener('click', () => { document.getElementById('playlist-detail-options-overlay').classList.add('active'); });
    document.getElementById('pdo-view')?.addEventListener('click', () => { document.getElementById('playlist-detail-options-overlay').classList.remove('active'); document.getElementById('view-sheet-overlay').classList.add('active'); });
    document.getElementById('pdo-sort')?.addEventListener('click', () => { document.getElementById('playlist-detail-options-overlay').classList.remove('active'); document.getElementById('sort-sheet-overlay').classList.add('active'); window.currentSortTarget = 'playlist'; });
    document.getElementById('pdo-reorder')?.addEventListener('click', () => {
        document.getElementById('playlist-detail-options-overlay').classList.remove('active'); currentMode = currentMode === 'reorder' ? 'normal' : 'reorder';
        const container = document.getElementById('playlist-details-songs-container');
        if(currentMode === 'reorder') { container.classList.add('reorder-mode'); if(playlistSortable) playlistSortable.option("disabled", false); } 
        else { container.classList.remove('reorder-mode'); if(playlistSortable) playlistSortable.option("disabled", true); }
    });
    document.getElementById('pdo-edit')?.addEventListener('click', () => { document.getElementById('playlist-detail-options-overlay').classList.remove('active'); window.currentContextPlaylistId = window.currentOpenPlaylistId; document.getElementById('ctx-pl-edit').click(); });

    const detailPlaylistCover = document.getElementById('detail-playlist-cover');
    if (detailPlaylistCover && typeof addLongPressListener === 'function') {
        addLongPressListener(detailPlaylistCover, (e) => {
            e.preventDefault(); e.stopPropagation();
            if (window.currentOpenPlaylistId) {
                if (window.currentOpenPlaylistId.toString().startsWith('temp_')) { alert("Dieser temporäre Vibe Mix kann nicht bearbeitet werden."); return; }
                window.currentContextPlaylistId = window.currentOpenPlaylistId; document.getElementById('ctx-pl-edit').click();
            }
        });
    }

    document.getElementById('pdo-add-songs')?.addEventListener('click', () => { document.getElementById('playlist-detail-options-overlay').classList.remove('active'); window.currentContextPlaylistId = window.currentOpenPlaylistId; document.getElementById('ctx-pl-add-songs').click(); });

    function updateSliderFill(slider, min, max) { const percentage = ((slider.value - min) / (max - min)) * 100; slider.style.background = `linear-gradient(to right, #ffffff ${percentage}%, rgba(255,255,255,0.2) ${percentage}%)`; }
    const volSlider = document.getElementById('volume-slider');
    if(volSlider && audioPlayer) { updateSliderFill(volSlider, 0, 1); volSlider.addEventListener('input', (e) => { audioPlayer.volume = e.target.value; updateSliderFill(e.target, 0, 1); }); }

    let isShuffle = false; let isRepeat = false;
    document.getElementById('btn-repeat')?.addEventListener('click', (e) => { isRepeat = !isRepeat; e.currentTarget.classList.toggle('ctrl-active', isRepeat); audioPlayer.loop = isRepeat; });
    document.getElementById('btn-shuffle')?.addEventListener('click', (e) => { isShuffle = !isShuffle; e.currentTarget.classList.toggle('ctrl-active', isShuffle); if(isShuffle) { playbackQueue = playbackQueue.sort(() => 0.5 - Math.random()); } });
    document.getElementById('btn-next')?.addEventListener('click', window.playNextSong);
    document.getElementById('btn-prev')?.addEventListener('click', window.playPrevSong);

    if (audioPlayer) {
        let _errRetry = 0; let _errTimer = null; const _ERR = { 1:'Abgebrochen', 2:'Netzwerk-Fehler', 3:'Decode-Fehler', 4:'URL nicht erreichbar' };
        function _showAudioToast(msg) { const t = document.createElement('div'); t.innerHTML = msg; t.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);background:#1c1c1e;color:#fff;padding:12px 20px;border-radius:16px;z-index:9999;font-size:14px;text-align:center;border:1px solid rgba(255,255,255,0.15);pointer-events:none'; document.body.appendChild(t); setTimeout(() => { t.style.transition='opacity 0.5s'; t.style.opacity='0'; setTimeout(()=>t.remove(),600); }, 4000); }
        audioPlayer.addEventListener('error', () => {
            const err = audioPlayer.error; const code = err ? err.code : 0; const label = _ERR[code] || 'Unbekannt'; isChangingSong = false;
            if (code === 4) { _errRetry = 0; _showAudioToast('Song nicht erreichbar (Fehler 4)'); return; }
            if (_errRetry < 1) { _errRetry++; clearTimeout(_errTimer); _errTimer = setTimeout(() => { audioPlayer.play().catch(() => {}); }, 3000); } 
            else { _errRetry = 0; _showAudioToast('Song konnte nicht geladen werden<br><small style="opacity:0.6">Fehler ' + code + ': ' + label + '</small>'); }
        });
        audioPlayer.addEventListener('loadstart', () => { _errRetry = 0; clearTimeout(_errTimer); });
    }

    let queueSortable = null;
    function buildQueueItem(song, type) {
        const div = document.createElement('div'); div.className = 'song-item';
        const coverSrc = song.coverUrl || song.cover_data || ''; const cover = coverSrc.length > 10 ? `url('${coverSrc}')` : 'var(--accent)';
        if (type === 'current') {
            div.classList.add('playing-active'); div.style.cssText = 'background:rgba(250,35,59,0.15);border:1px solid var(--accent);border-radius:10px;padding:10px;margin:6px 0 12px;';
            div.innerHTML = `<div class="song-cover" style="background:${cover};background-size:cover;position:relative;"><div class="playing-anim" style="position:absolute;bottom:5px;right:5px;transform:scale(0.6);"><span></span><span></span><span></span></div></div><div class="song-info"><div class="song-title" style="color:var(--accent);font-size:16px;">${_esc(song.title)}</div><div class="song-artist">${_esc(song.artist)}</div></div><div style="font-size:10px;color:var(--accent);font-weight:700;letter-spacing:1px;flex-shrink:0;">LÄUFT</div>`;
            div.addEventListener('click', () => { audioPlayer.currentTime = 0; audioPlayer.play(); });
        } else if (type === 'history') {
            div.style.opacity = '0.5';
            div.innerHTML = `<div class="song-cover" style="background:${cover};background-size:cover;"></div><div class="song-info"><div class="song-title">${_esc(song.title)}</div><div class="song-artist">${_esc(song.artist)}</div></div><div style="font-size:10px;color:var(--text-secondary);flex-shrink:0;padding-right:4px;">DAVOR</div>`;
            div.addEventListener('click', () => {
                const idx = playbackHistory.indexOf(song); if (idx === -1) return;
                const songsAfter = playbackHistory.splice(idx + 1); if (window.currentSongData) songsAfter.push(window.currentSongData);
                playbackQueue = [...songsAfter.reverse(), ...playbackQueue]; playbackHistory.splice(idx, 1); window.currentContextSongId = song.id || window.currentContextSongId; _skipNextHistoryPush = true; 
                window.playSong(song.title, song.artist, song.cover_data || song.coverUrl, song.file_url || song.fileUrl); document.getElementById('queue-overlay').classList.remove('active');
            });
        } else { 
            div.innerHTML = `<div class="song-cover" style="background:${cover};background-size:cover;"></div><div class="song-info"><div class="song-title">${_esc(song.title)}</div><div class="song-artist">${_esc(song.artist)}</div></div><div class="drag-handle" style="display:block;flex-shrink:0;">≡</div>`;
            let qStartX = 0;
            div.addEventListener('touchstart', (e) => { qStartX = e.touches[0].clientX; }, {passive: true});
            div.addEventListener('touchend', (e) => {
                if (!qStartX) return;
                if (qStartX - e.changedTouches[0].clientX > 50) { const actualIdx = playbackQueue.indexOf(song); if (actualIdx > -1) playbackQueue.splice(actualIdx, 1); div.style.transition = 'all 0.3s'; div.style.transform = 'translateX(-100%)'; div.style.opacity = '0'; setTimeout(() => div.remove(), 300); savePlayerState(); }
                qStartX = 0;
            });
            div.addEventListener('click', (e) => {
                if (e.target.closest('.drag-handle')) return;
                const idx = playbackQueue.indexOf(song); if (idx === -1) return;
                const skipped = playbackQueue.splice(0, idx); if (window.currentSongData) { playbackHistory.push(window.currentSongData); skipped.forEach(s => playbackHistory.push(s)); }
                playbackQueue.shift(); window.currentContextSongId = song.id || window.currentContextSongId; _skipNextHistoryPush = true; 
                window.playSong(song.title, song.artist, song.cover_data || song.coverUrl, song.file_url || song.fileUrl); document.getElementById('queue-overlay').classList.remove('active');
            });
        }
        return div;
    }

    document.getElementById('btn-queue-menu')?.addEventListener('click', () => {
        const qContainer = document.getElementById('queue-list'); qContainer.innerHTML = '';
        if (queueSortable) { queueSortable.destroy(); queueSortable = null; }

        const historyToShow = playbackHistory.slice(-10).reverse(); 
        if (historyToShow.length > 0) { const histLabel = document.createElement('div'); histLabel.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-secondary);letter-spacing:1px;text-transform:uppercase;padding:4px 4px 6px;'; histLabel.innerText = 'Verlauf'; qContainer.appendChild(histLabel); historyToShow.forEach(song => qContainer.appendChild(buildQueueItem(song, 'history'))); }

        if (window.currentSongData) { const nowLabel = document.createElement('div'); nowLabel.style.cssText = 'font-size:11px;font-weight:700;color:var(--accent);letter-spacing:1px;text-transform:uppercase;padding:8px 4px 2px;'; nowLabel.innerText = 'Läuft jetzt'; qContainer.appendChild(nowLabel); qContainer.appendChild(buildQueueItem(window.currentSongData, 'current')); }

        if (playbackQueue.length === 0) { const emptyMsg = document.createElement('div'); emptyMsg.style.cssText = 'padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;'; emptyMsg.innerText = 'Keine weiteren Lieder in der Warteschlange.'; qContainer.appendChild(emptyMsg); } 
        else {
            const nextLabel = document.createElement('div'); nextLabel.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-secondary);letter-spacing:1px;text-transform:uppercase;padding:8px 4px 6px;'; nextLabel.innerText = 'Als nächstes'; qContainer.appendChild(nextLabel);
            const nextContainer = document.createElement('div'); nextContainer.id = 'queue-next-container';
            playbackQueue.slice(0, 50).forEach(song => nextContainer.appendChild(buildQueueItem(song, 'next'))); qContainer.appendChild(nextContainer);
            if (playbackQueue.length > 50) { const moreMsg = document.createElement('div'); moreMsg.style.cssText = 'padding:15px;text-align:center;font-size:12px;color:var(--text-secondary);'; moreMsg.innerText = `+ ${playbackQueue.length - 50} weitere Lieder...`; qContainer.appendChild(moreMsg); }
            queueSortable = new Sortable(nextContainer, { animation: 150, handle: '.drag-handle', ghostClass: 'sortable-ghost', onEnd: function(evt) { const movedItem = playbackQueue.splice(evt.oldIndex, 1)[0]; playbackQueue.splice(evt.newIndex, 0, movedItem); savePlayerState(); } });
        }
        document.getElementById('queue-overlay').classList.add('active');
    });

    document.getElementById('btn-audio-out')?.addEventListener('click', async () => {
        const outList = document.getElementById('audio-devices-list'); outList.innerHTML = '';
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || !audioPlayer.setSinkId) { outList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary);">Dein Browser unterstützt diese Funktion leider nicht (nur Chrome/Edge PC).</div>'; } 
            else {
                const devices = await navigator.mediaDevices.enumerateDevices(); const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
                audioOutputs.forEach(device => { const btn = document.createElement('button'); btn.className = 'sheet-btn'; btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg> ${device.label || 'Unbekannter Lautsprecher'}`; btn.addEventListener('click', () => { audioPlayer.setSinkId(device.deviceId); document.getElementById('audio-out-overlay').classList.remove('active'); }); outList.appendChild(btn); });
            }
        } catch(e) { outList.innerHTML = 'Fehler beim Laden der Geräte.'; }
        document.getElementById('audio-out-overlay').classList.add('active');
    });

    const bigCover = document.getElementById('big-player-cover');
    if(bigCover) {
        addLongPressListener(bigCover, (e) => {
            const activeId = window.currentPlayingSongId || (window.currentSongData ? window.currentSongData.id : null);
            if (activeId) window.currentContextSongId = activeId;
            document.getElementById('big-player-context-overlay').classList.add('active');
        });
    }

    document.getElementById('bp-ctx-add-playlist')?.addEventListener('click', () => { document.getElementById('big-player-context-overlay').classList.remove('active'); selectedSongs.clear(); selectedSongs.add(String(window.currentContextSongId)); window.openPlaylistSelection(); });
    document.getElementById('bp-ctx-create-station')?.addEventListener('click', () => {
        document.getElementById('big-player-context-overlay').classList.remove('active');
        const activeId = window.currentPlayingSongId || (window.currentSongData ? window.currentSongData.id : null); if (!activeId) return;
        const song = window._songIndex?.get(parseInt(activeId)); if (!song) return;
        const sourceVibes = song.vibes || [];
        let stationSongs = window.globalSongsData.filter(s => { if (s.id === song.id) return true; const sVibes = s.vibes || []; const matchCount = sVibes.filter(v => sourceVibes.includes(v)).length; return matchCount >= 2; });
        if (stationSongs.length <= 1) { const randomFill = [...window.globalSongsData].sort(() => 0.5 - Math.random()).slice(0, 5); stationSongs = Array.from(new Set([...stationSongs, ...randomFill])); }
        stationSongs = stationSongs.sort(() => 0.5 - Math.random());
        const newStation = { id: 'station_' + Date.now(), name: "Sender: " + song.title, cover_data: song.cover_data, songs: stationSongs, expires: Date.now() + (24 * 60 * 60 * 1000) };
        const savedStations = JSON.parse(localStorage.getItem('heatbox_stations') || '[]'); savedStations.unshift(newStation); localStorage.setItem('heatbox_stations', JSON.stringify(savedStations));
        if (typeof window.renderHomeSections === 'function') window.renderHomeSections(); _showToast(`Sender für "${song.title}" erstellt!`);
    });

    document.getElementById('bp-ctx-edit-tags')?.addEventListener('click', () => { document.getElementById('big-player-context-overlay').classList.remove('active'); document.getElementById('ctx-edit-tags').click(); });
    document.getElementById('bp-ctx-delete')?.addEventListener('click', () => { document.getElementById('big-player-context-overlay').classList.remove('active'); document.getElementById('ctx-delete').click(); });
    document.getElementById('bp-ctx-edit-style')?.addEventListener('click', () => { document.getElementById('big-player-context-overlay').classList.remove('active'); document.getElementById('player-style-overlay').classList.add('active'); });
    window.setPlayerStyle = function(styleClass) { bigCover.className = `large-cover ${styleClass}`; document.getElementById('player-style-overlay').classList.remove('active'); };

    document.querySelectorAll('.close-alert, .close-sub-sheet').forEach(btn => { btn.addEventListener('click', (e) => { const overlay = e.target.closest('.action-sheet-overlay'); if(overlay) overlay.classList.remove('active'); }); });
    document.getElementById('more-options-btn')?.addEventListener('click', () => actionSheetOverlay.classList.add('active'));
    document.getElementById('cancel-sheet-btn')?.addEventListener('click', () => actionSheetOverlay.classList.remove('active'));

    const colorPicker = document.getElementById('theme-color-picker');
    if (colorPicker) {
        const savedColor = localStorage.getItem('heatbox_theme_color');
        if (savedColor) { colorPicker.value = savedColor; _setAccentColor(savedColor); }
        colorPicker.addEventListener('input', (e) => { const newColor = e.target.value; _setAccentColor(newColor); localStorage.setItem('heatbox_theme_color', newColor); if(typeof window.updateActiveHighlights === 'function') window.updateActiveHighlights(); });
    }

    const cfToggle = document.getElementById('setting-crossfade-toggle');
    if (cfToggle) { cfToggle.checked = localStorage.getItem('heatbox_crossfade') === 'true'; window.isCrossfadeEnabled = cfToggle.checked; cfToggle.addEventListener('change', (e) => { window.isCrossfadeEnabled = e.target.checked; localStorage.setItem('heatbox_crossfade', e.target.checked); }); }

    window.updateAppStats = function() {
        const statsEl = document.getElementById('app-stats-text');
        if (statsEl) { const songCount = (typeof window.globalSongsData !== 'undefined') ? window.globalSongsData.length : 0; const plCount = window.globalPlaylistsData ? window.globalPlaylistsData.length : 0; statsEl.innerText = `${songCount} Songs • ${plCount} Playlists in der Cloud`; }
    };

    document.getElementById('btn-backup-download')?.addEventListener('click', () => {
        const backupData = { state: JSON.parse(localStorage.getItem('heatbox_state') || '{}'), mixes: JSON.parse(localStorage.getItem('heatbox_vibe_mixes') || '[]'), stations: JSON.parse(localStorage.getItem('heatbox_stations') || '[]'), theme: localStorage.getItem('heatbox_theme_color') || '#fa233b', timestamp: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(backupData, null, 2)], {type: 'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `HeaTBox_Backup_${new Date().toISOString().split('T')[0]}.json`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    });

    document.getElementById('btn-carplay')?.addEventListener('click', () => { alert("🚗 Apple CarPlay & Android Auto bereit!\n\nVerbinde dein Handy einfach per Kabel oder Bluetooth mit deinem Auto. Da HeaTBox jetzt die native Media-Schnittstelle nutzt, werden Songs, Cover und die Steuerung automatisch auf dein Auto-Display übertragen!"); });

    // Sheet-Wisch-zum-Schließen: 1:1 mit dem Finger mitziehen statt nur den Endzustand beim
    // Loslassen zu prüfen (Apple Design: "feedback must be continuous during the interaction,
    // not just at the end"). Nach oben rausziehen wird gedämpft statt hart zu stoppen
    // (Rubber-Banding). Ein schneller Flick schließt auch bei kurzer Strecke (Emil Kowalski:
    // Geschwindigkeit statt reiner Distanz-Schwelle).
    document.querySelectorAll('.action-sheet-overlay').forEach(overlay => {
        const sheet = overlay.querySelector('.action-sheet'); if(!sheet) return;
        let startY = 0, lastY = 0, startTime = 0, dragging = false;

        function releaseSheet() {
            sheet.style.transition = '';
            sheet.style.transform = '';
        }

        sheet.addEventListener('touchstart', (e) => {
            const scrollable = e.target.closest('.vibes-container, [style*="overflow-y: auto"], [style*="overflow-y:auto"], .song-container, #queue-list, #dup-results-container');
            if (scrollable) { dragging = false; return; }
            startY = lastY = e.touches[0].clientY; startTime = Date.now(); dragging = true;
        }, {passive: true});

        sheet.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            lastY = e.touches[0].clientY;
            let diff = lastY - startY;
            if (diff < 0) diff *= 0.25; // Rubber-Band beim Rausziehen nach oben
            sheet.style.transition = 'none';
            sheet.style.transform = `translateY(${diff}px)`;
        }, {passive: true});

        sheet.addEventListener('touchend', () => {
            if (!dragging) return;
            dragging = false;
            const diff = lastY - startY;
            const velocity = diff / Math.max(1, Date.now() - startTime); // px/ms
            if (diff > 70 || velocity > 0.5) { releaseSheet(); overlay.classList.remove('active'); }
            else releaseSheet(); // schnappt über die eigene CSS-Transition der .action-sheet zurück
        });
        sheet.addEventListener('touchcancel', () => { dragging = false; releaseSheet(); });
    });

    document.querySelectorAll('.action-sheet-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.remove('active');
            }
        });
    });

    // --- SPOTIFY-CHECK FÜR SONGS OHNE VIBE (roter Punkt) ---
    // Einmaliger, manuell angestoßener Bulk-Check: NUR Titel/Künstler/Cover werden aufgefrischt
    // (Spotify kennt die eigenen Vibe-Namen wie "Ghana"/"N-rei" nicht - Vibes bleiben unangetastet,
    // der rote Punkt verschwindet also nicht automatisch, das ist gewollt). Jeder Song wird nur
    // EIN Mal von dieser Aktion angefasst (persistiert in _NOVIBE_SPOTIFY_CHECKED_KEY), damit
    // wiederholtes Antippen des Buttons nicht dieselben ergebnislosen Songs erneut abfragt.
    const _NOVIBE_SPOTIFY_CHECKED_KEY = 'himusic_novibe_spotify_checked';
    function _loadNoVibeChecked() {
        try { return new Set(JSON.parse(localStorage.getItem(_NOVIBE_SPOTIFY_CHECKED_KEY) || '[]')); }
        catch(e) { return new Set(); }
    }
    function _saveNoVibeChecked(set) {
        try { localStorage.setItem(_NOVIBE_SPOTIFY_CHECKED_KEY, JSON.stringify(Array.from(set))); } catch(e) {}
    }
    let _noVibeSpotifyRunning = false;
    document.getElementById('btn-spotify-check-novibe')?.addEventListener('click', async () => {
        if (_noVibeSpotifyRunning) return;
        const allSongs = window.globalSongsData || [];
        const alreadyChecked = _loadNoVibeChecked();
        const todo = allSongs.filter(s => _parseVibes(s.vibes).length === 0 && !alreadyChecked.has(s.id));
        if (todo.length === 0) { _showToast('Keine offenen Songs ohne Vibe (oder schon alle einmal geprüft)'); return; }
        if (!confirm(`${todo.length} Songs ohne Vibe einmalig per Spotify auf Titel/Künstler/Cover prüfen?`)) return;

        _noVibeSpotifyRunning = true;
        let updated = 0, noHit = 0, idx = 0;
        _showToast(`🔄 Prüfe ${todo.length} Songs via Spotify...`, 4000);

        async function worker() {
            while (idx < todo.length) {
                const song = todo[idx++];
                if (window._spotifyCooldownUntil && Date.now() < window._spotifyCooldownUntil) break; // Rate-Limit: Rest bleibt für den nächsten Klick offen
                try {
                    const meta = await searchSongMetaSpotify(song.title, song.artist);
                    if (meta && meta.rateLimited) break;
                    if (meta && meta.cover) {
                        const patch = { title: meta.title, artist: meta.artist, album: meta.album || "", cover_data: meta.cover, vibes: _parseVibes(song.vibes) };
                        await _apiFetch(`${API_URL}/songs/${song.id}`, {
                            method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(patch), signal: _mkTimeout(15000)
                        });
                        if (typeof window.applySongPatch === 'function') window.applySongPatch(song.id, patch);
                        updated++;
                    } else {
                        noHit++;
                    }
                    alreadyChecked.add(song.id);
                } catch(e) { /* Netzwerkfehler: bleibt ungecheckt, wird beim nächsten Klick erneut versucht */ }
            }
        }
        await Promise.all(Array.from({ length: 3 }, worker));
        _saveNoVibeChecked(alreadyChecked);
        _noVibeSpotifyRunning = false;
        _showToast(`✅ ${updated} aktualisiert, ${noHit} ohne Spotify-Treffer`, 4000);
    });

    // --- DUPLIKAT CLEANER ---
    document.getElementById('btn-find-duplicates')?.addEventListener('click', () => {
        document.getElementById('dup-results-container').innerHTML = '';
        document.getElementById('dup-status').innerText = 'Tippe auf „Scannen" um doppelte Songs zu finden.';
        document.getElementById('btn-dup-delete-all').style.display = 'none';
        document.getElementById('dup-progress-wrap').style.display = 'none';
        document.getElementById('duplicate-cleaner-overlay').classList.add('active');
    });

    document.getElementById('btn-dup-scan')?.addEventListener('click', async () => {
        const scanBtn      = document.getElementById('btn-dup-scan');
        const statusEl     = document.getElementById('dup-status');
        const progressWrap = document.getElementById('dup-progress-wrap');
        const progressBarEl = document.getElementById('dup-progress-bar');
        const resultsCont  = document.getElementById('dup-results-container');
        const deleteAllBtn = document.getElementById('btn-dup-delete-all');

        scanBtn.disabled = true;
        scanBtn.innerText = 'Scanne...';
        statusEl.innerText = 'Lade alle Songs aus der Datenbank...';
        progressWrap.style.display = 'block';
        progressBarEl.style.width = '10%';
        resultsCont.innerHTML = '';
        deleteAllBtn.style.display = 'none';

        const all = window.globalSongsData.map(s => ({
            id: s.id,
            title: s.title,
            artist: s.artist,
            file_size: s.file_size,
            cover_data: s.cover_data,
            vibes: s.vibes,
            duration: s.duration
        }));

        progressBarEl.style.width = '40%';
        statusEl.innerText = `${all.length} Songs geladen. Suche Duplikate...`;

const groups = new Map();
        all.forEach(song => {
            const cleanTitle = (song.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const cleanArtist = (song.artist || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            
            let k;
            if (song.file_size && song.file_size > 0 && cleanTitle.length > 0) {
                // Ein echtes Duplikat hat exakt die gleiche Bytegröße UND denselben Titel
                k = `dup_${song.file_size}_${cleanTitle}`;
            } else if (cleanArtist !== '' && cleanArtist !== 'unbekannterknstler') {
                // Fallback: Gleicher Titel & Künstler
                k = `meta_${cleanTitle}_${cleanArtist}`;
            } else {
                // Einzigartig -> nicht löschen
                k = `unique_${song.id}`;
            }

            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(song);
        });

        const dupGroups = [];
        groups.forEach(arr => { if (arr.length > 1) dupGroups.push(arr); });

        progressBarEl.style.width = '80%';

        const toDeleteIds = new Set();
        dupGroups.forEach(group => {
            const scored = group.map(s => ({
                song: s,
                score: (s.cover_data && s.cover_data.length > 10 ? 3 : 0)
                     + ((s.vibes || []).length)
                     + (s.duration ? 1 : 0)
                     - (s.id * 0.000001)
            }));
            scored.sort((a, b) => b.score - a.score);
            scored.slice(1).forEach(({ song }) => toDeleteIds.add(song.id));
        });

        progressBarEl.style.width = '100%';

        if (dupGroups.length === 0) {
            statusEl.innerText = '✅ Keine Duplikate! Deine Bibliothek ist sauber.';
            scanBtn.disabled = false; scanBtn.innerText = 'Erneut scannen'; return;
        }

        const totalDups = toDeleteIds.size;
        statusEl.innerHTML = `<b style="color:var(--accent)">${dupGroups.length} Duplikat-Gruppen</b> · <b>${totalDups} Songs</b> werden gelöscht`;
        deleteAllBtn.style.display = 'flex';
        deleteAllBtn.innerText = `${totalDups} Duplikate löschen`;

        const frag = document.createDocumentFragment();
        dupGroups.slice(0, 60).forEach(group => {
            const card = document.createElement('div');
            card.style.cssText = 'background:rgba(255,255,255,0.05);border-radius:10px;padding:10px;margin-bottom:8px;';
            const keep = group.find(s => !toDeleteIds.has(s.id));
            const dels = group.filter(s => toDeleteIds.has(s.id));
            const bg = keep?.cover_data && keep.cover_data.length > 10 ? `url('${keep.cover_data}')` : 'var(--accent)';
            card.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;">
                    <div style="width:38px;height:38px;border-radius:6px;flex-shrink:0;background:${bg};background-size:cover;"></div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(keep?.title||'?')}</div>
                        <div style="font-size:11px;color:var(--text-secondary);">${_esc(keep?.artist||'?')} · ${group.length}×</div>
                    </div>
                    <div style="font-size:11px;color:#ff3b30;font-weight:600;">${dels.length} weg</div>
                </div>`;
            frag.appendChild(card);
        });
        if (dupGroups.length > 60) {
            const more = document.createElement('div');
            more.style.cssText = 'text-align:center;color:var(--text-secondary);font-size:12px;padding:8px 0;';
            more.innerText = `+ ${dupGroups.length - 60} weitere Gruppen`;
            frag.appendChild(more);
        }
        resultsCont.appendChild(frag);
        scanBtn.disabled = false; scanBtn.innerText = 'Erneut scannen';

        deleteAllBtn.onclick = async () => {
            if (!confirm(`Wirklich ${totalDups} doppelte Songs unwiderruflich löschen?\nDer beste Song (mit Cover/Vibes) wird behalten.`)) return;
            deleteAllBtn.disabled = true; deleteAllBtn.innerText = 'Lösche...';
            scanBtn.disabled = true;
            progressBarEl.style.width = '0%';

            const idsArr = Array.from(toDeleteIds);
            const CHUNK = 50;
            let deleted = 0;
            for (let i = 0; i < idsArr.length; i += CHUNK) {
                const chunk = idsArr.slice(i, i + CHUNK);
                for (const id of chunk) {
                    try {
                        await apiDeleteSong(id);
                        deleted++;
                    } catch (error) {
                        console.error(`Fehler beim Löschen von Song ${id}:`, error);
                    }
                }
                progressBarEl.style.width = Math.round((deleted / idsArr.length) * 100) + '%';
                statusEl.innerText = `Lösche... ${deleted} / ${idsArr.length}`;
                await new Promise(r => setTimeout(r, 30));
            }

            window.globalSongsData = window.globalSongsData.filter(s => !toDeleteIds.has(s.id));
            rerenderSongsList(window.globalSongsData);
            if (typeof window.updateAppStats === 'function') window.updateAppStats();

            statusEl.innerHTML = `<span style="color:#30d158">✅ ${deleted} Duplikate gelöscht!</span>`;
            resultsCont.innerHTML = '';
            deleteAllBtn.style.display = 'none';
            scanBtn.disabled = false; scanBtn.innerText = 'Erneut scannen';
        };
    });

    // --- OFFLINE MODUS MODAL LOGIK ---
    (function() {
        var btn       = document.getElementById('btn-offline-mode');
        var modal     = document.getElementById('offline-modal');
        if (!btn || !modal) return;

        var label     = document.getElementById('offline-btn-label');
        var closeBtn  = document.getElementById('offline-close-btn');
        var startBtn  = document.getElementById('offline-start-btn');
        var clearBtn  = document.getElementById('offline-clear-btn');
        var progWrap  = document.getElementById('offline-progress-wrap');
        var progBar   = document.getElementById('offline-progress-bar');
        var progTxt   = document.getElementById('offline-progress-text');
        var progSong  = document.getElementById('offline-progress-song');
        var doneWrap  = document.getElementById('offline-done-wrap');
        var doneTxt   = document.getElementById('offline-done-text');
        var infoWrap  = document.getElementById('offline-info-wrap');
        var cacheInfo = document.getElementById('offline-cache-info');
        var titleEl   = document.getElementById('offline-modal-title');

        var SW_OK = ('serviceWorker' in navigator);

        function colorBtn(state) {
            if (state === 'on') {
                btn.style.background   = 'rgba(48,209,88,0.18)';
                btn.style.borderColor  = '#30d158';
                btn.style.color        = '#30d158';
                if (label) label.textContent = 'Offline bereit ✓';
            } else if (state === 'loading') {
                btn.style.background  = 'rgba(255,159,10,0.18)';
                btn.style.borderColor = '#ff9f0a';
                btn.style.color       = '#ff9f0a';
                if (label) label.textContent  = 'Lädt…';
            } else {
                btn.style.background  = 'rgba(255,255,255,0.07)';
                btn.style.borderColor = 'rgba(255,255,255,0.15)';
                btn.style.color       = 'var(--text-secondary)';
                if (label) label.textContent = 'Offline-Modus aktivieren';
            }
        }

        colorBtn(localStorage.getItem('himusic_offline') === '1' ? 'on' : 'off');

        if (SW_OK) {
            navigator.serviceWorker.addEventListener('message', function(e) {
                var d = e.data;
                if (!d) return;
                if (d.type === 'CACHE_PROGRESS') {
                    var pct = Math.round(d.done / d.total * 100);
                    if (progBar)  progBar.style.width  = pct + '%';
                    if (progTxt)  progTxt.textContent  = d.done + ' / ' + d.total + ' Songs (' + pct + '%)';
                    if (progSong) progSong.textContent = d.title || '';
                }
                if (d.type === 'CACHE_COMPLETE') {
                    progWrap.style.display = 'none';
                    doneWrap.style.display = 'block';
                    if (doneTxt)  doneTxt.textContent  = d.total + ' Songs offline gespeichert ✓';
                    startBtn.style.display = 'none';
                    if (clearBtn) clearBtn.style.display = 'block';
                    localStorage.setItem('himusic_offline', '1');
                    colorBtn('on');
                    if (titleEl) titleEl.textContent = 'Offline bereit';
                }
                if (d.type === 'CACHE_CLEARED') {
                    localStorage.removeItem('himusic_offline');
                    colorBtn('off');
                    doneWrap.style.display  = 'none';
                    infoWrap.style.display  = 'block';
                    progWrap.style.display  = 'none';
                    startBtn.style.display  = 'block';
                    if (clearBtn) clearBtn.style.display = 'none';
                    if (cacheInfo) cacheInfo.textContent = '';
                    if (titleEl) titleEl.textContent = 'Offline-Modus';
                }
                if (d.type === 'CACHE_INFO') {
                    const validCount = (window.globalSongsData && d.count > 0)
                        ? Math.min(d.count, window.globalSongsData.length)
                        : d.count;
                    if (cacheInfo) cacheInfo.textContent = validCount > 0
                        ? validCount + ' Songs bereits offline gespeichert'
                        : 'Noch keine Songs gespeichert';
                    if (clearBtn) clearBtn.style.display = d.count > 0 ? 'block' : 'none';
                }
            });
            function askSW() {
                var sw = navigator.serviceWorker.controller;
                if (sw) sw.postMessage({ type: 'GET_CACHE_INFO' });
            }
            if (navigator.serviceWorker.controller) askSW();
            else navigator.serviceWorker.addEventListener('controllerchange', function() { setTimeout(askSW, 400); });
        }

        btn.addEventListener('click', function() {
            progWrap.style.display  = 'none';
            doneWrap.style.display  = 'none';
            infoWrap.style.display  = 'block';
            startBtn.style.display  = 'block';
            if (clearBtn) clearBtn.style.display = 'none';
            if (titleEl) titleEl.textContent = 'Offline-Modus';
            startBtn.textContent = localStorage.getItem('himusic_offline') === '1'
                ? 'Erneut herunterladen' : 'Jetzt herunterladen';
            if (SW_OK && navigator.serviceWorker.controller)
                navigator.serviceWorker.controller.postMessage({ type: 'GET_CACHE_INFO' });
            modal.style.display = 'flex';
        });

        if (closeBtn) closeBtn.addEventListener('click', function() { modal.style.display = 'none'; });
        modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });

        startBtn.addEventListener('click', async function() {
            if (!window.globalSongsData || window.globalSongsData.length === 0) {
                alert('Bibliothek noch nicht geladen. Bitte warten.');
                return;
            }
            infoWrap.style.display  = 'none';
            doneWrap.style.display  = 'none';
            progWrap.style.display  = 'block';
            if (progBar)  progBar.style.width  = '0%';
            if (progTxt)  progTxt.textContent  = 'Starte…';
            if (progSong) progSong.textContent = '';
            startBtn.style.display  = 'none';
            if (clearBtn) clearBtn.style.display = 'none';
            colorBtn('loading');

            const songs     = (window.globalSongsData || []).filter(s => s.file_url);
            const total     = songs.length;
            let   done      = 0;
            const PARALLEL  = 5;
            const localUrls = await window.hbLocal.getAllLocalUrls();

            async function dlOne(song) {
                if (!localUrls.has(song.file_url)) {
                    await window.hbLocal.downloadToLocal(song.file_url, song.title);
                }
                done++;
                const pct = Math.round(done / total * 100);
                if (progBar)  progBar.style.width  = pct + '%';
                if (progTxt)  progTxt.textContent  = `${done} / ${total} Songs (${pct}%)`;
                if (progSong) progSong.textContent = song.title;
            }

let currentIndex = 0;
            const MAX_CONCURRENT = 12; // Vollgas: Cloudflare (R2/Worker) läuft über HTTP/2, das
            // Browser-Limit von 6 gilt nur pro HTTP/1.1-Verbindung, nicht pro Host über HTTP/2

            // Fluid-Pool Worker: Nimmt sich immer den nächsten Song aus der Liste, sobald eine Spur frei wird
            async function downloadWorker() {
                while (currentIndex < songs.length) {
                    const song = songs[currentIndex];
                    currentIndex++;
                    await dlOne(song);
                }
            }

            // Starte alle 6 Spuren parallel
            const workers = [];
            for (let i = 0; i < MAX_CONCURRENT; i++) {
                workers.push(downloadWorker());
            }
            await Promise.all(workers);

            progWrap.style.display = 'none';
            doneWrap.style.display = 'block';
            const info = await window.hbLocal.getLocalStorageInfo();
            const finalCount = window.globalSongsData ? window.globalSongsData.filter(s => s.file_url).length : total;
            if (doneTxt) doneTxt.textContent = `${finalCount} Songs offline ✓  (${info.usedMB} MB)`;
            if (clearBtn) clearBtn.style.display = 'block';
            localStorage.setItem('himusic_offline', '1');
            colorBtn('on');
            if (titleEl) titleEl.textContent = 'Offline bereit';
        });

        if (clearBtn) clearBtn.addEventListener('click', async function() {
            if (!confirm('Alle offline gespeicherten Songs löschen?')) return;
            await window.hbLocal.clearLocalAudio();
            if (SW_OK && navigator.serviceWorker.controller)
                navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_AUDIO_CACHE' });
            document.querySelectorAll('.offline-badge').forEach(b => b.style.display = 'none');
            localStorage.removeItem('himusic_offline');
            colorBtn('off');
            doneWrap.style.display  = 'none';
            infoWrap.style.display  = 'block';
            startBtn.style.display  = 'block';
            if (clearBtn) clearBtn.style.display = 'none';
            if (cacheInfo) cacheInfo.textContent = 'Offline-Daten gelöscht.';
            if (titleEl) titleEl.textContent = 'Offline-Modus';
        });

        btn.addEventListener('click', async function() {
            const localUrls = await window.hbLocal.getAllLocalUrls();
            const info      = await window.hbLocal.getLocalStorageInfo();
            if (cacheInfo) {
                cacheInfo.textContent = localUrls.size > 0
                    ? `${localUrls.size} Songs lokal gespeichert · ${info.usedMB} MB genutzt`
                    : 'Noch keine Songs lokal gespeichert.';
                if (clearBtn) clearBtn.style.display = localUrls.size > 0 ? 'block' : 'none';
            }
        });
    })();

// --- PULL TO REFRESH ---
    let pullStartY = 0;
    let isPullingToRefresh = false;
    let pullRefreshTimeout = null;

    function _reloadApp() {
        clearTimeout(_saveTimer);
        _doSavePlayerState();
        document.body.style.transition = 'opacity 0.3s';
        document.body.style.opacity = '0.5';
        window.location.reload();
    }

    document.addEventListener('touchstart', (e) => {
        const activeView = document.querySelector('.view.active');
        if (!activeView || activeView.scrollTop > 0) return;
        pullStartY = e.touches[0].clientY;
        isPullingToRefresh = true;
    }, {passive: true});

    document.addEventListener('touchmove', (e) => {
        if (!isPullingToRefresh) return;
        let pullDistance = e.touches[0].clientY - pullStartY;

        if (pullDistance > 100) {
            // Finger ist weit genug unten -> Timer starten
            if (!pullRefreshTimeout) {
                pullRefreshTimeout = setTimeout(_reloadApp, 2500); // Löst nach 2,5 Sekunden Halten aus
            }
        } else {
            // Wisch wieder nach oben -> Abbruch
            clearTimeout(pullRefreshTimeout);
            pullRefreshTimeout = null;
        }
    }, {passive: true});

    document.addEventListener('touchend', () => {
        isPullingToRefresh = false;
        clearTimeout(pullRefreshTimeout);
        pullRefreshTimeout = null;
    });

    setTimeout(() => {
        const inputIds = [
            'home-search-input', 
            'songs-search-input', 
            'pld-search-input', 
            'edit-input-title', 
            'edit-input-artist' 
        ];
        inputIds.forEach(id => {
            const input = document.getElementById(id);
            if (input) addClearButton(input);
        });
    }, 500);
    
    setTimeout(() => {
        if (typeof window.renderHomeSections === 'function') {
            window.renderHomeSections();
        }
    }, 800); 

} // END initApp()

// ==========================================
// 2. BULK IMPORT (Staging-Prinzip: roh hochladen, Server entscheidet über Duplikate am Inhalt)
// ==========================================
// AbortSignal.timeout gibt es erst ab Safari 16 – sicher kapseln
function _mkTimeout(ms) { try { return AbortSignal.timeout(ms); } catch(e) { return undefined; } }

// Gezieltes In-Memory- + DOM-Update eines einzelnen Songs (statt die ganze Liste neu zu rendern).
window.applySongPatch = function(id, patch) {
    if (window._songIndex) { const s = window._songIndex.get(id); if (s) Object.assign(s, patch); }
    document.querySelectorAll(`.song-item[data-id="${id}"]`).forEach(row => {
        if (patch.title != null) { const t = row.querySelector('.song-title'); if (t && !t.dataset.originalTitle) t.textContent = patch.title; }
        if (patch.artist != null) { const a = row.querySelector('.song-artist'); if (a) a.textContent = patch.artist; }
        if (patch.cover_data) {
            const c = row.querySelector('.song-cover');
            if (c) {
                c.style.backgroundImage = `url('${patch.cover_data}')`; c.style.backgroundSize = 'cover'; c.style.backgroundPosition = 'center';
                // Nicht komplett leeren – der "keine Vibes"-Punkt hängt als Kind im Cover und würde
                // sonst beim Cover-Update (z.B. Sync) mitgelöscht.
                const dot = c.querySelector('.no-vibes-dot');
                c.innerHTML = '';
                if (dot) c.appendChild(dot);
            }
        }
        if (patch.vibes !== undefined) {
            const c = row.querySelector('.song-cover');
            if (c) {
                const hasVibes = _parseVibes(patch.vibes).length > 0;
                let dot = c.querySelector('.no-vibes-dot');
                if (hasVibes && dot) dot.remove();
                else if (!hasVibes && !dot) { dot = document.createElement('span'); dot.className = 'no-vibes-dot'; c.appendChild(dot); }
            }
        }
    });
};

const oldFileInput = document.getElementById('native-file-upload');
if (oldFileInput) {
    const newFileInput = oldFileInput.cloneNode(true);
    oldFileInput.parentNode.replaceChild(newFileInput, oldFileInput);

    newFileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        const uploadLabel = document.querySelector('label[for="native-file-upload"]');
        const syncStatusDetail = document.getElementById('sync-status-detail');
        const setStatus = (msg, color = '#fff') => {
            if (syncStatusDetail) { syncStatusDetail.style.display = 'block'; syncStatusDetail.style.color = color; syncStatusDetail.innerText = msg; }
        };

        if (uploadLabel) uploadLabel.style.opacity = '0.5';
        window._importActive = true; // Sync pausieren, damit er den Import nicht stört

        // STAGING-PRINZIP – bewusst KEINE clientseitige Duplikat-Logik mehr:
        // Jede Datei wird roh nach R2 hochgeladen (R2 = Zwischenlager). Die Duplikat-Entscheidung
        // trifft ausschließlich der SERVER beim Registrieren (POST /songs): er liest die
        // Inhalts-Prüfsumme (ETag), die Cloudflare beim Upload über die BYTES berechnet hat,
        // vergleicht sie mit der Haupt-DB und verwirft Duplikate ({duplicate:true} + Datei wird
        // im Zwischenlager sofort gelöscht). Namen sind egal – nur der Inhalt zählt. Dadurch kann
        // hier clientseitig nichts mehr schiefgehen (alte Namensschemata, umbenannte Dateien etc.).
        const toUpload = files.map(file => ({ file, title: file.name.replace(/\.[^/.]+$/, "").trim() }));

        // Upload startet SOFORT. Worker-Pool + Durchsatz + Restzeit-Anzeige.
        const CONCURRENT = 5;
        let done = 0, dupes = 0, failed = 0, uploadedBytes = 0;
        const totalBytes = toUpload.reduce((a, x) => a + x.file.size, 0);
        const t0 = Date.now();
        const fmtMB = (b) => (b / 1048576).toFixed(0);
        function updateProgress() {
            const el = (Date.now() - t0) / 1000;
            const mbps = el > 0 ? (uploadedBytes / 1048576 / el) : 0;
            let eta = '';
            if (mbps > 0.05 && uploadedBytes > 0) {
                const secs = Math.round((totalBytes - uploadedBytes) / 1048576 / mbps);
                eta = ` · noch ~${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} min`;
            }
            setStatus(`⬆️ ${done + dupes}/${toUpload.length} · ${fmtMB(uploadedBytes)}/${fmtMB(totalBytes)} MB · ${mbps.toFixed(1)} MB/s${eta}${dupes > 0 ? ` · ${dupes} Duplikate` : ''}`);
        }
        updateProgress();

        async function uploadOne(file, title, attempt = 1) {
            const safeFilename = `fast_${Date.now()}_${Math.random().toString(36).slice(2,7)}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
            try {
                const uploadRes = await _apiFetch(`${API_URL}/upload/${safeFilename}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': file.type || 'audio/mpeg' },
                    body: file,
                    signal: _mkTimeout(180000) // fängt hängende Verbindungen ab, damit der Pool nie festfriert
                });
                if (!uploadRes.ok) throw new Error('upload failed');
                const uploadData = await uploadRes.json();

                const songRes = await _apiFetch(`${API_URL}/songs`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title, artist: "Unbekannt", cover_data: "",
                        file_url: uploadData.url, file_size: file.size, duration: 0, vibes: []
                    }),
                    signal: _mkTimeout(30000)
                });
                if (!songRes.ok) throw new Error('song create failed');
                const result = await songRes.json().catch(() => ({}));
                // Server-Tor hat entschieden: Datei war inhaltsgleich schon da → nicht doppelt gespeichert
                if (result && result.duplicate) dupes++; else done++;
                uploadedBytes += file.size;
            } catch(err) {
                if (attempt < 3) { await new Promise(r => setTimeout(r, 600 * attempt)); return uploadOne(file, title, attempt + 1); }
                failed++;
            }
            updateProgress();
        }

        // Worker-Pool: hält immer CONCURRENT Uploads gleichzeitig aktiv, ohne Head-of-Line-Blocking.
        let uploadIdx = 0;
        async function uploadWorker() {
            while (uploadIdx < toUpload.length) {
                const { file, title } = toUpload[uploadIdx++];
                await uploadOne(file, title);
            }
        }
        await Promise.all(Array.from({ length: CONCURRENT }, uploadWorker));

        // Sicherheitsnetz: Inhalts-Dedupe der Haupt-DB (fängt z.B. zwei zeitgleiche Uploads
        // derselben Datei im selben Batch ab). Löscht ausschließlich Byte-identische Einträge.
        let removed = 0;
        if (done > 0) {
            setStatus(`🧹 Prüfe auf Duplikate...`);
            try {
                const dRes = await _apiFetch(`${API_URL}/songs/dedupe`, { method: 'POST', signal: _mkTimeout(120000) });
                if (dRes.ok) { const d = await dRes.json().catch(() => ({})); removed = d.deleted || 0; }
            } catch(err) {}
        }

        window._importActive = false;
        if (uploadLabel) uploadLabel.style.opacity = '1';
        const skipped = dupes + removed;
        const summary = `✅ ${done - removed} neu importiert${skipped > 0 ? `, ${skipped} Duplikate übersprungen` : ''}${failed > 0 ? `, ${failed} fehlgeschlagen` : ''}`;
        setStatus(summary, failed > 0 ? '#ff9f0a' : '#32d74b');

        // Liste aktualisieren, dann Cover/Artist-Sync entkoppelt im Hintergrund
        if (window.fetchSongsFromDatabase) await window.fetchSongsFromDatabase(true);
        if (done > 0) setTimeout(processBackgroundSync, 1500);
    });
}

// ==========================================
// 3. BACKGROUND SYNC (primär iTunes; Spotify läuft nur als Fallback an, wenn iTunes nichts
//    findet – so bleibt das Anfragevolumen niedrig genug, dass Spotifys Rate-Limit nicht wieder
//    auslöst wie beim Vorfall mit 6 parallelen Workern. Wenn beide nichts finden, gilt der Song
//    als synchronisiert und wird nicht mehr automatisch retried – manuelle Nachbearbeitung im
//    Tag-Editor statt endlosem Warten.)
// ==========================================
let _syncRunning = false;
// Songs mit erfolglosem Sync-Versuch: Cooldown mit exponentiellem Backoff statt permanentem
// Blockieren. Vorher wurde ein Song nach einem Fehlversuch für den Rest der Sitzung komplett
// übersprungen und der Sync brach ab, sobald alle Reste einmal erfolglos dran waren – trotz
// Anzeige "später erneut versucht" gab es nie einen echten Reschedule. Jetzt läuft der Sync
// weiter, bis wirklich JEDER Song ein Cover hat; pro Song wächst die Pause nach jedem Fehlschlag
// (30s, 60s, 120s, ... gedeckelt bei 10 Min), damit iTunes nicht im Sekundentakt dieselbe
// erfolglose Suche bekommt.
const _syncCooldowns = new Map(); // id -> { nextRetryAt, attempts }
// Songs, für die weder iTunes noch Spotify einen Treffer haben (kryptische YouTube-Titel,
// Bootlegs/Mixtapes, die in keinem Katalog stehen), landen hier und werden nicht mehr automatisch
// retried – sonst blieb der Sync für immer bei "X ohne Treffer, nächster Versuch in Kürze" hängen,
// ohne je fertig zu werden. Persistiert in localStorage, damit ein Reload nicht wieder bei 0
// Versuchen anfängt. Der Song bleibt manuell im Tag-Editor bearbeitbar/erneut suchbar.
const _SYNC_GIVEUP_KEY = 'himusic_sync_giveup';
// Sicherheitsnetz für den Fall, dass Spotify dauerhaft im Rate-Limit-Cooldown hängt (dann wird
// nie wirklich beides versucht) – nach so vielen erfolglosen Durchläufen wird trotzdem aufgegeben.
const _SYNC_MAX_ATTEMPTS = 5;
let _syncGivenUp;
try { _syncGivenUp = new Set(JSON.parse(localStorage.getItem(_SYNC_GIVEUP_KEY) || '[]')); }
catch(e) { _syncGivenUp = new Set(); }
function _persistSyncGivenUp() {
    try { localStorage.setItem(_SYNC_GIVEUP_KEY, JSON.stringify(Array.from(_syncGivenUp))); } catch(e) {}
}

function _syncBackoffMs(attempts) {
    return Math.min(30000 * Math.pow(2, attempts - 1), 10 * 60 * 1000);
}

async function processBackgroundSync() {
    if (_syncRunning) return;
    // Während eines Imports komplett pausieren (window._importActive), damit der Sync weder Songs
    // anfasst, die gerade hochgeladen werden, noch mit den Uploads um Bandbreite konkurriert.
    if (window._importActive) { setTimeout(processBackgroundSync, 4000); return; }
    _syncRunning = true;

    const progressText = document.getElementById('sync-progress-text');
    const progressBar  = document.getElementById('sync-progress-bar');
    const statusDetail = document.getElementById('sync-status-detail');

    try {
        // Bibliothek EINMAL pro Durchlauf laden (früher passierte das alle 1,5 s → bei 1300+ Songs
        // dauerhaft langsam).
        const response = await _apiFetch(`${API_URL}/songs`, { signal: _mkTimeout(20000) });
        const songs = await response.json();
        const totalSongs = songs.length;
        const unsyncedAll = songs.filter(s => !s.cover_data && (s.artist === "Unbekannt" || s.artist === "" || s.artist === "Unbekannter Künstler"));
        // Songs mit ausgeschöpften Versuchen zählen für die Fortschrittsanzeige als "erledigt"
        // (sie sind halt manuell zu bearbeiten), sonst würde die Anzeige nie 100% erreichen.
        const unsyncedSongs = unsyncedAll.filter(s => !_syncGivenUp.has(s.id));
        const givenUpCount = unsyncedAll.length - unsyncedSongs.length;
        const alreadySynced = totalSongs - unsyncedSongs.length;
        const now = Date.now();
        // Nur die, deren Cooldown (falls vorhanden) schon abgelaufen ist
        const todo = unsyncedSongs.filter(s => {
            const cd = _syncCooldowns.get(s.id);
            return !cd || now >= cd.nextRetryAt;
        });

        if (progressText) progressText.innerText = `${alreadySynced} / ${totalSongs}`;
        if (progressBar) progressBar.style.width = totalSongs > 0 ? `${(alreadySynced / totalSongs) * 100}%` : '0%';

        if (unsyncedSongs.length === 0) {
            // Wirklich fertig – jeder Song hat entweder ein Cover oder wurde nach mehreren
            // erfolglosen Versuchen als manuell zu bearbeiten markiert. Kein Reschedule nötig,
            // ein neuer Import stößt den Sync über setTimeout(processBackgroundSync, 1500) an.
            if (statusDetail) {
                statusDetail.style.display = 'block';
                statusDetail.innerText = givenUpCount > 0
                    ? `Fertig – ${givenUpCount} ohne Treffer (bitte manuell im Tag-Editor bearbeiten)`
                    : "Alle Songs synchronisiert ✓";
                statusDetail.style.color = givenUpCount > 0 ? '#ff9f0a' : '#32d74b';
            }
            _syncRunning = false;
            return;
        }

        if (todo.length === 0) {
            // Alle Reste sind gerade im Cooldown – NICHT aufgeben, kurz warten und erneut prüfen.
            if (statusDetail) { statusDetail.style.display = 'block'; statusDetail.innerText = `${unsyncedSongs.length} ohne Treffer – nächster Versuch in Kürze...`; statusDetail.style.color = '#8e8e93'; }
            _syncRunning = false;
            setTimeout(processBackgroundSync, 10000);
            return;
        }

        if (statusDetail) { statusDetail.style.display = 'block'; statusDetail.innerText = `🔄 Synchronisiere ${todo.length} Songs...`; statusDetail.style.color = '#fa9a00'; }

        // Rückstand abarbeiten: 3 parallele Worker (6 haben Spotifys Rate-Limit ausgelöst → alle
        // Suchen schlugen mit 429 fehl, auch die manuellen). Jeder Worker aktualisiert nur seinen
        // Song gezielt in-place (kein Voll-Rerender der Liste).
        const PARALLEL = 3;
        let idx = 0, syncedNow = 0;

        async function syncWorker() {
            while (idx < todo.length) {
                if (window._importActive) return; // Import hat Vorrang → Durchlauf abbrechen
                const song = todo[idx++];
                let patch = null, matched = false, giveUpNow = false;
                try {
                    const meta = await searchSongMetaItunes(song.title, song.artist);
                    if (meta && meta.cover) {
                        patch = { title: meta.title, artist: meta.artist, album: meta.album || "", cover_data: meta.cover };
                        matched = true;
                    } else {
                        // iTunes ohne Treffer → Spotify als Fallback, aber nur wenn gerade kein
                        // Rate-Limit-Cooldown aktiv ist (siehe searchSongMetaSpotify). So bleibt das
                        // Anfragevolumen niedrig: Spotify wird nur für die iTunes-Fehlschläge angefragt,
                        // nicht für jeden Song.
                        const spotifyCoolingDown = window._spotifyCooldownUntil && Date.now() < window._spotifyCooldownUntil;
                        if (!spotifyCoolingDown) {
                            const sMeta = await searchSongMetaSpotify(song.title, song.artist);
                            if (sMeta && sMeta.rateLimited) {
                                // Rate-Limit gerade erst ausgelöst – nicht aufgeben, später erneut versuchen.
                            } else if (sMeta && sMeta.cover) {
                                patch = { title: sMeta.title, artist: sMeta.artist, album: sMeta.album || "", cover_data: sMeta.cover };
                                matched = true;
                            } else {
                                // Weder iTunes noch Spotify haben etwas gefunden → gilt als synchronisiert,
                                // manuelle Nachbearbeitung im Tag-Editor statt endlosem Retry.
                                giveUpNow = true;
                            }
                        }
                        if (!matched) {
                            patch = { title: song.title, artist: "Unbekannter Künstler", cover_data: "" };
                        }
                    }
                    await _apiFetch(`${API_URL}/songs/${song.id}`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...patch, vibes: _parseVibes(song.vibes) }),
                        signal: _mkTimeout(15000)
                    });
                    if (typeof window.applySongPatch === 'function') window.applySongPatch(song.id, patch);
                    if (matched) syncedNow++;
                } catch(e) { matched = false; }

                if (matched) {
                    _syncCooldowns.delete(song.id);
                } else if (giveUpNow) {
                    _syncCooldowns.delete(song.id);
                    _syncGivenUp.add(song.id);
                    _persistSyncGivenUp();
                } else {
                    const prevAttempts = (_syncCooldowns.get(song.id) || { attempts: 0 }).attempts + 1;
                    if (prevAttempts >= _SYNC_MAX_ATTEMPTS) {
                        _syncCooldowns.delete(song.id);
                        _syncGivenUp.add(song.id);
                        _persistSyncGivenUp();
                    } else {
                        _syncCooldowns.set(song.id, { nextRetryAt: Date.now() + _syncBackoffMs(prevAttempts), attempts: prevAttempts });
                    }
                }

                if (progressText) progressText.innerText = `${alreadySynced + syncedNow} / ${totalSongs}`;
                if (progressBar) progressBar.style.width = totalSongs > 0 ? `${((alreadySynced + syncedNow) / totalSongs) * 100}%` : '0%';
            }
        }
        await Promise.all(Array.from({ length: PARALLEL }, syncWorker));

        _syncRunning = false;
        // Kurz durchatmen, dann nächster Durchlauf (fängt neu importierte Songs und abgelaufene
        // Cooldowns). Endet automatisch erst, sobald unsyncedSongs.length === 0 oben.
        setTimeout(processBackgroundSync, 3000);

    } catch(err) { _syncRunning = false; setTimeout(processBackgroundSync, 15000); }
}
setTimeout(processBackgroundSync, 3000);

// ==========================================
// 4. YOUTUBE IMPORT
// ==========================================
// Primärweg: /youtube-queue – ein lokales Hilfsprogramm auf dem eigenen PC (Heim-IP, siehe
// local-import-watcher/) holt sich die Warteschlange und lädt herunter. Grund: GitHub-Actions-
// Runner-IPs werden von YouTube zunehmend als Bot geblockt (verifiziert: mehrere Videos
// scheiterten dort komplett, trotz PO-Token + TLS-Impersonation), die eigene Heim-IP hatte im
// Test keinen einzigen Block. Fällt automatisch auf /dispatch-import (GitHub Actions) zurück,
// falls der Worker die neue Route noch nicht kennt (z.B. vor einem Deploy) oder kein Watcher läuft.
// Ein YouTube-Import läuft asynchron auf einem entfernten Watcher/Runner – die Datei landet erst
// nach ca. 1-2 Min in der DB. Damit sie danach ohne manuellen Offline-Modus-Schalter direkt lokal
// verfügbar ist (Anforderung: YouTube-Downloads sollen automatisch offline-fähig sein), pollt diese
// Funktion kurz auf neue Songs mit einem YouTube-Import-Marker im file_url und cached sie sofort.
function _isYoutubeImportedUrl(fileUrl) {
    return !!fileUrl && (fileUrl.includes('_local_yt') || fileUrl.includes('/yt/'));
}

// Batch-Zähler für "Song X/Y lädt"-Anzeige: wächst mit jedem neu gestarteten Import, solange noch
// welche aus dem aktuellen Schwung offen sind; sobald alle fertig sind, setzt der nächste Start
// wieder bei 1 an (kein ewig wachsender Zähler über mehrere unabhängige Sessions hinweg).
window._ytBatchTotal = 0;
window._ytBatchDone = 0;

function _updateYtBatchProgress() {
    const el = document.getElementById('yt-batch-progress');
    if (!el) return;
    if (window._ytBatchTotal === 0 || window._ytBatchDone >= window._ytBatchTotal) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';
    el.innerText = `⏳ Song ${window._ytBatchDone + 1}/${window._ytBatchTotal} lädt...`;
}

function _ytBatchStart() {
    if (window._ytBatchDone >= window._ytBatchTotal) { window._ytBatchTotal = 0; window._ytBatchDone = 0; }
    window._ytBatchTotal++;
    _updateYtBatchProgress();
}

function _ytBatchFinish() {
    window._ytBatchDone++;
    _updateYtBatchProgress();
    if (window._ytBatchDone >= window._ytBatchTotal) {
        setTimeout(() => { window._ytBatchTotal = 0; window._ytBatchDone = 0; _updateYtBatchProgress(); }, 4000);
    }
}

async function _pollForFreshYtSongs(knownIds) {
    for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 8000));
        try {
            const res = await _apiFetch(`${API_URL}/songs`);
            if (!res.ok) continue;
            const songs = await res.json();
            const fresh = songs.filter(s => !knownIds.has(s.id) && _isYoutubeImportedUrl(s.file_url));
            if (fresh.length > 0) return fresh;
        } catch (e) {}
    }
    return null;
}

function _cacheFreshYtSongs(fresh) {
    fresh.forEach(s => { if (window.hbLocal) window.hbLocal.downloadToLocal(s.file_url, s.title); });
    if (typeof window.fetchSongsFromDatabase === 'function') window.fetchSongsFromDatabase(true);
}

// queueItemId ist gesetzt, wenn der Import über /youtube-queue lief (lokaler-Watcher-Weg): taucht
// der Song nach ~2 Min nicht auf, läuft dort vermutlich KEIN Watcher (Queue-POST meldet fälschlich
// "erfolgreich eingereiht", auch wenn niemand die Warteschlange abarbeitet – Songs blieben sonst
// für immer unbemerkt liegen). In dem Fall den hängenden Queue-Eintrag aufräumen und automatisch
// auf den GitHub-Actions-Fallback wechseln, statt den Nutzer im Unklaren zu lassen.
async function _watchForYoutubeImportAndCache(url, queueItemId, statusEl) {
    const knownIds = new Set((window.globalSongsData || []).map(s => s.id));
    try {
        const fresh = await _pollForFreshYtSongs(knownIds);
        if (fresh) { _cacheFreshYtSongs(fresh); return; }

        if (!queueItemId) {
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.innerText = '❌ Download nicht angekommen – bitte erneut versuchen.';
                statusEl.style.color = '#ff3b30';
                setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
            }
            return;
        }

        _apiFetch(`${API_URL}/youtube-queue/${queueItemId}`, { method: 'DELETE' }).catch(() => {});
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.innerText = '⚠️ Kein lokaler Watcher aktiv – wechsle zu Cloud-Fallback...';
            statusEl.style.color = '#fa9a00';
        }
        try {
            const response = await _apiFetch(`${API_URL}/dispatch-import`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ youtube_url: url }),
            });
            if (!response.ok) throw new Error(`Server: ${response.status}`);
            if (statusEl) {
                statusEl.innerText = '⏳ Cloud-Fallback gestartet, Song erscheint in ~2 Min.';
                statusEl.style.color = '#32d74b';
                setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
            }
            const fresh2 = await _pollForFreshYtSongs(knownIds);
            if (fresh2) { _cacheFreshYtSongs(fresh2); return; }
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.innerText = '❌ Download nicht angekommen – bitte erneut versuchen.';
                statusEl.style.color = '#ff3b30';
                setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
            }
        } catch (e) {
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.innerText = '❌ Cloud-Fallback fehlgeschlagen.';
                statusEl.style.color = '#ff3b30';
                setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
            }
        }
    } finally {
        _ytBatchFinish();
    }
}

async function startYoutubeImport(url, statusEl) {
    if (!url) return;
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.innerText = 'Wird eingereiht...';
        statusEl.style.color = '#fff';
    }
    try {
        const queueRes = await _apiFetch(`${API_URL}/youtube-queue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ youtube_url: url })
        });
        if (queueRes.ok) {
            const queueData = await queueRes.json().catch(() => ({}));
            if (statusEl) {
                statusEl.innerText = '⏳ In Warteschlange – dein lokaler Watcher lädt jetzt herunter.';
                statusEl.style.color = '#32d74b';
                setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
            }
            _ytBatchStart();
            _watchForYoutubeImportAndCache(url, queueData.id, statusEl);
            return true;
        }
        throw new Error(`Warteschlange nicht erreichbar (${queueRes.status})`);
    } catch (queueError) {
        // Fallback: GitHub-Actions-Kette (funktioniert auch ohne laufenden lokalen Watcher,
        // nur mit geringerer Erfolgsquote wegen Cloud-IP-Blocks).
        try {
            const response = await _apiFetch(`${API_URL}/dispatch-import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ youtube_url: url })
            });
            if (!response.ok) throw new Error(`Server: ${response.status}`);
            if (statusEl) {
                statusEl.innerText = '⏳ Download im Hintergrund gestartet (Cloud-Fallback)! Song erscheint in ~2 Min.';
                statusEl.style.color = '#32d74b';
                setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
            }
            _ytBatchStart();
            _watchForYoutubeImportAndCache(url, null, statusEl);
            return true;
        } catch (error) {
            if (statusEl) {
                statusEl.innerText = `❌ Fehler: ${error.message}`;
                statusEl.style.color = '#ff3b30';
                setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
            }
            return false;
        }
    }
}

// ── YouTube-Vorschau-Player (Play/Pause/Spulen) für die Suchergebnisse ──────────
// Nutzt die offizielle YouTube-IFrame-Player-API in einem unsichtbaren 1x1-Player: kein eigener
// Audio-Extraktionsschritt nötig, nur zum Reinhören VOR dem eigentlichen Download. Ein einzelner
// geteilter Player wird zwischen Ergebnissen wiederverwendet (nicht ein Player pro Zeile).
let _ytPlayer = null;
let _ytActiveRow = null;
let _ytSeekPollId = null;

function _ensureYtIframeApi() {
    return new Promise((resolve) => {
        if (window.YT && window.YT.Player) { resolve(); return; }
        if (!document.getElementById('yt-iframe-api-script')) {
            const s = document.createElement('script');
            s.id = 'yt-iframe-api-script';
            s.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(s);
        }
        const prevCallback = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prevCallback) prevCallback(); resolve(); };
    });
}

function _ensureYtPlayer() {
    if (_ytPlayer) return Promise.resolve(_ytPlayer);
    return _ensureYtIframeApi().then(() => new Promise((resolve) => {
        _ytPlayer = new YT.Player('yt-preview-player', {
            height: '1', width: '1',
            playerVars: { autoplay: 0, controls: 0 },
            events: {
                onReady: () => resolve(_ytPlayer),
                onStateChange: _onYtPlayerStateChange,
            },
        });
    }));
}

function _resetYtRowUI(row) {
    if (!row) return;
    const btn = row.querySelector('.yt-preview-playbtn');
    if (btn) btn.innerText = '▶';
    const seekWrap = row.querySelector('.yt-preview-seekwrap');
    if (seekWrap) seekWrap.style.display = 'none';
}

function _stopYtSeekPoll() { if (_ytSeekPollId) clearInterval(_ytSeekPollId); _ytSeekPollId = null; }

function _startYtSeekPoll() {
    _stopYtSeekPoll();
    _ytSeekPollId = setInterval(() => {
        if (!_ytActiveRow || !_ytPlayer || typeof _ytPlayer.getDuration !== 'function') return;
        const seekEl = _ytActiveRow.querySelector('.yt-preview-seek');
        if (seekEl && !seekEl._dragging) {
            const dur = _ytPlayer.getDuration() || 0;
            seekEl.max = Math.floor(dur) || 100;
            seekEl.value = Math.floor(_ytPlayer.getCurrentTime() || 0);
        }
    }, 500);
}

function _onYtPlayerStateChange(e) {
    if (!_ytActiveRow) return;
    const btn = _ytActiveRow.querySelector('.yt-preview-playbtn');
    if (e.data === YT.PlayerState.PLAYING) { if (btn) btn.innerText = '⏸'; _startYtSeekPoll(); }
    else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) { if (btn) btn.innerText = '▶'; _stopYtSeekPoll(); }
}

function _stopYtPreview() {
    if (_ytPlayer && typeof _ytPlayer.pauseVideo === 'function') { try { _ytPlayer.pauseVideo(); } catch (e) {} }
    _resetYtRowUI(_ytActiveRow);
    _ytActiveRow = null;
    _stopYtSeekPoll();
}

async function _toggleYtPreview(row, videoId) {
    const player = await _ensureYtPlayer();
    if (_ytActiveRow && _ytActiveRow !== row) _resetYtRowUI(_ytActiveRow);

    const wasActive = _ytActiveRow === row;
    const state = typeof player.getPlayerState === 'function' ? player.getPlayerState() : -1;

    if (wasActive && state === YT.PlayerState.PLAYING) { player.pauseVideo(); return; }
    if (wasActive && state === YT.PlayerState.PAUSED) { player.playVideo(); return; }

    _ytActiveRow = row;
    const seekWrap = row.querySelector('.yt-preview-seekwrap');
    if (seekWrap) seekWrap.style.display = 'flex';
    player.loadVideoById(videoId);
}

document.addEventListener('DOMContentLoaded', () => {
    // ── Manueller Link-Import (Fallback) ────────────────────
    const ytInput = document.getElementById('youtube-url-input');
    const ytBtn = document.getElementById('youtube-import-btn');
    const ytStatus = document.getElementById('youtube-status');
    const ytClearBtn = document.getElementById('youtube-clear-btn');

    if (ytInput && ytClearBtn) {
        ytInput.addEventListener('input', () => { ytClearBtn.style.display = ytInput.value.length > 0 ? 'block' : 'none'; });
        ytClearBtn.addEventListener('click', () => { ytInput.value = ''; ytClearBtn.style.display = 'none'; ytInput.focus(); });
    }

    if (ytBtn && ytInput) {
        ytBtn.addEventListener('click', async () => {
            const url = ytInput.value.trim();
            if (!url) return;
            ytBtn.disabled = true; ytBtn.style.opacity = '0.5';
            await startYoutubeImport(url, ytStatus);
            ytInput.value = '';
            if (ytClearBtn) ytClearBtn.style.display = 'none';
            ytBtn.disabled = false; ytBtn.style.opacity = '1';
        });
    }

    // ── Songsuche: Name eingeben → YouTube-Ergebnisse → auswählen ──
    const searchInput   = document.getElementById('yt-search-input');
    const searchBtn      = document.getElementById('yt-search-btn');
    const searchStatus   = document.getElementById('yt-search-status');
    const searchClearBtn = document.getElementById('yt-search-clear-btn');
    const resultsBox      = document.getElementById('yt-search-results');

    if (searchInput && searchClearBtn) {
        searchInput.addEventListener('input', () => { searchClearBtn.style.display = searchInput.value.length > 0 ? 'block' : 'none'; });
        searchClearBtn.addEventListener('click', () => {
            searchInput.value = ''; searchClearBtn.style.display = 'none'; searchInput.focus();
            _stopYtPreview();
            if (resultsBox) resultsBox.innerHTML = '';
        });
    }

    async function runSearch() {
        const q = searchInput.value.trim();
        if (!q || !resultsBox) return;
        searchBtn.disabled = true; searchBtn.style.opacity = '0.5';
        searchStatus.style.display = 'block';
        searchStatus.innerText = 'Suche läuft...';
        searchStatus.style.color = '#aaa';
        _stopYtPreview();
        resultsBox.innerHTML = '';

        try {
            const res = await _apiFetch(`${API_URL}/youtube-search?q=${encodeURIComponent(q)}`);
            if (!res.ok) throw new Error(`Server: ${res.status}`);
            const data = await res.json();
            const items = data.results || [];

            if (items.length === 0) {
                searchStatus.innerText = 'Keine Ergebnisse gefunden.';
                searchStatus.style.color = '#aaa';
            } else {
                searchStatus.style.display = 'none';
            }

            items.forEach(item => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:8px; border-radius:10px; background:rgba(255,255,255,0.06); backdrop-filter:blur(20px) saturate(180%); -webkit-backdrop-filter:blur(20px) saturate(180%); border:0.5px solid rgba(255,255,255,0.1);';
                row.innerHTML = `
                  <div style="display:flex; align-items:center; gap:10px;">
                    <img src="${_esc(item.thumbnail)}" style="width:64px; height:48px; border-radius:6px; object-fit:cover; flex-shrink:0;">
                    <div style="min-width:0; flex:1;">
                        <div style="font-size:14px; font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${_esc(item.title)}</div>
                        <div style="font-size:12px; color:#aaa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${_esc(item.channelTitle)}${item.duration ? ' · ' + _esc(item.duration) : ''}</div>
                    </div>
                    <button class="yt-preview-playbtn" title="Anhören" style="flex-shrink:0; width:36px; height:36px; border-radius:50%; border:none; background:rgba(255,255,255,0.15); color:#fff; font-size:14px; cursor:pointer;">▶</button>
                    <button class="yt-download-btn" title="Herunterladen" style="flex-shrink:0; padding:8px 14px; border-radius:8px; border:none; background:#fa233b; color:#fff; font-size:16px; cursor:pointer;">⬇</button>
                  </div>
                  <div class="yt-preview-seekwrap" style="display:none; align-items:center; gap:8px; padding:0 4px;">
                    <input type="range" class="yt-preview-seek" min="0" max="100" value="0" step="1" style="flex:1; accent-color:#fa233b;">
                  </div>
                `;
                const playBtn = row.querySelector('.yt-preview-playbtn');
                const downloadBtn = row.querySelector('.yt-download-btn');
                const seekEl = row.querySelector('.yt-preview-seek');

                playBtn.addEventListener('click', () => _toggleYtPreview(row, item.videoId));
                seekEl.addEventListener('pointerdown', () => { seekEl._dragging = true; });
                seekEl.addEventListener('change', () => {
                    seekEl._dragging = false;
                    if (_ytPlayer && _ytActiveRow === row) _ytPlayer.seekTo(Number(seekEl.value), true);
                });

                downloadBtn.addEventListener('click', async () => {
                    downloadBtn.disabled = true; downloadBtn.style.opacity = '0.5';
                    if (_ytActiveRow === row) _stopYtPreview();
                    searchStatus.style.display = 'block';
                    await startYoutubeImport(`https://www.youtube.com/watch?v=${item.videoId}`, searchStatus);
                    row.remove();
                });
                resultsBox.appendChild(row);
            });
        } catch (error) {
            searchStatus.innerText = `❌ Fehler: ${error.message}`;
            searchStatus.style.color = '#ff3b30';
        } finally {
            searchBtn.disabled = false; searchBtn.style.opacity = '1';
        }
    }

    if (searchBtn) searchBtn.addEventListener('click', runSearch);
    if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
});