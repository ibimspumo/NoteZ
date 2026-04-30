import { type Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { type Bucket, bucketBoundaries, bucketFor } from "../../lib/buckets";
import {
  bindRowHeightProbeContainer,
  rowHeightForPreview,
  subscribeRowHeightProbe,
} from "../../lib/rowHeightProbe";
import type { NoteSummary } from "../../lib/types";
import { APP_VERSION } from "../../lib/version";
import { nowTick } from "../../stores/clock";
import { loadMoreNotes, notesState, selectedId, setSelectedId } from "../../stores/notes";
import { openNoteIds } from "../../stores/panes";
import { sidebarPreviewLines } from "../../stores/settings";
import {
  closeSettings,
  openCommandBar,
  openSettings,
  settingsOpen,
  sidebarCollapsed,
} from "../../stores/ui";
import {
  downloadAndInstall,
  updateAvailable,
  updateProgress,
  updateStage,
} from "../../stores/update";
import { AboutDialog } from "../AboutDialog";
import { MeasuredVirtualList } from "../MeasuredVirtualList";
import { TrashDialog } from "../TrashDialog";
import { NewNoteIcon, SearchIcon, SettingsGearIcon, TrashIcon } from "../icons";
import { FolderTree } from "./FolderTree";
import { NoteListItem } from "./NoteListItem";

type Props = {
  onCreate: () => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  /** Forwarded to NoteListItem rows so ⌘-click and "Open in new tab" can
   *  reach the MainView's open-note pipeline (which knows about panes/tabs). */
  onOpenNote: (id: string, opts?: { newTab?: boolean }) => void;
};

type ListRow = { kind: "header"; label: Bucket } | { kind: "note"; note: NoteSummary };

const HEADER_ROW_HEIGHT = 32;

export const Sidebar: Component<Props> = (props) => {
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [trashOpen, setTrashOpen] = createSignal(false);
  const [probeRevision, setProbeRevision] = createSignal(0);

  onMount(() => {
    const unsub = subscribeRowHeightProbe(() => setProbeRevision((r) => r + 1));
    onCleanup(unsub);
  });

  // Group unpinned items into time buckets. Items arrive sorted by
  // updated_at DESC, so a single linear scan is enough - bucket transitions
  // happen at predictable points. O(n) on loaded items only (≤ a few page
  // chunks at any time), and re-runs only when items mutate.
  //
  // We pre-compute bucket boundaries once per tick (rather than allocating
  // a Date inside `bucketFor` for every row). At ITEMS_SLIDING_WINDOW_MAX
  // = 5000 rows × 1 tick / minute that's ~5000 fewer Date allocations per
  // minute - small but free.
  const rows = createMemo<ListRow[]>(() => {
    const items = notesState.items;
    const boundaries = bucketBoundaries(new Date(nowTick()));
    if (items.length === 0) return [];
    const out: ListRow[] = [];
    let last: Bucket | null = null;
    for (let i = 0; i < items.length; i++) {
      const note = items[i];
      const b = bucketFor(note.updated_at, boundaries);
      if (b !== last) {
        out.push({ kind: "header", label: b });
        last = b;
      }
      out.push({ kind: "note", note });
    }
    return out;
  });

  // Bumped when something outside row data invalidates heights (density
  // setting, font load, sidebar resize). MeasuredVirtualList re-estimates
  // every row when this changes.
  const estimateVersion = createMemo(() => sidebarPreviewLines() * 1_000_003 + probeRevision());

  const handleSearchTrigger = (e?: Event) => {
    if (e) e.preventDefault();
    openCommandBar();
  };

  const selectNote = (id: string, opts?: { newTab?: boolean }) => {
    closeSettings();
    if (opts?.newTab) {
      props.onOpenNote(id, { newTab: true });
      return;
    }
    setSelectedId(id);
  };

  return (
    <aside class="nz-sidebar" classList={{ collapsed: sidebarCollapsed() }}>
      <div class="nz-sidebar-titlebar" data-tauri-drag-region />
      <div class="nz-sidebar-header" data-tauri-drag-region>
        <button
          class="nz-icon-btn"
          aria-label="New note"
          title="New note · ⌘N"
          onClick={props.onCreate}
        >
          <NewNoteIcon />
        </button>
      </div>

      <div class="nz-sidebar-search">
        <button
          type="button"
          class="nz-search-trigger"
          onClick={handleSearchTrigger}
          aria-label="Search notes · ⌘K"
        >
          <SearchIcon width="13" height="13" />
          <span class="nz-search-trigger-label">Search notes</span>
          <kbd class="nz-search-trigger-kbd">⌘K</kbd>
        </button>
      </div>

      <div class="nz-sidebar-body" classList={{ "has-rows": rows().length > 0 }}>
        <FolderTree />

        <Show when={notesState.pinned.length > 0}>
          <div class="nz-pinned-region">
            <div class="nz-section-label">Pinned</div>
            <ul class="nz-note-list">
              <For each={notesState.pinned}>
                {(n) => (
                  <NoteListItem
                    note={n}
                    selected={n.id === selectedId()}
                    openElsewhere={openNoteIds().has(n.id) && n.id !== selectedId()}
                    onSelect={(opts) => selectNote(n.id, opts)}
                    onTogglePin={() => props.onTogglePin(n.id)}
                    onDelete={() => props.onDelete(n.id)}
                  />
                )}
              </For>
            </ul>
          </div>
        </Show>

        <div class="nz-others-region">
          <Show
            when={rows().length > 0}
            fallback={
              <Show when={notesState.pinned.length === 0 && notesState.initialLoaded}>
                <div class="nz-empty-state">
                  <p>No notes yet.</p>
                  <button class="nz-pill-btn" onClick={props.onCreate}>
                    Create your first note
                  </button>
                </div>
              </Show>
            }
          >
            <MeasuredVirtualList
              class="nz-others-mvlist"
              ref={(el) => bindRowHeightProbeContainer(el)}
              count={rows().length}
              estimateVersion={estimateVersion()}
              estimateHeight={(i) => {
                const r = rows()[i];
                if (!r) return HEADER_ROW_HEIGHT;
                if (r.kind === "header") return HEADER_ROW_HEIGHT;
                const lines = sidebarPreviewLines();
                return rowHeightForPreview(r.note.preview ?? "", lines);
              }}
              hasMore={!!notesState.nextCursor}
              onLoadMore={loadMoreNotes}
              renderRow={(i) => (
                <Show when={rows()[i]} keyed>
                  {(r) => {
                    // `keyed` is required. Without it Solid's <Show> uses
                    // `equals: (a, b) => !a === !b` and only re-emits when
                    // truthiness flips, so this function would run once at
                    // mount and freeze on the first ListRow it ever saw -
                    // which made the sidebar's bucket header look stuck
                    // after a save reordered the items underneath. With
                    // `keyed` the function re-runs on every identity
                    // change of rows()[i].
                    if (r.kind === "header") {
                      return (
                        <div class="nz-bucket-header">
                          <span>{r.label}</span>
                        </div>
                      );
                    }
                    return (
                      <NoteListItem
                        note={r.note}
                        selected={r.note.id === selectedId()}
                        openElsewhere={openNoteIds().has(r.note.id) && r.note.id !== selectedId()}
                        onSelect={(opts) => selectNote(r.note.id, opts)}
                        onTogglePin={() => props.onTogglePin(r.note.id)}
                        onDelete={() => props.onDelete(r.note.id)}
                      />
                    );
                  }}
                </Show>
              )}
            />
          </Show>
        </div>
      </div>

      <button class="nz-trash-row" onClick={() => setTrashOpen(true)} aria-label="Open Trash">
        <TrashIcon width="14" height="14" />
        <span class="nz-trash-row-label">Trash</span>
        <Show when={notesState.trashLoaded && notesState.trash.length > 0}>
          <span class="nz-trash-row-count">{notesState.trash.length}</span>
        </Show>
      </button>

      <div class="nz-sidebar-footer">
        <button
          class="nz-icon-btn nz-settings-button"
          classList={{ active: settingsOpen() }}
          aria-label={settingsOpen() ? "Close settings" : "Open settings"}
          aria-pressed={settingsOpen()}
          title="Settings"
          onClick={() => (settingsOpen() ? closeSettings() : openSettings())}
        >
          <SettingsGearIcon width="14" height="14" />
        </button>
        <Show
          when={updateAvailable() && updateStage() !== "idle" && updateStage() !== "checking"}
          fallback={
            <button
              class="nz-version-button"
              aria-label={`About NoteZ - version ${APP_VERSION}`}
              title="About NoteZ"
              onClick={() => setAboutOpen(true)}
            >
              v{APP_VERSION}
            </button>
          }
        >
          <button
            class="nz-version-button nz-version-button-update"
            data-stage={updateStage()}
            aria-label={`Update auf v${updateAvailable()?.version} verfügbar - jetzt installieren`}
            title={
              updateStage() === "downloading"
                ? `Lade v${updateAvailable()?.version}…`
                : updateStage() === "installing"
                  ? "Installiere und starte neu…"
                  : `Update auf v${updateAvailable()?.version} - klick zum Installieren`
            }
            disabled={updateStage() === "downloading" || updateStage() === "installing"}
            onClick={() => {
              void downloadAndInstall();
            }}
          >
            <Show
              when={updateStage() === "downloading"}
              fallback={
                <Show
                  when={updateStage() === "installing"}
                  fallback={<>v{updateAvailable()?.version} ↓</>}
                >
                  Installiere…
                </Show>
              }
            >
              {updateProgress() ?? 0}%
            </Show>
          </button>
        </Show>
      </div>

      <AboutDialog open={aboutOpen()} onClose={() => setAboutOpen(false)} />
      <TrashDialog open={trashOpen()} onClose={() => setTrashOpen(false)} />
    </aside>
  );
};
