# NoteZ - Claude context

Fast, local, beautiful notes for Mac. Tauri 2 + Rust backend + Solid + TypeScript +
Lexical editor (vanilla, custom UI). Mac-first; Windows/Linux possible later.

## Monorepo layout

This repo is a pnpm workspace. Top-level layout:

```
apps/
  desktop/       the Tauri/Solid app (everything below under "Architecture" lives here)
  web/           Astro landing page for take-notez.com (dark mode, English)
packages/
  shared/        placeholder for sync-related types shared between desktop, web,
                 and a future sync server. Empty until the sync feature lands.
tools/           standalone helper crates (e.g. share-bench), not in the workspace
```

The root `package.json` is `notez-monorepo` and only holds workspace scripts +
biome. Each app has its own `package.json`. From the repo root run desktop
commands via `pnpm desktop:dev` / `pnpm desktop:tauri:dev` /
`pnpm desktop:typecheck`, or `cd apps/desktop` and use the original
`pnpm dev` / `pnpm tauri:dev` / `pnpm typecheck` scripts directly. Web commands:
`pnpm web:dev`, `pnpm web:build`.

## Architecture (apps/desktop)

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

## Performance budget

**Always design for 1,000,000 notes.** Not "typical user has hundreds" - the
target is a power user with a million entries, and the UI must stay snappy
with that load. This is non-negotiable; don't ship code that degrades at
scale even if the current dev DB has 4 notes. When in doubt, imagine the
user has 1M notes and is searching, scrolling, or filtering them - if the
code would noticeably stutter, redesign before shipping.

Concretely, this rules out:

- Rendering all rows of an unbounded list into the DOM (sidebar, search
  results, trash, snapshots). Always virtualize / window the visible slice.
- Recomputing O(n) prefix sums or offset arrays on every measurement /
  scroll / settings change. Use a Fenwick tree (binary indexed tree) for
  prefix sums with O(log n) point updates so a single row's height change
  doesn't reflow the whole list math.
- Loading the whole `notes` table at once. Pagination is mandatory; the
  cursor-based `notesState.nextCursor` flow exists for this. Never write
  `SELECT ... FROM notes` without a `LIMIT`.
- Per-keystroke / per-scroll work that scans the full list in JS. If you
  find yourself iterating `notesState.items` inside a Solid effect that
  re-runs on every store mutation, push the work to Rust + an index, or
  cache by id in a Map.
- DOM `querySelectorAll` against the sidebar / list to find a row. Keep
  id → index mappings in JS state instead.
- Loading note `content_json` for the sidebar list. The `NoteSummary` type
  carries only what the list needs (title, preview, updated_at). Never
  hydrate full notes just to render row metadata.

If a feature genuinely needs O(n) work over all notes (full-text indexing,
export, etc.), it belongs in Rust on a worker thread, not in the render
path.

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

## README maintenance

This is a public open-source repo - the `README.md` is what visitors see
first and is the canonical user-facing description of what NoteZ is and
does. **After every set of changes, before committing, check whether the
README still accurately reflects the app** and update it in the same commit
if not.

Trigger an update when changes touch any of:

- **User-visible features** - new feature shipped, existing feature removed
  or renamed, behavior change a user would notice. The README's feature
  list / screenshots / "what it does" sections must match what's actually
  in the build.
- **Install / setup steps** - new dependency, new permission prompt,
  changed `xattr` step, different download path, OS-version requirement.
  If the install instructions in the workflow `releaseBody` change, the
  README's Install section must change in lockstep.
- **Keyboard shortcuts** - any global or in-app hotkey added, removed, or
  rebound. The README's shortcut table is a contract; stale shortcuts in
  the README are worse than no table.
- **Architecture claims** - if the README says "local-only" / "no
  telemetry" / "no forced updates" / "Mac-first", and a change would
  weaken any of those, the README must be updated *before* shipping or
  the change reverted.
- **Version badge** - already covered under Versioning (the badge line
  bumps with the rest of the five files), but flag it here so it's not
  forgotten.

Skip the update for purely internal changes: refactors with no behavior
delta, test-only edits, build-config tweaks that don't affect users, type
shuffles, or comments. When in doubt, ask: *would a user reading the
README right now form an inaccurate picture of the app after this
change?* If yes, update the README in the same commit.

## Commands

Run from the repo root (workspace-aware) unless noted:

```bash
pnpm install                            # installs every workspace
pnpm desktop:tauri:dev                  # full app with hot reload
pnpm desktop:dev                        # frontend-only Vite (no Tauri shell)
pnpm desktop:typecheck                  # tsc --noEmit
pnpm desktop:build                      # frontend prod bundle -> apps/desktop/dist/
pnpm desktop:tauri:build                # native .app

pnpm web:dev                            # Astro landing page on localhost:4321
pnpm web:build                          # static export -> apps/web/dist/

cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Or `cd apps/desktop` and use the original `pnpm dev` / `pnpm tauri:dev` /
`pnpm typecheck` / `pnpm test` aliases.

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

The version stays 3-digit semver (`X.Y.Z`). What differs is **whether a bump
publishes a downloadable build**:

- **Patch bump (3rd digit, e.g. `0.4.5` → `0.4.6`)** - the **default** for any
  user-visible change: bug fix, polish, copy, small feature. Updates all
  version files and commits. By default **does NOT tag** - the bump is
  commit-only, the in-app label updates but no `.dmg` is published. Bump as
  often as work warrants.
- **Minor bump (2nd digit, e.g. `0.4.x` → `0.5.0`)** - the "real" release.
  Tagged and pushed, which triggers the CI build to publish a downloadable
  `.dmg` on GitHub Releases. Use this when there is enough accumulated
  change since the last `.dmg` to justify asking users to download a new
  build.
- **Major bump (1st digit, e.g. `0.x.y` → `1.0.0`)** - same release behaviour
  as minor, used for breaking schema/migration or when leaving pre-1.0.

The release workflow's tag filter accepts any `vX.Y.Z` tag, so a patch
*can* be tagged as a one-off hotfix release if the user explicitly asks
for it ("ship this as 0.8.4"). Don't do that on your own initiative - the
default for patches is commit-only.

**ALWAYS ASK before doing anything that creates a GitHub Release.** Before
running `git tag vX.Y.Z && git push --tags`, ask the user explicitly: *"Publish
this as `vX.Y.Z`?"* and wait for confirmation. The user wants control over
every published build - never auto-decide the release version. Patch bumps
(no tag) need no such confirmation since they don't publish anything; just
do them.

**Files to update on every desktop bump (all four must match):**
1. `apps/desktop/package.json` - `version` field (canonical; Vite's `define`
   injects this into the renderer as `__APP_VERSION__`, so `src/lib/version.ts`
   no longer needs touching - it just re-exports the global)
2. `apps/desktop/src-tauri/tauri.conf.json` - `version` field
3. `apps/desktop/src-tauri/Cargo.toml` - `[package].version`
4. `README.md` (repo root) - the `**vX.Y.Z**` line + badge at the top

The web app (`apps/web/package.json`) versions independently. Marketing-site
copy that displays the desktop version (`v0.8.x` chips, download buttons)
imports from `apps/web/src/data/site.ts`, which reads
`apps/desktop/package.json` at build time - so a desktop bump is reflected
on take-notez.com after the next Vercel build, no web edits required.

If you ship a change without bumping, you've shipped a regression - the user
can't tell what version they're running. The version label is the contract.

## Web deploy (apps/web)

The marketing site at `take-notez.com` deploys to **Vercel**, not GitHub
Actions. Setup is one-time via the Vercel dashboard:

1. Import the repo into Vercel.
2. Set **Root Directory** to `apps/web`.
3. Vercel auto-detects Astro from `apps/web/vercel.json` (framework hint
   plus `buildCommand` that installs at the workspace root and builds the
   `@notez/web` filter).
4. Attach `take-notez.com` as the custom domain.

After that, every push to `main` that touches `apps/web/`,
`packages/shared/`, or the workspace lockfile triggers a deploy. The
`ignoreCommand` in `vercel.json` skips the build for desktop-only commits.
Other branches get preview URLs automatically.

There is no GitHub Action for the web deploy. The Action only owns the
desktop release pipeline.

## Releases (apps/desktop)

Releases are built and published by GitHub Actions
(`.github/workflows/release.yml`). The workflow fires on any `vX.Y.Z` tag
push (the four-part `v*.*.*.*` form is excluded). The convention is still
that *minor and major bumps* are the planned release tiers - patches stay
commit-only by default - but the workflow itself doesn't enforce that, so
a patch tag will trigger a real build if the user explicitly asks for one.

A matching tag triggers a build on `macos-latest` for `aarch64-apple-darwin`
(Apple Silicon only - we don't ship Intel) via `tauri-apps/tauri-action`,
which uploads the `.dmg` and `.app.tar.gz` artifacts to a GitHub Release.

The release notes come from the workflow itself (`releaseBody` in
`release.yml`) and include the `xattr -cr /Applications/NoteZ.app` install
step, since the app is unsigned and Gatekeeper blocks it on first launch.
Keep that block in sync with the README's Install section if you change the
wording.

**Cutting a release (minor or major bump - ASK USER FIRST; patch only on explicit user request):**

```bash
# 1. Confirm the target version with the user. Do not assume.
#    "Publish this as v0.5.0?" and wait for explicit yes.

# 2. Bump the five version files to vX.Y.0 (see Versioning) and commit
git commit -am "chore: vX.Y.0 - <summary>"

# 3. Tag and push - this triggers the release build
git tag vX.Y.0
git push origin main --tags
```

The build runs unsigned (no Apple Developer cert wired up). Users open the
`.dmg`, drag to Applications, then run `xattr -cr /Applications/NoteZ.app`
once to clear quarantine. If/when signing is added later, set
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` as repo secrets -
`tauri-action` picks them up automatically.

The tag must match the `version` field in `tauri.conf.json` exactly (without
the `v` prefix), otherwise `tauri-action` fails the build.

## Don'ts

- **Never start the dev server on your own.** Do not run `pnpm dev`,
  `pnpm tauri dev`, `pnpm desktop:tauri:dev`, `pnpm web:dev`, or
  `preview_start` to "verify" a change unless the user explicitly asks for
  it. The user runs the dev server themselves; rely on
  `pnpm desktop:typecheck` and `cargo check` for verification, and describe
  what to look for if a manual check is needed. This overrides the generic
  preview/verification workflow for this repo.
- **No `@lexical/react`.** Solid + React don't mix; vanilla-only.
- **No `tauri-plugin-sql`.** We own the schema in Rust (richer than the plugin allows
  for FTS5 + ranking).
- **No localStorage for note content.** Persistence is SQLite via Rust commands.
- **No `npm`.** Use `pnpm` (lockfile is pnpm-lock.yaml).
- **No telemetry.** App works fully offline. The only background network
  call is an hourly GET against the GitHub Releases `latest.json` manifest
  for the in-app updater (see `src/stores/update.ts`). No body, no
  identifier, no usage data - just "is there a newer version?". The
  download + install only happens when the user clicks the sidebar-footer
  pill; the check itself never installs anything.

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
