import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { Sidebar } from "../components/Sidebar/Sidebar";
import { Editor, type EditorChange } from "../components/Editor/Editor";
import { EditorToolbar } from "../components/Editor/Toolbar";
import { CommandBar } from "../components/CommandBar/CommandBar";
import { onEvent } from "../lib/tauri";
import { formatAbsoluteDate, formatRelative } from "../lib/format";
import type { LexicalEditor } from "lexical";
import {
  createNote,
  ensureSelection,
  getCachedNote,
  loadNote,
  patchCachedNote,
  refreshNotes,
  selectedId,
  setSelectedId,
  softDeleteNote,
  togglePin,
  updateNote,
  loadMoreNotes,
  notesState,
} from "../stores/notes";
import {
  closeCommandBar,
  commandBarOpen,
  openCommandBar,
  sidebarCollapsed,
  toggleSidebar,
} from "../stores/ui";
import { api } from "../lib/tauri";
import type { Note } from "../lib/types";
import { loadSettings, trashRetentionDays } from "../stores/settings";
import { useSavePipeline } from "./useSavePipeline";
import { useShortcuts } from "./useShortcuts";

export const MainView: Component = () => {
  const [activeNote, setActiveNote] = createSignal<Note | null>(null);
  const [editorKey, setEditorKey] = createSignal(0);
  const [editorInstance, setEditorInstance] = createSignal<LexicalEditor | null>(null);

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
    setSelectedId(id);
  };

  const handleCreateNote = async () => {
    await save.flush();
    const note = await createNote();
    save.resetBaseline(note.id, note.content_json);
    setSelectedId(note.id);
  };

  const handleCreateWithTitle = async (title: string) => {
    await save.flush();
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

  const handleTogglePin = async (id: string) => {
    await togglePin(id);
    const cached = getCachedNote(id);
    if (cached && activeNote()?.id === id) setActiveNote(cached);
  };

  const handleDelete = async (id: string) => {
    if (save.hasPending()) await save.flush();
    await softDeleteNote(id);
    if (selectedId() === id) {
      const next =
        notesState.pinned[0]?.id ?? notesState.items[0]?.id ?? null;
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
      <Sidebar
        onCreate={handleCreateNote}
        onTogglePin={handleTogglePin}
        onDelete={handleDelete}
      />
      <main class="nz-main">
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
          <div class="nz-main-header-spacer" data-tauri-drag-region />
          <Show when={activeNote()}>
            {(note) => (
              <div
                class="nz-main-header-title"
                classList={{ "is-untitled": !note().title.trim() }}
                data-tauri-drag-region
                title={note().title.trim() || "Untitled"}
              >
                {note().title.trim() || "Untitled"}
              </div>
            )}
          </Show>
          <div class="nz-main-header-spacer" data-tauri-drag-region />
          <div class="nz-saving-indicator" data-state={save.savingState()}>
            <Show when={save.savingState() === "saving"}>Saving…</Show>
            <Show when={save.savingState() === "saved"}>Saved</Show>
          </div>
          <button
            class="nz-icon-btn"
            aria-label="Search · ⌘K"
            title="Search · ⌘K"
            onClick={openCommandBar}
          >
            <CmdKIcon />
          </button>
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
            <>
              <Show when={editorInstance()}>
                {(ed) => <EditorToolbar editor={ed()} />}
              </Show>
              <div class="nz-editor-wrap">
                <div class="nz-meta-bar">
                  <span class="nz-meta-primary">
                    {formatAbsoluteDate(note().created_at)}
                  </span>
                  <span class="nz-meta-dot" aria-hidden="true">·</span>
                  <span class="nz-meta-secondary">
                    Last edited {formatRelative(note().updated_at)}
                  </span>
                  <Show when={note().is_pinned}>
                    <span class="nz-meta-dot" aria-hidden="true">·</span>
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
            </>
          )}
        </Show>
      </main>
      <CommandBar
        open={commandBarOpen()}
        onClose={closeCommandBar}
        onOpenNote={handleOpenNote}
        onCreateWithTitle={handleCreateWithTitle}
      />
    </div>
  );
};

const SidebarIcon: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.3" />
    <line x1="6.5" y1="3" x2="6.5" y2="13" stroke="currentColor" stroke-width="1.3" />
  </svg>
);

const CmdKIcon: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.3" />
    <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
  </svg>
);
