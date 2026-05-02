/**
 * Main-thread side of the editor stringify pipeline.
 *
 * Lazy-creates a single shared worker on first use. The worker outlives note
 * switches - there's no per-note state, so reuse is free.
 *
 * Resilience:
 *   - On any worker error, every pending request is rejected and the worker is
 *     torn down so the next call gets a fresh one. Without this, a worker error
 *     would leak `pending` entries and any code awaiting them (the save pipeline)
 *     would hang permanently.
 *   - Each request has a soft timeout. If the worker doesn't reply within
 *     `STRINGIFY_TIMEOUT_MS`, we reject and drop the entry so memory doesn't
 *     leak when the OS suspends/resumes the page.
 *   - Rejected promises fall back to a synchronous JSON.stringify in the caller
 *     (see `stringifyEditorState`), so the save pipeline never gets stuck.
 */

const STRINGIFY_TIMEOUT_MS = 10_000;

type Resolver = {
  resolve: (json: string) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Resolver>();

function rejectAllPending(reason: string) {
  for (const r of pending.values()) {
    clearTimeout(r.timer);
    r.reject(new Error(reason));
  }
  pending.clear();
}

function teardownWorker(reason: string) {
  rejectAllPending(reason);
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // ignore
    }
    worker = null;
  }
  nextId = 0;
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./editorStringify.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (e: MessageEvent<{ id: number; json: string }>) => {
      const { id, json } = e.data;
      const resolver = pending.get(id);
      if (resolver) {
        clearTimeout(resolver.timer);
        resolver.resolve(json);
        pending.delete(id);
      }
    });
    worker.addEventListener("error", (err) => {
      console.error("[editorStringify] worker error:", err);
      teardownWorker("worker error");
    });
    worker.addEventListener("messageerror", () => {
      console.error("[editorStringify] worker messageerror");
      teardownWorker("worker messageerror");
    });
    return worker;
  } catch (e) {
    console.warn("[editorStringify] worker creation failed, falling back to sync:", e);
    return null;
  }
}

/**
 * Stringify a Lexical editor state off the UI thread.
 *
 * The `state` argument should be the result of `editor.getEditorState().toJSON()` -
 * a plain object. Don't pass live editor instances or DOM nodes; structured
 * clone won't accept them.
 *
 * Falls back to a synchronous main-thread `JSON.stringify` if the worker fails,
 * so callers never have to worry about hangs.
 */
export function stringifyEditorState(state: unknown): Promise<string> {
  const w = getWorker();
  if (!w) {
    try {
      return Promise.resolve(JSON.stringify(state));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return new Promise<string>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("stringify worker timed out"));
    }, STRINGIFY_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      w.postMessage({ id, state });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  }).catch((err) => {
    // Last-resort fallback: do it on the main thread so a stuck worker never
    // blocks a save. The user gets one frame of jank instead of lost data.
    console.warn("[editorStringify] falling back to main-thread stringify:", err);
    return JSON.stringify(state);
  });
}
