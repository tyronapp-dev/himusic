# Himusic Player (native Hülle)

iOS-App, die die komplette himusic-Weboberfläche in einem WKWebView trägt und nur den Ton nativ
über AVPlayer abspielt — der Grund dafür steht in
[ADR-007](../docs/decisions/ADR-007-native-player-companion-app.md). Bibliothek, Suche, Import,
Tagging laufen unverändert als dieselbe Webseite (live von GitHub Pages), UI-Änderungen brauchen
deshalb keinen App-Neubau.

**Status: auf Gerät getestet und funktionsfähig** (08.08.2026) — Hintergrund-Wiedergabe bei
gesperrtem Bildschirm + korrekte Control-Center-Anzeige laufen. Zusätzlich ein persistenter
nativer Datei-Cache (`AudioFileCache.swift`, 8 GB Cap, LRU-Verdrängung) — Songs spielen nach dem
ersten Mal von Platte statt gestreamt zu werden, macht Wiedergabe auch ohne Netz möglich.

## Einmalige Einrichtung

### 1. IPA bauen (GitHub Actions, automatisch)
Jeder Push, der `native-player/**` ändert, baut automatisch ein unsigniertes `.ipa` über den
Workflow `build-native-player.yml`. Manuell auslösen geht auch:

1. Auf GitHub: **Actions** → **Build Himusic Player (iOS, unsigniert)** → **Run workflow**.
2. Nach ~5-10 Minuten: im abgeschlossenen Lauf unter **Artifacts** liegt
   `HimusicPlayer-unsigned-ipa` (enthält `HimusicPlayer.ipa`) zum Herunterladen.

Kostet nichts — das Repo ist öffentlich, GitHub-Actions-Minuten (auch macOS-Runner) sind dafür
unbegrenzt.

### 2. SideStore installieren (einmalig, braucht kurz einen Computer)
SideStore signiert das `.ipa` beim Installieren mit deiner eigenen (kostenlosen) Apple-ID neu
und hält die Signatur danach automatisch per WLAN am Leben — kein wiederkehrender
Computer-Kontakt, keine 99€/Jahr nötig. Offizielle Anleitung:
**https://docs.sidestore.io/docs/getting-started**

Kurzfassung:
1. SideStore-eigenen Installer auf dem Computer laufen lassen, iPhone per Kabel verbinden.
2. Mit einer (auch kostenlosen) Apple-ID anmelden, wenn gefragt.
3. SideStore installiert sich selbst auf dem iPhone. Kabel danach nicht mehr nötig — SideStore
   erneuert seine eigene Signatur im Hintergrund selbst.

### 3. Himusic Player über SideStore sideloaden
1. Das in Schritt 1 heruntergeladene `HimusicPlayer.ipa` aufs iPhone bringen (AirDrop, iCloud
   Drive, Mail an sich selbst — egal wie).
2. In SideStore: **+** → die `.ipa`-Datei auswählen → installieren.
3. Himusic Player erscheint als eigenes Icon auf dem Home-Bildschirm.

### 4. Fertig
Himusic Player öffnen, einmal anmelden (eigener Speicher, getrennt von Safari) — läuft. Der
Einstellungen-Schalter **"Nativer Hintergrund-Player (Beta)"** in der Webseite selbst betrifft
nur den alten Weg über Safari + `himusicplayer://` und bleibt bewusst als Rückfallebene erhalten,
falls die 7-Tage-Signatur der Hülle mal nicht rechtzeitig automatisch erneuert wird.

## Lokal bauen (falls du selbst einen Mac hast)
```
brew install xcodegen
cd native-player
xcodegen generate
open HimusicPlayer.xcodeproj
```
Danach in Xcode ganz normal auf ein verbundenes Gerät bauen (eigenes Apple-ID-Team reicht für
die 7-Tage-Signatur — SideStore ist hierfür nicht nötig, ersetzt nur den wiederkehrenden
Xcode-Kontakt).

## Bekannte v1-Grenzen
Siehe "Offene Punkte" in [ADR-007](../docs/decisions/ADR-007-native-player-companion-app.md) —
u.a. Warteschlange auf 25 Songs begrenzt, keine `data:`-URI-Cover, kein Zurück-Sync in die PWA.
