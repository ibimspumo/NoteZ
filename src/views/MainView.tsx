import { type Component, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { CommandBar } from "../components/CommandBar/CommandBar";
import { DevPanel } from "../components/DevPanel";
import { EditorToolbar } from "../components/Editor/Toolbar";
import { PaneTree } from "../components/Pane/PaneTree";
import { Sidebar } from "../components/Sidebar/Sidebar";
import { SnapshotsDialog } from "../components/SnapshotsDialog";
import { HistoryIcon, SidebarIcon } from "../components/icons";
import { matchHotkey } from "../lib/keymap";
import { api, onEvent } from "../lib/tauri";
import {
  createNote,
  ensureSelection,
  getCachedNote,
  loadMoreNotes,
  notesState,
  patchCachedNote,
  refreshNotes,
  selectedId,
  setSelectedId,
  softDeleteNote,
  togglePin,
  updateNote,
} from "../stores/notes";
import {
  activeApi,
  activeEditor,
  activePaneId,
  closePane,
  panes,
  panesState,
  setActivePaneId,
  splitPane,
  totalPaneCount,
} from "../stores/panes";
import {
  loadLayout,
  restoreLayoutFromSettings,
  scheduleLayoutPersist,
} from "../stores/panesPersist";
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
import { useShortcuts } from "./useShortcuts";

export const MainView: Component = () => {
  const [snapshotsOpen, setSnapshotsOpen] = createSignal(false);
  const [devPanelOpen, setDevPanelOpen] = createSignal(false);

  const savingState = createMemo(() => activeApi()?.savingState() ?? "idle");
  const layoutRoot = createMemo(() => panesState.root);

  const flushIfPending = async () => {
    const a = activeApi();
    if (a?.hasPendingSave()) await a.flushSave();
  };

  const handleOpenNote = async (id: string, opts?: { split: boolean }) => {
    await flushIfPending();
    closeSettings();
    if (opts?.split) {
      // ⌘/Ctrl+click on a mention: open the linked note in a new right-split
      // pane, mirroring ⌘D. splitPane's same-note guard focuses an existing
      // pane if the note is already open elsewhere.
      splitPane(activePaneId(), "right", id);
      return;
    }
    setSelectedId(id);
  };

  const handleCreateNote = async () => {
    await activeApi()?.flushSave();
    closeSettings();
    const note = await createNote();
    activeApi()?.resetBaseline(note.id, note.content_json);
    setSelectedId(note.id);
  };

  const handleCreateWithTitle = async (title: string) => {
    await activeApi()?.flushSave();
    closeSettings();
    const note = await createNote();
    activeApi()?.resetBaseline(note.id, note.content_json);
    setSelectedId(note.id);
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
    activeApi()?.applyExternalUpdate(updated);
  };

  const handleSnapshotRestored = async (noteId: string) => {
    const a = activeApi();
    if (a) await a.reloadFromBackend(noteId);
  };

  const handleTogglePin = async (id: string) => {
    await togglePin(id);
    const cached = getCachedNote(id);
    if (cached) activeApi()?.syncActiveNote(cached);
  };

  /** Move the sidebar selection by `step` rows. Wraps the combined
   *  `[pinned, ...items]` view, since that's how the user perceives the list. */
  const navigateSelection = (step: 1 | -1) => {
    const all = [...notesState.pinned, ...notesState.items];
    if (all.length === 0) return;
    const cur = selectedId();
    const idx = cur ? all.findIndex((n) => n.id === cur) : -1;
    let next = idx + step;
    if (next < 0) next = 0;
    if (next > all.length - 1) next = all.length - 1;
    void handleOpenNote(all[next].id);
  };

  const handleDelete = async (id: string) => {
    await flushIfPending();
    await softDeleteNote(id);
    if (selectedId() === id) {
      const next = notesState.pinned[0]?.id ?? notesState.items[0]?.id ?? null;
      if (next) {
        setSelectedId(next);
      } else if (notesState.nextCursor) {
        await loadMoreNotes();
        setSelectedId(notesState.items[0]?.id ?? null);
      } else {
        setSelectedId(null);
      }
    }
  };

  const splitActivePane = (side: "right" | "bottom") => {
    splitPane(activePaneId(), side, null);
  };

  const closeActivePane = () => {
    if (totalPaneCount() <= 1) return;
    closePane(activePaneId());
  };

  const focusPaneByIndex = (n: number) => {
    const list = panes();
    const target = list[n - 1];
    if (target) setActivePaneId(target.id);
  };

  onMount(async () => {
    await loadSettings().catch((e) => console.warn("loadSettings failed:", e));
    const days = trashRetentionDays();
    if (days > 0) {
      api.purgeOldTrash(days).catch((e) => console.warn("purge_old_trash failed:", e));
    }
    await refreshNotes();
    // Restore the saved layout BEFORE ensureSelection so the layout drives the
    // initial selection, not the other way around. References to deleted
    // notes get nulled out by `restoreLayoutFromSettings`.
    const saved = await loadLayout();
    if (saved) restoreLayoutFromSettings(saved);
    await ensureSelection();
    // Subsequent layout mutations debounce-persist to the settings table.
    scheduleLayoutPersist();
  });

  useShortcuts([
    { hotkey: { key: "k", mods: ["mod"] }, handler: () => openCommandBar() },
    {
      hotkey: { key: "n", mods: ["mod"] },
      handler: () => {
        void handleCreateNote();
      },
    },
    { hotkey: { key: "\\", mods: ["mod"] }, handler: () => toggleSidebar() },
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
    {
      hotkey: { key: "h", mods: ["mod", "shift"] },
      handler: () => {
        if (selectedId()) setSnapshotsOpen(true);
      },
    },
    {
      hotkey: { key: "ArrowDown", mods: ["mod", "alt"] },
      handler: () => navigateSelection(1),
    },
    {
      hotkey: { key: "ArrowUp", mods: ["mod", "alt"] },
      handler: () => navigateSelection(-1),
    },
    // Splits: ⌘D right, ⌘⇧D down. New pane comes up empty - the picker is
    // autofocused so the user keeps typing without an extra click.
    {
      hotkey: { key: "d", mods: ["mod"] },
      handler: () => splitActivePane("right"),
    },
    {
      hotkey: { key: "d", mods: ["mod", "shift"] },
      handler: () => splitActivePane("bottom"),
    },
    // ⌘W: close active pane. Returns false (falls through) when there's only
    // one pane left, so Tauri's window-close binding can still take it.
    {
      hotkey: { key: "w", mods: ["mod"] },
      handler: () => {
        if (totalPaneCount() <= 1) return false;
        closeActivePane();
      },
    },
    // Dev-only: stress-test panel.
    {
      hotkey: { key: "d", mods: ["mod", "shift", "alt"] },
      handler: () => {
        if (!import.meta.env.DEV) return false;
        setDevPanelOpen((v) => !v);
      },
    },
  ]);

  // ⌘1..⌘9 focus pane N. One listener handles the whole range - cheaper than
  // nine entries in `useShortcuts`.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (totalPaneCount() <= 1) return;
      for (let n = 1; n <= 9; n++) {
        if (matchHotkey(e, { key: String(n), mods: ["mod"] })) {
          e.preventDefault();
          focusPaneByIndex(n);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  onMount(async () => {
    const unlistenCmd = await onEvent("notez://global/command-bar", () => {
      openCommandBar();
    });
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
              <Show when={activeEditor()}>{(ed) => <EditorToolbar editor={ed()} />}</Show>
            </div>
            <div
              class="nz-saving-indicator"
              data-tauri-drag-region
              data-state={savingState()}
              title={savingState() === "error" ? "Last save failed" : undefined}
            >
              <Show when={savingState() === "saving"}>Saving…</Show>
              <Show when={savingState() === "saved"}>Saved</Show>
              <Show when={savingState() === "error"}>Save failed</Show>
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
          <div class="nz-pane-host">
            <PaneTree
              node={layoutRoot()}
              onOpenNote={handleOpenNote}
              onCreate={handleCreateNote}
            />
          </div>
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
