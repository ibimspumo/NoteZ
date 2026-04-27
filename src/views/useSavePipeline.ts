import { createSignal, onCleanup, onMount } from "solid-js";
import { api } from "../lib/tauri";
import { debounce } from "../lib/debounce";
import { deriveTitle } from "../lib/format";
import { patchCachedNote, updateNote } from "../stores/notes";
import type { Note } from "../lib/types";

export type EditorSnapshot = {
  /** JSON string of the editor state — already stringified (cheaply, off the UI thread). */
  contentJson: string;
  contentText: string;
  mentionTargetIds: string[];
  assetIds: string[];
};

export type SnapshotProvider = () => Promise<EditorSnapshot | null>;

export type SavingState = "idle" | "saving" | "saved";

export type SavePipeline = {
  savingState: () => SavingState;
  /** Mark the currently-edited note as dirty; the pipeline pulls a snapshot on its own schedule. */
  markDirty: (noteId: string, snapshotProvider: SnapshotProvider) => void;
  /** Force an immediate save of any pending change AND wait for any in-flight save to complete. */
  flush: () => Promise<void>;
  /** True if there's a pending change that hasn't reached the DB yet. */
  hasPending: () => boolean;
  /** Replace the "last saved" baseline — call after switching notes so the diff check is accurate. */
  resetBaseline: (noteId: string, json: string) => void;
};

const SAVE_DEBOUNCE_MS = 350;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const SAVED_INDICATOR_MS = 800;

/**
 * Save pipeline.
 *
 * Lifecycle of an edit:
 *   1. The Editor calls `markDirty(noteId, getSnapshot)` on every keystroke.
 *      `getSnapshot` is a *deferred* callback — it does NOT compute the JSON
 *      stringification yet, so per-keystroke cost is O(1).
 *   2. We debounce 350 ms. After the user stops typing, we invoke `getSnapshot`
 *      *once*. That fan-in is what makes typing feel free even on huge notes —
 *      we stringify exactly once per save, off-thread (worker), regardless of
 *      how many keystrokes happened in the burst.
 *   3. Compare the resulting JSON to the last saved baseline. If unchanged,
 *      we skip the IPC entirely. (Common when Lexical fires an update event
 *      for selection-only changes, or when the user types-then-undoes.)
 *   4. Call `update_note`, refresh local cache, possibly create an auto-snapshot.
 *
 * Concurrency invariants:
 *   - At most one `performSave` is in flight at a time. New `markDirty` calls
 *     during a save just update the pending slot; the next save reads the latest.
 *   - `lastSavedJson` and `lastSavedNoteId` are updated TOGETHER and ONLY for the
 *     note we actually saved. A note switch that races a save can't poison the
 *     baseline of the other note.
 *   - `flush()` resolves only after both the pending debounce AND any in-flight
 *     save have finished — the window-blur / note-switch caller can rely on
 *     "after flush, nothing in this pipeline is racing."
 */
export function useSavePipeline(opts: {
  onSaved?: (note: Note) => void;
}): SavePipeline {
  const [savingState, setSavingState] = createSignal<SavingState>("idle");
  let pendingNoteId: string | null = null;
  let pendingSnapshot: SnapshotProvider | null = null;
  let lastSavedJson: string = "";
  let lastSavedNoteId: string | null = null;
  let lastSnapshotAt = 0;
  let savedTimer: number | undefined;
  /** A save is in flight iff this is non-null. Lets `flush()` await it. */
  let inFlight: Promise<void> | null = null;

  async function performSave(noteId: string, provider: SnapshotProvider): Promise<void> {
    const snap = await provider();
    if (!snap) return;
    if (noteId === lastSavedNoteId && snap.contentJson === lastSavedJson) {
      // No actual content delta — Lexical fired an update for selection or a
      // formatting toggle that round-trips to the same serialized state. Skip
      // the IPC and the FTS index churn it would cause.
      return;
    }

    setSavingState("saving");
    try {
      const title = deriveTitle(snap.contentText);
      const updated = await updateNote({
        id: noteId,
        title,
        content_json: snap.contentJson,
        content_text: snap.contentText,
        mention_target_ids: snap.mentionTargetIds,
        asset_ids: snap.assetIds,
      });
      patchCachedNote(updated);
      // ONLY update baselines for the note we actually saved. If the user
      // switched notes during the IPC, `resetBaseline` for the new note has
      // already run; we must not overwrite it.
      if (lastSavedNoteId === noteId || lastSavedNoteId === null) {
        lastSavedJson = snap.contentJson;
        lastSavedNoteId = noteId;
      }
      opts.onSaved?.(updated);
      setSavingState("saved");
      window.clearTimeout(savedTimer);
      savedTimer = window.setTimeout(() => {
        if (savingState() === "saved") setSavingState("idle");
      }, SAVED_INDICATOR_MS);

      if (Date.now() - lastSnapshotAt > SNAPSHOT_INTERVAL_MS) {
        try {
          await api.createSnapshot(updated.id, false);
          lastSnapshotAt = Date.now();
        } catch {
          // expected when no changes since last snapshot — silent.
        }
      }
    } catch (e) {
      console.error("save failed:", e);
      setSavingState("idle");
    }
  }

  /** Wraps `performSave` so callers can await any in-flight work and so we can
   *  guarantee at most one save runs at a time. */
  function startSave(noteId: string, provider: SnapshotProvider): Promise<void> {
    pendingNoteId = null;
    pendingSnapshot = null;
    const work = (async () => {
      try {
        await performSave(noteId, provider);
      } finally {
        inFlight = null;
        // If new dirt arrived during the save, kick the pipeline again.
        if (pendingNoteId && pendingSnapshot) {
          const id = pendingNoteId;
          const p = pendingSnapshot;
          pendingNoteId = null;
          pendingSnapshot = null;
          inFlight = startSave(id, p);
        }
      }
    })();
    inFlight = work;
    return work;
  }

  const debouncedSave = debounce((noteId: string, provider: SnapshotProvider) => {
    // If a save is already running, queue this for after — the finally hook of
    // startSave will pick the latest pending pair up.
    if (inFlight) {
      pendingNoteId = noteId;
      pendingSnapshot = provider;
      return;
    }
    void startSave(noteId, provider);
  }, SAVE_DEBOUNCE_MS);

  const markDirty: SavePipeline["markDirty"] = (noteId, provider) => {
    pendingNoteId = noteId;
    pendingSnapshot = provider;
    debouncedSave(noteId, provider);
  };

  const flush: SavePipeline["flush"] = async () => {
    debouncedSave.cancel();
    // Capture pending before kicking it off — it could be cleared inside startSave.
    const pNoteId = pendingNoteId;
    const pProvider = pendingSnapshot;
    if (pNoteId && pProvider && !inFlight) {
      void startSave(pNoteId, pProvider);
    }
    while (inFlight) {
      await inFlight;
    }
  };

  const resetBaseline: SavePipeline["resetBaseline"] = (noteId, json) => {
    lastSavedNoteId = noteId;
    lastSavedJson = json;
    pendingNoteId = null;
    pendingSnapshot = null;
    debouncedSave.cancel();
  };

  // Flush pending changes when the window loses focus — protects against
  // "I closed the lid before the debounce fired" data loss.
  onMount(() => {
    const onBlur = () => {
      if (pendingNoteId || inFlight) void flush();
    };
    window.addEventListener("blur", onBlur);
    onCleanup(() => {
      window.removeEventListener("blur", onBlur);
      window.clearTimeout(savedTimer);
    });
  });

  return {
    savingState,
    markDirty,
    flush,
    hasPending: () => pendingNoteId !== null || inFlight !== null,
    resetBaseline,
  };
}
