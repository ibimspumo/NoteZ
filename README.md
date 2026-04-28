<p align="center">
  <img src="app-icon.png" width="160" alt="NoteZ" />
</p>

<h1 align="center">NoteZ</h1>

<p align="center">
  <em>Fast, local, beautiful notes for Mac.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.0-1f883d?style=flat-square" alt="version" />
  <img src="https://img.shields.io/badge/platform-macOS-1f883d?style=flat-square" alt="macOS" />
  <img src="https://img.shields.io/badge/storage-local%20only-1f883d?style=flat-square" alt="local-only" />
  <img src="https://img.shields.io/badge/telemetry-none-1f883d?style=flat-square" alt="no telemetry" />
  <img src="https://img.shields.io/badge/license-MIT-1f883d?style=flat-square" alt="license" />
</p>

---

NoteZ is the note app for people who think Apple Notes is too simple and Notion is
too much. It opens instantly, searches across thousands of notes in under a
hundred milliseconds, and keeps every word you write in a single file on
your Mac - no cloud, no account, no waiting.

## Why NoteZ

**It's actually fast.** Most note apps slow down once you have a few thousand
notes. NoteZ uses a real database under the hood and stays snappy whether you
have ten notes or a hundred thousand. Search results appear as you type.

**Your notes are yours.** Everything lives in a single file on your Mac. You can
back it up, sync it with iCloud Drive or Dropbox, copy it to a USB stick, or
do nothing at all. There is no NoteZ server. There is no account to make. There
is no internet connection required, ever.

**No Markdown in your face.** Type `# ` for a heading and the `# ` disappears.
Type `**bold**` and the asterisks vanish. The shortcuts are there if you want
them, but the screen always shows the finished page - never the source code.

**Mac-first, properly.** Translucent sidebar, hidden traffic lights, native dark
mode, global hotkeys. It looks and feels like an Apple app because it's built
with the same materials.

## What you can do

**Search anything in milliseconds.** Press `Cmd+K` for a Spotlight-style command
bar. Find any note by title, content, or fragment. Smart ranking puts the most
recent and most relevant matches first.

**Write without friction.** A clean editor that handles headings, bullets,
numbered lists, bold, italic, links, and inline images - all through familiar
keyboard shortcuts that get out of your way.

**Link notes together.** Type `@` anywhere to link to another note. Click the
link to jump there. Build a web of ideas without folders or tags getting in
the way.

**Pin what matters.** Keep your most-used notes at the top of the sidebar.

**Never lose a thought.** A global hotkey (`Cmd+Shift+N`) opens a tiny capture
window from anywhere on your Mac. Type, press `Cmd+Enter`, and it's saved.

**Undo yesterday.** Every five minutes of editing, NoteZ quietly takes a
snapshot. Up to fifty history points per note. Roll back to any of them with
one click.

**Trust the trash.** Deleted notes sit in a 30-day Trash before they actually
disappear. Plenty of time to change your mind.

## Keyboard

| | |
|---|---|
| `Cmd+K` | Search / command bar |
| `Cmd+N` | New note |
| `Cmd+Shift+N` | Quick Capture (works system-wide) |
| `Cmd+\` | Toggle sidebar |
| `Cmd+Shift+P` | Pin or unpin current note |
| `Cmd+Backspace` | Move note to Trash |
| `@` | Open note-link suggestions |
| `# `, `## `, `### ` | Headings |
| `- ` or `* ` | Bullet list |
| `1. ` | Numbered list |
| `**text**` | Bold |
| `_text_` | Italic |

## Install

NoteZ is built for **Apple Silicon Macs**. Grab the latest
`.dmg` from [Releases](https://github.com/ibimspumo/NoteZ/releases).

1. Open the `.dmg` and drag **NoteZ.app** into **Applications**.
2. The app is unsigned (no Apple Developer account), so macOS Gatekeeper
   will block it on first launch. Run this once in Terminal to clear the
   quarantine flag:

   ```bash
   xattr -cr /Applications/NoteZ.app
   ```

3. Open NoteZ from Applications - it will launch normally from now on.

If you skip step 2, you'll see *"NoteZ is damaged and can't be opened"* or
*"cannot be opened because the developer cannot be verified"*. That's macOS,
not the app. The `xattr` command is safe - it just removes the
quarantine attribute that Safari/Finder added to the download.

## Where your notes live

One SQLite file:

```
~/Library/Application Support/de.agent-z.notez/notez.db
```

That's it. Back it up however you like. Sync the folder if you want it on
multiple Macs. Move it to a different drive. Open it with any SQLite tool if
you ever want to look inside.

## Roadmap

**Now.** Editor, search, pinning, snapshots, mentions, quick capture, trash,
images.

**Next.** Split panes. Slash menu. Code blocks with syntax highlighting.
Backlinks panel. Hashtag tags. Daily notes. Templates.

**Later.** Windows and Linux builds. Tables, callouts, LaTeX. End-to-end
encrypted sync. Local semantic search. iOS companion.

## Built with

Tauri 2, Rust, Solid.js, TypeScript, Lexical, SQLite (FTS5). No Electron, no
React, no telemetry. The whole app is around ten megabytes.

For development setup, see [CLAUDE.md](CLAUDE.md).

## License

MIT
