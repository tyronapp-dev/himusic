const API_URL = window.HiMusicConfig?.apiBaseUrl || 'https://heatbox-api.tyron-app.workers.dev';

function _parseVibes(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch(e) { return []; } }
    return [];
}

async function apiGetAllSongs() {
  const response = await fetch(`${API_URL}/songs`);
  if (!response.ok) throw new Error('Failed to fetch songs');
  return await response.json();
}

async function apiCreateSong(songData) {
  const response = await fetch(`${API_URL}/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(songData) });
  if (!response.ok) throw new Error('Failed to create song');
  return await response.json();
}

async function apiUpdateSong(songId, updates) {
  const response = await fetch(`${API_URL}/songs/${songId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  if (!response.ok) throw new Error('Failed to update song');
  return await response.json();
}

async function apiDeleteSong(songId) {
  const response = await fetch(`${API_URL}/songs/${songId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete song');
  return await response.json();
}

async function apiGetAllPlaylists() {
  const response = await fetch(`${API_URL}/playlists`);
  if (!response.ok) throw new Error('Failed to fetch playlists');
  return await response.json();
}

async function apiCreatePlaylist(name) {
  const response = await fetch(`${API_URL}/playlists`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Server blockiert (Status ${response.status}): ${errText}`);
  }
  return await response.json();
}

async function apiDeletePlaylist(playlistId) {
  const response = await fetch(`${API_URL}/playlists/${playlistId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete playlist');
  return await response.json();
}

async function apiGetPlaylistSongs(playlistId) {
  const response = await fetch(`${API_URL}/playlists/${playlistId}/songs`);
  if (!response.ok) throw new Error('Failed to fetch playlist songs');
  return await response.json();
}

async function apiAddSongsToPlaylist(playlistId, songIds) {
  const response = await fetch(`${API_URL}/playlists/${playlistId}/songs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ song_ids: songIds }) });
  if (!response.ok) throw new Error('Failed to add songs to playlist');
  return await response.json();
}

async function apiRemoveSongFromPlaylist(playlistId, songId) {
  const response = await fetch(`${API_URL}/playlists/${playlistId}/songs/${songId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to remove song from playlist');
  return await response.json();
}

async function apiUpdatePlaylist(playlistId, updates) {
  const response = await fetch(`${API_URL}/playlists/${playlistId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  if (!response.ok) throw new Error('Failed to update playlist');
  return await response.json();
}

async function apiReorderPlaylistSongs(playlistId, updates) {
  const response = await fetch(`${API_URL}/playlists/${playlistId}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }) });
  if (!response.ok) throw new Error('Failed to reorder playlist songs');
  return await response.json();
}

function updatePlayerBackground(color1, color2) {
    const bg = document.querySelector('.dynamic-bg');
    if (!bg) return;
    bg.style.backgroundImage = `radial-gradient(at 0% 10%, ${color1}66 0px, transparent 60%), radial-gradient(at 100% 20%, ${color2}44 0px, transparent 60%), radial-gradient(at 50% 100%, rgba(0, 0, 0, 1) 0px, transparent 100%)`;
    document.documentElement.style.setProperty('--accent', color1);
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

async function fetchCoverFromiTunes(title, artist, retryCount = 0) {
    let queryParts = [];
    if (title && title.trim() !== "") queryParts.push(title.trim());
    if (artist && artist.trim() !== "" && artist !== "Unbekannter Künstler") queryParts.push(artist.trim());
    if (queryParts.length === 0) return null; 

    try {
        const query = encodeURIComponent(queryParts.join(" "));
        const response = await fetch(`https://itunes.apple.com/search?term=${query}&entity=song&limit=1`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.results && data.results.length > 0) return data.results[0].artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg');
        return null;
    } catch (e) {
        if (retryCount < 2 && (e.name === 'AbortError' || e.message.includes('Failed to fetch'))) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return fetchCoverFromiTunes(title, artist, retryCount + 1);
        }
        return null;
    }
}

const AVAILABLE_VIBES = ["Afro", "Ghana", "RnB", "Old School", "Deepdream", "LD", "Calm", "SAD", "Gym", "HYPE", "Carpool", "Amapiano", "Hard rap", "Dancehall", "Rap", "Summer", "Latenight", "Dance", "Christ", "Soul", "Exotic", "N-rei"];

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
            volume: document.getElementById('volume-slider')?.value || 1,
            eq: {
                isOn: document.getElementById('eq-power-toggle')?.checked || false,
                preamp: document.getElementById('eq-preamp')?.value || 0,
                preset: document.querySelector('.eq-preset.active')?.dataset.mode || 'classic'
            }
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

            if (state.eq) {
                const eqPreamp = document.getElementById('eq-preamp');
                if (state.eq.preamp && eqPreamp) {
                    eqPreamp.value = state.eq.preamp;
                    updateSliderFill(eqPreamp, -12, 12);
                    const valEl = document.getElementById('eq-preamp-val');
                    if(valEl) valEl.innerText = (state.eq.preamp > 0 ? '+' : '') + state.eq.preamp + ' dB';
                }
                if (state.eq.preset) {
                    document.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
                    const presetBtn = document.querySelector(`.eq-preset[data-mode="${state.eq.preset}"]`);
                    if(presetBtn) presetBtn.classList.add('active');
                }
               if (state.eq.isOn) {
                    const eqToggle = document.getElementById('eq-power-toggle');
                    if(eqToggle) { eqToggle.checked = true; } 
                }
            }
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
        if (document.visibilityState === 'hidden') savePlayerState();
        else {
            setTimeout(() => {
                if (audioPlayer && audioPlayer.paused && window._shouldBePlaying && audioPlayer.src) {
                    audioPlayer.play().catch(() => {});
                }
            }, 500);
        }
    });
    setInterval(() => { if (memAudio && !memAudio.paused && memAudio.currentTime > 0) _doSavePlayerState(); }, 5000);

    const navButtons = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');
    navButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            navButtons.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
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
    const playPauseBtns = [document.querySelector('#mini-player svg'), document.querySelector('.play-large'), document.getElementById('home-np-playpause')];
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
            window._shouldBePlaying = true; 
            try { await audioPlayer.play(); } catch(err){}
        } else { 
            window._shouldBePlaying = false; 
            audioPlayer.pause(); 
        }
    };
    playPauseBtns.forEach(btn => { if(btn) btn.addEventListener('click', window.togglePlayPause); });

    audioPlayer.addEventListener('play', () => {
        window._shouldBePlaying = true;
        window.updatePlayPauseIcons(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "playing";
    });
    
    audioPlayer.addEventListener('pause', () => {
        window._shouldBePlaying = false;
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
        const IDLE_PARALLEL = 3; // 3 Spuren unsichtbar im Hintergrund

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
            } else { downloadToLocal(fileUrl, title); }
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
        if(miniCover) { miniCover.style.backgroundImage = bgStyle !== 'none' ? bgStyle : 'var(--accent)'; miniCover.style.backgroundSize = 'cover'; }
        if(miniTitle) miniTitle.innerText = title;

        const bpTitle = document.getElementById('bp-song-name');
        const bpArtist = document.getElementById('bp-artist-name');
        const largeCover = document.querySelector('.large-cover');
        const bpHv = document.getElementById('bp-header-vibes');
        
        if(bpTitle) bpTitle.innerText = title;
        if(bpArtist) bpArtist.innerText = artist;
        if(largeCover) { largeCover.style.backgroundImage = bgStyle !== 'none' ? bgStyle : 'var(--accent)'; largeCover.style.backgroundSize = 'cover'; }
        if(bpHv) bpHv.innerText = window.currentSongData.vibes?.join(' • ') || "Aktueller Titel";

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
        let coverHtml = '';
        if (song.cover_data && song.cover_data.length > 10) { coverHtml = `<div class="song-cover" style="background-image: url('${song.cover_data}'); background-size: cover; background-position: center; border-radius: 6px;"></div>`; } 
        else { const hue = Math.floor(Math.random() * 360); coverHtml = `<div class="song-cover" style="background: hsl(${hue}, 70%, 50%); display:flex; justify-content:center; align-items:center; border-radius: 6px;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`; }
        
        songDiv.innerHTML = `
            <div class="song-checkbox"></div>
            ${coverHtml}
            <div class="song-info">
                <div class="song-title">${song.title}</div>
                <div class="song-artist">${song.artist}</div>
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

        let songStartX = 0; let isSwiping = false;
        songDiv.addEventListener('touchstart', (e) => { songStartX = e.touches[0].clientX; isSwiping = false; }, {passive: true});
        songDiv.addEventListener('touchmove', (e) => { if (!songStartX) return; if (Math.abs(songStartX - e.touches[0].clientX) > 20) isSwiping = true; }, {passive: true});
        songDiv.addEventListener('touchend', (e) => {
            if (!songStartX || !isSwiping) return;
            let diffX = songStartX - e.changedTouches[0].clientX;
            if (Math.abs(diffX) > 60) {
                if (diffX < 0) { 
                    playbackQueue.unshift(song); savePlayerState();
                    const originalBg = songDiv.style.background; songDiv.style.background = 'rgba(250, 35, 59, 0.2)'; setTimeout(() => songDiv.style.background = originalBg, 300);
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
                    const uploadResponse = await fetch(`${API_URL}/upload/${safeFileName}`, { method: 'PUT', body: file });
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
    const btnSaveTags = document.getElementById('btn-save-tags');

    let currentEditCoverData = "";

    if(ctxEditTags) {
        ctxEditTags.addEventListener('click', () => {
            if(songContextOverlay) songContextOverlay.classList.remove('active');
            let song = (window._songIndex?.get(window.currentContextSongId)) || (window._songIndex?.get(parseInt(window.currentContextSongId)));
            if (!song && window.currentSongData && window.currentSongData.id == window.currentContextSongId) { song = window.currentSongData; }
            if (!song) { alert("Lied noch nicht vollständig geladen. Bitte kurz warten."); return; }

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

    if (btnSearchItunes) {
        btnSearchItunes.addEventListener('click', async () => {
            btnSearchItunes.innerText = "Suche...";
            const newUrl = await fetchCoverFromiTunes(editTitle.value, editArtist.value);
            if (newUrl) { currentEditCoverData = newUrl; editCoverPreview.src = newUrl; btnSearchItunes.innerHTML = "Cover gefunden!"; } 
            else { btnSearchItunes.innerHTML = "Nichts gefunden"; }
            setTimeout(() => btnSearchItunes.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 5px; margin-top: -2px;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> In iTunes suchen`, 2000);
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

            const song = window._songIndex?.get(window.currentContextSongId) || window._songIndex?.get(parseInt(window.currentContextSongId));
            if (song) Object.assign(song, changes);

            if (!navigator.onLine) {
                _savePendingEdit(window.currentContextSongId, changes);
                editOverlay.classList.remove('active'); btnSaveTags.innerText = "Speichern"; _showToast('✈️ Offline gespeichert – wird synchronisiert wenn online');
                return;
            }

            try {
                await apiUpdateSong(window.currentContextSongId, changes);
                editOverlay.classList.remove('active');
                
                const songId = window.currentContextSongId;
                const songElement = document.querySelector(`.song-item[data-id="${songId}"]`);
                if (songElement) {
                    const coverImg = songElement.querySelector('.song-cover img');
                    if (coverImg && changes.cover_data) coverImg.src = changes.cover_data;
                    const titleEl = songElement.querySelector('.song-title');
                    const artistEl = songElement.querySelector('.song-artist');
                    if (titleEl) titleEl.textContent = changes.title;
                    if (artistEl) artistEl.textContent = changes.artist;
                    
                    if (window.currentPlayingSongId == songId) {
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
            } catch (error) { _savePendingEdit(window.currentContextSongId, changes); _showToast('⚠️ Fehler – lokal gesichert'); }
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

            if (window.currentSortTarget !== 'playlist' && criteria === 'created_at') {
                const sorted = [...lazyAllSongs].sort((a, b) => { const diff = parseInt(a.id) - parseInt(b.id); return sortAscending ? diff : -diff; });
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
        if (_noVibeFilterActive) { _noVibeFilterActive = false; songsContainer.innerHTML = ''; allSongsElements.forEach(el => songsContainer.appendChild(el)); return; }
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
            else { const div = document.createElement('div'); div.className = 'song-item'; div.dataset.id = song.id; updateSongDOM(div, song); songsContainer.appendChild(div); }
        });
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
                if (!el) { el = document.createElement('div'); el.className = 'song-item'; el.dataset.id = song.id; updateSongDOM(el, song); allSongsElements.push(el); }
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
        if (cachedPlaylists && cachedPlaylists.length > 0) { window.globalPlaylistsData = cachedPlaylists; if (typeof window.renderHomeSections === 'function') window.renderHomeSections(); _renderPlaylistsUI(cachedPlaylists, []); }

        const now = Date.now();
        if (_fetchPlaylistsRunning) return; if (!force && cachedPlaylists && (now - _playlistsLastFetched) < 60000) return;
        _fetchPlaylistsRunning = true;

        try {
            const playlists = await apiGetAllPlaylists();
            window.globalPlaylistsData = playlists; _playlistsLastFetched = Date.now();
            try { localStorage.setItem('heatbox_playlists_snapshot', JSON.stringify(playlists)); } catch(e) {}
            if (typeof window.renderHomeSections === 'function') window.renderHomeSections();
            if (typeof window.updateAppStats === 'function') window.updateAppStats();
            _renderPlaylistsUI(playlists, []); 
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
                    
                    pDiv.innerHTML = `<div class="song-checkbox playlist-checkbox"></div>${coverHtml}<div class="song-info"><div class="song-title">${playlist.name}</div><div class="song-artist">Playlist • ${statText}</div></div><button class="list-play-btn icon-btn" style="margin-left: auto; padding: 10px; color: var(--accent);"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><button class="playlist-context-btn icon-btn" style="padding: 10px; color: var(--text-secondary);"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.5"></circle><circle cx="12" cy="12" r="2.5"></circle><circle cx="12" cy="19" r="2.5"></circle></svg></button>`;

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
            else { playlists.forEach(playlist => { const btn = document.createElement('button'); btn.className = 'sheet-btn'; btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-secondary);"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg> ${playlist.name}`; btn.addEventListener('click', () => addSelectedSongsToPlaylist(playlist.id, playlist.name)); availablePlaylistsContainer.appendChild(btn); }); }
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
            setTimeout(() => { document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active')); const plNavBtn = document.querySelector('.nav-btn[data-target="view-playlists"]'); if (plNavBtn) plNavBtn.classList.add('active'); document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); }); const viewPlaylists = document.getElementById('view-playlists'); if (viewPlaylists) { viewPlaylists.classList.remove('hidden'); setTimeout(() => viewPlaylists.classList.add('active'), 10); } if (typeof window.openPlaylistDetails === 'function') { window.openPlaylistDetails(playlistId, playlistName, true); } }, 300);
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
                card.innerHTML = `<div class="station-cover" style="background-image: ${bgImage};"><button class="cover-play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div><div class="station-title">${rp.name}</div>`;
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
                    card.innerHTML = `<div class="station-cover" style="background-image: ${bgImage};"><button class="cover-play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div><div class="station-title">${mix.name}</div>`;
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
                    card.innerHTML = `<div class="station-cover" style="background-image: ${bgImage};"><button class="cover-play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div><div class="station-title">${station.name}</div>`;
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

    const eqPreamp = document.getElementById('eq-preamp');
    if(eqPreamp) {
        updateSliderFill(eqPreamp, -12, 12);
        eqPreamp.addEventListener('input', (e) => { if(window.preamp) window.preamp.gain.value = Math.pow(10, e.target.value / 20); const valStr = (e.target.value > 0 ? '+' : '') + e.target.value + ' dB'; const valDisplay = document.getElementById('eq-preamp-val'); if(valDisplay) valDisplay.innerText = valStr; updateSliderFill(e.target, -12, 12); });
        eqPreamp.addEventListener('change', savePlayerState);
    }

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
            div.innerHTML = `<div class="song-cover" style="background:${cover};background-size:cover;position:relative;"><div class="playing-anim" style="position:absolute;bottom:5px;right:5px;transform:scale(0.6);"><span></span><span></span><span></span></div></div><div class="song-info"><div class="song-title" style="color:var(--accent);font-size:16px;">${song.title}</div><div class="song-artist">${song.artist}</div></div><div style="font-size:10px;color:var(--accent);font-weight:700;letter-spacing:1px;flex-shrink:0;">LÄUFT</div>`;
            div.addEventListener('click', () => { audioPlayer.currentTime = 0; audioPlayer.play(); });
        } else if (type === 'history') {
            div.style.opacity = '0.5';
            div.innerHTML = `<div class="song-cover" style="background:${cover};background-size:cover;"></div><div class="song-info"><div class="song-title">${song.title}</div><div class="song-artist">${song.artist}</div></div><div style="font-size:10px;color:var(--text-secondary);flex-shrink:0;padding-right:4px;">DAVOR</div>`;
            div.addEventListener('click', () => {
                const idx = playbackHistory.indexOf(song); if (idx === -1) return;
                const songsAfter = playbackHistory.splice(idx + 1); if (window.currentSongData) songsAfter.push(window.currentSongData);
                playbackQueue = [...songsAfter.reverse(), ...playbackQueue]; playbackHistory.splice(idx, 1); window.currentContextSongId = song.id || window.currentContextSongId; _skipNextHistoryPush = true; 
                window.playSong(song.title, song.artist, song.cover_data || song.coverUrl, song.file_url || song.fileUrl); document.getElementById('queue-overlay').classList.remove('active');
            });
        } else { 
            div.innerHTML = `<div class="song-cover" style="background:${cover};background-size:cover;"></div><div class="song-info"><div class="song-title">${song.title}</div><div class="song-artist">${song.artist}</div></div><div class="drag-handle" style="display:block;flex-shrink:0;">≡</div>`;
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

    const hdAudioToggle = document.getElementById('setting-hd-audio');
    if (hdAudioToggle) { hdAudioToggle.addEventListener('change', (e) => { if (e.target.checked) { if(audioPlayer) audioPlayer.volume = 1.0; alert("HD Audio aktiviert! Maximale Qualität & Lautstärke geladen."); } }); }

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
        if (savedColor) { colorPicker.value = savedColor; document.documentElement.style.setProperty('--accent', savedColor); }
        colorPicker.addEventListener('input', (e) => { const newColor = e.target.value; document.documentElement.style.setProperty('--accent', newColor); localStorage.setItem('heatbox_theme_color', newColor); if(typeof window.updateActiveHighlights === 'function') window.updateActiveHighlights(); });
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

    document.querySelectorAll('.action-sheet-overlay').forEach(overlay => {
        const sheet = overlay.querySelector('.action-sheet'); if(!sheet) return;
        let sheetStartY = 0; let swipeStartedInScrollable = false;
        sheet.addEventListener('touchstart', (e) => { sheetStartY = e.touches[0].clientY; const scrollable = e.target.closest('.vibes-container, [style*="overflow-y: auto"], [style*="overflow-y:auto"], .song-container, #queue-list, #dup-results-container'); swipeStartedInScrollable = !!scrollable; }, {passive: true});
sheet.addEventListener('touchend', (e) => {
            if(!sheetStartY || swipeStartedInScrollable) { sheetStartY = 0; swipeStartedInScrollable = false; return; }
            let diffY = e.changedTouches[0].clientY - sheetStartY;
            if(diffY > 70) overlay.classList.remove('active');
            sheetStartY = 0;
            swipeStartedInScrollable = false;
        });
    });

    document.querySelectorAll('.action-sheet-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.remove('active');
            }
        });
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
                        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${keep?.title||'?'}</div>
                        <div style="font-size:11px;color:var(--text-secondary);">${keep?.artist||'?'} · ${group.length}×</div>
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
            const MAX_CONCURRENT = 6; // Vollgas: Nutzt das absolute Browser-Limit aus

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
                pullRefreshTimeout = setTimeout(() => {
                    clearTimeout(_saveTimer);
                    _doSavePlayerState();
                    document.body.style.transition = 'opacity 0.3s';
                    document.body.style.opacity = '0.5';
                    window.location.reload();
                }, 2000); // Löst nach exakt 2 Sekunden aus
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
// YOUTUBE IMPORT LOGIK & CLEAR BUTTON
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const ytInput = document.getElementById('youtube-url-input');
    const ytBtn = document.getElementById('youtube-import-btn');
    const ytStatus = document.getElementById('youtube-status');
    const ytClearBtn = document.getElementById('youtube-clear-btn');

    // Zeige das X nur an, wenn Text im Feld steht
    if (ytInput && ytClearBtn) {
        ytInput.addEventListener('input', () => {
            ytClearBtn.style.display = ytInput.value.length > 0 ? 'block' : 'none';
        });

        // Klick auf das X löscht das Feld sofort
        ytClearBtn.addEventListener('click', () => {
            ytInput.value = '';
            ytClearBtn.style.display = 'none';
            ytInput.focus(); 
        });
    }

    if(ytBtn && ytInput) {
        ytBtn.addEventListener('click', async () => {
            const url = ytInput.value.trim();
            if(!url.includes('youtube.com') && !url.includes('youtu.be')) {
                alert('Bitte einen gültigen YouTube-Link eingeben!');
                return;
            }

            ytBtn.disabled = true;
            ytBtn.style.opacity = '0.5';
            ytStatus.style.display = 'block';
            ytStatus.innerText = 'Lade Video herunter und konvertiere... (Das dauert ein paar Sekunden)';
            ytStatus.style.color = '#fff';

            try {
                const response = await fetch(`${API_URL}/import-youtube`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ youtube_url: url })
                });

                if(!response.ok) {
                    const errText = await response.text();
                    throw new Error('Server-Fehler: ' + errText);
                }
                
                ytInput.value = '';
                if(ytClearBtn) ytClearBtn.style.display = 'none'; 
                ytStatus.innerText = '✅ Song erfolgreich importiert!';
                ytStatus.style.color = '#32d74b';
                
                if(window.fetchSongsForPage) {
                    await window.fetchSongsForPage(true);
                }

            } catch (error) {
                ytStatus.innerText = '❌ Fehler: ' + error.message;
                ytStatus.style.color = '#ff3b30';
            } finally {
                ytBtn.disabled = false;
                ytBtn.style.opacity = '1';
                setTimeout(() => { if(ytStatus.innerText.includes('✅')) ytStatus.style.display = 'none'; }, 4000);
            }
        });
    }
});