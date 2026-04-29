import { type Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { formatRelative } from "../lib/format";
import { api } from "../lib/tauri";
import type { AiCall, AiCallsCursor, AiStats } from "../lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
};

export const AIActivityDialog: Component<Props> = (props) => {
  const [items, setItems] = createSignal<AiCall[]>([]);
  const [cursor, setCursor] = createSignal<AiCallsCursor | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [stats, setStats] = createSignal<AiStats | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [page, s] = await Promise.all([api.listAiCalls(null, 50), api.getAiStats()]);
      setItems(page.items);
      setCursor(page.next_cursor);
      setStats(s);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    const c = cursor();
    if (!c || loading()) return;
    setLoading(true);
    try {
      const page = await api.listAiCalls(c, 50);
      setItems([...items(), ...page.items]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    if (!confirmClear()) {
      setConfirmClear(true);
      return;
    }
    try {
      await api.clearAiCalls();
      setConfirmClear(false);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  createEffect(() => {
    if (!props.open) {
      setConfirmClear(false);
      return;
    }
    void reload();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const isEmpty = () => loaded() && items().length === 0;

  return (
    <Show when={props.open}>
      <div class="nz-trash-backdrop" onClick={props.onClose}>
        <div
          class="nz-trash-dialog nz-ai-activity"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nz-ai-activity-title"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="nz-trash-header">
            <div class="nz-trash-title-wrap">
              <h2 class="nz-trash-title" id="nz-ai-activity-title">
                AI activity
              </h2>
              <Show when={stats()}>
                {(s) => <span class="nz-trash-count">{s().total_calls}</span>}
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

          <Show when={stats()}>
            {(s) => (
              <p class="nz-trash-blurb">
                Total spent: <strong>{formatUsd(s().total_cost_usd)}</strong> across{" "}
                {s().total_calls} call{s().total_calls === 1 ? "" : "s"}
                <Show when={s().error_calls > 0}>
                  <span> · {s().error_calls} failed</span>
                </Show>
              </p>
            )}
          </Show>

          <div class="nz-trash-body">
            <Show when={error()}>
              <p class="nz-settings-error" style={{ padding: "0 18px" }}>
                {error()}
              </p>
            </Show>
            <Show
              when={!isEmpty()}
              fallback={
                <Show when={loaded()} fallback={<div class="nz-trash-loading">Loading…</div>}>
                  <div class="nz-trash-empty">
                    <p>No AI calls yet.</p>
                  </div>
                </Show>
              }
            >
              <ul class="nz-ai-list">
                <For each={items()}>{(call) => <AiCallRow call={call} />}</For>
              </ul>
              <Show when={cursor()}>
                <button
                  class="nz-trash-loadmore"
                  onClick={() => void loadMore()}
                  disabled={loading()}
                >
                  {loading() ? "Loading…" : "Load more"}
                </button>
              </Show>
            </Show>
          </div>

          <Show when={items().length > 0}>
            <footer class="nz-trash-footer">
              <button class="nz-pill-btn danger" onClick={() => void handleClear()}>
                {confirmClear() ? "Click again to confirm" : "Clear history"}
              </button>
            </footer>
          </Show>
        </div>
      </div>
    </Show>
  );
};

const AiCallRow: Component<{ call: AiCall }> = (p) => {
  const isError = () => p.call.status === "error";
  return (
    <li class="nz-ai-row" classList={{ error: isError() }}>
      <div class="nz-ai-row-main">
        <div class="nz-ai-row-top">
          <span class="nz-ai-row-title">
            {p.call.note_title?.trim() || (p.call.note_id ? "Untitled note" : "—")}
          </span>
          <span class="nz-ai-row-cost">{isError() ? "failed" : formatUsd(p.call.cost_usd)}</span>
        </div>
        <div class="nz-ai-row-meta">
          <span title={p.call.created_at}>{formatRelative(p.call.created_at)}</span>
          <span class="nz-trash-dot" aria-hidden="true">
            ·
          </span>
          <span class="nz-ai-row-model">{p.call.model}</span>
          <Show when={!isError()}>
            <span class="nz-trash-dot" aria-hidden="true">
              ·
            </span>
            <span>
              {p.call.prompt_tokens}→{p.call.completion_tokens} tok
            </span>
            <span class="nz-trash-dot" aria-hidden="true">
              ·
            </span>
            <span>{p.call.duration_ms}ms</span>
          </Show>
        </div>
        <Show when={isError() && p.call.error}>
          <div class="nz-ai-row-error">{p.call.error}</div>
        </Show>
      </div>
    </li>
  );
};

function formatUsd(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
