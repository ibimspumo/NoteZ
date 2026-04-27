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
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Set WAL once on a single bootstrap connection — running this from
        // r2d2's `with_init` racks up "database is locked" errors when the pool
        // builds multiple connections in parallel.
        {
            let bootstrap = Connection::open(&path)?;
            bootstrap.busy_timeout(std::time::Duration::from_secs(5))?;
            bootstrap.pragma_update(None, "journal_mode", "WAL")?;
        }

        let manager = SqliteConnectionManager::file(&path).with_init(|c| {
            c.busy_timeout(std::time::Duration::from_secs(5))?;
            c.execute_batch(
                "PRAGMA synchronous=NORMAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA temp_store=MEMORY;
                 PRAGMA mmap_size=268435456;",
            )
        });
        let pool = Pool::builder().max_size(8).build(manager)?;

        let db = Self { pool: Arc::new(pool) };
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>> {
        Ok(self.pool.get()?)
    }

    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn()?;
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

        let migrations: &[(i64, &str)] = &[(1, MIGRATION_001)];

        let tx = conn.transaction()?;
        for (version, sql) in migrations {
            if *version > current {
                tracing::info!("applying migration v{}", version);
                tx.execute_batch(sql)?;
                tx.execute_batch(&format!("PRAGMA user_version = {}", version))?;
            }
        }
        tx.commit()?;
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

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn note_row_to_summary(conn: &Connection, row: &rusqlite::Row) -> rusqlite::Result<crate::models::NoteSummary> {
    let _ = conn;
    let content_text: String = row.get("content_text")?;
    let preview = make_preview(&content_text, 140);
    Ok(crate::models::NoteSummary {
        id: row.get("id")?,
        title: row.get("title")?,
        preview,
        is_pinned: row.get::<_, i64>("is_pinned")? != 0,
        pinned_at: row.get("pinned_at")?,
        updated_at: row.get("updated_at")?,
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
