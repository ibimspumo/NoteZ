use crate::db::{now_iso, Db};
use crate::error::{NoteZError, Result};
use crate::models::{DeleteFolderMode, Folder};
use rusqlite::types::Value;
use rusqlite::Connection;
use tauri::State;
use uuid::Uuid;

const MAX_FOLDER_NAME_LEN: usize = 120;
/// Hard cap on tree depth. The recursive descendant query below also relies
/// on this to bound its work; if a future bug ever produces a cycle we want
/// the query to terminate rather than spin SQLite.
const MAX_FOLDER_DEPTH: i64 = 64;

#[tauri::command]
pub fn list_folders(db: State<Db>) -> Result<Vec<Folder>> {
    let conn = db.conn()?;
    // Note counts come from a LEFT JOIN aggregation against active notes.
    // For 1M notes this still runs in milliseconds: idx_notes_folder_active_updated
    // is a partial index on (folder_id, ...) WHERE deleted_at IS NULL, so the
    // GROUP BY scans only the index. Folder count is bounded by user behaviour
    // (hundreds at most), so the join's outer side is small.
    let mut stmt = conn.prepare(
        "SELECT f.id, f.parent_id, f.name, f.sort_order, f.created_at, f.updated_at,
                COALESCE(c.cnt, 0) AS cnt
         FROM folders f
         LEFT JOIN (
             SELECT folder_id, COUNT(*) AS cnt
             FROM notes
             WHERE deleted_at IS NULL AND folder_id IS NOT NULL
             GROUP BY folder_id
         ) c ON c.folder_id = f.id
         ORDER BY COALESCE(f.parent_id, ''), f.sort_order, f.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Folder {
            id: row.get("id")?,
            parent_id: row.get("parent_id")?,
            name: row.get("name")?,
            sort_order: row.get("sort_order")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            note_count: row.get::<_, i64>("cnt")?.max(0) as u32,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn create_folder(
    db: State<Db>,
    name: String,
    parent_id: Option<String>,
) -> Result<Folder> {
    let trimmed = sanitize_name(&name)?;
    let conn = db.conn()?;

    if let Some(pid) = parent_id.as_ref() {
        ensure_folder_exists(&conn, pid)?;
        // Bound the tree depth so a recursive descendant query can't blow up.
        let depth = depth_of(&conn, pid)?;
        if depth + 1 >= MAX_FOLDER_DEPTH {
            return Err(NoteZError::InvalidInput(format!(
                "folder tree too deep (max {})",
                MAX_FOLDER_DEPTH
            )));
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    // Place the new folder at the end of its sibling list.
    let next_sort: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id IS ?1",
            rusqlite::params![parent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![id, parent_id, trimmed, next_sort, now],
    )?;
    fetch_folder(&conn, &id)
}

#[tauri::command]
pub fn rename_folder(db: State<Db>, id: String, name: String) -> Result<Folder> {
    let trimmed = sanitize_name(&name)?;
    let conn = db.conn()?;
    let now = now_iso();
    let updated = conn.execute(
        "UPDATE folders SET name = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![trimmed, now, id],
    )?;
    if updated == 0 {
        return Err(NoteZError::NotFound(id));
    }
    fetch_folder(&conn, &id)
}

/// Delete a folder. The `mode` parameter decides what happens to the notes
/// and subfolders inside (see `DeleteFolderMode`). The default
/// (`ReparentToParent`) preserves the legacy behaviour of moving children
/// up one level. All work runs in a single transaction so a partial failure
/// can't leave rows pointing at a non-existent folder.
#[tauri::command]
pub fn delete_folder(
    db: State<Db>,
    id: String,
    mode: Option<DeleteFolderMode>,
) -> Result<()> {
    let mode = mode.unwrap_or_default();
    let mut conn = db.conn()?;
    let tx = conn.transaction()?;

    // Look up the folder's parent up front: we need it for the default
    // ReparentToParent mode and to surface a clean NotFound error otherwise.
    let parent_id: Option<String> = match tx.query_row(
        "SELECT parent_id FROM folders WHERE id = ?1",
        rusqlite::params![id],
        |r| r.get(0),
    ) {
        Ok(p) => p,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Err(NoteZError::NotFound(id)),
        Err(e) => return Err(e.into()),
    };

    let now = now_iso();

    match &mode {
        DeleteFolderMode::ReparentToParent => {
            tx.execute(
                "UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE parent_id = ?3",
                rusqlite::params![parent_id, now, id],
            )?;
            tx.execute(
                "UPDATE notes SET folder_id = ?1 WHERE folder_id = ?2 AND deleted_at IS NULL",
                rusqlite::params![parent_id, id],
            )?;
            tx.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![id])?;
        }
        DeleteFolderMode::ReparentTo { folder_id } => {
            // Validate destination: must not be the folder itself or any of
            // its descendants, otherwise the reparent creates a dangling
            // cycle (target dies along with the deleted subtree).
            if let Some(target) = folder_id.as_ref() {
                if target == &id {
                    return Err(NoteZError::InvalidInput(
                        "cannot reparent contents into the folder being deleted".into(),
                    ));
                }
                if is_descendant_of(&tx, target, &id)? {
                    return Err(NoteZError::InvalidInput(
                        "cannot reparent contents into a descendant of the folder being deleted"
                            .into(),
                    ));
                }
                ensure_folder_exists(&tx, target)?;
            }
            tx.execute(
                "UPDATE folders SET parent_id = ?1, updated_at = ?2 WHERE parent_id = ?3",
                rusqlite::params![folder_id, now, id],
            )?;
            tx.execute(
                "UPDATE notes SET folder_id = ?1 WHERE folder_id = ?2 AND deleted_at IS NULL",
                rusqlite::params![folder_id, id],
            )?;
            tx.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![id])?;
        }
        DeleteFolderMode::TrashNotes => {
            // Treat the whole subtree (the folder + its descendants) as a
            // unit: notes inside any of these folders go to Trash, then the
            // folders themselves are removed. The user doesn't end up with
            // empty subfolders that survive the operation.
            let descendants = resolve_descendants(&tx, &id)?;
            // resolve_descendants always includes the root, but be defensive.
            if descendants.is_empty() {
                tx.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![id])?;
            } else {
                let placeholders = vec!["?"; descendants.len()].join(",");
                let trash_sql = format!(
                    "UPDATE notes SET deleted_at = ?1, is_pinned = 0, pinned_at = NULL
                     WHERE deleted_at IS NULL AND folder_id IN ({})",
                    placeholders
                );
                let mut params: Vec<Value> = Vec::with_capacity(descendants.len() + 1);
                params.push(Value::from(now.clone()));
                for d in &descendants {
                    params.push(Value::from(d.clone()));
                }
                tx.execute(&trash_sql, rusqlite::params_from_iter(params))?;

                let del_sql =
                    format!("DELETE FROM folders WHERE id IN ({})", placeholders);
                let del_params: Vec<Value> =
                    descendants.iter().map(|s| Value::from(s.clone())).collect();
                tx.execute(&del_sql, rusqlite::params_from_iter(del_params))?;
            }
        }
    }

    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn move_note_to_folder(
    db: State<Db>,
    note_id: String,
    folder_id: Option<String>,
) -> Result<()> {
    let conn = db.conn()?;
    if let Some(fid) = folder_id.as_ref() {
        ensure_folder_exists(&conn, fid)?;
    }
    let now = now_iso();
    let updated = conn.execute(
        "UPDATE notes SET folder_id = ?1, updated_at = ?2
         WHERE id = ?3 AND deleted_at IS NULL",
        rusqlite::params![folder_id, now, note_id],
    )?;
    if updated == 0 {
        return Err(NoteZError::NotFound(note_id));
    }
    Ok(())
}

/// Reparent a folder, optionally placing it at a specific sort order. Refuses
/// cycles (placing a folder under itself or one of its descendants).
#[tauri::command]
pub fn move_folder(
    db: State<Db>,
    id: String,
    new_parent_id: Option<String>,
) -> Result<Folder> {
    let conn = db.conn()?;
    ensure_folder_exists(&conn, &id)?;

    if let Some(target) = new_parent_id.as_ref() {
        if target == &id {
            return Err(NoteZError::InvalidInput("cannot move folder into itself".into()));
        }
        ensure_folder_exists(&conn, target)?;
        if is_descendant_of(&conn, target, &id)? {
            return Err(NoteZError::InvalidInput(
                "cannot move folder into one of its own descendants".into(),
            ));
        }
        let depth = depth_of(&conn, target)?;
        if depth + 1 >= MAX_FOLDER_DEPTH {
            return Err(NoteZError::InvalidInput(format!(
                "folder tree too deep (max {})",
                MAX_FOLDER_DEPTH
            )));
        }
    }

    let now = now_iso();
    let next_sort: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders WHERE parent_id IS ?1",
            rusqlite::params![new_parent_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "UPDATE folders SET parent_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![new_parent_id, next_sort, now, id],
    )?;
    fetch_folder(&conn, &id)
}

fn fetch_folder(conn: &Connection, id: &str) -> Result<Folder> {
    conn.query_row(
        "SELECT f.id, f.parent_id, f.name, f.sort_order, f.created_at, f.updated_at,
                (SELECT COUNT(*) FROM notes
                  WHERE folder_id = f.id AND deleted_at IS NULL) AS cnt
         FROM folders f WHERE f.id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(Folder {
                id: row.get("id")?,
                parent_id: row.get("parent_id")?,
                name: row.get("name")?,
                sort_order: row.get("sort_order")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                note_count: row.get::<_, i64>("cnt")?.max(0) as u32,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => NoteZError::NotFound(id.to_string()),
        other => NoteZError::Database(other),
    })
}

fn ensure_folder_exists(conn: &Connection, id: &str) -> Result<()> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM folders WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Err(NoteZError::NotFound(id.to_string()));
    }
    Ok(())
}

fn depth_of(conn: &Connection, folder_id: &str) -> Result<i64> {
    // Walks up via parent_id. Bounded by MAX_FOLDER_DEPTH so a corrupted
    // cycle can't infinite-loop here.
    let depth: i64 = conn.query_row(
        "WITH RECURSIVE up(id, parent_id, depth) AS (
            SELECT id, parent_id, 0 FROM folders WHERE id = ?1
            UNION ALL
            SELECT f.id, f.parent_id, up.depth + 1
            FROM folders f JOIN up ON f.id = up.parent_id
            WHERE up.depth < ?2
         )
         SELECT MAX(depth) FROM up",
        rusqlite::params![folder_id, MAX_FOLDER_DEPTH],
        |r| r.get(0),
    )?;
    Ok(depth)
}

fn is_descendant_of(conn: &Connection, candidate: &str, ancestor: &str) -> Result<bool> {
    let hit: i64 = conn.query_row(
        "WITH RECURSIVE up(id, parent_id, depth) AS (
            SELECT id, parent_id, 0 FROM folders WHERE id = ?1
            UNION ALL
            SELECT f.id, f.parent_id, up.depth + 1
            FROM folders f JOIN up ON f.id = up.parent_id
            WHERE up.depth < ?3
         )
         SELECT COUNT(1) FROM up WHERE id = ?2",
        rusqlite::params![candidate, ancestor, MAX_FOLDER_DEPTH],
        |r| r.get(0),
    )?;
    Ok(hit > 0)
}

fn sanitize_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(NoteZError::InvalidInput("folder name must not be empty".into()));
    }
    if trimmed.chars().count() > MAX_FOLDER_NAME_LEN {
        return Err(NoteZError::InvalidInput(format!(
            "folder name too long (max {} chars)",
            MAX_FOLDER_NAME_LEN
        )));
    }
    Ok(trimmed.to_string())
}

/// Resolve a folder filter to the SQL fragment + bind params needed to scope
/// `list_notes`. Internal helper, used by `commands::notes`.
pub fn resolve_descendants(conn: &Connection, root_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE down(id, depth) AS (
            SELECT id, 0 FROM folders WHERE id = ?1
            UNION ALL
            SELECT f.id, down.depth + 1
            FROM folders f JOIN down ON f.parent_id = down.id
            WHERE down.depth < ?2
         )
         SELECT id FROM down",
    )?;
    let rows = stmt.query_map(rusqlite::params![root_id, MAX_FOLDER_DEPTH], |r| {
        r.get::<_, String>(0)
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
