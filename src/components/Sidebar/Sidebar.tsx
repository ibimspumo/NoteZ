import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import {
  loadMoreNotes,
  notesState,
  selectedId,
  setSelectedId,
} from "../../stores/notes";
import { openCommandBar, sidebarCollapsed } from "../../stores/ui";
import { sidebarPreviewLines } from "../../stores/settings";
import { nowTick } from "../../stores/clock";
import { APP_VERSION } from "../../lib/version";
import { MeasuredVirtualList } from "../MeasuredVirtualList";
import { AboutDialog } from "../AboutDialog";
import { SettingsDialog } from "../SettingsDialog";
import { TrashDialog } from "../TrashDialog";
import { NoteListItem } from "./NoteListItem";
import { bucketFor, type Bucket } from "../../lib/buckets";
import {
  bindRowHeightProbeContainer,
  rowHeightForPreview,
  subscribeRowHeightProbe,
} from "../../lib/rowHeightProbe";
import type { NoteSummary } from "../../lib/types";

type Props = {
  onCreate: () => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
};

type ListRow =
  | { kind: "header"; label: Bucket }
  | { kind: "note"; note: NoteSummary };

const HEADER_ROW_HEIGHT = 32;

export const Sidebar: Component<Props> = (props) => {
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [trashOpen, setTrashOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [probeRevision, setProbeRevision] = createSignal(0);

  onMount(() => {
    const unsub = subscribeRowHeightProbe(() => setProbeRevision((r) => r + 1));
    onCleanup(unsub);
  });

  // Group unpinned items into time buckets. Items arrive sorted by
  // updated_at DESC, so a single linear scan is enough - bucket transitions
  // happen at predictable points. O(n) on loaded items only (≤ a few page
  // chunks at any time), and re-runs only when items mutate.
  const rows = createMemo<ListRow[]>(() => {
    const items = notesState.items;
    // Reactive on nowTick so buckets re-assign as time passes (e.g. Today
    // rolls into Yesterday at midnight). Same dependency keeps the headers
    // in sync with the per-row time labels below.
    const now = new Date(nowTick());
    if (items.length === 0) return [];
    const out: ListRow[] = [];
    let last: Bucket | null = null;
    for (let i = 0; i < items.length; i++) {
      const note = items[i];
      const b = bucketFor(note.updated_at, now);
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
  const estimateVersion = createMemo(
    () => sidebarPreviewLines() * 1_000_003 + probeRevision(),
  );

  const handleSearchTrigger = (e?: Event) => {
    if (e) e.preventDefault();
    openCommandBar();
  };

  return (
    <aside
      class="nz-sidebar"
      classList={{ collapsed: sidebarCollapsed() }}
    >
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
          <SearchIcon />
          <span class="nz-search-trigger-label">Search notes</span>
          <kbd class="nz-search-trigger-kbd">⌘K</kbd>
        </button>
      </div>

      <div class="nz-sidebar-body" classList={{ "has-rows": rows().length > 0 }}>
        <Show when={notesState.pinned.length > 0}>
          <div class="nz-pinned-region">
            <div class="nz-section-label">Pinned</div>
            <ul class="nz-note-list">
              <For each={notesState.pinned}>
                {(n) => (
                  <NoteListItem
                    note={n}
                    selected={n.id === selectedId()}
                    onSelect={() => setSelectedId(n.id)}
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
              <Show
                when={
                  notesState.pinned.length === 0 && notesState.initialLoaded
                }
              >
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
                <Show when={rows()[i]}>
                  {(row) => {
                    const r = row();
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
                        onSelect={() => setSelectedId(r.note.id)}
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

      <button
        class="nz-trash-row"
        onClick={() => setTrashOpen(true)}
        aria-label="Open Trash"
      >
        <TrashIcon />
        <span class="nz-trash-row-label">Trash</span>
        <Show when={notesState.trashLoaded && notesState.trash.length > 0}>
          <span class="nz-trash-row-count">{notesState.trash.length}</span>
        </Show>
      </button>

      <div class="nz-sidebar-footer">
        <button
          class="nz-icon-btn nz-settings-button"
          aria-label="Open settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsGearIcon />
        </button>
        <button
          class="nz-version-button"
          aria-label={`About NoteZ - version ${APP_VERSION}`}
          title="About NoteZ"
          onClick={() => setAboutOpen(true)}
        >
          v{APP_VERSION}
        </button>
      </div>

      <AboutDialog open={aboutOpen()} onClose={() => setAboutOpen(false)} />
      <SettingsDialog open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <TrashDialog open={trashOpen()} onClose={() => setTrashOpen(false)} />
    </aside>
  );
};

const SearchIcon: Component = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
    <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);

const TrashIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.6 8.5A1.5 1.5 0 0 0 6.1 14.5h3.8a1.5 1.5 0 0 0 1.5-1.5l.6-8.5"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M7 7v5M9 7v5"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>
);

const SettingsGearIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.03 7.03 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
    <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.6" />
  </svg>
);

const NewNoteIcon: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M3 3.5C3 2.67 3.67 2 4.5 2H9L13 6V12.5C13 13.33 12.33 14 11.5 14H4.5C3.67 14 3 13.33 3 12.5V3.5Z"
      stroke="currentColor"
      stroke-width="1.3"
    />
    <path d="M9 2V6H13" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    <path d="M8 8.5V11.5M6.5 10H9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
  </svg>
);
