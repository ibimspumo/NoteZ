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
import { CommandBar } from "../components/CommandBar/CommandBar";
import { api, onEvent } from "../lib/tauri";
import { debounce } from "../lib/debounce";
import { deriveTitle, formatRelative } from "../lib/format";
import { matchHotkey } from "../lib/keymap";
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
} from "../stores/notes";
import {
  closeCommandBar,
  commandBarOpen,
  openCommandBar,
  setSidebarCollapsed,
  sidebarCollapsed,
  toggleSidebar,
} from "../stores/ui";
import type { Note } from "../lib/types";

const SAVE_DEBOUNCE_MS = 350;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export const MainView: Component = () => {
  const [activeNote, setActiveNote] = createSignal<Note | null>(null);
  const [editorKey, setEditorKey] = createSignal(0);
  const [savingState, setSavingState] = createSignal<"idle" | "saving" | "saved">("idle");
  let pendingChange: EditorChange | null = null;
  let lastSnapshotAt = 0;

  const persist = debounce(async (change: EditorChange, noteId: string) => {
    pendingChange = null;
    setSavingState("saving");
    try {
      const title = deriveTitle(change.contentText);
      const updated = await updateNote({
        id: noteId,
        title,
        content_json: change.contentJson,
        content_text: change.contentText,
        mention_target_ids: change.mentionTargetIds,
      });
      patchCachedNote(updated);
      const current = activeNote();
      if (current && current.id === updated.id) {
        setActiveNote(updated);
      }
      setSavingState("saved");
      setTimeout(() => {
        if (savingState() === "saved") setSavingState("idle");
      }, 800);

      if (Date.now() - lastSnapshotAt > SNAPSHOT_INTERVAL_MS) {
        try {
          await api.createSnapshot(updated.id, false);
          lastSnapshotAt = Date.now();
        } catch (_) {
          // expected when no changes since last snapshot
        }
      }
    } catch (e) {
      console.error("save failed", e);
      setSavingState("idle");
    }
  }, SAVE_DEBOUNCE_MS);

  const handleChange = (change: EditorChange) => {
    pendingChange = change;
    const id = selectedId();
    if (!id) return;
    persist(change, id);
  };

  const handleOpenNote = async (id: string) => {
    setSelectedId(id);
  };

  const handleCreateNote = async () => {
    persist.flush();
    const note = await createNote();
    setSelectedId(note.id);
  };

  const handleCreateWithTitle = async (title: string) => {
    persist.flush();
    const note = await createNote();
    setSelectedId(note.id);
    // Inject title via a fresh editor state — easiest is to call updateNote with title-only state.
    const initialJson = {
      root: {
        children: [
          {
            children: [{ detail: 0, format: 0, mode: "normal", style: "", text: title, type: "text", version: 1 }],
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
    const updated = await updateNote({
      id: note.id,
      title,
      content_json: JSON.stringify(initialJson),
      content_text: title,
      mention_target_ids: [],
    });
    patchCachedNote(updated);
    setActiveNote(updated);
    setEditorKey((k) => k + 1);
  };

  const handleTogglePin = async (id: string) => {
    await togglePin(id);
    const cached = getCachedNote(id);
    if (cached && activeNote()?.id === id) setActiveNote(cached);
  };

  const handleDelete = async (id: string) => {
    persist.flush();
    await softDeleteNote(id);
    if (selectedId() === id) {
      const list = await api.listNotes(false);
      const next = list[0]?.id ?? null;
      setSelectedId(next);
    }
  };

  onMount(async () => {
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
    const note = await loadNote(id);
    setActiveNote(note);
    setEditorKey((k) => k + 1);
  });

  // Keyboard shortcuts (in-window).
  const handleKeyDown = (e: KeyboardEvent) => {
    if (matchHotkey(e, { key: "k", mods: ["mod"] })) {
      e.preventDefault();
      openCommandBar();
      return;
    }
    if (matchHotkey(e, { key: "n", mods: ["mod"] })) {
      e.preventDefault();
      handleCreateNote();
      return;
    }
    if (matchHotkey(e, { key: "\\", mods: ["mod"] })) {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (matchHotkey(e, { key: "p", mods: ["mod", "shift"] })) {
      e.preventDefault();
      const id = selectedId();
      if (id) handleTogglePin(id);
      return;
    }
    if (
      matchHotkey(e, { key: "Backspace", mods: ["mod", "shift"] }) ||
      matchHotkey(e, { key: "Delete", mods: ["mod", "shift"] })
    ) {
      e.preventDefault();
      const id = selectedId();
      if (id) handleDelete(id);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  onMount(async () => {
    const unlistenCmd = await onEvent("notez://global/command-bar", () => {
      openCommandBar();
    });
    onCleanup(() => unlistenCmd());
  });

  // Flush pending changes when window loses focus.
  onMount(() => {
    const onBlur = () => {
      if (pendingChange) persist.flush();
    };
    window.addEventListener("blur", onBlur);
    onCleanup(() => window.removeEventListener("blur", onBlur));
  });

  void sidebarCollapsed;
  void setSidebarCollapsed;

  return (
    <div class="nz-app" classList={{ "sidebar-collapsed": sidebarCollapsed() }}>
      <Sidebar
        onCreate={handleCreateNote}
        onTogglePin={handleTogglePin}
        onDelete={handleDelete}
      />
      <main class="nz-main">
        <header class="nz-main-header" data-tauri-drag-region>
          <button
            class="nz-icon-btn"
            aria-label="Toggle sidebar"
            title="Toggle sidebar · ⌘\\"
            onClick={toggleSidebar}
          >
            <SidebarIcon />
          </button>
          <div class="nz-main-header-spacer" data-tauri-drag-region />
          <div class="nz-saving-indicator" data-state={savingState()}>
            <Show when={savingState() === "saving"}>Saving…</Show>
            <Show when={savingState() === "saved"}>Saved</Show>
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
            <div class="nz-editor-wrap">
              <div class="nz-meta-bar">
                <span>{formatRelative(note().updated_at)}</span>
                <Show when={note().is_pinned}>
                  <span class="nz-meta-pin">· Pinned</span>
                </Show>
              </div>
              {/* Re-mount editor on note change via key. */}
              <div data-editor-key={editorKey()}>
                <Editor
                  noteId={note().id}
                  initialJson={note().content_json}
                  onChange={handleChange}
                  onOpenNote={handleOpenNote}
                />
              </div>
            </div>
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
