# NoteZ - Claude context

Fast, local, beautiful notes for Mac. Tauri 2 + Rust backend + Solid + TypeScript +
Lexical editor (vanilla, custom UI). Mac-first; Windows/Linux possible later.

## Architecture

```
src-tauri/        Rust backend
  src/
    main.rs              entry → notez_lib::run()
    lib.rs               Tauri Builder, plugin wiring, global shortcuts, command registration
    db.rs                SQLite pool (r2d2 + rusqlite, bundled), schema migrations, FTS5 setup
    error.rs             NoteZError + Serialize for tauri::command return
    models.rs            Rust structs (Note, NoteSummary, SearchHit, Snapshot, UpdateNoteInput)
    setup.rs             Window vibrancy (NSVisualEffectMaterial::Sidebar)
    commands/
      notes.rs           CRUD + soft-delete + pin + trash
      search.rs          FTS5 query + custom ranking (bm25 + recency + title bonus + pin)
      snapshots.rs       Auto + manual snapshots, prunes to last 50 auto per note
      mentions.rs        Backlinks lookup (mentions table is updated by update_note)
      settings.rs        Key/value settings table
      capture.rs         Quick-capture window (toggle/show/hide)

src/              Solid frontend (TypeScript)
  index.tsx              entry, mounts <App>, imports CSS
  App.tsx                routes between MainView and CaptureView via ?window=capture
  views/
    MainView.tsx         full app: sidebar + editor + command bar
    CaptureView.tsx      mini textarea, ⌘+Enter saves, esc dismisses
  components/
    Sidebar/             sidebar list with pinned/notes split + context menu
    Editor/
      Editor.tsx         Solid wrapper, mounts Lexical to a div ref
      MentionPopover.tsx popover when user types '@'
      lexical/
        createEditor.ts  vanilla Lexical bootstrap (createEditor + registerHistory + registerMarkdownShortcuts)
        theme.ts         CSS class names per node type
        mentionNode.ts   Custom ElementNode for @mentions (token-like, inline)
        mentionPlugin.ts registerUpdateListener detects '@<query>', exposes match to Solid
    CommandBar/          Spotlight-style ⌘K modal with smart ranking
  stores/
    notes.ts             Solid store + cache + actions (createNote, updateNote, refreshNotes, etc.)
    ui.ts                signals: sidebarCollapsed, commandBarOpen
  lib/
    types.ts             TS types matching Rust models
    tauri.ts             typed invoke wrappers + onEvent helper
    format.ts            relative time, deriveTitle
    debounce.ts          flush-able debounce for save-on-type
    keymap.ts            cross-platform mod-key matcher
  styles/                CSS files (one per concern)
```

## Data flow

- Editor mounts on note select, fires `onChange` → debounced save (350ms) → `updateNote`
  invoke → Rust updates `notes` row + `mentions` table → trigger refreshes FTS5 row.
- Auto-snapshot fires once every 5 minutes of editing per note (rejected if content
  unchanged since last snapshot - that's expected, the catch is silent).
- Search: frontend → `quick_lookup` or `search_notes` → FTS5 + custom ranking in Rust →
  returns `SearchHit[]` with snippets containing `<<` … `>>` highlight markers.
- Lexical state is stored as JSON string in `notes.content_json`. Plain text
  (`getTextContent()`) is mirrored to `notes.content_text` for FTS5 + previews.

## Conventions

- **Rust holds the truth.** Frontend never writes SQL. All persistence goes through
  `#[tauri::command]` functions.
- **All entities use UUIDv4 string IDs.** Created at insert. Never auto-increment integers
  for note IDs (sync-readiness).
- **Timestamps** are RFC3339 strings, generated in Rust via `chrono::Utc::now().to_rfc3339()`.
- **No `any` in TypeScript.** Backend types live in `src/lib/types.ts`, mirrored from Rust.
- **Lexical: vanilla only.** No `@lexical/react`. Build everything as Solid components
  that mount Lexical via `editor.setRootElement(ref)`.
- **Mod key:** use `matchHotkey(e, { key, mods })` from `lib/keymap.ts`. Never check
  `e.metaKey` / `e.ctrlKey` directly in components.
- **Solid stores:** `notes.ts` exposes signals + async actions. Components subscribe via
  `notesState.list`, `selectedId()`. Don't `setState` from components - call store actions.

## Commands

```bash
pnpm install
pnpm tauri dev          # full app with hot reload
pnpm dev                # frontend-only Vite (no Tauri shell)
pnpm typecheck          # tsc --noEmit
pnpm build              # frontend prod bundle → dist/
pnpm tauri build        # native .app

cargo check --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

## Debugging

- Rust logs via `tracing`. Set `RUST_LOG=notez=debug` for verbose. Default filter is
  `notez=debug,info` (see `lib.rs::run`).
- DB path printed at startup: `opening database: …`.
- Inspect SQLite live: `sqlite3 ~/Library/Application\ Support/de.agent-z.notez/notez.db`.
- Lexical: editor errors land in browser DevTools (right-click in dev mode → Inspect).
  All Lexical nodes register from `createEditor.ts::nodes`.
- Global shortcuts on macOS: dev builds prompt for Accessibility on first hotkey use.
  Once granted, hot-reload won't re-prompt.

## Versioning

Every user-visible change MUST bump the app version. The version is shown in the
bottom-right of the sidebar and is the user's only signal that something changed.

**Bump rules (semver-ish, pre-1.0):**
- Bug fix, minor polish, copy change → patch (`0.0.2` → `0.0.3`)
- New feature, redesign, behavior change → minor (`0.0.x` → `0.1.0`)
- Breaking schema/migration → major (when we hit `1.0.0`)

**Files to update on every bump (all five must match):**
1. `src/lib/version.ts` - `APP_VERSION` constant (drives the in-app label)
2. `package.json` - `version` field
3. `src-tauri/tauri.conf.json` - `version` field
4. `src-tauri/Cargo.toml` - `[package].version`
5. `README.md` - the `**vX.Y.Z**` line at the top

If you ship a change without bumping, you've shipped a regression - the user can't
tell what version they're running. The version label is the contract.

## Don'ts

- **No `@lexical/react`.** Solid + React don't mix; vanilla-only.
- **No `tauri-plugin-sql`.** We own the schema in Rust (richer than the plugin allows
  for FTS5 + ranking).
- **No localStorage for note content.** Persistence is SQLite via Rust commands.
- **No `npm`.** Use `pnpm` (lockfile is pnpm-lock.yaml).
- **No telemetry, no auto-update calls.** App must work fully offline forever.

## Out of scope (Phase 1)

- Multi-pane / split view (architecture is ready; UI is not).
- Backlinks UI (data is captured in `mentions` table, no panel yet).
- Tags, folders, daily notes, templates - Phase 2.
- Image/attachment support - Phase 2.
- Sync - Phase 3.
- Mobile - Phase 3.

## Troubleshooting

- **Vibrancy looks wrong / opaque** - make sure `body { background: transparent }`.
  Tauri.conf must have `transparent: true` and `macOSPrivateApi: true`.
- **`global-shortcut: register failed` warning** - another app holds the shortcut, or
  the user denied Accessibility. Falls through silently; in-app shortcuts still work.
- **`sqlite locked`** - should not happen with WAL + r2d2 pool. If it does, check that
  no migration fired mid-write (migrations run once at startup inside a tx).
