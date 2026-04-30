import {
  type Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
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
  const [placement, setPlacement] = createSignal<"below" | "above">("below");
  const [popoverHeight, setPopoverHeight] = createSignal(0);
  let popoverRef: HTMLDivElement | undefined;
  // Solid evaluates the component body once on mount. Calling the parent's
  // register* setters here used to install a closure that captured the
  // signal accessors of THIS instance - if the popover unmounted and
  // remounted (a quick @-trigger churn) without the parent clearing the
  // setter, the dead closure stuck around. By gating the registration in
  // onMount and clearing it in onCleanup we keep the Editor's `navigateFn`
  // / `confirmFn` slots strictly tied to the live popover instance.

  // Debounce the FTS query so rapid typing doesn't fire one IPC per
  // keystroke. 60ms matches the command bar's debounce - users perceive
  // the popover as "instant" while burst-typing only fires the final query.
  createEffect(() => {
    const q = props.match.query;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      api
        .quickLookup(q, 8)
        .then((hits) => {
          if (cancelled) return;
          const filtered = hits.filter((h) => h.id !== props.currentNoteId);
          setResults(filtered);
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

  onMount(() => {
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
  });

  onCleanup(() => {
    // Drop the parent's references to our closed-over closures so they
    // don't keep our (dead) signal accessors alive across a fresh mount.
    props.registerNavigate(() => {});
    props.registerConfirm(() => false);
  });

  const positionStyle = () => {
    const r = props.match.rect;
    if (!r) return { left: "0px", top: "0px", visibility: "hidden" as const };
    if (placement() === "above") {
      const h = popoverHeight();
      if (h === 0) {
        return {
          left: `${r.left}px`,
          top: `${r.bottom + 4}px`,
          visibility: "hidden" as const,
        };
      }
      return {
        left: `${r.left}px`,
        top: `${r.top - h - 4}px`,
      };
    }
    return {
      left: `${r.left}px`,
      top: `${r.bottom + 4}px`,
    };
  };

  // Re-measure the popover whenever its content or the caret position
  // changes, then flip above the caret if there isn't enough room below.
  // The first frame can render before the measurement settles, so the
  // initial style hides the popover via visibility:hidden until we know
  // its height - avoids a one-frame flash at the wrong location.
  createEffect(() => {
    results();
    props.match.rect;
    if (!popoverRef) return;
    queueMicrotask(() => {
      if (!popoverRef) return;
      const h = popoverRef.offsetHeight;
      if (h === 0) return;
      setPopoverHeight(h);
      const r = props.match.rect;
      if (!r) return;
      const margin = 8;
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      if (h > spaceBelow && spaceAbove > spaceBelow) {
        setPlacement("above");
      } else {
        setPlacement("below");
      }
    });
  });

  return (
    <Portal>
      <div class="nz-mention-popover" ref={popoverRef} style={positionStyle()}>
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
                    <span class="nz-mention-snippet" innerHTML={highlight(hit.snippet)} />
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
  return escapeHtml(snippet).replaceAll("&lt;&lt;", "<mark>").replaceAll("&gt;&gt;", "</mark>");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
