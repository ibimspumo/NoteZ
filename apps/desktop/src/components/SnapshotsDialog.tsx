import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { type DiffLine, type WordPart, computeLineDiff, diffStats } from "../lib/diff";
import { formatRelative } from "../lib/format";
import { api } from "../lib/tauri";
import type { Snapshot, SnapshotsCursor } from "../lib/types";
import { nowTick } from "../stores/clock";
import { loadNote } from "../stores/notes";
import { toast } from "../stores/toasts";
import { ArrowLeftIcon, CloseIcon, HistoryIcon } from "./icons";
import { Badge, Button, IconButton, Input } from "./ui";

type Props = {
  open: boolean;
  /** The note whose history we're showing. The dialog hides itself if no note
   *  is active when opened. */
  noteId: string | null;
  onClose: () => void;
  /** Called after a successful restore so the host can reload the editor with
   *  the post-restore content. The host owns the side-effects (editor key
   *  bump, baseline reset, cache patch) - we just signal "the row changed". */
  onRestored: (noteId: string) => Promise<void> | void;
};

type DiffMode = "current" | "previous";

/**
 * Snapshot history for a single note.
 *
 * Two views in one dialog:
 *   - List view: every snapshot, newest first, with auto/manual badges and
 *     timestamps. Click a row to see what changed.
 *   - Diff view: GitHub-style line-and-word-level diff between the chosen
 *     snapshot and either (a) the current note state or (b) the snapshot
 *     immediately before it. Toggleable.
 *
 * "Restore" creates a defensive backup snapshot of the current state first
 * (label: "Before restore"), so an accidental restore is recoverable - the
 * pre-restore state is right there in the history.
 *
 * Why diff over plain text and not over Lexical JSON: JSON diff is noisy
 * (every key reorder lights up red), and 99 % of what users care about is
 * "what words did I add/remove". Plain text already covers headings, lists
 * (with markers), checklist items - everything that ends up in
 * `content_text`. Format-only changes (bold/italic/etc.) are intentionally
 * invisible in the diff; the snapshot still captures them on restore.
 */
export const SnapshotsDialog: Component<Props> = (props) => {
  const [items, setItems] = createSignal<Snapshot[]>([]);
  const [cursor, setCursor] = createSignal<SnapshotsCursor | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [labelInput, setLabelInput] = createSignal("");
  const [taking, setTaking] = createSignal(false);
  const [confirmingRestore, setConfirmingRestore] = createSignal<string | null>(null);
  // When set, the dialog renders a detail-view diff for this snapshot
  // instead of the list. Closing the diff view returns to the list.
  const [viewing, setViewing] = createSignal<Snapshot | null>(null);
  const [diffMode, setDiffMode] = createSignal<DiffMode>("current");
  // Snapshot of the live note's content_text, captured when we entered the
  // diff view. We pin this so a save landing during compare doesn't make
  // the diff jitter.
  const [currentText, setCurrentText] = createSignal<string>("");

  const reload = async () => {
    const id = props.noteId;
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listSnapshots(id, null, 50);
      setItems(page.items);
      setCursor(page.next_cursor);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    const id = props.noteId;
    const c = cursor();
    if (!id || !c || loading()) return;
    setLoading(true);
    try {
      const page = await api.listSnapshots(id, c, 50);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleTakeSnapshot = async () => {
    const id = props.noteId;
    if (!id || taking()) return;
    setTaking(true);
    setError(null);
    try {
      const label = labelInput().trim() || undefined;
      await api.createSnapshot(id, true, label);
      setLabelInput("");
      toast.success("Snapshot saved");
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setTaking(false);
    }
  };

  const handleRestore = async (snapshotId: string) => {
    const id = props.noteId;
    if (!id) return;
    if (confirmingRestore() !== snapshotId) {
      setConfirmingRestore(snapshotId);
      return;
    }
    setError(null);
    try {
      // Defensive backup: take a manual snapshot of the *current* state before
      // overwriting it. If the user restores by mistake, the previous content
      // is still in the history and they can roll forward.
      try {
        await api.createSnapshot(id, true, "Before restore");
      } catch {
        // No-op snapshot (no changes since last) is fine - the previous
        // snapshot still represents the current state.
      }
      await api.restoreSnapshot(snapshotId);
      toast.success("Snapshot restored");
      await props.onRestored(id);
      setConfirmingRestore(null);
      props.onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const enterDiff = async (snap: Snapshot) => {
    const id = props.noteId;
    if (!id) return;
    // Pull the live note's text once when entering the diff view. We use the
    // store's cache when warm; otherwise fall back to a fresh IPC.
    try {
      const note = await loadNote(id);
      setCurrentText(note.content_text);
    } catch (e) {
      setError(String(e));
      setCurrentText("");
    }
    setDiffMode("current");
    setViewing(snap);
  };

  /** Find the chronologically next-older snapshot. The list is `created_at
   *  DESC` so the predecessor sits at index+1. Returns null if `snap` is the
   *  oldest loaded entry. (We don't auto-paginate to find an even older one;
   *  the user can fall back to "vs current" or load more.) */
  const previousOf = (snap: Snapshot): Snapshot | null => {
    const list = items();
    const idx = list.findIndex((s) => s.id === snap.id);
    if (idx < 0 || idx === list.length - 1) return null;
    return list[idx + 1];
  };

  const diffLines = createMemo<DiffLine[]>(() => {
    const v = viewing();
    if (!v) return [];
    const before = v.content_text;
    let after: string;
    if (diffMode() === "current") {
      after = currentText();
    } else {
      // "previous" mode shows v vs the snapshot before it - useful to see
      // what THAT snapshot recorded as a delta. We swap roles so older = before.
      const prev = previousOf(v);
      if (!prev) return [];
      // older state on the left, the chosen snapshot on the right.
      return computeLineDiff(prev.content_text, before);
    }
    return computeLineDiff(before, after);
  });

  const stats = createMemo(() => diffStats(diffLines()));
  const hasPrevious = createMemo(() => {
    const v = viewing();
    return v ? previousOf(v) !== null : false;
  });

  createEffect(() => {
    if (!props.open) {
      setConfirmingRestore(null);
      setError(null);
      setViewing(null);
      return;
    }
    setLabelInput("");
    void reload();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc backs out of the diff view first, then closes the dialog.
        if (viewing()) {
          setViewing(null);
          return;
        }
        props.onClose();
        return;
      }
      if (!viewing() && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void handleTakeSnapshot();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const isEmpty = createMemo(() => loaded() && items().length === 0);

  return (
    <Show when={props.open && props.noteId}>
      <div class="nz-trash-backdrop" onClick={props.onClose}>
        <div
          class="nz-trash-dialog nz-snapshots-dialog"
          classList={{ "in-diff": !!viewing() }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="nz-snapshots-title"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="nz-trash-header">
            <div class="nz-trash-title-wrap">
              <Show
                when={viewing()}
                fallback={
                  <>
                    <HistoryIcon width="14" height="14" />
                    <h2 class="nz-trash-title" id="nz-snapshots-title">
                      History
                    </h2>
                    <Show when={items().length > 0}>
                      <Badge variant="neutral">{items().length}</Badge>
                    </Show>
                  </>
                }
              >
                {(_v) => (
                  <>
                    <IconButton
                      size="sm"
                      aria-label="Back to history"
                      title="Back · esc"
                      onClick={() => setViewing(null)}
                    >
                      <ArrowLeftIcon width="14" height="14" />
                    </IconButton>
                    <h2 class="nz-trash-title" id="nz-snapshots-title">
                      Compare
                    </h2>
                  </>
                )}
              </Show>
            </div>
            <IconButton aria-label="Close" title="Close · esc" onClick={props.onClose}>
              <CloseIcon />
            </IconButton>
          </header>

          <Show
            when={!viewing()}
            fallback={
              <DiffView
                snap={viewing()!}
                lines={diffLines()}
                stats={stats()}
                mode={diffMode()}
                onModeChange={setDiffMode}
                hasPrevious={hasPrevious()}
                onRestore={() => handleRestore(viewing()!.id)}
                confirming={confirmingRestore() === viewing()!.id}
                onCancelRestoreConfirm={() => setConfirmingRestore(null)}
              />
            }
          >
            <p class="nz-trash-blurb">
              Auto-snapshots every ~5 min while you type (last 50 kept). Click a row to see what
              changed; manual snapshots are preserved beyond the auto cap.
            </p>

            <div class="nz-snapshots-take">
              <Input
                size="md"
                placeholder="Optional label for this snapshot…"
                value={labelInput()}
                onInput={(e) => setLabelInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleTakeSnapshot();
                  }
                }}
                maxLength={120}
                spellcheck={false}
                autocomplete="off"
              />
              <Button
                variant="primary"
                shape="pill"
                onClick={() => void handleTakeSnapshot()}
                disabled={taking()}
              >
                {taking() ? "Saving…" : "Take snapshot"}
              </Button>
            </div>

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
                      <p>No snapshots yet for this note.</p>
                    </div>
                  </Show>
                }
              >
                <ul class="nz-snapshots-list">
                  <For each={items()}>
                    {(s) => (
                      <SnapshotRow
                        snapshot={s}
                        confirming={confirmingRestore() === s.id}
                        onView={() => void enterDiff(s)}
                        onRestore={() => void handleRestore(s.id)}
                        onCancelConfirm={() => setConfirmingRestore(null)}
                      />
                    )}
                  </For>
                </ul>
                <Show when={cursor()}>
                  <button
                    type="button"
                    class="nz-trash-loadmore"
                    onClick={() => void loadMore()}
                    disabled={loading()}
                  >
                    {loading() ? "Loading…" : "Load more"}
                  </button>
                </Show>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

const SnapshotRow: Component<{
  snapshot: Snapshot;
  confirming: boolean;
  onView: () => void;
  onRestore: () => void;
  onCancelConfirm: () => void;
}> = (p) => {
  const labelOrTitle = () => {
    if (p.snapshot.is_manual && p.snapshot.manual_label?.trim()) {
      return p.snapshot.manual_label.trim();
    }
    return p.snapshot.title.trim() || "Untitled";
  };
  const preview = () => {
    const text = p.snapshot.content_text;
    const firstLine = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!firstLine) return "";
    return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
  };

  return (
    <li class="nz-snapshot-item" classList={{ manual: p.snapshot.is_manual }}>
      <button
        type="button"
        class="nz-snapshot-main"
        title="Compare with current"
        onClick={p.onView}
      >
        <div class="nz-snapshot-top">
          <span class="nz-snapshot-title">{labelOrTitle()}</span>
          <Show when={p.snapshot.is_manual}>
            <span class="nz-snapshot-badge" title="Manual snapshot">
              manual
            </span>
          </Show>
        </div>
        <Show when={preview()}>
          <div class="nz-snapshot-preview">{preview()}</div>
        </Show>
        <div class="nz-snapshot-meta">
          <span title={p.snapshot.created_at}>
            {formatRelative(p.snapshot.created_at, nowTick())}
          </span>
          <span class="nz-snapshot-cta">Click to compare →</span>
        </div>
      </button>
      <div class="nz-snapshot-actions">
        <Show
          when={p.confirming}
          fallback={
            <Button
              shape="pill"
              title="Replace current content with this snapshot"
              onClick={p.onRestore}
            >
              Restore
            </Button>
          }
        >
          <Button shape="pill" onClick={p.onCancelConfirm}>
            Cancel
          </Button>
          <Button variant="danger" shape="pill" onClick={p.onRestore}>
            Confirm restore
          </Button>
        </Show>
      </div>
    </li>
  );
};

/** Detail view: header with snapshot meta + mode toggle, body with the
 *  unified diff, footer with the Restore button. */
const DiffView: Component<{
  snap: Snapshot;
  lines: DiffLine[];
  stats: { added: number; removed: number };
  mode: DiffMode;
  onModeChange: (m: DiffMode) => void;
  hasPrevious: boolean;
  onRestore: () => void;
  confirming: boolean;
  onCancelRestoreConfirm: () => void;
}> = (p) => {
  const subtitle = () => {
    if (p.snap.is_manual && p.snap.manual_label?.trim()) return p.snap.manual_label.trim();
    return p.snap.title.trim() || "Untitled";
  };
  return (
    <>
      <div class="nz-diff-header">
        <div class="nz-diff-meta">
          <div class="nz-diff-subtitle">{subtitle()}</div>
          <div class="nz-diff-substats">
            <span title={p.snap.created_at}>{formatRelative(p.snap.created_at, nowTick())}</span>
            <span class="nz-trash-dot" aria-hidden="true">
              ·
            </span>
            <span class="nz-diff-stat-add">+{p.stats.added}</span>
            <span class="nz-diff-stat-remove">-{p.stats.removed}</span>
            <Show when={p.snap.is_manual}>
              <span class="nz-trash-dot" aria-hidden="true">
                ·
              </span>
              <span class="nz-snapshot-badge" title="Manual snapshot">
                manual
              </span>
            </Show>
          </div>
        </div>
        <div class="nz-diff-mode" role="radiogroup" aria-label="Diff mode">
          <button
            type="button"
            role="radio"
            aria-checked={p.mode === "current"}
            class="nz-settings-pill"
            classList={{ active: p.mode === "current" }}
            onClick={() => p.onModeChange("current")}
            title="Compare snapshot with the current note content"
          >
            vs current
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={p.mode === "previous"}
            class="nz-settings-pill"
            classList={{ active: p.mode === "previous" }}
            onClick={() => p.onModeChange("previous")}
            disabled={!p.hasPrevious}
            title={
              p.hasPrevious
                ? "Compare snapshot with the snapshot just before it"
                : "No earlier snapshot loaded"
            }
          >
            vs previous
          </button>
        </div>
      </div>

      <div class="nz-diff-body">
        <Show
          when={p.lines.length > 0}
          fallback={
            <div class="nz-diff-empty">
              <Show when={p.mode === "previous" && !p.hasPrevious} fallback={<p>No changes.</p>}>
                <p>This is the oldest loaded snapshot - nothing earlier to compare with.</p>
              </Show>
            </div>
          }
        >
          <div class="nz-diff" role="region" aria-label="Diff">
            <For each={p.lines}>{(line) => <DiffRow line={line} />}</For>
          </div>
        </Show>
      </div>

      <footer class="nz-trash-footer">
        <Show
          when={p.confirming}
          fallback={
            <Button variant="primary" shape="pill" onClick={p.onRestore}>
              Restore this snapshot
            </Button>
          }
        >
          <Button shape="pill" onClick={p.onCancelRestoreConfirm}>
            Cancel
          </Button>
          <Button variant="danger" shape="pill" onClick={p.onRestore}>
            Confirm restore
          </Button>
        </Show>
      </footer>
    </>
  );
};

const DiffRow: Component<{ line: DiffLine }> = (p) => {
  const sigil = () => (p.line.kind === "add" ? "+" : p.line.kind === "remove" ? "-" : " ");
  return (
    <div
      class="nz-diff-row"
      classList={{
        "nz-diff-row-add": p.line.kind === "add",
        "nz-diff-row-remove": p.line.kind === "remove",
        "nz-diff-row-context": p.line.kind === "context",
      }}
    >
      <span class="nz-diff-sigil" aria-hidden="true">
        {sigil()}
      </span>
      <Show
        when={"words" in p.line && p.line.words}
        fallback={<span class="nz-diff-text">{p.line.text || " "}</span>}
      >
        <span class="nz-diff-text">
          <For each={p.line.kind !== "context" ? (p.line.words as WordPart[]) : []}>
            {(w) => (
              <span
                classList={{
                  "nz-diff-word-add": w.kind === "add",
                  "nz-diff-word-remove": w.kind === "remove",
                }}
              >
                {w.text}
              </span>
            )}
          </For>
        </span>
      </Show>
    </div>
  );
};
