use crate::constants::{
    DEFAULT_QUICK_LOOKUP_LIMIT, DEFAULT_SEARCH_LIMIT, FTS_CANDIDATE_POOL,
    MAX_QUICK_LOOKUP_LIMIT, MAX_SEARCH_LIMIT,
};
use crate::db::Db;
use crate::error::Result;
use crate::models::SearchHit;
use tauri::State;

/// Spotlight-grade search. Two-stage:
///   1. FTS5 returns the top `FTS_CANDIDATE_POOL` matches by raw bm25 (cheap; uses
///      the prefix='2 3 4' index so trailing-* tokens hit a real index, not a scan).
///   2. We re-rank those candidates with the composite score below and trim to `limit`.
///
/// Scaling ceiling: stage 1 stays sub-100ms up to ~10M notes. Beyond that the
/// FTS index itself starts paging from disk; mitigation = per-year FTS shards or
/// an external index (Tantivy). Not needed for v1.
///
/// Ranking is composed from:
///   - FTS5 bm25 score (lower is better → we negate)
///   - title-prefix bonus (huge: matches that start the title)
///   - title-substring bonus (medium)
///   - recency decay (notes touched recently rank higher; halves every 14 days)
///   - pinned bonus (small: keeps order intuitive when scores are close)
#[tauri::command]
pub fn search_notes(db: State<Db>, query: String, limit: Option<u32>) -> Result<Vec<SearchHit>> {
    let q = query.trim();
    let limit = limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT as u32)
        .min(MAX_SEARCH_LIMIT) as usize;

    if q.is_empty() {
        return Ok(Vec::new());
    }

    let conn = db.conn()?;

    // Tokenize: every non-alnum becomes a separator. Each token becomes a prefix-match in FTS.
    let tokens: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect();

    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    let fts_query = tokens
        .iter()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");

    let lower_q = q.to_lowercase();

    // Stage 1: pull a candidate pool from FTS, ordered by raw bm25.
    // We deliberately fetch more than `limit` so the re-rank can surface a great
    // title-match that lost on bm25 alone (e.g. very short titles that bm25 underweights).
    let sql = "
        SELECT
            n.id,
            n.title,
            snippet(notes_fts, 1, '<<', '>>', '…', 12) AS snippet,
            n.is_pinned,
            n.updated_at,
            bm25(notes_fts) AS bm25,
            (julianday('now') - julianday(n.updated_at)) AS age_days
        FROM notes_fts
        JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
        ORDER BY bm25 ASC
        LIMIT ?2
    ";

    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(rusqlite::params![fts_query, FTS_CANDIDATE_POOL], |row| {
        let id: String = row.get("id")?;
        let title: String = row.get("title")?;
        let snippet: String = row.get("snippet")?;
        let is_pinned: bool = row.get::<_, i64>("is_pinned")? != 0;
        let updated_at: String = row.get("updated_at")?;
        let bm25: f64 = row.get("bm25")?;
        let age_days: f64 = row.get("age_days")?;

        let title_lower = title.to_lowercase();
        let mut bonus: f64 = 0.0;
        if title_lower.starts_with(&lower_q) {
            bonus += 8.0;
        } else if title_lower.contains(&lower_q) {
            bonus += 4.0;
        }
        for t in &tokens {
            if title_lower.contains(t.as_str()) {
                bonus += 0.5;
            }
        }
        let recency: f64 = (-age_days.max(0.0) / 14.0).exp();
        let pin_bonus: f64 = if is_pinned { 0.4 } else { 0.0 };

        let score = -bm25 + bonus + recency + pin_bonus;

        Ok(SearchHit {
            id,
            title,
            snippet,
            is_pinned,
            updated_at,
            score,
        })
    })?;

    // Stage 2: re-rank in memory and trim to `limit`.
    let mut hits: Vec<SearchHit> = rows.filter_map(|r| r.ok()).collect();
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

#[tauri::command]
pub fn quick_lookup(db: State<Db>, query: String, limit: Option<u32>) -> Result<Vec<SearchHit>> {
    let q = query.trim();
    let limit = limit
        .unwrap_or(DEFAULT_QUICK_LOOKUP_LIMIT)
        .min(MAX_QUICK_LOOKUP_LIMIT);

    let conn = db.conn()?;

    if q.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, title, substr(content_text, 1, 120) AS snippet, is_pinned, updated_at
             FROM notes
             WHERE deleted_at IS NULL
             ORDER BY is_pinned DESC, updated_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
            Ok(SearchHit {
                id: row.get("id")?,
                title: row.get("title")?,
                snippet: row.get("snippet")?,
                is_pinned: row.get::<_, i64>("is_pinned")? != 0,
                updated_at: row.get("updated_at")?,
                score: 0.0,
            })
        })?;
        return Ok(rows.filter_map(|r| r.ok()).collect());
    }

    search_notes(db, q.to_string(), Some(limit))
}
