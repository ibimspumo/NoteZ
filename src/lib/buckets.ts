/**
 * Time-bucket grouping for the sidebar list.
 *
 * Notes are sorted by `updated_at DESC`, so bucket transitions happen at
 * predictable points and we can compute them in a single linear pass over
 * the loaded items. The buckets themselves are derived client-side from
 * `updated_at`, no backend grouping needed - this stays correct as items
 * page in via the cursor.
 *
 * Buckets returned in chronological-recency order:
 *   Today / Yesterday / This week / Last week / This month / Older
 */

export type Bucket =
  | "Today"
  | "Yesterday"
  | "This week"
  | "Last week"
  | "This month"
  | "Older";

const DAY_MS = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function bucketFor(updatedAt: string, now: Date = new Date()): Bucket {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return "Older";

  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;

  if (t >= todayStart) return "Today";
  if (t >= yesterdayStart) return "Yesterday";

  const ageMs = now.getTime() - t;
  if (ageMs < 7 * DAY_MS) return "This week";
  if (ageMs < 14 * DAY_MS) return "Last week";
  if (ageMs < 30 * DAY_MS) return "This month";
  return "Older";
}
