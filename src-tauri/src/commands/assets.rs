use crate::db::{now_iso, Db};
use crate::error::{NoteZError, Result};
use crate::models::{Asset, AssetRef};
use aho_corasick::AhoCorasick;
use image::GenericImageView;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use tauri::State;

/// Save an image asset.
///
/// Pipeline:
///   1. SHA-256 the bytes → content-addressed id (dedup: same image saved twice
///      reuses the existing row + file).
///   2. If unknown, decode to learn dimensions + generate a 4×3 blurhash placeholder
///      so the editor can paint *something* before the full bitmap loads.
///   3. **Insert the row first**, then write the bytes to disk. If the bytes-write
///      fails we DELETE the row so we never leak metadata pointing at no file.
///      If the row insert fails we never wrote bytes — no leak.
///   4. Files live at `<assets_dir>/<id[0..2]>/<id>.<ext>` (sharded so directories
///      stay enumerable; ~256 dirs at the top level).
#[tauri::command]
pub async fn save_asset(
    db: State<'_, Db>,
    bytes: Vec<u8>,
    mime: String,
) -> Result<AssetRef> {
    if bytes.is_empty() {
        return Err(NoteZError::InvalidInput("empty asset".into()));
    }

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let id = hex::encode(hasher.finalize());

    let ext = ext_for_mime(&mime).ok_or_else(|| {
        NoteZError::InvalidInput(format!("unsupported mime type: {mime}"))
    })?;

    let assets_dir = db.assets_dir.clone();
    let shard_dir = assets_dir.join(&id[0..2]);
    let file_path = shard_dir.join(format!("{}.{}", id, ext));

    // Fast path: already known.
    {
        let conn = db.conn()?;
        if let Some(asset) = lookup_asset(&conn, &id)? {
            // Heal a missing file: same id, same bytes, just rewrite if disk lost it.
            if !file_path.exists() {
                std::fs::create_dir_all(&shard_dir)?;
                atomic_write(&file_path, &bytes)?;
            }
            return Ok(AssetRef {
                id: asset.id,
                mime: asset.mime,
                width: asset.width,
                height: asset.height,
                blurhash: asset.blurhash,
                byte_size: asset.byte_size,
                path: file_path.to_string_lossy().to_string(),
            });
        }
    }

    // Slow path: decode + blurhash on the async pool.
    let bytes_for_decode = bytes.clone();
    let (width, height, blurhash) = tauri::async_runtime::spawn_blocking(move || {
        decode_image_metadata(&bytes_for_decode)
    })
    .await
    .map_err(|e| NoteZError::Other(format!("image decode join: {e}")))?
    .map_err(|e| NoteZError::Other(format!("image decode failed: {e}")))?;

    let byte_size = bytes.len() as u64;
    let now = now_iso();

    // Insert metadata FIRST. Use ON CONFLICT DO NOTHING because the id is
    // content-addressed: identical bytes always produce the same row, period.
    // (Avoids INSERT OR REPLACE silently overwriting an existing file path on a
    // mime mismatch.)
    let inserted_rows;
    {
        let conn = db.conn()?;
        inserted_rows = conn.execute(
            "INSERT INTO assets
                (id, mime, ext, width, height, blurhash, byte_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO NOTHING",
            rusqlite::params![
                id,
                mime,
                ext,
                width as i64,
                height as i64,
                blurhash,
                byte_size as i64,
                now
            ],
        )?;
    }

    // Then write the bytes. If this fails AND we just inserted, roll back
    // the row so the metadata never points at a non-existent file.
    if let Err(e) = std::fs::create_dir_all(&shard_dir).and_then(|_| atomic_write(&file_path, &bytes)) {
        if inserted_rows > 0 {
            let conn = db.conn()?;
            let _ = conn.execute("DELETE FROM assets WHERE id = ?1", rusqlite::params![id]);
        }
        return Err(NoteZError::Io(e));
    }

    Ok(AssetRef {
        id,
        mime,
        width,
        height,
        blurhash,
        byte_size,
        path: file_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn get_asset(db: State<Db>, id: String) -> Result<Option<AssetRef>> {
    let conn = db.conn()?;
    let Some(asset) = lookup_asset(&conn, &id)? else {
        return Ok(None);
    };
    let path = asset_path(&db.assets_dir, &asset.id, &asset.ext);
    Ok(Some(AssetRef {
        id: asset.id,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
        blurhash: asset.blurhash,
        byte_size: asset.byte_size,
        path: path.to_string_lossy().to_string(),
    }))
}

/// Absolute path to the on-disk assets directory. Cached by the frontend at
/// startup so the editor can resolve image paths synchronously during render
/// without per-image IPC.
#[tauri::command]
pub fn get_assets_dir(db: State<Db>) -> Result<String> {
    Ok(db.assets_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_assets(db: State<Db>) -> Result<Vec<Asset>> {
    let conn = db.conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, mime, ext, width, height, blurhash, byte_size, created_at
         FROM assets ORDER BY created_at DESC LIMIT 1000",
    )?;
    let rows = stmt.query_map([], row_to_asset)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Garbage-collect assets that no live note or snapshot references.
///
/// Two-stage:
///   1. Reference set — Aho-Corasick over every `content_json` blob (notes +
///      snapshots), single pass per blob. O(total_json_bytes), not O(notes ×
///      assets).
///   2. Then, for each known id NOT in the reference set, remove file + row.
///   3. Finally, walk the on-disk shard directories and delete any orphan file
///      whose id is not in the assets table — heals leaks from prior crash paths.
#[tauri::command]
pub fn gc_orphan_assets(db: State<Db>) -> Result<u64> {
    let conn = db.conn()?;

    // (id, ext) for everything we know about.
    let known: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, ext FROM assets")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let collected: rusqlite::Result<Vec<_>> = rows.collect();
        collected?
    };

    if known.is_empty() {
        // Still walk the disk to clear stray files (e.g. left over from a crash).
        return Ok(reap_disk_orphans(&db.assets_dir, &HashSet::new())?);
    }

    let ids: Vec<&str> = known.iter().map(|(id, _)| id.as_str()).collect();
    let ac = AhoCorasick::new(&ids).map_err(|e| NoteZError::Other(format!("aho-corasick: {e}")))?;
    let mut referenced: HashSet<String> = HashSet::with_capacity(ids.len());

    // One pass over notes + snapshots, one substring search per blob.
    {
        let mut stmt = conn.prepare("SELECT content_json FROM notes")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            let blob = r?;
            for m in ac.find_iter(&blob) {
                referenced.insert(known[m.pattern().as_usize()].0.clone());
            }
        }
    }
    {
        let mut stmt = conn.prepare("SELECT content_json FROM snapshots")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            let blob = r?;
            for m in ac.find_iter(&blob) {
                referenced.insert(known[m.pattern().as_usize()].0.clone());
            }
        }
    }

    // Collect orphans, then drop them in one DELETE.
    let mut orphan_ids: Vec<String> = Vec::new();
    let mut orphan_paths: Vec<PathBuf> = Vec::new();
    for (id, ext) in &known {
        if referenced.contains(id) {
            continue;
        }
        orphan_ids.push(id.clone());
        orphan_paths.push(asset_path(&db.assets_dir, id, ext));
    }

    let mut deleted: u64 = 0;
    if !orphan_ids.is_empty() {
        // Batch DELETE.
        let placeholders = std::iter::repeat("?").take(orphan_ids.len()).collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM assets WHERE id IN ({})", placeholders);
        let params: Vec<&dyn rusqlite::ToSql> =
            orphan_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params.as_slice())?;
        for p in &orphan_paths {
            let _ = std::fs::remove_file(p);
        }
        deleted = orphan_ids.len() as u64;
    }

    // Heal disk-side leaks (crash-time half-writes, etc.).
    let live: HashSet<String> = known.iter().map(|(id, _)| id.clone()).collect();
    deleted += reap_disk_orphans(&db.assets_dir, &live)?;

    Ok(deleted)
}

// --- helpers ---

fn lookup_asset(conn: &rusqlite::Connection, id: &str) -> Result<Option<Asset>> {
    let row = conn.query_row(
        "SELECT id, mime, ext, width, height, blurhash, byte_size, created_at
         FROM assets WHERE id = ?1",
        rusqlite::params![id],
        row_to_asset,
    );
    match row {
        Ok(a) => Ok(Some(a)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(NoteZError::Database(e)),
    }
}

fn row_to_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: row.get("id")?,
        mime: row.get("mime")?,
        ext: row.get("ext")?,
        width: row.get::<_, i64>("width")? as u32,
        height: row.get::<_, i64>("height")? as u32,
        blurhash: row.get("blurhash")?,
        byte_size: row.get::<_, i64>("byte_size")? as u64,
        created_at: row.get("created_at")?,
    })
}

fn asset_path(assets_dir: &std::path::Path, id: &str, ext: &str) -> PathBuf {
    assets_dir.join(&id[0..2]).join(format!("{}.{}", id, ext))
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn decode_image_metadata(bytes: &[u8]) -> std::result::Result<(u32, u32, Option<String>), String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let (width, height) = img.dimensions();

    // Blurhash needs RGBA bytes. We downscale large images first — blurhash
    // quality is independent of source resolution and the encoder is O(w*h).
    let small = if width.max(height) > 256 {
        img.thumbnail(256, 256)
    } else {
        img
    };
    let rgba = small.to_rgba8();
    let (sw, sh) = (small.dimensions().0 as usize, small.dimensions().1 as usize);
    let hash = blurhash::encode(4, 3, sw as u32, sh as u32, rgba.as_raw())
        .ok()
        .map(|s| s.to_string());

    Ok((width, height, hash))
}

fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Walk the assets directory and delete any file whose id is NOT in `live`.
/// File names are `<sha>.<ext>`; subdirs are sha-prefix shards.
fn reap_disk_orphans(assets_dir: &std::path::Path, live: &HashSet<String>) -> Result<u64> {
    let mut deleted = 0u64;
    let Ok(entries) = std::fs::read_dir(assets_dir) else {
        return Ok(0);
    };
    for shard in entries.flatten() {
        let path = shard.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&path) else { continue };
        for file in files.flatten() {
            let fp = file.path();
            if !fp.is_file() {
                continue;
            }
            // Strip extension to get the id.
            let stem = fp
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if stem.is_empty() {
                continue;
            }
            // Skip in-flight tmp files (atomic_write's `<id>.tmp`).
            let is_tmp = fp
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s == "tmp")
                .unwrap_or(false);
            if is_tmp {
                continue;
            }
            if !live.contains(&stem) {
                if std::fs::remove_file(&fp).is_ok() {
                    deleted += 1;
                }
            }
        }
    }
    Ok(deleted)
}
