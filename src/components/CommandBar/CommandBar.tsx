import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "../../lib/tauri";
import { formatRelative } from "../../lib/format";
import { nowTick } from "../../stores/clock";
import type { SearchHit } from "../../lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onCreateWithTitle: (title: string) => void;
};

export const CommandBar: Component<Props> = (props) => {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchHit[]>([]);
  const [activeIdx, setActiveIdx] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (props.open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef?.focus(), 0);
      api.quickLookup("", 8).then(setResults).catch(() => setResults([]));
    }
  });

  createEffect(() => {
    const q = query();
    if (!props.open) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      api
        .quickLookup(q, 12)
        .then((hits) => {
          if (!cancelled) {
            setResults(hits);
            setActiveIdx(0);
          }
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 60);
    onCleanup(() => {
      cancelled = true;
      clearTimeout(handle);
    });
  });

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const len = results().length;
      if (len > 0) setActiveIdx((i) => (i + 1) % len);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const len = results().length;
      if (len > 0) setActiveIdx((i) => (i - 1 + len) % len);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = results()[activeIdx()];
      if (hit) {
        props.onOpenNote(hit.id);
        props.onClose();
      } else if (query().trim()) {
        props.onCreateWithTitle(query().trim());
        props.onClose();
      }
    }
  };

  const showCreateAction = () =>
    query().trim().length > 0 &&
    !results().some(
      (r) => (r.title || "").toLowerCase() === query().trim().toLowerCase(),
    );

  return (
    <Show when={props.open}>
      <Portal>
        <div class="nz-cb-backdrop" onMouseDown={props.onClose}>
          <div
            class="nz-cb-shell"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div class="nz-cb-input-row">
              <SearchIcon />
              <input
                ref={(el) => (inputRef = el)}
                class="nz-cb-input"
                placeholder="Search or create…"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={handleKey}
                spellcheck={false}
                autocomplete="off"
              />
              <kbd class="nz-cb-esc">esc</kbd>
            </div>
            <div class="nz-cb-results">
              <For each={results()}>
                {(hit, i) => (
                  <div
                    class="nz-cb-row"
                    classList={{ active: i() === activeIdx() }}
                    onMouseEnter={() => setActiveIdx(i())}
                    onClick={() => {
                      props.onOpenNote(hit.id);
                      props.onClose();
                    }}
                  >
                    <div class="nz-cb-row-main">
                      <span class="nz-cb-row-title">
                        {hit.title || <em class="nz-untitled">Untitled</em>}
                      </span>
                      <Show when={hit.is_pinned}>
                        <span class="nz-cb-pin">📌</span>
                      </Show>
                    </div>
                    <Show when={hit.snippet}>
                      <div
                        class="nz-cb-row-snippet"
                        innerHTML={highlight(hit.snippet)}
                      />
                    </Show>
                    <div class="nz-cb-row-time">{formatRelative(hit.updated_at, nowTick())}</div>
                  </div>
                )}
              </For>
              <Show when={showCreateAction()}>
                <div
                  class="nz-cb-row create"
                  classList={{ active: results().length === 0 }}
                  onClick={() => {
                    props.onCreateWithTitle(query().trim());
                    props.onClose();
                  }}
                >
                  <div class="nz-cb-row-main">
                    <span class="nz-cb-create-icon">+</span>
                    <span class="nz-cb-row-title">
                      Create &ldquo;{query().trim()}&rdquo;
                    </span>
                  </div>
                </div>
              </Show>
              <Show when={results().length === 0 && !showCreateAction()}>
                <div class="nz-cb-empty">No notes yet - type to create one.</div>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};

function highlight(snippet: string): string {
  return escapeHtml(snippet)
    .replaceAll("&lt;&lt;", "<mark>")
    .replaceAll("&gt;&gt;", "</mark>");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const SearchIcon: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
    <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
