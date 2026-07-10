window.HiMusicConfig = {
    // Trage hier deinen exakten Worker-Link aus dem letzten Schritt ein
    apiBaseUrl: "https://himusic-api.tyron-app.workers.dev",
    // Muss exakt dem API_KEY-Secret entsprechen, das im Worker gesetzt ist (Cloudflare Dashboard
    // -> Worker -> Settings -> Variables and Secrets). Schuetzt nur vor zufaelligem/automatisiertem
    // Zugriff auf die offene Worker-URL, NICHT vor jemandem, der diese App im Browser oeffnet und
    // die Netzwerk-Requests inspiziert - der Key steht dort sichtbar in jedem Request-Header.
    apiKey: "CcOM2sYl2LfkpuIuSYKTh1S42hPJwoY4RW2lMy0yxPQ"
};