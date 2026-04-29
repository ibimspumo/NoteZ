//! Cursor-pagination utilities. The list-command pattern looks like this:
//!
//!   1. Prepare a SQL stmt with a `LIMIT ?` slot for `limit + 1`.
//!   2. `query_map` it through a row mapper.
//!   3. Collect the iterator into a `Vec<rusqlite::Result<T>>`, propagate errors.
//!   4. Test whether we got more rows than asked → `has_more`.
//!   5. Truncate to the user's `limit`.
//!   6. Build a cursor from the last item if `has_more`, else `None`.
//!
//! Steps 2-6 are mechanical and were copy-pasted across `notes::list_notes`,
//! `notes::list_trash`, `snapshots::list_snapshots`, `ai::list_ai_calls`. This
//! module owns them so the call sites stay focused on the SQL + the row mapper.
//!
//! The SQL itself is left to the caller because it varies across queries
//! (different cursor columns, different WHERE filters, different JOINs).
//! Pure-string SQL templating without rusqlite's bound parameters would
//! invite injection bugs - keeping the SQL caller-owned is the safer trade-off.

use rusqlite::{Row, Statement};

/// Run a prepared statement and collect mapped rows, splitting off the
/// "we fetched one more than asked" probe row to detect `has_more`.
///
/// `params_iter` is forwarded straight to `Statement::query_map`. Caller is
/// responsible for binding `LIMIT (limit + 1)` somewhere in the SQL - we don't
/// touch that because it sits in the middle of caller-owned templates.
pub fn collect_page<T, P, F>(
    stmt: &mut Statement<'_>,
    params: P,
    limit: u32,
    map_row: F,
) -> rusqlite::Result<(Vec<T>, bool)>
where
    P: rusqlite::Params,
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    let mapped = stmt.query_map(params, map_row)?;
    let collected: rusqlite::Result<Vec<_>> = mapped.collect();
    let mut rows = collected?;
    let has_more = rows.len() > limit as usize;
    if has_more {
        rows.truncate(limit as usize);
    }
    Ok((rows, has_more))
}

/// Build a `next_cursor` from the last item in a page if `has_more`.
pub fn next_cursor<T, C, F>(items: &[T], has_more: bool, make: F) -> Option<C>
where
    F: FnOnce(&T) -> C,
{
    if !has_more {
        return None;
    }
    items.last().map(make)
}
