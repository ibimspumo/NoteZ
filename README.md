# NoteZ

**v0.4.2** — Fast, local, beautiful notes for Mac.

NoteZ is the note-taking app that fills the gap between Apple Notes (too simple, Apple-only)
and Obsidian/Notion (too complex, online-first). Built native with Tauri 2 + Rust + Solid.js,
it boots instantly, ships zero telemetry, stores everything locally in SQLite, and gets out
of your way.

## Why

- **Apple-Notes speed.** Sub-100ms search across 100k notes via SQLite FTS5 with smart
  ranking (recency × match quality × pin × prefix bonus).
- **No cloud lock-in.** Your data is one SQLite file in a folder of your choice. Sync it
  yourself with iCloud Drive, Dropbox, Syncthing — or don't sync at all.
- **No Markdown in your face.** WYSIWYG editor (custom-built on Lexical) where Markdown
  shortcuts work but the syntax is never shown.
- **Mac-first.** Vibrancy, native window chrome, system dark mode, global hotkeys.
  Win/Linux possible later — same codebase.

## Stack

- **Tauri 2** for the shell (native macOS WebKit, ~10 MB bundle).
- **Rust** for the backend: SQLite (with FTS5), migrations, ranking, snapshots.
- **Solid.js + TypeScript** for the frontend (fine-grained reactivity, fast on long lists).
- **Lexical** as an invisible editor engine — custom UI, custom nodes, custom plugins built on top.
- **No telemetry, no accounts, no required network calls.**

## Features

- ⚡️ Instant search (`⌘K`) — Spotlight-style command bar, fuzzy + FTS, smart ranking.
- 📝 WYSIWYG editor — type `# `, `## `, `- `, `1. `, `[]`, `**bold**`, `_italic_`. The
  syntax disappears as you type.
- 🔗 `@mentions` — type `@` to link to any note. Inline auto-suggest, click to jump.
- 📌 Pinning — keep important notes at the top of the sidebar.
- 🗑️ Soft-delete with 30-day Trash.
- ⏱️ Automatic snapshots — every five minutes of edits, with up to 50 history points
  per note. Roll back from the Versions panel.
- 🪟 Quick Capture — a global hotkey (`⌘⇧N`) opens a tiny capture window from anywhere.
  `⌘ + ↵` to save, `esc` to dismiss.
- 🍎 Mac-native — vibrancy, transparent titlebar, hidden traffic lights, follows system dark mode.

## Keyboard

| Shortcut | Action |
|---|---|
| `⌘K` | Open search / command bar |
| `⌘N` | New note |
| `⌘⇧N` | Quick Capture (works globally) |
| `⌘\\` | Toggle sidebar |
| `⌘⇧P` | Pin/unpin current note |
| `⌘⌫` | Move current note to trash |
| `@` (in editor) | Open note-link suggestions |
| `# `, `## `, `### ` | Heading 1/2/3 |
| `- `, `* ` | Bullet list |
| `1. ` | Numbered list |
| `**text**`, `_text_` | Bold / italic |

## Develop

```bash
# Install Rust (one time): https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

pnpm install
pnpm tauri dev          # run in dev with hot reload
pnpm typecheck          # frontend type-check
pnpm tauri build        # produce a signed-able .app
```

## Storage

NoteZ stores its database in:

```
~/Library/Application Support/de.agent-z.notez/notez.db
```

The schema is documented in [src-tauri/src/db.rs](src-tauri/src/db.rs). It's a single
SQLite file with FTS5, plus an `attachments/` and `snapshots/` companion directory next to
it (will be added when image/file support lands in Phase 2).

## Roadmap

**Phase 1 — Shipped (this repo).**
Editor, search, sidebar, pinning, soft-delete, auto-snapshots, mentions, quick capture,
mac vibrancy.

**Phase 2.** Multi-pane (drag a note from the sidebar onto the editor for a 50/50 split,
recursively splittable). Images with content-addressable storage and OCR via Apple Vision.
Code blocks with syntax highlighting. Slash menu. Backlinks panel. `#hashtag` tags.
Daily notes. Templates.

**Phase 3.** Windows + Linux builds. Tables, callouts, toggle blocks, LaTeX. CRDT-based
sync layer. Local semantic search (Ollama). iOS companion app.

## License

MIT
