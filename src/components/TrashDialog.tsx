import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { formatRelative, truncate } from "../lib/format";
import type { TrashSummary } from "../lib/types";
import {
  emptyTrash,
  loadMoreTrash,
  loadTrash,
  notesState,
  purgeNote,
  restoreNote,
} from "../stores/notes";

type Props = {
  open: boolean;
  onClose: () => void;
};

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TrashDialog: Component<Props> = (props) => {
  const [confirmEmpty, setConfirmEmpty] = createSignal(false);

  createEffect(() => {
    if (!props.open) {
      setConfirmEmpty(false);
      return;
    }
    void loadTrash();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const items = createMemo(() => notesState.trash);
  const isEmpty = () => notesState.trashLoaded && items().length === 0;

  const handleEmpty = async () => {
    if (!confirmEmpty()) {
      setConfirmEmpty(true);
      return;
    }
    await emptyTrash();
    setConfirmEmpty(false);
  };

  return (
    <Show when={props.open}>
      <div class="nz-trash-backdrop" onClick={props.onClose}>
        <div
          class="nz-trash-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nz-trash-title"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="nz-trash-header">
            <div class="nz-trash-title-wrap">
              <TrashIcon />
              <h2 class="nz-trash-title" id="nz-trash-title">
                Trash
              </h2>
              <Show when={items().length > 0}>
                <span class="nz-trash-count">{items().length}</span>
              </Show>
            </div>
            <button
              class="nz-trash-close"
              aria-label="Close"
              title="Close · esc"
              onClick={props.onClose}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="m3.5 3.5 7 7M10.5 3.5l-7 7"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>

          <p class="nz-trash-blurb">
            Items in Trash are automatically deleted after {RETENTION_DAYS} days.
          </p>

          <div class="nz-trash-body">
            <Show
              when={!isEmpty()}
              fallback={
                <Show
                  when={notesState.trashLoaded}
                  fallback={<div class="nz-trash-loading">Loading…</div>}
                >
                  <div class="nz-trash-empty">
                    <div class="nz-trash-empty-icon">
                      <TrashIcon />
                    </div>
                    <p>Trash is empty.</p>
                  </div>
                </Show>
              }
            >
              <ul class="nz-trash-list">
                <For each={items()}>{(item) => <TrashRow item={item} />}</For>
              </ul>
              <Show when={notesState.trashCursor}>
                <button class="nz-trash-loadmore" onClick={() => void loadMoreTrash()}>
                  Load more
                </button>
              </Show>
            </Show>
          </div>

          <Show when={items().length > 0}>
            <footer class="nz-trash-footer">
              <button class="nz-pill-btn danger" onClick={() => void handleEmpty()}>
                {confirmEmpty() ? "Click again to confirm" : "Empty Trash"}
              </button>
            </footer>
          </Show>
        </div>
      </div>
    </Show>
  );
};

const TrashRow: Component<{ item: TrashSummary }> = (p) => {
  const [confirming, setConfirming] = createSignal(false);
  const title = () => p.item.title.trim() || "New Note";
  const preview = () => truncate(p.item.preview || "", 120);
  const remaining = () => {
    const deleted = Date.parse(p.item.deleted_at);
    if (Number.isNaN(deleted)) return null;
    const elapsed = Date.now() - deleted;
    const left = RETENTION_DAYS * DAY_MS - elapsed;
    if (left <= 0) return "deleting soon";
    const days = Math.ceil(left / DAY_MS);
    return days === 1 ? "1 day left" : `${days} days left`;
  };

  return (
    <li class="nz-trash-item">
      <div class="nz-trash-item-main">
        <div class="nz-trash-item-title">{title()}</div>
        <Show when={preview()}>
          <div class="nz-trash-item-preview">{preview()}</div>
        </Show>
        <div class="nz-trash-item-meta">
          <span>Deleted {formatRelative(p.item.deleted_at)}</span>
          <Show when={remaining()}>
            <span class="nz-trash-dot" aria-hidden="true">
              ·
            </span>
            <span class="nz-trash-countdown">{remaining()}</span>
          </Show>
        </div>
      </div>
      <div class="nz-trash-item-actions">
        <button class="nz-pill-btn" title="Restore" onClick={() => void restoreNote(p.item.id)}>
          Restore
        </button>
        <button
          class="nz-pill-btn danger"
          title="Delete forever"
          onClick={() => {
            if (!confirming()) {
              setConfirming(true);
              return;
            }
            void purgeNote(p.item.id);
          }}
        >
          {confirming() ? "Confirm" : "Delete"}
        </button>
      </div>
    </li>
  );
};

const TrashIcon: Component = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.6 8.5A1.5 1.5 0 0 0 6.1 14.5h3.8a1.5 1.5 0 0 0 1.5-1.5l.6-8.5"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path d="M7 7v5M9 7v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
  </svg>
);
