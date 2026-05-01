use crate::constants::{BLURHASH_DECODE_SIZE, DEFAULT_PAGE_SIZE, MAX_ASSET_BYTES, MAX_PAGE_SIZE};
use crate::db::{now_iso, Db};
use crate::error::{NoteZError, Result};
use crate::models::{Asset, AssetRef, AssetsCursor, AssetsPage};
use crate::pagination::{collect_page, next_cursor};
use image::GenericImageView;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Read, Write};
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
///      If the row insert fails we never wrote bytes - no leak.
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
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(NoteZError::InvalidInput(format!(
            "asset too large: {} bytes (max {MAX_ASSET_BYTES})",
            bytes.len()
        )));
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

/// Paginated list of stored assets. Same `(created_at DESC, id DESC)` cursor
/// pattern as everywhere else - a 1M-asset DB no longer silently truncates
/// at 1000 (the previous hard cap).
#[tauri::command]
pub fn list_assets(
    db: State<Db>,
    cursor: Option<AssetsCursor>,
    limit: Option<u32>,
) -> Result<AssetsPage> {
    let conn = db.conn()?;
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let fetch = (limit + 1) as i64;

    let (items, has_more) = if let Some(c) = cursor.as_ref() {
        let mut stmt = conn.prepare(
            "SELECT id, mime, ext, width, height, blurhash, byte_size, created_at
             FROM assets
             WHERE (created_at, id) < (?1, ?2)
             ORDER BY created_at DESC, id DESC
             LIMIT ?3",
        )?;
        collect_page(
            &mut stmt,
            rusqlite::params![c.created_at, c.id, fetch],
            limit,
            row_to_asset,
        )?
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, mime, ext, width, height, blurhash, byte_size, created_at
             FROM assets
             ORDER BY created_at DESC, id DESC
             LIMIT ?1",
        )?;
        collect_page(&mut stmt, rusqlite::params![fetch], limit, row_to_asset)?
    };

    let next = next_cursor(&items, has_more, |a| AssetsCursor {
        created_at: a.created_at.clone(),
        id: a.id.clone(),
    });
    Ok(AssetsPage { items, next_cursor: next })
}

/// Garbage-collect assets that no live note or snapshot references.
///
/// Pipeline:
///   1. Stage 1: an asset is orphaned iff `note_assets` has no row pointing
///      at it. The join table is maintained incrementally by `update_note`
///      (and seeded once at v5 migration time), so this is an O(assets)
///      LEFT JOIN - no Aho-Corasick over content blobs, no O(corpus_bytes).
///   2. Stage 2: also keep assets referenced by SNAPSHOTS - those don't have
///      a join table because snapshots are immutable, but they're bounded
///      (50 auto + ≤500 manual per note) so a one-pass substring scan over
///      snapshot blobs is acceptable. We ONLY scan snapshots for assets that
///      stage 1 already declared orphaned, so the work is O(orphans × snapshot_bytes)
///      which collapses to nothing when there are few orphans (the common case).
///   3. Stage 3: walk on-disk shard directories and delete any file whose id
///      isn't in the assets table - heals leaks from prior crash paths.
///
/// Off-thread: the whole pipeline runs in `spawn_blocking` because step 3
/// hits the filesystem (recursive read_dir) and the snapshot fallback can
/// touch many rows. On a 1M-asset DB step 1 is sub-100ms, step 3 dominates.
#[tauri::command]
pub async fn gc_orphan_assets(db: State<'_, Db>) -> Result<u64> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<u64> { gc_orphan_assets_blocking(&db) })
        .await
        .map_err(|e| NoteZError::Other(format!("gc join: {e}")))?
}

fn gc_orphan_assets_blocking(db: &Db) -> Result<u64> {
    // We deliberately scope the DB connection to the queries-only phase so
    // we don't hold a pool slot while the filesystem reaping below walks
    // every shard directory. The previous code held the connection for the
    // entire pipeline; on a 1M-asset DB that's many minutes of read_dir +
    // remove_file blocking other writers (save pipeline) on the pool.
    //
    // Stage 1 + 2 collect what to delete; we then close the connection and
    // do disk + write phase separately on a fresh connection.
    struct Plan {
        orphan_ids: Vec<String>,
        orphan_paths: Vec<PathBuf>,
        live_kept: HashSet<String>,
    }

    let plan: Plan = {
        let conn = db.conn()?;
        // Stage 1: orphans per the join table.
        let stage1_orphans: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.ext
                   FROM assets a
                   LEFT JOIN note_assets na ON na.asset_id = a.id
                  WHERE na.asset_id IS NULL",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let known_ids_for_disk: HashSet<String> = {
            let mut stmt = conn.prepare("SELECT id FROM assets")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<HashSet<_>>>()?
        };

        if stage1_orphans.is_empty() {
            Plan {
                orphan_ids: Vec::new(),
                orphan_paths: Vec::new(),
                live_kept: known_ids_for_disk,
            }
        } else {
            // Stage 2: exclude orphans still referenced by a snapshot via
            // the snapshot_assets join table (populated by `create_snapshot`,
            // backfilled by migration v8). This makes GC O(stage1_orphans)
            // instead of O(orphans × snapshot_bytes).
            let referenced: HashSet<String> = {
                let candidate_json = serde_json::to_string(
                    &stage1_orphans.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
                )?;
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT sa.asset_id
                       FROM snapshot_assets sa
                       JOIN json_each(?1) je ON je.value = sa.asset_id",
                )?;
                let rows = stmt.query_map(rusqlite::params![candidate_json], |r| {
                    r.get::<_, String>(0)
                })?;
                rows.collect::<rusqlite::Result<HashSet<_>>>()?
            };

            let mut orphan_ids: Vec<String> = Vec::new();
            let mut orphan_paths: Vec<PathBuf> = Vec::new();
            for (id, ext) in &stage1_orphans {
                if referenced.contains(id) {
                    continue;
                }
                orphan_ids.push(id.clone());
                orphan_paths.push(asset_path(&db.assets_dir, id, ext));
            }

            let live_kept: HashSet<String> = known_ids_for_disk
                .into_iter()
                .filter(|id| !orphan_ids.iter().any(|o| o == id))
                .collect();

            Plan {
                orphan_ids,
                orphan_paths,
                live_kept,
            }
        }
    };
    // ↑ `conn` dropped here: pool slot returns, other writers can interleave.

    let mut deleted: u64 = 0;
    if !plan.orphan_ids.is_empty() {
        // Re-acquire connection for the DELETE only.
        let conn = db.conn()?;
        // Bulk-delete via json_each so we don't hand-build placeholder SQL
        // for variable-length IN clauses.
        let json = serde_json::to_string(&plan.orphan_ids)?;
        conn.execute(
            "DELETE FROM assets WHERE id IN (SELECT value FROM json_each(?1))",
            rusqlite::params![json],
        )?;
        drop(conn);

        for p in &plan.orphan_paths {
            let _ = std::fs::remove_file(p);
        }
        deleted = plan.orphan_ids.len() as u64;
    }

    // Disk-only reaping has no DB connection. Heals files left behind by
    // crash-during-save scenarios.
    deleted += reap_disk_orphans(&db.assets_dir, &plan.live_kept)?;
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

    // Blurhash needs RGBA bytes. We downscale large images first - blurhash
    // quality is independent of source resolution and the encoder is O(w*h).
    let small = if width.max(height) > BLURHASH_DECODE_SIZE {
        img.thumbnail(BLURHASH_DECODE_SIZE, BLURHASH_DECODE_SIZE)
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

/// Like `save_asset`, but reads the bytes from disk instead of accepting them
/// over the IPC. This is the *fast* path for editor image drops: a 10 MB photo
/// passed as `Vec<u8>` over the JSON-encoded IPC channel is literally millions
/// of `number[]` entries to serialise/deserialise (~150 ms+ on M1). Reading
/// from a path the renderer just told us about is O(file_size) on disk, no JSON.
///
/// Security:
///  - We `metadata()` the path FIRST and reject anything that isn't a regular
///    file or whose declared size is over `MAX_ASSET_BYTES`. Without this,
///    `fs::read` would happily slurp a 50 GB file into memory before any cap
///    check, OOMing the process (a malicious drop or a buggy DnD source could
///    trigger this).
///  - We refuse symlinks. A user drop produces a real file path; symlinks
///    only appear when something automated (e.g. a malicious extension) is
///    constructing the IPC payload, and refusing them prevents follow-the-
///    symlink reads of arbitrary user files (`~/.ssh/id_rsa`, etc.).
///  - The *target* path is content-addressed and always inside `assets_dir`,
///    so there's no traversal risk on the write side.
#[tauri::command]
pub async fn save_asset_from_path(
    db: State<'_, Db>,
    path: String,
    mime: String,
) -> Result<AssetRef> {
    // TOCTOU-safe pipeline:
    //   1. `symlink_metadata` returns the *link* metadata (does not follow).
    //      Reject symlinks here so the open() below can't be redirected.
    //   2. `File::open` returns a real fd that hangs on to the inode. Even
    //      if a hostile process swaps the path now, our fd still points at
    //      the original file (or rather: the `open` resolves before the
    //      swap, and the kernel keeps the inode alive until we close).
    //   3. Read the OPEN file's metadata - this is the size that the read
    //      will actually see, not the pre-open size which a swap could lie
    //      about. Reject too-large files here.
    //   4. `Read::take(MAX_ASSET_BYTES + 1)` makes the read defensively
    //      bounded even if the file grew between metadata-on-fd and read.
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>> {
        // 1. Pre-open symlink + filetype check. The check is cheap and
        //    trips the obvious-path attack early.
        let pre_meta = std::fs::symlink_metadata(&path)?;
        let ft = pre_meta.file_type();
        if ft.is_symlink() {
            return Err(NoteZError::InvalidInput(
                "symlinked asset paths are not allowed".into(),
            ));
        }
        if !ft.is_file() {
            return Err(NoteZError::InvalidInput(
                "asset path is not a regular file".into(),
            ));
        }

        // 2. Open before any further metadata read. Holding the fd makes
        //    the rest race-free: a path swap after this point cannot
        //    redirect our reads.
        let mut f = std::fs::File::open(&path)?;

        // 3. Re-check metadata via the open fd. This is the metadata of
        //    the file we'll actually read.
        let meta = f.metadata()?;
        if !meta.file_type().is_file() {
            return Err(NoteZError::InvalidInput(
                "asset path is not a regular file (post-open)".into(),
            ));
        }
        if meta.len() == 0 {
            return Err(NoteZError::InvalidInput("empty asset".into()));
        }
        if meta.len() > MAX_ASSET_BYTES {
            return Err(NoteZError::InvalidInput(format!(
                "asset too large: {} bytes (max {MAX_ASSET_BYTES})",
                meta.len()
            )));
        }

        // 4. Hard-cap the read length even against a file that grew between
        //    metadata and read. `take` truncates at the limit; if we hit
        //    exactly the cap+1, we know the file is over-budget.
        let mut buf = Vec::with_capacity(meta.len() as usize);
        let read_n = std::io::Read::by_ref(&mut f)
            .take(MAX_ASSET_BYTES + 1)
            .read_to_end(&mut buf)?;
        if read_n as u64 > MAX_ASSET_BYTES {
            return Err(NoteZError::InvalidInput(format!(
                "asset grew during read; rejected (max {MAX_ASSET_BYTES})"
            )));
        }
        Ok(buf)
    })
    .await
    .map_err(|e| NoteZError::Other(format!("read join: {e}")))??;

    save_asset(db, bytes, mime).await
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
            if !live.contains(&stem) && std::fs::remove_file(&fp).is_ok() {
                deleted += 1;
            }
        }
    }
    Ok(deleted)
}
