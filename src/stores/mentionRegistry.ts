import { createStore, produce } from "solid-js/store";
import { api } from "../lib/tauri";
import type { MentionStatus } from "../lib/types";

/**
 * Per-noteId status map for mention targets currently rendered in any open
 * editor. The decorator in `mentionStatusDecorator.ts` reads this and paints
 * `data-mention-status` on each mention DOM node so the CSS can show alive /
 * trashed / missing states differently.
 *
 * Capacity: bounded by what's *visible* across all open panes, not the corpus.
 * A power user with 1M notes still has a tiny mention set per editor (each
 * note realistically has <50 distinct mentions), so a Solid store is fine -
 * no LRU needed.
 *
 * Reactivity: notes-store actions (`softDeleteNote`, `restoreNote`,
 * `purgeNote`) call `invalidateMentionStatus(id)` so any open editor that
 * mentioned that id re-paints on next reconcile. Likewise `createNote` /
 * `updateNote` don't change a target's existence status, so no invalidation
 * is needed there.
 */

type RegistryState = Record<string, MentionStatus>;

const [state, setState] = createStore<RegistryState>({});

const inflight = new Set<string>();

/**
 * Soft cap on the registry. A power user cycling through tens of thousands
 * of notes over a long session would otherwise accumulate every mention
 * target ever seen in memory. When we exceed the cap, drop the oldest
 * "alive" entries first - those are the cheapest to re-fetch (one IPC) and
 * the editor will re-resolve them on the next render. Trashed/missing
 * entries are kept longer because they carry user-visible state (the
 * broken-mention pill).
 */
const MENTION_REGISTRY_MAX = 5_000;
const MENTION_REGISTRY_TARGET = 4_000;

export const mentionRegistry = state;

/** Look up a target's current status. `undefined` means "unknown - the
 *  decorator should request it via `ensureMentionStatus`". */
export function getMentionStatus(id: string): MentionStatus | undefined {
  return state[id];
}

/** Fetch and cache statuses for any IDs we haven't seen yet. Idempotent and
 *  deduplicated against in-flight requests. */
export async function ensureMentionStatus(ids: string[]): Promise<void> {
  const need = ids.filter((id) => !(id in state) && !inflight.has(id));
  if (need.length === 0) return;
  for (const id of need) inflight.add(id);
  try {
    const results = await api.getMentionStatusBulk(need);
    setState(
      produce((s) => {
        for (const r of results) {
          s[r.id] = r.status;
        }
      }),
    );
    enforceCap();
  } catch (e) {
    console.warn("getMentionStatusBulk failed", e);
  } finally {
    for (const id of need) inflight.delete(id);
  }
}

/** Trim the registry when it exceeds the soft cap. Drops "alive" entries
 *  first (cheapest to re-fetch); keeps "trashed"/"missing" entries that
 *  carry visible UI state. Iteration order is insertion-order in modern
 *  engines, so older entries get evicted first by walking from the front. */
function enforceCap() {
  const keys = Object.keys(state);
  if (keys.length <= MENTION_REGISTRY_MAX) return;
  const toDrop = keys.length - MENTION_REGISTRY_TARGET;
  let dropped = 0;
  setState(
    produce((s) => {
      for (const k of keys) {
        if (dropped >= toDrop) break;
        if (s[k] === "alive") {
          delete s[k];
          dropped++;
        }
      }
      // If alive entries alone weren't enough to hit the target (corner case:
      // every entry is trashed/missing), drop oldest regardless to keep the
      // hard cap as a real cap.
      if (dropped < toDrop) {
        for (const k of keys) {
          if (dropped >= toDrop) break;
          if (k in s) {
            delete s[k];
            dropped++;
          }
        }
      }
    }),
  );
}

/** Mark a target as having changed status. Called from notes-store actions
 *  whose effects flip a note between alive/trashed/missing. The next read
 *  re-fetches from the backend. */
export function invalidateMentionStatus(id: string): void {
  if (!(id in state)) return;
  setState(
    produce((s) => {
      delete s[id];
    }),
  );
}

/** Forcibly set a status without a round-trip. Used when we already know the
 *  new state (e.g. softDelete just succeeded). Saves an IPC. */
export function setMentionStatus(id: string, status: MentionStatus): void {
  setState(id, status);
}

/** Bulk-flip every cached `trashed` entry to `missing`. Called after the
 *  empty-trash flow, where every soft-deleted note is now permanently gone
 *  and we don't have the individual IDs. */
export function markAllTrashedAsMissing(): void {
  setState(
    produce((s) => {
      for (const id of Object.keys(s)) {
        if (s[id] === "trashed") s[id] = "missing";
      }
    }),
  );
}
