use crate::constants::{DB_BUSY_TIMEOUT_SECS, DB_POOL_SIZE, PREVIEW_MAX_CHARS};
use crate::error::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

pub type DbPool = Pool<SqliteConnectionManager>;

#[derive(Clone)]
pub struct Db {
    pub pool: Arc<DbPool>,
    /// Absolute path to the on-disk asset directory (`<app_data>/assets`).
    /// Stable for the lifetime of the app.
    pub assets_dir: std::path::PathBuf,
}

impl Db {
    pub fn open(path: impl AsRef<Path>, assets_dir: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let assets_dir = assets_dir.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&assets_dir)?;

        // Bootstrap pass:
        //   - ensure page_size is 8192 (required before any tables exist; existing DBs are
        //     migrated via VACUUM, which cannot run inside a transaction or under WAL)
        //   - turn WAL on once, on a single connection, before the r2d2 pool builds others
        //     in parallel (avoids "database is locked" races during bootstrap)
        //
        // WAL re-enable is unconditional: if the user kills the app between the page_size
        // VACUUM and the WAL pragma, the DB stays in DELETE mode forever - running this
        // on every launch is idempotent and self-healing.
        {
            let bootstrap = Connection::open(&path)?;
            bootstrap.busy_timeout(std::time::Duration::from_secs(DB_BUSY_TIMEOUT_SECS))?;

            let current_page_size: i64 =
                bootstrap.query_row("PRAGMA page_size", [], |r| r.get(0))?;
            if current_page_size != 8192 {
                // VACUUM requires journal_mode != WAL.
                bootstrap.pragma_update(None, "journal_mode", "DELETE")?;
                bootstrap.execute_batch("PRAGMA page_size = 8192; VACUUM;")?;
            }
            bootstrap.pragma_update(None, "journal_mode", "WAL")?;
        }

        let manager = SqliteConnectionManager::file(&path).with_init(|c| {
            c.busy_timeout(std::time::Duration::from_secs(DB_BUSY_TIMEOUT_SECS))?;
            // `cache_spill=0` keeps in-flight transactions in RAM rather than
            // spilling pages to the OS. NoteZ transactions are tiny (single-
            // note save, single-folder mutation) so we never come close to
            // the 64 MB cache - allowing spill would be wasted disk traffic.
            c.execute_batch(
                "PRAGMA synchronous=NORMAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA temp_store=MEMORY;
                 PRAGMA mmap_size=268435456;
                 PRAGMA cache_size=-65536;
                 PRAGMA wal_autocheckpoint=1000;
                 PRAGMA journal_size_limit=67108864;
                 PRAGMA cache_spill=0;",
            )
        });
        let pool = Pool::builder().max_size(DB_POOL_SIZE).build(manager)?;

        let db = Self {
            pool: Arc::new(pool),
            assets_dir,
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>> {
        Ok(self.pool.get()?)
    }

    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn()?;
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

        let migrations: &[(i64, &str)] = &[
            (1, MIGRATION_001),
            (2, MIGRATION_002),
            (3, MIGRATION_003),
            (4, MIGRATION_004),
            (5, MIGRATION_005),
            (6, MIGRATION_006),
            (7, MIGRATION_007),
            (8, MIGRATION_008),
        ];

        let tx = conn.transaction()?;
        let mut crossed_v5 = false;
        let mut crossed_v8 = false;
        for (version, sql) in migrations {
            if *version > current {
                tracing::info!("applying migration v{}", version);
                tx.execute_batch(sql)?;
                tx.execute_batch(&format!("PRAGMA user_version = {}", version))?;
                if *version == 5 {
                    crossed_v5 = true;
                }
                if *version == 8 {
                    crossed_v8 = true;
                }
            }
        }
        tx.commit()?;

        // Post-migration data backfill for v5: scan every existing note's
        // content_json for asset id substrings (the old GC logic) and seed
        // the note_assets join table. We do this exactly once - subsequent
        // updates to note_assets flow through `update_note` from the editor's
        // tracked asset_ids set, no more O(content_bytes) scans.
        if crossed_v5 {
            if let Err(e) = backfill_note_assets(&conn) {
                tracing::warn!("note_assets backfill failed (will retry on next launch): {e}");
            }
        }
        // Post-migration data backfill for v8: same logic but for the
        // snapshot_assets join table - the GC pipeline can then drop its
        // snapshot-content scan and become O(snapshots) via index lookup.
        if crossed_v8 {
            if let Err(e) = backfill_snapshot_assets(&conn) {
                tracing::warn!(
                    "snapshot_assets backfill failed (will retry on next launch): {e}"
                );
            }
        }
        Ok(())
    }
}

const MIGRATION_001: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '{}',
    content_text TEXT NOT NULL DEFAULT '',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at ON notes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(is_pinned, pinned_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    content_text,
    content='notes',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content_json TEXT NOT NULL,
    content_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_manual INTEGER NOT NULL DEFAULT 0,
    manual_label TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_note ON snapshots(note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mentions (
    source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_note_id, target_note_id)
);

CREATE INDEX IF NOT EXISTS idx_mentions_target ON mentions(target_note_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"#;

// v2:
//   - rebuild FTS5 with prefix='2 3 4' so trailing-* queries don't scan the full term list
//   - explicitly drop+recreate the FTS triggers so the dependency between the FTS schema
//     and its maintenance triggers is captured in the same migration (otherwise a future
//     FTS column change would silently desync from the v1-defined triggers)
//   - add a partial index for the active-notes listing path (skips trash rows entirely)
//   - drop the now-redundant full updated_at index
//   - add a partial index for the pinned-list query
//   - add an explicit index on notes.created_at (used by upcoming "sort by created" UIs)
//   - make the FTS update trigger conditional on title/content actually changing -
//     toggle_pin() and other metadata-only updates no longer cause an FTS rebuild
//   - add the assets table for image / attachment storage with content-addressed dedup
const MIGRATION_002: &str = r#"
DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS notes_au;
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
    title,
    content_text,
    content='notes',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2',
    prefix='2 3 4'
);

INSERT INTO notes_fts(rowid, title, content_text)
SELECT rowid, title, content_text FROM notes;

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
END;

-- Conditional update: only rebuild the FTS row when the indexed columns actually
-- change. This makes pin toggles, soft-deletes, and any other metadata-only
-- writes free w.r.t. FTS - a real win when a user is rapidly pinning/unpinning.
CREATE TRIGGER notes_au AFTER UPDATE OF title, content_text ON notes
WHEN old.title IS NOT new.title OR old.content_text IS NOT new.content_text
BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content_text)
    VALUES ('delete', old.rowid, old.title, old.content_text);
    INSERT INTO notes_fts(rowid, title, content_text)
    VALUES (new.rowid, new.title, new.content_text);
END;

DROP INDEX IF EXISTS idx_notes_updated_at;
CREATE INDEX IF NOT EXISTS idx_notes_active_updated
    ON notes(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_trash_deleted
    ON notes(deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_active_pinned
    ON notes(pinned_at DESC) WHERE deleted_at IS NULL AND is_pinned = 1;
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,                  -- sha256 hex of bytes
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,                    -- file extension without dot
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    blurhash TEXT,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at DESC);
"#;

// v3: AI call ledger for OpenRouter integration. Every call (success or failure)
// gets a row with token counts, USD cost, and a loose note_id reference (no FK
// CASCADE - call history must outlive a deleted note so spend stays auditable).
const MIGRATION_003: &str = r#"
CREATE TABLE IF NOT EXISTS ai_calls (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    note_id TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_created_at ON ai_calls(created_at DESC);
"#;

// v4: folders for organizing notes.
//   - `folders`: hierarchical tree via self-referential parent_id. parent_id
//     uses ON DELETE SET NULL so a buggy delete leaves orphans rather than
//     losing data; the app's `delete_folder` command reparents children to
//     the deleted folder's parent before removing it.
//   - `notes.folder_id`: nullable, ON DELETE SET NULL - deleting a folder
//     drops its notes back to Inbox rather than nuking them.
//   - `idx_notes_folder_active_updated`: covers the per-folder list query
//     (folder_id + updated_at DESC range scan, deleted_at IS NULL filter
//     pushed into the partial-index predicate).
const MIGRATION_004: &str = r#"
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_parent
    ON folders(parent_id, sort_order, name);

ALTER TABLE notes ADD COLUMN folder_id TEXT
    REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notes_folder_active_updated
    ON notes(folder_id, updated_at DESC) WHERE deleted_at IS NULL;
"#;

// v5: explicit note→asset reference table for GC.
//
// Before this migration, `gc_orphan_assets` ran an Aho-Corasick scan over
// every note's `content_json` blob to find which assets were referenced -
// O(total_json_bytes). With 1M notes × ~10 KB = ~10 GB of text streamed
// through pattern matching on every GC. That's a desktop-app deal-breaker
// once the corpus grows.
//
// `note_assets(note_id, asset_id)` makes the relationship first-class: the
// `update_note` IPC populates it from `input.asset_ids` (the editor's mutation
// tracker already tracks ImageNode keys, see `editorRefs.ts`), and `gc_orphan_assets`
// becomes a single LEFT JOIN that runs in O(assets), not O(content).
//
// CASCADE on note delete removes orphaned references automatically. Snapshots
// can still hold references via the `note_id` of their owning note (snapshots
// are deleted with their note via the existing FK CASCADE on `snapshots`),
// so a snapshot's content_json *only* references assets that the live note
// also references - no need for `snapshot_assets` separately.
//
// Bootstrap: the migration backfills the table from the existing notes by
// substring-matching every known asset id in every note's content_json. This
// is the same Aho-Corasick logic the old GC ran, but it runs ONCE here at
// migration time rather than every GC. After this migration commits, normal
// updates keep the table in sync incrementally.
const MIGRATION_005: &str = r#"
CREATE TABLE IF NOT EXISTS note_assets (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_note_assets_asset ON note_assets(asset_id);
"#;

// v6: denormalized `folders.note_count` for cheap sidebar counts.
//
// Before this, `list_folders` ran a `LEFT JOIN (SELECT folder_id, COUNT(*) ...
// GROUP BY folder_id)` aggregation against every active note. At 1M notes
// that's an index-only scan of millions of rows on every cold app boot - the
// partial index keeps it sub-100ms but it's still proportional to corpus size.
//
// Maintaining `folders.note_count` via SQLite triggers makes `list_folders`
// O(folders), independent of note count. Triggers fire on the four ways a
// note's effective folder membership changes:
//   - INSERT (folder_id set)        : +1
//   - UPDATE folder_id              : -1 old, +1 new
//   - UPDATE deleted_at NULL→NOTNULL: -1 (soft delete leaves the row)
//   - UPDATE deleted_at NOTNULL→NULL: +1 (restore from trash)
//   - DELETE                        : -1 (only if was active; partial)
//
// Counts are clamped to 0 in case of trigger gaps (e.g. data loaded from
// legacy backups before this migration).
//
// Bootstrap: the migration recomputes counts from the current state of the
// notes table.
const MIGRATION_006: &str = r#"
ALTER TABLE folders ADD COLUMN note_count INTEGER NOT NULL DEFAULT 0;

UPDATE folders SET note_count = (
    SELECT COUNT(*) FROM notes
    WHERE notes.folder_id = folders.id AND notes.deleted_at IS NULL
);

CREATE TRIGGER IF NOT EXISTS notes_folder_count_ai
AFTER INSERT ON notes
WHEN new.folder_id IS NOT NULL AND new.deleted_at IS NULL
BEGIN
    UPDATE folders SET note_count = note_count + 1 WHERE id = new.folder_id;
END;

CREATE TRIGGER IF NOT EXISTS notes_folder_count_ad
AFTER DELETE ON notes
WHEN old.folder_id IS NOT NULL AND old.deleted_at IS NULL
BEGIN
    UPDATE folders
       SET note_count = MAX(note_count - 1, 0)
     WHERE id = old.folder_id;
END;

-- Single trigger handles both folder moves and trash/restore by reasoning
-- about the four-way (was-active, is-active) × (old-folder, new-folder)
-- transition. The CASE expressions branch on the active/inactive state.
CREATE TRIGGER IF NOT EXISTS notes_folder_count_au
AFTER UPDATE OF folder_id, deleted_at ON notes
BEGIN
    -- Decrement the old folder if the row WAS active and IS now leaving it
    -- (either via soft-delete or via folder_id change to a different value).
    UPDATE folders
       SET note_count = MAX(note_count - 1, 0)
     WHERE old.deleted_at IS NULL
       AND old.folder_id IS NOT NULL
       AND id = old.folder_id
       AND (
            new.deleted_at IS NOT NULL
            OR new.folder_id IS NOT old.folder_id
       );

    -- Increment the new folder if the row IS active and IS now joining it
    -- (either via restore from trash or via folder_id change from elsewhere).
    UPDATE folders
       SET note_count = note_count + 1
     WHERE new.deleted_at IS NULL
       AND new.folder_id IS NOT NULL
       AND id = new.folder_id
       AND (
            old.deleted_at IS NOT NULL
            OR new.folder_id IS NOT old.folder_id
       );
END;
"#;

// v7: dedicated `cursors` table to move per-note caret state out of the
// `settings` kitchen-sink.
//
// Before this, the editor persisted caret position via `settings(key, value)`
// with `key = "cursor:<uuid>"`. With 100k notes that's 100k+ rows in the
// settings table, and `list_settings` (called on every `loadSettings`) had to
// stream all of them just to find the half-dozen real settings keys. Worst
// case: a settings IPC RTT proportional to corpus size. Splitting them out
// makes both `list_settings` and the cursor lookups O(1) per query.
//
// `note_id` is a primary key (one cursor per note). FK CASCADE on note
// deletion drops orphaned cursor rows automatically.
//
// Migration backfills from existing `settings` rows whose key matches the
// `cursor:<uuid>` prefix, then deletes those rows from settings.
const MIGRATION_007: &str = r#"
CREATE TABLE IF NOT EXISTS cursors (
    note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO cursors (note_id, value, updated_at)
SELECT
    substr(s.key, length('cursor:') + 1) AS note_id,
    s.value,
    s.updated_at
FROM settings s
JOIN notes n ON n.id = substr(s.key, length('cursor:') + 1)
WHERE s.key LIKE 'cursor:%';

DELETE FROM settings WHERE key LIKE 'cursor:%';
"#;

// v8: `snapshot_assets` join table mirroring `note_assets`, but for snapshots.
//
// The previous `gc_orphan_assets` had a Stage-2 substring scan over every
// snapshot's content_json to keep assets referenced by snapshots from being
// reclaimed. With 1M notes × 50 auto-snapshots = 50M snapshots × ~10 KB blob
// = 500 GB pattern-match work per GC. Unbenutzbar im Zielkorpus.
//
// First-class join makes the GC O(orphan_candidates) via a JOIN against this
// table. Snapshots are immutable, so the only insert path is `create_snapshot`
// (mirrors the live note's `note_assets` rows at creation time). Migration
// backfills the existing snapshot blobs once via the same Aho-Corasick scan
// that `backfill_note_assets` runs.
//
// FK CASCADE on snapshot delete; the snapshot's own CASCADE (FK to notes)
// already handles purge of a note's whole history.
const MIGRATION_008: &str = r#"
CREATE TABLE IF NOT EXISTS snapshot_assets (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (snapshot_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_assets_asset ON snapshot_assets(asset_id);
"#;

/// One-shot backfill of the `note_assets` join table from the existing
/// notes/snapshots content_json blobs. Used at v4→v5 migration time only.
/// Idempotent (uses INSERT OR IGNORE) and bounded - skips if no assets exist.
fn backfill_note_assets(conn: &rusqlite::Connection) -> Result<()> {
    let known: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM assets")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if known.is_empty() {
        return Ok(());
    }

    let ac = aho_corasick::AhoCorasick::new(&known)
        .map_err(|e| crate::error::NoteZError::Other(format!("aho-corasick: {e}")))?;

    let mut insert = conn.prepare("INSERT OR IGNORE INTO note_assets (note_id, asset_id) VALUES (?1, ?2)")?;
    let mut select = conn.prepare("SELECT id, content_json FROM notes WHERE deleted_at IS NULL")?;
    let mut count: u64 = 0;
    let rows = select.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (note_id, blob) = row?;
        // Use a small Set so the same asset referenced multiple times in
        // one note results in only one INSERT call.
        let mut seen = std::collections::HashSet::new();
        for m in ac.find_iter(&blob) {
            let asset_id = &known[m.pattern().as_usize()];
            if seen.insert(asset_id.clone()) {
                insert.execute(rusqlite::params![note_id, asset_id])?;
                count += 1;
            }
        }
    }
    tracing::info!("note_assets backfill seeded {} entries", count);
    Ok(())
}

/// One-shot backfill of the `snapshot_assets` join table from the existing
/// snapshots content_json blobs. Used at v7→v8 migration time only.
/// Idempotent (uses INSERT OR IGNORE) and bounded - skips if no assets exist.
fn backfill_snapshot_assets(conn: &rusqlite::Connection) -> Result<()> {
    let known: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM assets")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if known.is_empty() {
        return Ok(());
    }

    let ac = aho_corasick::AhoCorasick::new(&known)
        .map_err(|e| crate::error::NoteZError::Other(format!("aho-corasick: {e}")))?;

    let mut insert = conn.prepare(
        "INSERT OR IGNORE INTO snapshot_assets (snapshot_id, asset_id) VALUES (?1, ?2)",
    )?;
    let mut select = conn.prepare("SELECT id, content_json FROM snapshots")?;
    let mut count: u64 = 0;
    let rows = select.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (snap_id, blob) = row?;
        let mut seen = std::collections::HashSet::new();
        for m in ac.find_iter(&blob) {
            let asset_id = &known[m.pattern().as_usize()];
            if seen.insert(asset_id.clone()) {
                insert.execute(rusqlite::params![snap_id, asset_id])?;
                count += 1;
            }
        }
    }
    tracing::info!("snapshot_assets backfill seeded {} entries", count);
    Ok(())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Force a WAL checkpoint with TRUNCATE - merge the WAL back into the main DB
/// and shrink it to zero. Call after a bulk operation that produced a large
/// WAL (`empty_trash`, `dev_delete_generated_notes`, big migrations) so the
/// WAL doesn't keep eating disk between auto-checkpoints.
///
/// Also runs `PRAGMA optimize` so SQLite refreshes its query-planner stats
/// after the bulk write - the recommended `0x10002` mask only does work
/// when stale stats are actually detected, so this is cheap when there's
/// nothing to do.
///
/// Best-effort: the result is logged but never bubbles up - failure means the
/// WAL stays large until the next auto-checkpoint, which is harmless.
pub fn wal_checkpoint(db: &Db) -> Result<()> {
    let conn = db.conn()?;
    if let Err(e) = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE") {
        tracing::warn!("wal_checkpoint(TRUNCATE) failed: {e}");
    }
    // SQLite reference: https://sqlite.org/pragma.html#pragma_optimize -
    // 0x10002 is the recommended mask for periodic tuning passes.
    if let Err(e) = conn.execute_batch("PRAGMA optimize=0x10002;") {
        tracing::warn!("PRAGMA optimize failed: {e}");
    }
    Ok(())
}

pub fn note_row_to_summary(
    _conn: &Connection,
    row: &rusqlite::Row,
) -> rusqlite::Result<crate::models::NoteSummary> {
    let content_text: String = row.get("content_text")?;
    let preview = make_preview(&content_text, PREVIEW_MAX_CHARS);
    Ok(crate::models::NoteSummary {
        id: row.get("id")?,
        title: row.get("title")?,
        preview,
        is_pinned: row.get::<_, i64>("is_pinned")? != 0,
        pinned_at: row.get("pinned_at")?,
        updated_at: row.get("updated_at")?,
        folder_id: row.get("folder_id")?,
    })
}

pub fn make_preview(content_text: &str, max_len: usize) -> String {
    let cleaned: String = content_text
        .split('\n')
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    if cleaned.chars().count() <= max_len {
        cleaned
    } else {
        let truncated: String = cleaned.chars().take(max_len).collect();
        format!("{}…", truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_preview_collapses_newlines_to_dots() {
        let text = "First line\nSecond line\n\nThird line";
        assert_eq!(make_preview(text, 100), "First line · Second line · Third line");
    }

    #[test]
    fn make_preview_skips_blank_lines() {
        let text = "\n\nFirst\n\n  \nSecond\n";
        assert_eq!(make_preview(text, 100), "First · Second");
    }

    #[test]
    fn make_preview_truncates_with_ellipsis() {
        let text = "x".repeat(200);
        let preview = make_preview(&text, 50);
        assert_eq!(preview.chars().count(), 51); // 50 chars + ellipsis
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn make_preview_handles_unicode_boundaries() {
        // 4-char-wide emoji should not split mid-codepoint.
        let text = "😀".repeat(60);
        let preview = make_preview(&text, 10);
        assert_eq!(preview.chars().count(), 11); // 10 emoji + ellipsis
    }

    #[test]
    fn make_preview_is_short_circuit_when_under_limit() {
        let text = "Short";
        assert_eq!(make_preview(text, 100), "Short");
    }
}
