import {
  type Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { formatRelative } from "../../lib/format";
import { api } from "../../lib/tauri";
import type { SearchHit } from "../../lib/types";
import { nowTick } from "../../stores/clock";
import { type PaneId, openNoteIds, openNoteInPane } from "../../stores/panes";

type Props = {
  paneId: PaneId;
  onCreate: () => Promise<void>;
};

/**
 * Embedded note picker shown in an empty pane. Search field is autofocused so
 * pressing ⌘D + typing flows seamlessly. Empty query shows the 5 most-recent
 * notes (filtered to those not already open in another pane, since opening
 * one of those would just focus the existing pane via the same-note guard
 * - confusing in this context).
 */
export const EmptyPanePicker: Component<Props> = (props) => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchHit[]>([]);
  const [activeIdx, setActiveIdx] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    // setTimeout 0 because the Show transition mounts us synchronously - the
    // input doesn't accept focus until after the current frame.
    setTimeout(() => inputRef?.focus(), 0);
  });

  // Filter results to drop notes already shown in another pane. The picker is
  // only useful for things you can actually open here.
  const filtered = () => {
    const open = openNoteIds();
    return results().filter((h) => !open.has(h.id));
  };

  createEffect(() => {
    const q = query();
    let cancelled = false;
    const handle = window.setTimeout(() => {
      api
        .quickLookup(q, q ? 12 : 8)
        .then((hits) => {
          if (cancelled) return;
          setResults(hits);
          setActiveIdx(0);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 60);
    onCleanup(() => {
      cancelled = true;
      window.clearTimeout(handle);
    });
  });

  const open = (id: string) => {
    openNoteInPane(props.paneId, id);
  };

  const handleKey = (e: KeyboardEvent) => {
    const list = filtered();
    const len = list.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (len > 0) setActiveIdx((i) => (i + 1) % len);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (len > 0) setActiveIdx((i) => (i - 1 + len) % len);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = list[activeIdx()];
      if (hit) open(hit.id);
    }
  };

  return (
    <div class="nz-empty-pane">
      <div class="nz-empty-pane-shell">
        <div class="nz-empty-pane-input-row">
          <SearchIcon />
          <input
            ref={(el) => (inputRef = el)}
            class="nz-empty-pane-input"
            placeholder="Search notes…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleKey}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
        <Show when={!query() && filtered().length > 0}>
          <div class="nz-empty-pane-section-label">Recent</div>
        </Show>
        <div class="nz-empty-pane-results">
          <For each={filtered()}>
            {(hit, i) => (
              <button
                type="button"
                class="nz-empty-pane-row"
                classList={{ active: i() === activeIdx() }}
                onMouseEnter={() => setActiveIdx(i())}
                onClick={() => open(hit.id)}
              >
                <span class="nz-empty-pane-row-title">{hit.title || "Untitled"}</span>
                <span class="nz-empty-pane-row-time">
                  {formatRelative(hit.updated_at, nowTick())}
                </span>
              </button>
            )}
          </For>
          <Show when={filtered().length === 0}>
            <div class="nz-empty-pane-empty">{query() ? "No matches." : "No notes available."}</div>
          </Show>
        </div>
        <button type="button" class="nz-empty-pane-create" onClick={() => void props.onCreate()}>
          + New note
        </button>
      </div>
    </div>
  );
};

const SearchIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
    <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
