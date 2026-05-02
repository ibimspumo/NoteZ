import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { getCachedNote, notesState } from "../../stores/notes";
import {
  type LeafPane,
  type Tab,
  closeTab,
  moveTab,
  openEmptyTabInActivePane,
  setActivePaneId,
  setActiveTabId,
} from "../../stores/panes";
import { PinIcon } from "../icons";

const TAB_DRAG_MIME = "application/x-notez-tab";

type Props = {
  pane: LeafPane;
  onCreate: () => Promise<void>;
};

/**
 * Per-pane tab strip. Shown only when a pane has 2+ tabs - the single-tab
 * case keeps the simpler PaneHeader chrome (or no chrome at all in single-pane
 * mode).
 *
 * Layout strategy:
 * - Tabs are flex children with `flex: 1 1 var(--nz-tab-wunsch)` so they
 *   share available width but cap at their preferred size (140px).
 * - When the strip overflows, CSS `min-width: var(--nz-tab-min)` (80px) kicks
 *   in and any further squeeze becomes horizontal scroll.
 * - The active tab gets a higher min-width (120px) so it's always legible.
 * - A "+ new tab" button and a "▾" dropdown sit to the right of the strip.
 *   The dropdown lists every tab in the pane, useful when the strip is
 *   scrolled and the user knows the title but not where it is on the strip.
 */
export const PaneTabStrip: Component<Props> = (props) => {
  const [dropdownOpen, setDropdownOpen] = createSignal(false);
  const [dragOverIdx, setDragOverIdx] = createSignal<number | null>(null);
  let stripScrollRef: HTMLDivElement | undefined;

  const handleNewTab = () => {
    setActivePaneId(props.pane.id);
    openEmptyTabInActivePane();
  };

  // Translate vertical wheel to horizontal scroll on the strip - matches the
  // browser convention that mouse-wheel users expect when scanning many tabs.
  const handleWheel = (e: WheelEvent) => {
    if (!stripScrollRef) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (stripScrollRef.scrollWidth <= stripScrollRef.clientWidth) return;
    e.preventDefault();
    stripScrollRef.scrollLeft += e.deltaY;
  };

  // Auto-scroll the active tab into view on switch. Avoids the case where
  // pressing Ctrl+Tab cycles to a tab that's currently scrolled off-screen
  // and the user can't see they actually moved.
  createEffect(() => {
    const activeIdx = props.pane.activeTabIdx;
    queueMicrotask(() => {
      if (!stripScrollRef) return;
      const el = stripScrollRef.querySelector(
        `[data-tab-idx="${activeIdx}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }
    });
  });

  return (
    <div class="nz-pane-tabs">
      <div class="nz-pane-tabs-scroll" ref={(el) => (stripScrollRef = el)} onWheel={handleWheel}>
        <For each={props.pane.tabs}>
          {(tab, idx) => (
            <PaneTab
              tab={tab}
              idx={idx()}
              paneId={props.pane.id}
              isActive={idx() === props.pane.activeTabIdx}
              dragOverIdx={dragOverIdx()}
              onDragOver={setDragOverIdx}
              onDragEnd={() => setDragOverIdx(null)}
            />
          )}
        </For>
      </div>
      <button
        type="button"
        class="nz-pane-tabs-new"
        onClick={handleNewTab}
        title="New tab · ⌘T"
        aria-label="New tab"
      >
        +
      </button>
      <Show when={props.pane.tabs.length > 4}>
        <TabDropdown
          tabs={props.pane.tabs}
          activeTabIdx={props.pane.activeTabIdx}
          paneId={props.pane.id}
          isOpen={dropdownOpen()}
          onToggle={() => setDropdownOpen((o) => !o)}
          onClose={() => setDropdownOpen(false)}
        />
      </Show>
    </div>
  );
};

const PaneTab: Component<{
  tab: Tab;
  idx: number;
  paneId: string;
  isActive: boolean;
  dragOverIdx: number | null;
  onDragOver: (idx: number | null) => void;
  onDragEnd: () => void;
}> = (props) => {
  const note = createMemo(() => {
    const id = props.tab.noteId;
    if (!id) return null;
    const cached = getCachedNote(id);
    if (cached) return cached;
    return (
      notesState.pinned.find((n) => n.id === id) ??
      notesState.items.find((n) => n.id === id) ??
      null
    );
  });

  const title = () => {
    const n = note();
    if (!n) return props.tab.noteId ? "Untitled" : "New tab";
    return n.title?.trim() || "Untitled";
  };
  const isPinned = () => note()?.is_pinned ?? false;
  const isEmpty = () => props.tab.noteId === null;

  const handleClick = () => {
    setActiveTabId(props.paneId, props.tab.id);
  };

  const handleClose = (e: MouseEvent) => {
    e.stopPropagation();
    closeTab(props.paneId, props.tab.id);
  };

  const handleAuxClick = (e: MouseEvent) => {
    // Middle-click closes - matches every browser tab UI.
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      closeTab(props.paneId, props.tab.id);
    }
  };

  const handleDragStart = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify({ paneId: props.paneId, idx: props.idx }));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    props.onDragOver(props.idx);
  };

  const handleDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    const payload = e.dataTransfer.getData(TAB_DRAG_MIME);
    if (!payload) return;
    try {
      const parsed = JSON.parse(payload) as { paneId: string; idx: number };
      // Cross-pane tab moves are deliberately not supported in v1 - the strip
      // only handles within-pane reorder. Drop the cross-pane case quietly.
      if (parsed.paneId !== props.paneId) return;
      moveTab(props.paneId, parsed.idx, props.idx);
    } catch {
      // ignore malformed payload
    } finally {
      props.onDragEnd();
    }
  };

  return (
    <div
      class="nz-pane-tab"
      classList={{
        active: props.isActive,
        empty: isEmpty(),
        "drag-over": props.dragOverIdx === props.idx,
      }}
      data-tab-idx={props.idx}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      title={title()}
      draggable={true}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={() => {
        if (props.dragOverIdx === props.idx) props.onDragOver(null);
      }}
      onDrop={handleDrop}
      onDragEnd={props.onDragEnd}
    >
      <Show when={isPinned()}>
        <span class="nz-pane-tab-pin" aria-label="Pinned">
          <PinIcon width="10" height="10" fill="currentColor" />
        </span>
      </Show>
      <span class="nz-pane-tab-title">{title()}</span>
      <button
        type="button"
        class="nz-pane-tab-close"
        onClick={handleClose}
        aria-label="Close tab"
        tabindex="-1"
      >
        ×
      </button>
    </div>
  );
};

const TabDropdown: Component<{
  tabs: Tab[];
  activeTabIdx: number;
  paneId: string;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}> = (props) => {
  const [filter, setFilter] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  // Close on outside click. Capture phase so we beat any per-row handlers.
  createEffect(() => {
    if (!props.isOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const root = (e.currentTarget as Document) ?? document;
      const popover = root.getElementById?.("nz-pane-tabs-dropdown");
      if (popover?.contains(target)) return;
      // Toggle button click handles its own toggle, ignore those too.
      if ((target as HTMLElement).closest?.(".nz-pane-tabs-dropdown-trigger")) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", onDocPointer, true);
    onCleanup(() => document.removeEventListener("pointerdown", onDocPointer, true));
  });

  // Autofocus the filter input when the dropdown opens.
  createEffect(() => {
    if (props.isOpen) {
      queueMicrotask(() => inputRef?.focus());
      setFilter("");
    }
  });

  const matched = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const rows = props.tabs.map((t, idx) => {
      const id = t.noteId;
      const cached = id ? getCachedNote(id) : null;
      const summary =
        !cached && id
          ? (notesState.pinned.find((n) => n.id === id) ??
            notesState.items.find((n) => n.id === id) ??
            null)
          : null;
      const title = (cached?.title ?? summary?.title ?? "").trim() || (id ? "Untitled" : "New tab");
      return { tab: t, idx, title };
    });
    if (!q) return rows;
    return rows.filter((r) => r.title.toLowerCase().includes(q));
  });

  const handleSelect = (idx: number) => {
    const t = props.tabs[idx];
    if (!t) return;
    setActiveTabId(props.paneId, t.id);
    props.onClose();
  };

  return (
    <>
      <button
        type="button"
        class="nz-pane-tabs-dropdown-trigger"
        onClick={props.onToggle}
        title="All tabs in this pane"
        aria-label="All tabs"
      >
        ▾
      </button>
      <Show when={props.isOpen}>
        <div id="nz-pane-tabs-dropdown" class="nz-pane-tabs-dropdown" role="menu">
          <input
            ref={(el) => (inputRef = el)}
            class="nz-pane-tabs-dropdown-filter"
            placeholder="Filter tabs…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              } else if (e.key === "Enter") {
                e.preventDefault();
                const first = matched()[0];
                if (first) handleSelect(first.idx);
              }
            }}
            spellcheck={false}
            autocomplete="off"
          />
          <div class="nz-pane-tabs-dropdown-list">
            <For each={matched()}>
              {(row) => (
                <button
                  type="button"
                  class="nz-pane-tabs-dropdown-row"
                  classList={{ active: row.idx === props.activeTabIdx }}
                  onClick={() => handleSelect(row.idx)}
                >
                  <span class="nz-pane-tabs-dropdown-row-title">{row.title}</span>
                </button>
              )}
            </For>
            <Show when={matched().length === 0}>
              <div class="nz-pane-tabs-dropdown-empty">No tabs match.</div>
            </Show>
          </div>
        </div>
      </Show>
    </>
  );
};

// Re-exported so other modules (drag handlers etc.) can recognize a tab drag.
export { TAB_DRAG_MIME };
