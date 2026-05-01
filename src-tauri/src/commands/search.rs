use crate::constants::{
    DEFAULT_QUICK_LOOKUP_LIMIT, DEFAULT_SEARCH_LIMIT, FTS_CANDIDATE_POOL,
    MAX_QUICK_LOOKUP_LIMIT, MAX_SEARCH_LIMIT,
};
use crate::db::Db;
use crate::error::Result;
use crate::models::SearchHit;
use tauri::State;
use unicode_segmentation::UnicodeSegmentation;

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

    let tokens = tokenize_query(q);
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
    //
    // Highlight markers: U+E000 / U+E001 (Private Use Area, BMP). User content
    // can legitimately contain literal `<<…>>` (e.g. comparators, generics)
    // which the previous markers would mistake for FTS hits. PUA codepoints
    // are reserved for application-specific use, so they never appear in
    // normal note text. The frontend splits on these sentinels and renders
    // <mark> via real Solid components - no innerHTML round-trip.
    let sql = "
        SELECT
            n.id,
            n.title,
            snippet(notes_fts, 1, char(57344), char(57345), '…', 12) AS snippet,
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

/// Tokenize a free-form query into FTS5-friendly prefix-match tokens.
///
/// Strategy:
///   1. Use UAX#29 word segmentation (`unicode_segmentation::UnicodeWords`)
///      to find word units. Latin/Cyrillic/etc. scripts get sensible per-
///      word tokens.
///   2. For tokens that contain any CJK Unified Ideograph or Hiragana /
///      Katakana / Hangul codepoint, further split into individual graphemes.
///      FTS5's `unicode61` tokenizer already indexes CJK content at the
///      single-char level (no whitespace splits multi-char CJK runs there
///      either), so character-level query tokens are how we line up with
///      the index. This is what makes the CJK case work end-to-end.
///   3. Lowercase. ASCII letters fold; non-ASCII are mostly already
///      case-invariant.
fn tokenize_query(q: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in q.unicode_words() {
        if contains_cjk(word) {
            // Per-grapheme split using char iteration. Code points outside
            // the BMP are extremely rare in CJK queries and a per-char
            // split here matches `unicode61`'s behaviour closely enough.
            for ch in word.chars() {
                if !ch.is_whitespace() && !ch.is_control() {
                    out.push(ch.to_lowercase().collect::<String>());
                }
            }
        } else {
            out.push(word.to_lowercase());
        }
    }
    if out.is_empty() {
        return Vec::new();
    }
    // Drop ASCII single-letter noise tokens UNLESS that's all we have. CJK
    // single-char tokens are kept always (one char can be a complete query).
    let has_long = out.iter().any(|t| t.chars().count() >= 2);
    if !has_long {
        return out;
    }
    out.into_iter()
        .filter(|t| t.chars().count() >= 2 || contains_cjk(t))
        .collect()
}

fn contains_cjk(s: &str) -> bool {
    s.chars().any(is_cjk_char)
}

fn is_cjk_char(c: char) -> bool {
    let cp = c as u32;
    matches!(
        cp,
        0x3040..=0x309F   // Hiragana
        | 0x30A0..=0x30FF // Katakana
        | 0x3400..=0x4DBF // CJK Unified Ideographs Extension A
        | 0x4E00..=0x9FFF // CJK Unified Ideographs
        | 0xAC00..=0xD7AF // Hangul Syllables
        | 0xF900..=0xFAFF // CJK Compatibility Ideographs
        | 0x20000..=0x2A6DF // CJK Extension B
    )
}

#[cfg(test)]
mod tests {
    use super::tokenize_query;

    #[test]
    fn ascii_query_tokenises_by_word() {
        assert_eq!(
            tokenize_query("Hello, World!"),
            vec!["hello".to_string(), "world".to_string()]
        );
    }

    #[test]
    fn ascii_single_letter_query_is_kept_when_alone() {
        assert_eq!(tokenize_query("a"), vec!["a".to_string()]);
    }

    #[test]
    fn ascii_short_letters_dropped_when_long_tokens_present() {
        let tokens = tokenize_query("a is the");
        assert!(tokens.contains(&"is".to_string()));
        assert!(tokens.contains(&"the".to_string()));
        assert!(!tokens.contains(&"a".to_string()));
    }

    #[test]
    fn cjk_query_decomposes_into_per_char_tokens() {
        // CJK content is indexed character-by-character by FTS5 unicode61,
        // so the query side has to mirror that. The Japanese phrase below
        // should yield several per-char tokens, one for each CJK codepoint.
        let tokens = tokenize_query("日本語");
        assert_eq!(tokens, vec!["日".to_string(), "本".to_string(), "語".to_string()]);
    }

    #[test]
    fn cjk_single_char_query_is_kept() {
        // A single CJK char can be a meaningful query - don't filter it.
        assert_eq!(tokenize_query("日"), vec!["日".to_string()]);
    }

    #[test]
    fn mixed_latin_cjk_query() {
        let tokens = tokenize_query("hello 日本");
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"日".to_string()));
        assert!(tokens.contains(&"本".to_string()));
    }

    #[test]
    fn empty_and_whitespace_queries_return_empty() {
        assert!(tokenize_query("").is_empty());
        assert!(tokenize_query("   ").is_empty());
        assert!(tokenize_query(",.;:!?").is_empty());
    }

    #[test]
    fn lowercases_ascii() {
        assert_eq!(tokenize_query("Hello"), vec!["hello".to_string()]);
    }
}
