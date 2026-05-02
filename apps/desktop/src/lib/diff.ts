import { type Change, diffLines, diffWordsWithSpace } from "diff";

/**
 * Diff helpers for the snapshot-history view.
 *
 * Two granularities:
 *   - Line-level: the structural diff that decides which rows are added /
 *     removed / unchanged.
 *   - Word-level (intra-line): for a "changed" line pair, highlight which
 *     words inside actually differ. GitHub's classic look. We only run this
 *     when both an added and a removed line sit adjacent in the line diff,
 *     meaning the user *edited* that line rather than wholesale deleted /
 *     inserted it.
 *
 * Why hand-roll the pairing on top of `diff`'s `diffLines`: `diffLines`
 * gives us a flat sequence of "added", "removed", "unchanged" chunks. To
 * present GitHub-style edited-line pairs we walk that sequence, look for
 * removed-followed-by-added, and run a second word-level diff on the line
 * texts. That second pass is the secret to readable diffs - without it the
 * user only sees "this whole line went red, this whole line came green".
 */

export type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "add"; text: string; words?: WordPart[] }
  | { kind: "remove"; text: string; words?: WordPart[] };

export type WordPart =
  | { kind: "same"; text: string }
  | { kind: "add"; text: string }
  | { kind: "remove"; text: string };

/** Compute a unified line diff between `before` and `after`.
 *
 *  Adjacent removed/added blocks of equal-ish length are paired and given a
 *  word-level overlay so the renderer can highlight only the changed words.
 *
 *  Both inputs are normalised to end with `\n` before diffing - jsdiff
 *  treats a trailing-newline-less last line as a separate token from a
 *  newline-terminated one, which would surface as spurious "edited last
 *  line" diff artefacts whenever notes are saved without a trailing newline.
 *  Our editor doesn't append one, so we have to guard against it here. */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.endsWith("\n") || before === "" ? before : `${before}\n`;
  const b = after.endsWith("\n") || after === "" ? after : `${after}\n`;
  const chunks = diffLines(a, b);
  const out: DiffLine[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const lines = stripTrailingNewline(c.value).split("\n");
    if (c.added) {
      // Pair with an immediately preceding remove block - only when both have
      // exactly one line, to avoid noisy word-level alignment on big multi-
      // line edits where line-level granularity already conveys the intent.
      const prev = chunks[i - 1];
      if (prev?.removed) {
        const prevLines = stripTrailingNewline(prev.value).split("\n");
        if (prevLines.length === 1 && lines.length === 1) {
          // Replace the previously-emitted plain "remove" with a word-overlay
          // pair: the existing remove gets words, then we emit the matching add.
          const removeIdx = out.length - 1;
          if (removeIdx >= 0 && out[removeIdx].kind === "remove") {
            const w = wordPairs(prevLines[0], lines[0]);
            out[removeIdx] = {
              kind: "remove",
              text: prevLines[0],
              words: w.removeWords,
            };
            out.push({ kind: "add", text: lines[0], words: w.addWords });
            continue;
          }
        }
      }
      for (const l of lines) out.push({ kind: "add", text: l });
    } else if (c.removed) {
      for (const l of lines) out.push({ kind: "remove", text: l });
    } else {
      for (const l of lines) out.push({ kind: "context", text: l });
    }
  }

  return out;
}

/** Word-level diff between two single lines. Returns the WordPart streams
 *  for the "remove" and "add" rows respectively. */
function wordPairs(
  removed: string,
  added: string,
): { removeWords: WordPart[]; addWords: WordPart[] } {
  const changes: Change[] = diffWordsWithSpace(removed, added);
  const removeWords: WordPart[] = [];
  const addWords: WordPart[] = [];
  for (const c of changes) {
    if (c.added) {
      addWords.push({ kind: "add", text: c.value });
    } else if (c.removed) {
      removeWords.push({ kind: "remove", text: c.value });
    } else {
      removeWords.push({ kind: "same", text: c.value });
      addWords.push({ kind: "same", text: c.value });
    }
  }
  return { removeWords, addWords };
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/** Quick stat tuple for the diff header: `(added, removed)` line counts. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "remove") removed++;
  }
  return { added, removed };
}
