# ADR-007: Native Begleit-App für Hintergrund-Wiedergabe (statt volle Capacitor-Hülle)

## Status
Proposed / in Umsetzung — Code-Gerüst (`native-player/`, GitHub-Actions-Workflow,
app2.js-Hand-off, Settings-Toggle) steht, aber **noch nicht gebaut, signiert oder auf einem
echten Gerät getestet**. Nichts hiervon war bisher verifizierbar, da weder ein Mac noch das
Zielgerät im Rahmen dieser Änderung zur Verfügung standen — der erste echte Test (CI-Build +
SideStore-Sideload) steht beim Nutzer noch aus.

## Date
2026-07-25

## Context
Zwei zusammenhängende Symptome, ausführlich untersucht (siehe Memory-Zusammenfassung unten):

1. Musik stockt/stoppt, sobald die App im Hintergrund oder bei gesperrtem Bildschirm läuft.
2. Der Play-Button im iOS-Control-Center springt nicht zu Himusic zurück, sondern zur zuletzt
   aktiven anderen App (z.B. Spotify).

**Root Cause (bestätigt):** iOS gewährt Web-Apps kein `UIBackgroundModes: audio`-Recht wie
nativen Apps. Der Prozess wird im Hintergrund eingefroren, unabhängig vom eigenen JS-Code.
Dadurch stirbt auch die MediaSession-Registrierung, die Control Center brauchen würde, um
Himusic als "Now Playing"-Quelle zu erkennen.

**Bereits ausprobiert und gescheitert** (siehe `ios-background-audio-freeze-investigation`
Memory für den vollen Verlauf):
- `apple-mobile-web-app-capable="no"` + `manifest.json display: "browser"`, um das
  Home-Bildschirm-Icon als normalen Safari-Tab statt App-Hülle zu öffnen — auf iOS 26 vom neuen
  "Als Web-App öffnen"-Schalter übersteuert.
- Schalter manuell ausgeschaltet, trotzdem weiterhin über Icon gestartet — Freeze blieb
  bestehen. **Einzig bestätigt stabiler Fall bisher:** App als normaler, durchgehend offener
  Tab in Brave, nie über ein Icon neu gestartet.
- Sandbox/VM-Idee des Nutzers geprüft und als architektonisch unmöglich verworfen: eine VM
  innerhalb einer App ist selbst nur ein normaler Prozess aus Sicht von iOS' Kernel, kann sich
  keine eigene Ausnahme von dessen Hintergrund-Regeln verschaffen.
- Jailbreak (der einzige echte Weg, die Kernel-Regel selbst zu ändern) für iOS 26 aktuell nicht
  öffentlich verfügbar (Stand 2026-07, letzter öffentlicher Jailbreak bei iOS 17.0).

## Decision
Statt die komplette PWA (app2.js, ~4500 Zeilen UI/Bibliothek/Import/Tagging) in eine
Capacitor-Hülle zu wrappen, bauen wir eine **kleine, eigenständige native App**
(`native-player/`), die ausschließlich Wiedergabe übernimmt:

- **AVPlayer statt `<audio>`-Element** — umgeht die dokumentierte WKWebView-Hintergrund-Audio-
  Bug-Klasse (seit iOS 13 bekannt, laut Entwickler-Berichten noch bis iOS 17.2.1 reproduzierbar,
  selbst mit korrekt gesetztem `UIBackgroundModes: audio`). Eine volle Capacitor-Hülle hätte
  dasselbe Risiko geerbt, solange sie weiterhin `<audio>` in einer WKWebView abspielt.
- **MPNowPlayingInfoCenter + MPRemoteCommandCenter** — Apples eigene, von jeder nativen
  Musik-App (auch Spotify) genutzte APIs fürs Control Center. Löst Symptom 2 grundsätzlich,
  nicht nur behelfsweise.
- **Übergabe per Custom-URL-Scheme** (`himusicplayer://play?q=<base64url-JSON>`) statt vollem
  Rewrite: die PWA bleibt für alles außer der eigentlichen Wiedergabe unverändert (Bibliothek,
  Suche, YouTube-Import, Tag-Editor, Playlists). Nur `window.playSong()` übergibt bei
  aktiviertem Toggle den aktuellen Song + die nächsten 24 aus der Warteschlange an die native
  App, statt lokal per `<audio>` abzuspielen (siehe `_tryNativePlayerHandoff()` in app2.js).
- **XcodeGen statt handgeschriebenem `.xcodeproj`** — `project.pbxproj` ist ein fragiles,
  ID-basiertes Format, das ohne laufendes Xcode leicht kaputtgeht. `native-player/project.yml`
  ist eine einfache YAML-Spec, aus der `xcodegen generate` das Xcode-Projekt deterministisch
  erzeugt (CI-tauglich, aktiv gepflegt, Stand 2026-07: v2.46.0).
- **Unsigniertes `.ipa` aus GitHub Actions, Signierung erst lokal beim Sideload** —
  `.github/workflows/build-native-player.yml` baut auf einem macOS-Runner (kostenlos, da das
  Repo öffentlich ist → unbegrenzte Actions-Minuten) ein unsigniertes `.ipa` als Artefakt.
  SideStore/AltStore signieren beim Installieren lokal mit dem eigenen (kostenlosen) Apple-ID-
  Zertifikat neu — dadurch braucht dieser Workflow **keine** Apple-Signing-Secrets im Repo.
- **SideStore statt bezahltem Apple-Developer-Account** — Signaturen aus einem kostenlosen
  Apple-ID-Konto laufen nach 7 Tagen ab. SideStore erneuert sie automatisch im Hintergrund per
  WLAN (via lokalem VPN-Trick), nach einmaliger Ersteinrichtung ohne weiteren Computer-Kontakt.
  Alternative wäre 99€/Jahr für ein 1 Jahr gültiges Zertifikat gewesen — für eine reine
  Ein-Geräte-Privatnutzung nicht nötig.

## Offene Punkte (bewusste v1-Grenzen, nicht vergessen)
- **Warteschlangen-Limit:** nur die ersten 25 Songs (aktueller + 24 nächste) werden übergeben.
  Skippt man im Control Center über das Ende dieser Liste hinaus, passiert nichts mehr, bis man
  die PWA erneut öffnet und einen neuen Song antippt. Für normale Nutzung (Hintergrund läuft,
  gelegentlich Skip) ausreichend, aber kein unbegrenzter Queue-Sync.
- **Cover-Bilder:** nur `http(s)`-URLs werden übergeben, keine `data:`-URIs (würden die
  Übergabe-URL sprengen). Songs mit nur lokal eingebettetem Cover zeigen in der nativen App
  vorübergehend kein Artwork.
- **Kein automatischer Rücksprung in die PWA** beim Song-Wechsel aus der nativen App heraus —
  reiner Player, keine Synchronisierung von Wiedergabestatus zurück in `heatbox_state`.
- **App-Icon/Assets fehlen** (kein `Assets.xcassets`) — funktional egal, kosmetisch nachträglich
  ergänzbar.
- **Komplett ungetestet** bis zum ersten echten CI-Build + Sideload-Versuch des Nutzers — Swift-
  Code wurde ohne Xcode/Mac geschrieben, kann beim ersten `xcodebuild` noch Fehler zeigen.

## Consequences
**Positiv:** löst beide Symptome grundsätzlich (nicht nur kaschiert), nutzt ausschließlich
Apples vorgesehene Mechanismen statt gegen die Plattform zu arbeiten, hält die bestehende PWA
komplett unangetastet für alles außer Wiedergabe, keine laufenden Kosten.

**Negativ / Trade-offs:** zwei Code-Bereiche statt einem (PWA + kleine native App), Sideload-Weg
ist ein Community-Tool statt offizieller Apple-Distributionsweg (kann bei größeren iOS-Updates
zeitweise brechen), kurzer sichtbarer App-Wechsel beim Song-Start technisch nicht vermeidbar,
Build/Signier-Pipeline muss der Nutzer einmalig selbst einrichten (SideStore-Ersteinrichtung
braucht einmalig einen Computer).
