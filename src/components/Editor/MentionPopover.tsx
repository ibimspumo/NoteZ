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
import type { SearchHit } from "../../lib/types";
import type { MentionMatch } from "./lexical/mentionPlugin";

type Props = {
  match: MentionMatch;
  currentNoteId: string;
  onSelect: (noteId: string, title: string) => void;
  onClose: () => void;
  registerNavigate: (fn: (dir: "up" | "down") => void) => void;
  registerConfirm: (fn: () => boolean) => void;
};

export const MentionPopover: Component<Props> = (props) => {
  const [results, setResults] = createSignal<SearchHit[]>([]);
  const [activeIdx, setActiveIdx] = createSignal(0);

  createEffect(() => {
    const q = props.match.query;
    let cancelled = false;
    api.quickLookup(q, 8).then((hits) => {
      if (cancelled) return;
      const filtered = hits.filter((h) => h.id !== props.currentNoteId);
      setResults(filtered);
      setActiveIdx(0);
    }).catch(() => {
      if (!cancelled) setResults([]);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  props.registerNavigate((dir) => {
    const len = results().length;
    if (len === 0) return;
    setActiveIdx((i) => {
      if (dir === "down") return (i + 1) % len;
      return (i - 1 + len) % len;
    });
  });

  props.registerConfirm(() => {
    const r = results()[activeIdx()];
    if (!r) {
      props.onClose();
      return false;
    }
    props.onSelect(r.id, r.title || "Untitled");
    return true;
  });

  const positionStyle = () => {
    const r = props.match.rect;
    if (!r) return { left: "0px", top: "0px" };
    return {
      left: `${r.left}px`,
      top: `${r.bottom + 4}px`,
    };
  };

  return (
    <Portal>
      <div class="nz-mention-popover" style={positionStyle()}>
        <div class="nz-mention-header">
          <span class="nz-mention-prefix">@</span>
          <span class="nz-mention-query">{props.match.query || "search notes…"}</span>
        </div>
        <Show
          when={results().length > 0}
          fallback={<div class="nz-mention-empty">No matching notes</div>}
        >
          <ul class="nz-mention-list">
            <For each={results()}>
              {(hit, i) => (
                <li
                  class="nz-mention-item"
                  classList={{ active: i() === activeIdx() }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    props.onSelect(hit.id, hit.title || "Untitled");
                  }}
                  onMouseEnter={() => setActiveIdx(i())}
                >
                  <span class="nz-mention-title">
                    {hit.title || <em class="nz-untitled">Untitled</em>}
                  </span>
                  <Show when={hit.snippet}>
                    <span
                      class="nz-mention-snippet"
                      innerHTML={highlight(hit.snippet)}
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Portal>
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
