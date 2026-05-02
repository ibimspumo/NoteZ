/**
 * JSON.stringify the editor state off the UI thread.
 *
 * Why: stringifying a large Lexical editor state (10k+ nodes) on the main
 * thread can stall input by 30-80 ms. Moving the work into a dedicated worker
 * keeps the editor responsive while the user is typing into a giant note.
 *
 * The plain object passed in is structured-cloned across the worker boundary -
 * that's still O(n) in the object size, but it doesn't block paint, so frame
 * delivery stays smooth even on big snapshots.
 */
type Request = { id: number; state: unknown };
type Response = { id: number; json: string };

self.addEventListener("message", (e: MessageEvent<Request>) => {
  const { id, state } = e.data;
  const json = JSON.stringify(state);
  const reply: Response = { id, json };
  (self as unknown as Worker).postMessage(reply);
});

export {};
