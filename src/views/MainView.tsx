import type { LexicalEditor } from "lexical";
import { type Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { CommandBar } from "../components/CommandBar/CommandBar";
import { DevPanel } from "../components/DevPanel";
import { Editor, type EditorChange } from "../components/Editor/Editor";
import { EditorToolbar } from "../components/Editor/Toolbar";
import { Sidebar } from "../components/Sidebar/Sidebar";
import { SnapshotsDialog } from "../components/SnapshotsDialog";
import { HistoryIcon, SidebarIcon } from "../components/icons";
import { formatAbsoluteDate, formatRelative } from "../lib/format";
import { onEvent } from "../lib/tauri";
import { api } from "../lib/tauri";
import type { Note } from "../lib/types";
import { nowTick } from "../stores/clock";
import {
  createNote,
  ensureSelection,
  getCachedNote,
  loadMoreNotes,
  loadNote,
  notesState,
  patchCachedNote,
  refreshNotes,
  reloadNote,
  selectedId,
  setSelectedId,
  softDeleteNote,
  togglePin,
  updateNote,
} from "../stores/notes";
import { loadSettings, trashRetentionDays } from "../stores/settings";
import {
  closeCommandBar,
  closeSettings,
  commandBarOpen,
  openCommandBar,
  settingsOpen,
  sidebarCollapsed,
  toggleSidebar,
} from "../stores/ui";
import { SettingsView } from "./SettingsView";
import { useSavePipeline } from "./useSavePipeline";
import { useShortcuts } from "./useShortcuts";

export const MainView: Component = () => {
  const [activeNote, setActiveNote] = createSignal<Note | null>(null);
  const [editorKey, setEditorKey] = createSignal(0);
  const [editorInstance, setEditorInstance] = createSignal<LexicalEditor | null>(null);
  const [devPanelOpen, setDevPanelOpen] = createSignal(false);
  const [snapshotsOpen, setSnapshotsOpen] = createSignal(false);

  const save = useSavePipeline({
    onSaved: (updated) => {
      const current = activeNote();
      if (current && current.id === updated.id) setActiveNote(updated);
    },
  });

  const handleChange = (change: EditorChange) => {
    const id = selectedId();
    if (!id) return;
    save.markDirty(id, change.snapshot);
  };

  const handleOpenNote = async (id: string) => {
    if (save.hasPending()) await save.flush();
    closeSettings();
    setSelectedId(id);
  };

  const handleCreateNote = async () => {
    await save.flush();
    closeSettings();
    const note = await createNote();
    save.resetBaseline(note.id, note.content_json);
    setSelectedId(note.id);
  };

  const handleCreateWithTitle = async (title: string) => {
    await save.flush();
    closeSettings();
    const note = await createNote();
    save.resetBaseline(note.id, note.content_json);
    setSelectedId(note.id);
    // Inject title via a fresh editor state - easiest is to call updateNote with title-only state.
    const initialJson = {
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: "normal",
                style: "",
                text: title,
                type: "text",
                version: 1,
              },
            ],
            direction: "ltr",
            format: "",
            indent: 0,
            type: "paragraph",
            version: 1,
            textFormat: 0,
            textStyle: "",
          },
        ],
        direction: "ltr",
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    };
    const json = JSON.stringify(initialJson);
    const updated = await updateNote({
      id: note.id,
      title,
      content_json: json,
      content_text: title,
      mention_target_ids: [],
      asset_ids: [],
    });
    patchCachedNote(updated);
    setActiveNote(updated);
    save.resetBaseline(note.id, json);
    setEditorKey((k) => k + 1);
  };

  /** After a snapshot restores onto a note, reload that note from the DB and
   *  remount the editor with the post-restore content. Cache + sidebar
   *  summary are patched too so the user doesn't see stale title/preview. */
  const handleSnapshotRestored = async (noteId: string) => {
    // Cancel any in-flight save for the previous (now-stale) editor state.
    // The restore replaced what was on disk; we don't want a debounced save
    // of the pre-restore state to land afterwards and clobber it.
    await save.flush();
    const note = await reloadNote(noteId);
    if (selectedId() === noteId) {
      setActiveNote(note);
      save.resetBaseline(note.id, note.content_json);
      setEditorKey((k) => k + 1);
    }
  };

  const handleTogglePin = async (id: string) => {
    await togglePin(id);
    const cached = getCachedNote(id);
    if (cached && activeNote()?.id === id) setActiveNote(cached);
  };

  /** Move the sidebar selection by `step` rows. Wraps the combined
   *  `[pinned, ...items]` view, since that's how the user perceives the list. */
  const navigateSelection = (step: 1 | -1) => {
    const all = [...notesState.pinned, ...notesState.items];
    if (all.length === 0) return;
    const cur = selectedId();
    const idx = cur ? all.findIndex((n) => n.id === cur) : -1;
    let next = idx + step;
    // Clamp instead of wrap - wrapping at the bottom would teleport the user
    // back to the pinned section, which is disorienting.
    if (next < 0) next = 0;
    if (next > all.length - 1) next = all.length - 1;
    void handleOpenNote(all[next].id);
  };

  const handleDelete = async (id: string) => {
    if (save.hasPending()) await save.flush();
    await softDeleteNote(id);
    if (selectedId() === id) {
      const next = notesState.pinned[0]?.id ?? notesState.items[0]?.id ?? null;
      if (next) {
        setSelectedId(next);
      } else {
        // No notes left in the loaded prefix - try to fetch the next page
        // before giving up, in case there are more behind the cursor.
        if (notesState.nextCursor) {
          await loadMoreNotes();
          setSelectedId(notesState.items[0]?.id ?? null);
        } else {
          setSelectedId(null);
        }
      }
    }
  };

  onMount(async () => {
    // Load user settings first so the trash purge uses the configured retention.
    await loadSettings().catch((e) => {
      console.warn("loadSettings failed:", e);
    });
    // Trash auto-expiry: 0 means "never auto-delete".
    const days = trashRetentionDays();
    if (days > 0) {
      api.purgeOldTrash(days).catch((e) => {
        console.warn("purge_old_trash failed:", e);
      });
    }
    await refreshNotes();
    await ensureSelection();
  });

  // Load note when selection changes.
  createEffect(async () => {
    const id = selectedId();
    if (!id) {
      setActiveNote(null);
      setEditorInstance(null);
      return;
    }
    // Wait for any save targeting the previous note to land before we hand the
    // baseline over to the new one - otherwise the in-flight save could update
    // the new note's baseline if its IPC resolves after this effect.
    if (save.hasPending()) await save.flush();
    const note = await loadNote(id);
    setActiveNote(note);
    save.resetBaseline(note.id, note.content_json);
    setEditorKey((k) => k + 1);
  });

  useShortcuts([
    {
      hotkey: { key: "k", mods: ["mod"] },
      handler: () => {
        openCommandBar();
      },
    },
    {
      hotkey: { key: "n", mods: ["mod"] },
      handler: () => {
        void handleCreateNote();
      },
    },
    {
      hotkey: { key: "\\", mods: ["mod"] },
      handler: () => toggleSidebar(),
    },
    {
      hotkey: { key: "p", mods: ["mod", "shift"] },
      handler: () => {
        const id = selectedId();
        if (id) void handleTogglePin(id);
      },
    },
    {
      hotkey: { key: "Backspace", mods: ["mod", "shift"] },
      handler: () => {
        const id = selectedId();
        if (id) void handleDelete(id);
      },
    },
    {
      hotkey: { key: "Delete", mods: ["mod", "shift"] },
      handler: () => {
        const id = selectedId();
        if (id) void handleDelete(id);
      },
    },
    // ⌘⇧H: open snapshot history for the active note. Mirrors macOS Notes /
    // browser conventions (Cmd-Y is taken by Lexical for redo).
    {
      hotkey: { key: "h", mods: ["mod", "shift"] },
      handler: () => {
        if (selectedId()) setSnapshotsOpen(true);
      },
    },
    // Cmd-Up/Down: navigate the sidebar list without leaving the editor.
    // Skipped if the user is mid-mention (`@…` popover catches up/down first
    // because Lexical's KEY_ARROW commands run before window keydown).
    {
      hotkey: { key: "ArrowDown", mods: ["mod", "alt"] },
      handler: () => navigateSelection(1),
    },
    {
      hotkey: { key: "ArrowUp", mods: ["mod", "alt"] },
      handler: () => navigateSelection(-1),
    },
    // Dev-only: open the stress-test panel. The handler returns false in
    // release so the keypress falls through to whatever else might use it.
    {
      hotkey: { key: "d", mods: ["mod", "shift"] },
      handler: () => {
        if (!import.meta.env.DEV) return false;
        setDevPanelOpen((v) => !v);
      },
    },
  ]);

  onMount(async () => {
    const unlistenCmd = await onEvent("notez://global/command-bar", () => {
      openCommandBar();
    });
    // Fired by the Quick Capture window after it persists a new note -
    // refresh the sidebar so the entry shows up live.
    const unlistenChanged = await onEvent("notez://notes/changed", () => {
      void refreshNotes();
    });
    onCleanup(() => {
      unlistenCmd();
      unlistenChanged();
    });
  });

  return (
    <div class="nz-app" classList={{ "sidebar-collapsed": sidebarCollapsed() }}>
      <Sidebar onCreate={handleCreateNote} onTogglePin={handleTogglePin} onDelete={handleDelete} />
      <main class="nz-main">
        <Show when={!settingsOpen()} fallback={<SettingsView />}>
          <header class="nz-main-header" data-tauri-drag-region>
            <div class="nz-traffic-light-spacer" data-tauri-drag-region />
            <button
              class="nz-icon-btn"
              aria-label="Toggle sidebar"
              title="Toggle sidebar · ⌘\\"
              onClick={toggleSidebar}
            >
              <SidebarIcon />
            </button>
            <div class="nz-main-header-toolbar" data-tauri-drag-region>
              <Show when={editorInstance()}>{(ed) => <EditorToolbar editor={ed()} />}</Show>
            </div>
            <div
              class="nz-saving-indicator"
              data-tauri-drag-region
              data-state={save.savingState()}
              title={save.savingState() === "error" ? "Last save failed" : undefined}
            >
              <Show when={save.savingState() === "saving"}>Saving…</Show>
              <Show when={save.savingState() === "saved"}>Saved</Show>
              <Show when={save.savingState() === "error"}>Save failed</Show>
            </div>
            <Show when={selectedId()}>
              <button
                type="button"
                class="nz-icon-btn"
                aria-label="Snapshot history"
                title="Snapshot history · ⌘⇧H"
                onClick={() => setSnapshotsOpen(true)}
              >
                <HistoryIcon width="15" height="15" />
              </button>
            </Show>
          </header>
          <Show
            when={activeNote()}
            fallback={
              <div class="nz-empty-editor">
                <button class="nz-pill-btn primary" onClick={handleCreateNote}>
                  Create your first note
                </button>
              </div>
            }
          >
            {(note) => (
              <div class="nz-editor-wrap">
                <div class="nz-meta-bar">
                  <span class="nz-meta-primary">{formatAbsoluteDate(note().created_at)}</span>
                  <span class="nz-meta-dot" aria-hidden="true">
                    ·
                  </span>
                  <span class="nz-meta-secondary">
                    Last edited {formatRelative(note().updated_at, nowTick())}
                  </span>
                  <Show when={note().is_pinned}>
                    <span class="nz-meta-dot" aria-hidden="true">
                      ·
                    </span>
                    <span class="nz-meta-pin">Pinned</span>
                  </Show>
                </div>
                {/* Re-mount editor on note change via key. */}
                <div data-editor-key={editorKey()}>
                  <Editor
                    noteId={note().id}
                    initialJson={note().content_json}
                    onChange={handleChange}
                    onOpenNote={handleOpenNote}
                    onReady={setEditorInstance}
                  />
                </div>
              </div>
            )}
          </Show>
        </Show>
      </main>
      <CommandBar
        open={commandBarOpen()}
        onClose={closeCommandBar}
        onOpenNote={handleOpenNote}
        onCreateWithTitle={handleCreateWithTitle}
      />
      <SnapshotsDialog
        open={snapshotsOpen()}
        noteId={selectedId()}
        onClose={() => setSnapshotsOpen(false)}
        onRestored={handleSnapshotRestored}
      />
      <Show when={import.meta.env.DEV}>
        <DevPanel open={devPanelOpen()} onClose={() => setDevPanelOpen(false)} />
      </Show>
    </div>
  );
};
