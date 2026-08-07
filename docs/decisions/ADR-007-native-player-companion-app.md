# ADR-007: Native Begleit-App für Hintergrund-Wiedergabe (statt volle Capacitor-Hülle)

## Status
Proposed / in Umsetzung — **CI-Build erstmals erfolgreich am 2026-08-07**, Signierung und
Gerätetest stehen weiterhin aus.

Chronologie:
- 2026-07-25 — Code-Gerüst geschrieben (`native-player/`, GitHub-Actions-Workflow,
  app2.js-Hand-off, Settings-Toggle), ohne Mac und ohne Xcode. Zunächst **nicht committet**;
  die Arbeit lag wochenlang nur in einem lokalen Backup.
- 2026-08-07 — committet (`95ed58b`) und gebaut: Workflow-Lauf `31133839373` lief in **45 s
  durch**, `xcodegen generate` + `xcodebuild` ohne Fehler, Artefakt
  `HimusicPlayer-unsigned-ipa` (58,3 KB). Der ohne Xcode geschriebene Swift-Code kompiliert
  also unverändert.
- 2026-08-07 — per SideStore auf dem iPhone installiert. **Erster Gerätetest schlug fehl:**
  Safari meldete beim Antippen eines Songs „Die Adresse ist ungültig", der Hand-off kam nie
  an. **Ursache:** XcodeGen *erzeugt* die Info.plist am Pfad unter `info.path` aus
  `info.properties` und überschreibt dabei die handgeschriebene Datei. Dort stand
  `properties: {}`, also entstand ein Rumpf. Am gebauten Artefakt verifiziert: die
  Info.plist in der IPA war 749 Bytes und enthielt **weder** `CFBundleURLTypes` **noch**
  `UIBackgroundModes: audio`. Es waren damit zwei Dinge kaputt — ohne das Schema kennt iOS
  die URL nicht, und ohne `UIBackgroundModes` hätte die App auch nach geglückter Übergabe
  bei gesperrtem Bildschirm nicht weitergespielt. Behoben in `091e15c`, alle Schlüssel
  liegen jetzt in `project.yml`; neu gebaute Info.plist ist 1025 Bytes und enthält beide.
- **Offen:** der Funktionstest auf dem Gerät mit dem korrigierten Paket
  (Hintergrund-Wiedergabe + Control Center). Bis dahin ist kein Verhalten dieser App auf
  einem Gerät belegt.

## Lehre fürs nächste Mal

Ein grüner CI-Build beweist nur, dass der Code **kompiliert** — nicht, dass das Paket
richtig **konfiguriert** ist. Info.plist-Schlüssel, Berechtigungen und URL-Schemata werden
von keinem Compiler geprüft. Nach jedem Build am Artefakt selbst nachsehen, ob sie drin
sind, statt der Quelldatei zu vertrauen.

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
- ~~Kein automatischer Rücksprung in die PWA~~ → **seit 2026-08-07 gelöst:** nach der
  Übergabe wartet die App 0,7 s, bis der AVPlayer läuft, und schickt den Nutzer dann per
  `UIApplication.open` zurück auf `https://tyronapp-dev.github.io/himusic/`. Der kurze
  Wechsel selbst bleibt unvermeidbar — iOS erlaubt keinen stillen Start im Hintergrund,
  ein Custom-URL-Aufruf holt die Ziel-App immer in den Vordergrund. Zusätzlich gibt es in
  der App einen Knopf „Zurück zu Himusic".
- **Keine Synchronisierung des Wiedergabestatus** zurück in `heatbox_state` — die PWA weiß
  nicht, was die native App gerade spielt.
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
