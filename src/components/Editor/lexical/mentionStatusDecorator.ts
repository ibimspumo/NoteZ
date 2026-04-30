import type { LexicalEditor } from "lexical";
import { createEffect, createRoot } from "solid-js";
import {
  ensureMentionStatus,
  getMentionStatus,
  mentionRegistry,
} from "../../../stores/mentionRegistry";

/**
 * Per-editor: keep `data-mention-status` on every `.nz-mention` DOM element
 * in sync with the live mention registry. The CSS in `editor.css` reads this
 * attribute to paint trashed mentions dimmed and missing mentions with a
 * struck-through "broken" treatment.
 *
 * Why DOM mutation rather than a Lexical `editor.update()` to rewrite the
 * MentionNode: changing the node would mark it dirty, dirty triggers our
 * save pipeline, save bumps `updated_at`, which would re-sort the note in
 * the sidebar every time the user opens an editor whose mentions have
 * drifted. The visual hint must not look like a user edit.
 *
 * Lexical does fully re-render on rare events (undo/redo, state load), and
 * any DOM tweak we made gets clobbered. We re-paint after every editor
 * update listener fires - cheap because the DOM walk is bounded by the
 * number of mention pills in the visible note, not the corpus.
 */
export function registerMentionStatusDecorator(
  editor: LexicalEditor,
  rootEl: HTMLElement,
): () => void {
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      paint(rootEl);
    });
  };

  // Repaint after every Lexical reconcile - this catches new mentions
  // added by the user, content loaded for a new note, undo/redo, etc.
  const offUpdate = editor.registerUpdateListener(() => {
    schedule();
  });

  // Repaint when the registry itself changes (a target was trashed in
  // another pane, restored, or initially fetched). Solid's createEffect
  // tracks the read of `mentionRegistry[id]` inside `paint`, but we don't
  // know the id list ahead of time - so subscribe via a no-arg read of the
  // store object's "version" by iterating its keys. Solid tracks key-set
  // changes; new entries fire the effect, which is exactly when we need
  // to repaint pills that were "loading".
  let dispose = () => {};
  createRoot((d) => {
    dispose = d;
    createEffect(() => {
      // Touch the store so Solid tracks ANY top-level mutation:
      // new key, deleted key, or value change on a tracked key. The
      // explicit `mentionRegistry[k]` read inside the loop registers
      // a per-id dependency, so a status flip on any cached id triggers
      // re-paint without us having to enumerate ids ahead of time.
      for (const k in mentionRegistry) {
        void mentionRegistry[k];
      }
      paint(rootEl);
    });
  });

  // Initial paint on mount so existing mentions get classified before the
  // user even moves the caret.
  schedule();

  return () => {
    offUpdate();
    dispose();
  };
}

function paint(rootEl: HTMLElement) {
  const els = rootEl.querySelectorAll<HTMLElement>('[data-lexical-mention="true"]');
  if (els.length === 0) return;
  const unknown: string[] = [];
  els.forEach((el) => {
    const id = el.getAttribute("data-note-id");
    if (!id) return;
    const status = getMentionStatus(id);
    if (status === undefined) {
      el.setAttribute("data-mention-status", "loading");
      unknown.push(id);
      return;
    }
    el.setAttribute("data-mention-status", status);
  });
  if (unknown.length > 0) {
    void ensureMentionStatus(unknown);
  }
}
