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

export type Bucket = "Today" | "Yesterday" | "This week" | "Last week" | "This month" | "Older";

const DAY_MS = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Pre-computed boundaries for a single `now` value. Keeping these as a
 *  reusable struct lets the sidebar (which calls `bucketFor` once per
 *  visible row per tick) avoid re-allocating a `Date` and re-running
 *  `startOfDay` for every row. */
export type BucketBoundaries = {
  nowMs: number;
  todayStart: number;
  yesterdayStart: number;
  weekCutoff: number;
  twoWeeksCutoff: number;
  monthCutoff: number;
};

export function bucketBoundaries(now: Date = new Date()): BucketBoundaries {
  const nowMs = now.getTime();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  return {
    nowMs,
    todayStart,
    yesterdayStart,
    weekCutoff: nowMs - 7 * DAY_MS,
    twoWeeksCutoff: nowMs - 14 * DAY_MS,
    monthCutoff: nowMs - 30 * DAY_MS,
  };
}

/**
 * Fast path: caller passes in a pre-computed `BucketBoundaries`. Used by the
 * sidebar where the same `now` is reused across thousands of rows per tick.
 *
 * Slow path: caller passes a `Date` or omits it. Computes boundaries once
 * inline. Convenient for one-off callers (notes-store flashMoved) where the
 * O(allocations) cost is irrelevant.
 */
export function bucketFor(updatedAt: string, nowOrBoundaries?: Date | BucketBoundaries): Bucket {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return "Older";

  const b: BucketBoundaries =
    nowOrBoundaries && "todayStart" in nowOrBoundaries
      ? nowOrBoundaries
      : bucketBoundaries(nowOrBoundaries instanceof Date ? nowOrBoundaries : new Date());

  if (t >= b.todayStart) return "Today";
  if (t >= b.yesterdayStart) return "Yesterday";
  if (t >= b.weekCutoff) return "This week";
  if (t >= b.twoWeeksCutoff) return "Last week";
  if (t >= b.monthCutoff) return "This month";
  return "Older";
}
