# Windows Support - Plan

Status: planning, not implemented.
Owner: review with Timo before any code change.
Last updated: 2026-04-30.

## Ziel

NoteZ soll auf Windows laufen mit **Funktions-Parität zu macOS**. Heißt:
jede Funktion, die auf Mac geht, geht auch auf Windows. Visuelle
Eigenheiten (Vibrancy vs. Mica, Traffic-Lights vs. Min/Max/Close
rechts) sind erlaubt, **funktionale Unterschiede sind es nicht**.

Zusätzlich: ab dem Moment, wo Windows live ist, wird **jede neue
Funktion automatisch für beide Plattformen entwickelt und gebaut**. Wir
wollen nie in den Modus kommen, "ach das fixen wir auf Windows
nachher". Das CI-Setup und die Code-Konventionen unten erzwingen das.

## End-State

- Eine Codebase, ein Repo, ein Tauri-Projekt - so wie heute.
- `pnpm tauri build` auf einem Windows-Rechner produziert eine
  funktionierende `.msi` und `.exe` (NSIS).
- `pnpm tauri build` auf macOS produziert weiter `.dmg` + `.app.tar.gz`
  wie bisher.
- Ein einziger `git tag vX.Y.Z` Push triggert die Release-CI, die
  **parallel** auf macOS und Windows baut und beide Artefakte am
  gleichen GitHub-Release anhängt.
- Plattformabweichungen leben hinter expliziten `#[cfg(target_os = ...)]`
  in Rust und expliziten `if (platform === "windows")` Branches im
  Frontend, nicht implizit.

## Audit-Zusammenfassung (was heute Mac-spezifisch ist)

Vollständiger Audit ist in dieser Konversation gelaufen. Kernpunkte:

**Hart Mac-only (muss unter cfg gestellt oder ersetzt werden):**

- [src-tauri/src/setup.rs](../src-tauri/src/setup.rs) - `apply_vibrancy(NSVisualEffectMaterial::Sidebar)` ist schon `#[cfg(target_os = "macos")]`, aber das Windows-Pendant (`apply_mica` / `apply_acrylic`) fehlt komplett.
- [src-tauri/Cargo.toml:72-73](../src-tauri/Cargo.toml) - `window-vibrancy` ist nur unter `[target.'cfg(target_os = "macos")']`. Die Crate unterstützt aber **auch Windows** (Mica auf Win11, Acrylic auf Win10/11). Muss auf beide Targets ausgeweitet werden.
- [src-tauri/Cargo.toml:16](../src-tauri/Cargo.toml) - `tauri` Feature `macos-private-api` ist unconditional. Auf Windows ignoriert, harmlos, kann bleiben.
- [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) - `macOSPrivateApi: true`, `titleBarStyle: "Overlay"`, `hiddenTitle: true` sind Mac-Konfig, werden auf Windows ignoriert. Aber `transparent: true` greift auf beiden Plattformen und braucht ein Mica/Acrylic-Backing auf Win, sonst sieht man den Desktop durch das Fenster.

**CSS, das ohne Vibrancy/Mica kaputt aussieht:**

- `backdrop-filter: blur(...)` in [app.css](../src/styles/app.css), [panes.css](../src/styles/panes.css), [editor.css](../src/styles/editor.css), [settings.css](../src/styles/settings.css), [about.css](../src/styles/about.css), [trash.css](../src/styles/trash.css). Funktioniert technisch in Chromium, aber ohne opaken Hintergrund hinter dem Element wird der Desktop sichtbar.
- [src/styles/global.css:18](../src/styles/global.css) - `body { background: transparent }` für Vibrancy.
- [src/styles/theme.css:56-61](../src/styles/theme.css) - `body { background-color: var(--nz-body-bg, transparent) }`. Mono-Theme setzt opaken Hintergrund, default + light nicht.
- [src/styles/app.css:44-52](../src/styles/app.css) - `.nz-traffic-light-spacer` reserviert 78px für die Mac-Traffic-Lights bei eingeklappter Sidebar. Auf Windows nutzlos und stört (Min/Max/Close sitzen rechts, nicht links).

**Already cross-platform, kein Change nötig:**

- In-App Keyboard-Handling: [src/lib/keymap.ts](../src/lib/keymap.ts) behandelt `metaKey || ctrlKey` als Mod, alle Components nutzen das. Audit zeigt keine Verstöße.
- Pfade: [src-tauri/src/lib.rs:30-42](../src-tauri/src/lib.rs) nutzt `app.path().app_data_dir()`, plattformkorrekt.
- SQLite WAL: funktioniert auf Windows lokal problemlos.
- Keychain: [Cargo.toml:64](../src-tauri/Cargo.toml) Feature `apple-native` triggert auf Mac die Keychain. Die Crate fällt auf Windows automatisch auf den Credential Manager zurück. Trotzdem prüfen, dass das `apple-native` Feature nicht windows-only Code wegswitcht; ggf. unter `cfg(target_os = "macos")` ziehen.
- Drag-and-Drop: HTML5 DataTransfer API, plattformneutral.
- Icons: [src-tauri/icons/](../src-tauri/icons/) hat schon `icon.ico` und `icon.icns`, beide Pfade in `tauri.conf.json` referenziert.

**Globale Shortcuts: Bug auf Windows (Audit-Nachtrag)**

[src-tauri/src/shortcuts.rs:42-48](../src-tauri/src/shortcuts.rs)
hardcoded `Modifiers::SUPER` als Default für Quick-Capture und
Command-Bar-Toggle. `Modifiers::SUPER` mappt im
`tauri-plugin-global-shortcut` plattformabhängig:

- macOS: Cmd-Taste (gewünscht)
- Windows: **Win-Taste** (nicht Ctrl!)
- Linux: Super-Taste

Heißt der aktuelle Code würde auf Windows `Win+K` und `Win+Alt+N`
registrieren. `Win+K` ist von Windows reserviert (Cast-Device-Picker),
die Registrierung schlägt fehl. `Win+Alt+N` würde funktional gehen,
aber User erwarten auf Windows die Win-Taste **nicht** als
App-Shortcut-Modifier - das ist Microsofts Hoheit.

**Lösung:** Default-Shortcuts müssen plattformspezifisch sein.

```rust
#[cfg(target_os = "macos")]
const DEFAULT_MOD: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const DEFAULT_MOD: Modifiers = Modifiers::CONTROL;
```

Anwenden auf `default_quick_capture` (= `DEFAULT_MOD | ALT + KeyN`)
und `default_command_bar` (= `DEFAULT_MOD + KeyK`). Die `ShortcutSpec`-
Struktur und das Matching darunter bleiben plattformneutral, nur die
Default-Werte differenzieren.

**Custom-Shortcuts (User-definiert in Settings):** der User legt fest
welche Modifier er will, das wird 1:1 gespeichert und genutzt. Kein
Auto-Mapping nötig - wenn ein User auf Mac `Cmd+K` setzt und das DB-
Setting auf einen Win-Rechner sync't (später, mit Sync), bleibt es
`Cmd+K` und schlägt auf Win fehl. Das ist erwartet, kein Bug. Default-
Werte sind das einzige was plattformspezifisch sein muss.

**Shortcut-Display in Settings:** [src/views/SettingsView.tsx](../src/views/SettingsView.tsx)
nutzt `formatAccelerator()` mit Mac-Symbolen `⌘⌥⇧⌃`. Auf Windows
erwartet der User Text-Form "Ctrl + Alt + N". Display-Funktion muss
auf `platform()` aus `lib/platform.ts` schauen und entweder Symbole
(Mac-Konvention) oder Text mit `+`-Joiner (Windows-Konvention)
rendern.

**README Shortcut-Tabelle:** zwei Spalten "macOS" und "Windows",
oder Notation `Mod+K` mit Fußnote `Mod = Cmd auf macOS, Ctrl auf
Windows`. Vorschlag: zwei Spalten, klarer für User.

**Dokumentation, die Mac annimmt:**

- [README.md](../README.md): Badges "macOS", "Apple Silicon native", "Mac-first" Claim, `xattr` Install-Anleitung, `Cmd+...` Shortcut-Tabelle.
- [CLAUDE.md:168](../CLAUDE.md) - SQLite-Inspect-Pfad ist `~/Library/Application Support/...`, nicht annotiert als Mac-only.
- [.github/workflows/release.yml:52-71](../.github/workflows/release.yml) - `releaseBody` ist komplett Mac-zentriert.
- [.github/workflows/release.yml:14-15](../.github/workflows/release.yml) - Job heißt "Build macOS (Apple Silicon)", läuft nur auf `macos-latest`, baut nur `aarch64-apple-darwin`.
- [.github/workflows/ci.yml:54](../.github/workflows/ci.yml) - Backend-Tests laufen nur auf `macos-latest`, kein Windows-Job.

## Plan in Phasen

Reihenfolge ist wichtig. Phase 1 ändert kein User-Verhalten auf Mac und
ist riskoarm. Erst danach kommt Visuelles und CI.

### Phase 1: Build-Fähigkeit auf Windows herstellen

Ziel: ein Entwickler mit Windows-Rechner kann `pnpm tauri build`
laufen lassen und kriegt eine `.msi` raus, die startet und alle
Funktionen erfüllt - auch wenn die Optik noch nicht poliert ist.

1. **`window-vibrancy` für beide Plattformen aktivieren.**
   In [src-tauri/Cargo.toml](../src-tauri/Cargo.toml): den
   `[target.'cfg(target_os = "macos")']` Block aufteilen in einen
   macOS-Block und einen `[target.'cfg(target_os = "windows")']`
   Block, beide referenzieren `window-vibrancy = "0.6"`. Alternativ
   die Crate in die normalen `[dependencies]` ziehen, sie kompiliert
   auf Linux ohne Funktion, aber das vereinfacht.

2. **`setup.rs` um Windows-Branch erweitern.**
   In [src-tauri/src/setup.rs](../src-tauri/src/setup.rs) einen
   `#[cfg(target_os = "windows")]` Block hinzufügen, der
   `apply_mica` versucht (Win11) und bei Fehler `apply_acrylic`
   versucht (Win10). Beide schlagen fehl warnen, die App soll
   trotzdem starten - dann zeigt Tauri einfach das Default-Fenster.

3. **Apple-spezifische Tauri-Config klären.**
   `macOSPrivateApi: true` und `titleBarStyle: "Overlay"`,
   `hiddenTitle: true` in [tauri.conf.json](../src-tauri/tauri.conf.json)
   sind Mac-only Felder, die Tauri auf Windows ignoriert. Können
   bleiben. **`transparent: true` wird kritisch:** wenn Mica/Acrylic
   greift, ist transparent korrekt; wenn nicht, sieht man den
   Desktop durch. Optionen:
   - **A:** transparent + Mica/Acrylic, mit Fallback auf opaken
     Body-Background wenn Vibrancy-Apply fehlschlägt (Frontend
     bekommt Event von Rust und setzt `--nz-body-bg` opak).
   - **B:** auf Windows `transparent: false` per zweitem
     `WindowConfig` oder per Runtime-Setup, dann CSS-Hack
     überflüssig.
   Empfehlung: **A**, weil A auch auf älteren Windows-Versionen
   ohne Mica/Acrylic gracefully degraded.

4. **CSS-Fallback für opaken Body.**
   In [src/styles/theme.css](../src/styles/theme.css) eine
   Klasse `.platform-windows-no-vibrancy` definieren, die
   `--nz-body-bg` auf einen opaken Wert setzt (z.B.
   `var(--nz-surface)`). Die Klasse wird zur Laufzeit auf `<html>`
   gesetzt, wenn Rust meldet, dass Vibrancy-Apply fehlgeschlagen
   ist (siehe Punkt 3A).

5. **`backdrop-filter` auf Windows abschwächen.**
   In allen CSS-Files mit `backdrop-filter: blur(...)`: einen
   Fallback-Hintergrund mit höherer Deckkraft zur jeweiligen Klasse
   hinzufügen. Das blur greift dann nur auf das opake Backing,
   nicht auf den Desktop.

6. **Traffic-Light-Spacer auf Windows nullen.**
   [src/styles/app.css:44-52](../src/styles/app.css):
   `.nz-traffic-light-spacer` per `:root.platform-windows ...`
   override auf `flex: 0 0 0px` setzen, unabhängig vom
   Sidebar-Zustand. Auch das `sidebar-collapsed`-Override.

7. **Plattform-Marker im Frontend.**
   Schon zur Build-Zeit oder beim App-Start eine Konstante
   `__APP_PLATFORM__` exposen ("macos" | "windows" | "linux"). Vite
   `define` aus `process.platform` setzen, plus zur Laufzeit ein
   Tauri-Command, das die echte Rust-`std::env::consts::OS`
   zurückgibt (nicht die Build-OS, sondern die Run-OS - relevant
   wenn man später cross-built). Eine Helper-Funktion
   `platform()` in `src/lib/platform.ts` exportieren.

8. **`<html>`-Klasse setzen.**
   `App.tsx` setzt zum Mount `document.documentElement.classList.add(\`platform-\${platform()}\`)`.
   So können CSS-Files plattformspezifisch differenzieren ohne
   überall JavaScript-Branches.

9. **`vite.config.ts` Build-Target.**
   `target: "safari17"` in [vite.config.ts](../vite.config.ts)
   ist für macOS WKWebView gewählt. Tauri auf Windows nutzt
   WebView2 (Edge/Chromium), das ist neuer als Safari 17 und
   versteht alles. Lassen, oder auf
   `["safari17", "edge120"]` umstellen für Klarheit. Niedriger
   Prio.

10. **Globale Shortcut-Defaults plattformspezifisch.**
    In [src-tauri/src/shortcuts.rs](../src-tauri/src/shortcuts.rs)
    eine `DEFAULT_MOD` Konstante per `cfg(target_os = "macos")`
    auf `Modifiers::SUPER` setzen, sonst auf `Modifiers::CONTROL`.
    `default_quick_capture` und `default_command_bar` nutzen die
    Konstante. Resultat: Mac-User kriegen weiter `Cmd+K` /
    `Cmd+Alt+N`, Win-User kriegen `Ctrl+K` / `Ctrl+Alt+N`. **Wer
    schon auf Mac einen Custom-Shortcut gesetzt hat, behält ihn**,
    weil das nur die Default-Funktion betrifft.

11. **App-Daten-Pfad auf Windows umbenennen.**
    Heute ist der Bundle-Identifier `de.agent-z.notez` und der
    AppData-Pfad nutzt den 1:1. Auf Windows wäre das
    `%APPDATA%\de.agent-z.notez\` - hässlich für User die
    reinschauen. In [src-tauri/src/lib.rs::resolve_app_paths](../src-tauri/src/lib.rs)
    auf Windows den Pfad explizit auf `%APPDATA%\NoteZ\` umbiegen
    (über `dirs::data_dir()` plus `"NoteZ"` join, oder per
    `cfg(windows)` Branch der `app_data_dir()` ignoriert und
    selber `%APPDATA%` resolved). Mac-Pfad bleibt unverändert.
    **Wichtig:** der Identifier in `tauri.conf.json` darf nicht
    geändert werden, sonst kapern wir nicht den existierenden
    Mac-DB-Pfad.

12. **`apple-native` Keyring-Feature einschränken.**
    [src-tauri/Cargo.toml:64](../src-tauri/Cargo.toml): Feature
    `apple-native` unter `cfg(target_os = "macos")` ziehen, damit
    auf Windows der Default-Backend (Credential Manager) genutzt
    wird ohne `apple-native` Code zu kompilieren.

13. **Rust kompiliert sauber unter Windows verifizieren.**
    `cargo check --target x86_64-pc-windows-msvc` ist nicht
    cross-fähig von Mac aus ohne weiteres. Erstmal CI das machen
    lassen (Phase 3) oder auf einem Windows-Rechner verifizieren.

**Akzeptanz-Test Phase 1:** Auf einem Win11-Rechner `pnpm install &&
pnpm tauri build` laufen lassen, `.msi` installieren, App starten.
Folgende Funktionen manuell durchgehen: neue Notiz, Editor tippen,
Suche, Command-Bar (Strg+K), Quick-Capture (Strg+Alt+N), Sidebar,
Pin, Snapshot, Trash, Settings, Mention `@`, Backlinks. Alle müssen
gehen - auch wenn das Fenster optisch nackt aussieht.

### Phase 2: Visuelle Parität auf Windows

Erst angehen, wenn Phase 1 sauber durchläuft.

1. **Mica auf Win11 polieren.**
   Mica reagiert auf Dark/Light-Mode des Systems automatisch.
   Prüfen, dass die App-Themes (default, light, mono, ...) sauber
   darüber liegen. Mono-Theme bleibt unverändert (eigener opaker
   Hintergrund).

2. **Acrylic-Fallback auf Win10 testen.**
   Acrylic ist performance-mäßig teurer als Mica, aber sieht auf
   Win10 (kein Mica verfügbar) am nächsten an Vibrancy.

3. **Custom Title-Bar entscheiden.**
   Auf Windows ist die Standard-Title-Bar mit Min/Max/Close
   rechts. Optionen:
   - **Standard-Bar lassen:** schnellster Weg, sieht aber "Windows-
     y" aus, nicht so clean wie der Mac-Look.
   - **Custom Title-Bar:** `decorations: false` + eigene
     HTML-Title-Bar mit `data-tauri-drag-region` und
     Min/Max/Close-Buttons rechts. Mehr Arbeit, aber konsistent.
   Empfehlung: **Standard-Bar in Phase 2**, Custom in einer
   späteren Iteration als optionales Polish-Ticket.

4. **Font-Stack erweitern.**
   In [src/styles/theme.css:51-53](../src/styles/theme.css):
   `--nz-font-ui` voranstellen mit `"Segoe UI Variable", "Segoe UI"`
   auf Windows, damit Win11 sein modernes UI-Font nutzt statt
   Arial-Fallback. CSS kann das per `@supports` nicht plattform-
   spezifisch, aber wir haben ja `:root.platform-windows`.

5. **Shortcut-Display in Settings plattformneutral machen.**
   [src/views/SettingsView.tsx](../src/views/SettingsView.tsx)
   `formatAccelerator()` umbauen: auf Mac weiter `⌘⌥⇧⌃X`-Symbol-
   Form rendern, auf Windows als Text mit `+`-Joiner ("Ctrl + Alt
   + N"). Helper aus `src/lib/platform.ts` reinziehen.

6. **README-Shortcut-Tabelle zweispaltig.**
   Bei Phase 4 (Doku) zwei Spalten "macOS" und "Windows" mit
   nebenstehender Notation, statt nur `Cmd+...`.

**Akzeptanz-Test Phase 2:** Screenshots von macOS und Windows
nebeneinander legen. Funktional identisch, optisch je nativ-ish.

### Phase 3: CI / Release auf beide Plattformen

1. **`release.yml` auf Matrix umstellen.**
   [.github/workflows/release.yml](../.github/workflows/release.yml)
   in einen Matrix-Job konvertieren:
   ```yaml
   strategy:
     fail-fast: false
     matrix:
       include:
         - platform: macos-latest
           target: aarch64-apple-darwin
           label: macOS (Apple Silicon)
         - platform: windows-latest
           target: x86_64-pc-windows-msvc
           label: Windows (x64)
   ```
   Beide Jobs nutzen `tauri-apps/tauri-action@v0` mit demselben
   `tagName`, das Action hängt die Artefakte ans selbe Release.
   Wichtig: `releaseDraft: true` für **alle ausser dem letzten**
   damit das Release nicht halb-fertig sichtbar wird, oder den
   ersten Job lassen das Draft anlegen, den zweiten nur Assets
   nachschieben (siehe `tauri-action` README; das ist das
   Standard-Pattern).

2. **Release-Body um Windows-Sektion erweitern.**
   Die `releaseBody` in der Action heredoc-Vorlage bekommt einen
   "Windows" Block: ".msi runterladen, doppelklicken, fertig."
   (Unsigned-Hinweis: SmartScreen wird "Unbekannter Herausgeber"
   warnen, User klickt "Trotzdem ausführen". Erst wenn Code-
   Signing eingerichtet wird (siehe Open Questions), entfällt
   das.)

3. **`ci.yml` um Windows-Backend-Job ergänzen.**
   Backend (Rust) Tests sollten auf `windows-latest` laufen,
   sonst kriegen wir Windows-Regressionen erst im Release-Build
   mit. Job parallel zu macOS Backend-Job.

4. **Release-Tag-Filter prüfen.**
   Der Filter `v*.*.*` in [release.yml:6-7](../.github/workflows/release.yml)
   bleibt unverändert.

**Akzeptanz-Test Phase 3:** Test-Tag (z.B. `v0.0.0-rc1` auf einem
Branch) pushen, schauen ob beide Builds grün durchlaufen und beide
Artefakte am Release-Draft hängen.

### Phase 4: Doku und User-facing Wording

1. **README.md.**
   - Badges erweitern: "macOS + Windows".
   - "Mac-first" Claim entfernen oder relativieren ("Native auf Mac
     und Windows").
   - Install-Sektion in zwei Tabs/Subsections: "macOS" mit
     `xattr`-Block, "Windows" mit `.msi`-Hinweis und
     SmartScreen-Note.
   - Shortcut-Tabelle: Spalten "Mac" und "Windows" mit
     Cmd-vs.-Ctrl-Mapping. Oder eine Spalte mit `Mod+K` und
     einer Fußnote "Mod = Cmd auf macOS, Ctrl auf Windows".

2. **CLAUDE.md.**
   - Plattformlistes oben in Architecture-Sektion: "Mac + Windows
     erstklassig, Linux best-effort".
   - SQLite-Inspect-Beispiel um Windows-Pfad ergänzen
     (`%APPDATA%\de.agent-z.notez\notez.db`).
   - Eine neue Sektion **"Cross-platform discipline"** (siehe
     unten "Konventionen ab jetzt") direkt nach der
     "Conventions"-Sektion.

3. **Bundle-Description.**
   [tauri.conf.json:50-51](../src-tauri/tauri.conf.json):
   `shortDescription` und `longDescription` plattformneutral
   reformulieren ("Fast, local, beautiful notes for desktop.").

## Konventionen ab jetzt (verhindert Drift)

Diese Regeln gehen in CLAUDE.md, sobald Phase 1 mergt. Sie sind der
eigentliche Schutz gegen "wir entwickeln zwei Apps".

1. **Plattform-Branches nur an einer Stelle pro Konzept.**
   Vibrancy-Logik lebt in `setup.rs`, nicht über die Codebase
   verstreut. Wenn ein neues Konzept Plattform-Branching braucht,
   gehört es in einen einzigen, klar benannten Modul.

2. **Cfg-Gates statt Runtime-Checks in Rust.**
   `#[cfg(target_os = "...")]` ist verständlicher und sicherer als
   `if cfg!(target_os = "...")`, weil der Compiler die nicht
   passende Variante komplett rauswirft.

3. **Frontend: `platform()` aus `lib/platform.ts` benutzen.**
   Niemals `navigator.platform` oder `navigator.userAgent`
   parsen. Die Helper-Funktion ist die einzige Quelle.

4. **Keine Mac-only Annahme in CSS ohne explizite Klasse.**
   Wenn ein Style nur auf Mac sinnvoll ist, gehört er unter
   `:root.platform-macos ...`. Wenn es nur auf Windows sinnvoll
   ist, unter `:root.platform-windows ...`. Wenn der Style beide
   trifft (= 95% der Fälle): keine Klasse, gilt überall.

5. **Keyboard-Shortcuts: niemals direkt `e.metaKey` oder
   `e.ctrlKey`.** Immer `matchHotkey()` aus
   [src/lib/keymap.ts](../src/lib/keymap.ts). Das gibt es schon,
   wir halten uns dran. Ausnahme: das eine Settings-Capture-UI,
   das beide Bits explizit braucht (siehe Audit) - klar
   kommentiert, nicht ausweiten.

5a. **Globale Shortcut-Defaults: immer plattformspezifisch.**
    Mac default = `Modifiers::SUPER + ...`, Windows/Linux default =
    `Modifiers::CONTROL + ...`. Niemals `SUPER` als Default auf
    nicht-Mac-Targets, das mappt auf die Win-Taste und ist von
    Microsoft reserviert. Custom-Shortcuts vom User bleiben
    unverändert gespeichert.

5b. **Shortcut-Anzeige folgt Plattform-Konvention.**
    Mac zeigt `⌘⌥⇧⌃` als Symbole ohne Trenner, Windows zeigt
    "Ctrl + Alt + Shift + X" als Text. Eine zentrale
    `formatShortcut(spec)` Funktion macht das, Components rufen
    nur die auf.

6. **Pfade: nie String-konkateniert.** Immer `Path::join()` /
   `PathBuf`. Frontend-seitig nie URLs aus Datei-Pfaden bauen
   ohne `convertFileSrc` aus `@tauri-apps/api`.

7. **Neuer Code muss auf beiden Plattformen kompilieren - CI
   erzwingt das.** Wenn der Windows-CI-Job rot ist, ist der PR
   nicht mergebar. Punkt.

8. **Visuelle Polish-Asymmetrie ist okay, funktionale nicht.**
   Mica sieht anders aus als macOS-Vibrancy - das ist normal.
   Ein Knopf, der auf Mac geht aber auf Windows nicht, ist ein
   Bug.

9. **Release-Notes ab v0.x.0 (Windows-Launch) immer beide
   Plattformen abdecken.** Eine Sektion "macOS", eine "Windows",
   beide aktuell.

10. **README-Pflege wie bisher** (siehe `README maintenance` in
    CLAUDE.md), aber jeder feature-relevante Commit muss prüfen,
    ob die Beschreibung des Features auf beiden Plattformen
    stimmt.

## Beschlossen (2026-04-30)

- **Kein Code-Signing.** Unsigned wie auf Mac. SmartScreen-Warnung
  beim ersten Launch, User klickt "Trotzdem ausführen". Wird im
  Release-Body und README dokumentiert. Re-evaluierbar später.
- **Plattform-Targets.** macOS Apple Silicon (`aarch64-apple-darwin`)
  + Windows x64 (`x86_64-pc-windows-msvc`). **Kein ARM** auf
  Windows, kein x86_64-Mac, kein Linux (Phase 1).
- **Win-Minimum: Win10 1809+.** Mica auf Win11, Acrylic-Fallback
  ab Win10 1809.
- **Installer: nur NSIS.** Single `NoteZ-Setup.exe` per User-Click,
  kein Admin nötig, kein MSI. In `tauri.conf.json` unter
  `bundle.targets` explizit setzen statt `"all"` (sonst baut Tauri
  auch MSI was wir nicht wollen).
- **App-Daten-Pfad Windows: `%APPDATA%\NoteZ\notez.db`.** Bundle-
  Identifier `de.agent-z.notez` bleibt unverändert (sonst
  Migrations-Risiko auf Mac), Pfad wird in `resolve_app_paths`
  per `cfg(windows)` Branch explizit umgebogen.
- **Test-Setup.** Timo hat einen Win-Rechner zum Manual-Testen.
  CI ist Pflicht-Gate, Manual-Test ist Akzeptanz-Test pro Phase.
- **Version.** Offen, nicht-blockierend. Wird beim Release-Tagging
  entschieden.
- **Timing.** Plan-only, kein Implementierungsstart bis Timo
  loslegen will.

## Offene Fragen (noch zu klären)

1. **Default-Shortcuts auf Windows.** Plan-Vorschlag: `Ctrl+K`
   (Command Bar) und `Ctrl+Alt+N` (Quick Capture). Beide sind frei
   auf Windows (kein Konflikt mit System-Bindings). Okay so?

2. **Custom Title-Bar oder Standard-Bar.** Standard Win-Bar ist
   schnell, sieht aber weniger clean aus als der Mac-Look. Custom
   Bar mit Min/Max/Close rechts braucht ein paar Stunden Arbeit.
   Phase 2 oder später als Polish-Ticket?

3. **Wenn Mica/Acrylic-Apply fehlschlägt (sehr alte Win10-
   Version, exotische GPU-Treiber): Fallback-Body-Color welche?**
   Vorschlag: `var(--nz-surface)` aus dem aktuellen Theme, dann
   sieht's solide aus statt durchsichtig.

## Was dieser Plan **nicht** behandelt

- **Linux-Support.** Tauri kann es, aber die CSS-/Window-Hacks
  oben sind Mac+Win-fokussiert. Linux würde eine eigene Audit-
  Runde brauchen (Wayland vs X11, GTK-Webkit vs Tauri-Webkit,
  AppImage vs deb vs Flatpak).
- **iOS / Android.** Separater Diskussionsthread, siehe Mobile-
  Strategie-Konversation.
- **Sync-Backend.** Plattformneutral, nicht Teil dieses Plans.
- **Code-Migration zu pnpm-Workspace / Mehr-App-Struktur.** Wird
  erst relevant, wenn Mobile-Apps dazukommen. Bis dahin bleibt
  alles in einem Tauri-Projekt.
