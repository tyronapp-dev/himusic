# Himusic Player (native Begleit-App)

Kleine iOS-App, die ausschließlich zuverlässige Hintergrund-Wiedergabe + Control-Center-
Integration übernimmt — der Grund dafür steht in
[ADR-007](../docs/decisions/ADR-007-native-player-companion-app.md). Sie ersetzt NICHT die
PWA: Bibliothek, Suche, Import, Tagging bleiben in Himusic Cloud wie gehabt. Nur der eigentliche
Ton läuft hierüber, sobald du das in den Himusic-Einstellungen einschaltest.

**Status: ungetestet.** Dieser Code wurde ohne Zugriff auf einen Mac oder ein echtes iPhone
geschrieben. Der erste Build + Sideload-Versuch wird vermutlich noch etwas Fehlersuche brauchen
— das ist normal, kein Grund zur Sorge.

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

### 4. In Himusic Cloud aktivieren
Einstellungen → Abschnitt **"Nativer Hintergrund-Player (Beta)"** → antippen zum Einschalten.
Ab jetzt übergibt ein Tap auf Play in der PWA die Wiedergabe an Himusic Player. Beim ersten Mal
wechselt iOS kurz sichtbar die App — normal, lässt sich technisch nicht vermeiden.

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
