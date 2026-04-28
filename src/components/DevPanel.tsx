import {
  Show,
  createEffect,
  createSignal,
  For,
  onCleanup,
  type Component,
} from "solid-js";
import { api, onDevProgress, type DevProgress } from "../lib/tauri";
import { hardRefreshNotes, setSelectedId } from "../stores/notes";

type Props = {
  open: boolean;
  onClose: () => void;
};

type Style = "plain" | "mixed" | "long";
type RunningKind = "generate" | "delete";
type Status =
  | { kind: "idle" }
  | { kind: "running"; op: RunningKind; done: number; total: number }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export const DevPanel: Component<Props> = (props) => {
  const [count, setCount] = createSignal(100);
  const [style, setStyle] = createSignal<Style>("mixed");
  const [pinPercent, setPinPercent] = createSignal(5);
  const [tracked, setTracked] = createSignal(0);
  const [status, setStatus] = createSignal<Status>({ kind: "idle" });
  let inputRef: HTMLInputElement | undefined;

  const refreshTracked = async () => {
    try {
      setTracked(await api.devCountGeneratedNotes());
    } catch (e) {
      console.warn("dev count failed:", e);
    }
  };

  createEffect(() => {
    if (!props.open) return;
    setStatus({ kind: "idle" });
    void refreshTracked();
    setTimeout(() => inputRef?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Subscribe to backend progress events for the lifetime of the open panel.
  // Each batch commit on the Rust side fires one event so the bar stays smooth
  // even when generating 100k notes.
  createEffect(() => {
    if (!props.open) return;
    let unGen: (() => void) | null = null;
    let unDel: (() => void) | null = null;

    const apply = (op: RunningKind, p: DevProgress) => {
      const cur = status();
      if (cur.kind !== "running" || cur.op !== op) return;
      setStatus({ kind: "running", op, done: p.done, total: p.total });
    };

    onDevProgress("generate", (p) => apply("generate", p)).then((u) => {
      unGen = u;
    });
    onDevProgress("delete", (p) => apply("delete", p)).then((u) => {
      unDel = u;
    });

    onCleanup(() => {
      unGen?.();
      unDel?.();
    });
  });

  const onGenerate = async () => {
    const n = Math.max(1, Math.min(100_000, Math.floor(count() || 0)));
    setStatus({ kind: "running", op: "generate", done: 0, total: n });
    const t0 = performance.now();
    try {
      const created = await api.devGenerateNotes({
        count: n,
        style: style(),
        pinPercent: Math.max(0, Math.min(100, Math.floor(pinPercent() || 0))),
      });
      const ms = Math.round(performance.now() - t0);
      // Hard reset: drops the in-memory note cache and reloaded list state
      // before refetching, so the sidebar reflects what actually landed in
      // the DB rather than patching N batches into stale local arrays.
      await hardRefreshNotes();
      await refreshTracked();
      setStatus({
        kind: "done",
        message: `Created ${created.toLocaleString()} notes in ${ms} ms`,
      });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const onDeleteAll = async () => {
    setStatus({ kind: "running", op: "delete", done: 0, total: tracked() });
    const t0 = performance.now();
    try {
      const removed = await api.devDeleteGeneratedNotes();
      const ms = Math.round(performance.now() - t0);
      // Drop selection first - the editor's effect bails on null, so it
      // won't try to load a now-deleted note via the cache. Then a hard
      // reset blows away every loaded summary + the cache map so the
      // sidebar can't keep painting deleted rows.
      setSelectedId(null);
      await hardRefreshNotes();
      await refreshTracked();
      setStatus({
        kind: "done",
        message: `Deleted ${removed.toLocaleString()} notes in ${ms} ms`,
      });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const progressPercent = () => {
    const s = status();
    if (s.kind !== "running" || s.total === 0) return 0;
    return Math.min(100, Math.round((s.done / s.total) * 100));
  };

  return (
    <Show when={props.open}>
      <div class="nz-dev-backdrop" onClick={props.onClose}>
        <div
          class="nz-dev-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nz-dev-title"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="nz-dev-header">
            <div>
              <span class="nz-dev-tag">DEV</span>
              <h2 id="nz-dev-title">Stress test notes</h2>
            </div>
            <button class="nz-dev-close" aria-label="Close" onClick={props.onClose}>
              ×
            </button>
          </header>

          <div class="nz-dev-body">
            <label class="nz-dev-row">
              <span>Count</span>
              <input
                ref={inputRef}
                type="number"
                min="1"
                max="100000"
                step="1"
                value={count()}
                onInput={(e) => setCount(parseInt(e.currentTarget.value, 10) || 0)}
              />
            </label>

            <label class="nz-dev-row">
              <span>Style</span>
              <select
                value={style()}
                onChange={(e) => setStyle(e.currentTarget.value as Style)}
              >
                <option value="plain">Plain (1-3 paragraphs)</option>
                <option value="mixed">Mixed (headings, lists, formatting)</option>
                <option value="long">Long (heading + 8-20 paragraphs)</option>
              </select>
            </label>

            <label class="nz-dev-row">
              <span>Pinned %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={pinPercent()}
                onInput={(e) =>
                  setPinPercent(parseInt(e.currentTarget.value, 10) || 0)
                }
              />
            </label>

            <div class="nz-dev-quick">
              <For each={[100, 1000, 10000, 100000]}>
                {(n) => (
                  <button class="nz-dev-chip" onClick={() => setCount(n)}>
                    {n.toLocaleString()}
                  </button>
                )}
              </For>
            </div>

            <div class="nz-dev-tracked">
              Tracked dev notes in DB: <strong>{tracked().toLocaleString()}</strong>
            </div>

            <div class="nz-dev-actions">
              <button
                class="nz-dev-btn primary"
                disabled={status().kind === "running"}
                onClick={onGenerate}
              >
                Generate
              </button>
              <button
                class="nz-dev-btn danger"
                disabled={status().kind === "running" || tracked() === 0}
                onClick={onDeleteAll}
              >
                Delete all generated
              </button>
            </div>

            <Show when={status().kind === "running"}>
              {(() => {
                const s = status() as Extract<Status, { kind: "running" }>;
                return (
                  <div class="nz-dev-progress" role="status" aria-live="polite">
                    <div class="nz-dev-progress-track">
                      <div
                        class="nz-dev-progress-fill"
                        style={{ width: `${progressPercent()}%` }}
                      />
                    </div>
                    <div class="nz-dev-progress-meta">
                      <span>
                        {s.op === "generate" ? "Generating" : "Deleting"}
                      </span>
                      <span>
                        {s.done.toLocaleString()} / {s.total.toLocaleString()}
                        {" · "}
                        {progressPercent()}%
                      </span>
                    </div>
                  </div>
                );
              })()}
            </Show>

            <div class="nz-dev-status" data-kind={status().kind}>
              {status().kind === "done" &&
                (status() as { message: string }).message}
              {status().kind === "error" &&
                "Error: " + (status() as { message: string }).message}
              {status().kind === "idle" && (
                <span class="nz-dev-hint">
                  Generates random Lexical content with bold/italic/code spans,
                  headings, lists, and quotes. Writes commit in batches of 250
                  so the UI stays responsive. "Delete all" only removes notes
                  tracked in <code>dev_generated_notes</code>.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};
