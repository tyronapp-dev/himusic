window.HiMusicConfig = {
    // Trage hier deinen exakten Worker-Link aus dem letzten Schritt ein
    apiBaseUrl: "https://himusic-api.tyron-app.workers.dev"
    // Kein apiKey-Feld mehr hier (siehe ADR-006): der Key wird erst nach erfolgreichem Login
    // per POST /auth/login vom Worker geholt und nur noch in localStorage gehalten, nie mehr
    // in einer getrackten Datei committed.
};