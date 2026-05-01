/**
 * Render an FTS5 snippet with highlight markers as a Solid fragment - no
 * innerHTML, no regex round-trip.
 *
 * The Rust side passes Private-Use-Area (PUA) codepoints U+E000 and U+E001
 * around hits via `snippet(..., char(57344), char(57345), ...)`. We split on
 * those sentinels and wrap the matching segments in `<mark>`. Splitting on
 * single PUA codepoints is unambiguous: PUA characters are reserved for
 * application-specific use and never appear in user note text.
 *
 * Mismatched markers (a START without an END or vice versa) are tolerated by
 * just rendering the trailing tail as plain text. We never produce malformed
 * markup because we don't construct markup at all - it's all Solid components.
 */

import type { JSX } from "solid-js";

const MARK_START = "\u{E000}";
const MARK_END = "\u{E001}";

/** Render the snippet, returning a Solid JSX node tree. */
export function renderHighlightedSnippet(snippet: string): JSX.Element {
  if (!snippet) return null;
  if (!snippet.includes(MARK_START) && !snippet.includes(MARK_END)) {
    // Hot path: most snippets have no marker (e.g. quick_lookup empty-query
    // recency listing). Avoid the split allocation entirely.
    return snippet;
  }
  const out: JSX.Element[] = [];
  let cursor = 0;
  while (cursor < snippet.length) {
    const start = snippet.indexOf(MARK_START, cursor);
    if (start < 0) {
      out.push(snippet.slice(cursor));
      break;
    }
    if (start > cursor) out.push(snippet.slice(cursor, start));
    const end = snippet.indexOf(MARK_END, start + 1);
    if (end < 0) {
      // Unbalanced: treat the rest as plain text rather than emitting a
      // dangling <mark>.
      out.push(snippet.slice(start + 1));
      break;
    }
    out.push(<mark>{snippet.slice(start + 1, end)}</mark>);
    cursor = end + 1;
  }
  return out;
}
