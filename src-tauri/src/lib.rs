mod commands;
mod db;
mod error;
mod models;
mod setup;
mod shortcuts;

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::db::Db;
use crate::error::{NoteZError, Result};
use crate::shortcuts::{ShortcutSpec, ShortcutsState};

const SETTING_QUICK_CAPTURE: &str = "shortcut_quick_capture";
const SETTING_COMMAND_BAR: &str = "shortcut_command_bar";

struct AppPaths {
    db: PathBuf,
    assets: PathBuf,
}

fn resolve_app_paths(app: &AppHandle) -> std::io::Result<AppPaths> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| std::io::Error::other(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let assets = dir.join("assets");
    std::fs::create_dir_all(&assets)?;
    Ok(AppPaths {
        db: dir.join("notez.db"),
        assets,
    })
}

fn read_shortcut_setting(db: &Db, key: &str, default: ShortcutSpec) -> ShortcutSpec {
    let conn = match db.conn() {
        Ok(c) => c,
        Err(_) => return default,
    };
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |r| r.get(0),
        )
        .ok();
    value
        .as_deref()
        .and_then(shortcuts::parse)
        .unwrap_or(default)
}

#[tauri::command]
fn update_shortcut(
    app: AppHandle,
    db: State<Db>,
    name: String,
    accelerator: String,
) -> Result<String> {
    let spec = shortcuts::parse(&accelerator)
        .ok_or_else(|| NoteZError::InvalidInput(format!("invalid shortcut: {accelerator}")))?;
    let state = app.state::<ShortcutsState>();
    let gs = app.global_shortcut();

    let (slot, key) = match name.as_str() {
        "quick_capture" => (&state.quick_capture, SETTING_QUICK_CAPTURE),
        "command_bar" => (&state.command_bar, SETTING_COMMAND_BAR),
        _ => return Err(NoteZError::InvalidInput(format!("unknown shortcut: {name}"))),
    };

    let mut current = slot
        .lock()
        .map_err(|_| NoteZError::Other("shortcut state poisoned".into()))?;

    if *current == spec {
        return Ok(spec.to_canonical());
    }

    let old = *current;
    let _ = gs.unregister(old.to_shortcut());
    if let Err(e) = gs.register(spec.to_shortcut()) {
        // Roll back: try to put the old one back so the user isn't left with nothing.
        let _ = gs.register(old.to_shortcut());
        return Err(NoteZError::Other(format!("register shortcut failed: {e}")));
    }
    *current = spec;
    drop(current);

    let canonical = spec.to_canonical();
    let conn = db.conn()?;
    let now = crate::db::now_iso();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, canonical, now],
    )?;
    Ok(canonical)
}

#[tauri::command]
fn get_shortcuts(app: AppHandle) -> Result<serde_json::Value> {
    let state = app.state::<ShortcutsState>();
    let qc = state
        .quick_capture
        .lock()
        .map_err(|_| NoteZError::Other("shortcut state poisoned".into()))?;
    let cb = state
        .command_bar
        .lock()
        .map_err(|_| NoteZError::Other("shortcut state poisoned".into()))?;
    Ok(serde_json::json!({
        "quick_capture": qc.to_canonical(),
        "command_bar": cb.to_canonical(),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("notez=debug,info")))
        .try_init();

    tauri::Builder::default()
        .plugin(
            // The window-state plugin restores DECORATIONS by default, which
            // overrides our `decorations(false)` for the Quick Capture window
            // (it stays a frameless HUD; we don't want a stale saved state to
            // bring the title bar back).
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["capture"])
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let mods = shortcut.mods;
                    let key = shortcut.key;
                    let state = app.state::<ShortcutsState>();
                    let qc = state.quick_capture.lock().ok().map(|s| *s);
                    let cb = state.command_bar.lock().ok().map(|s| *s);
                    if let Some(spec) = qc {
                        if spec.matches(mods, key) {
                            let _ = app.emit("notez://global/quick-capture", ());
                            let app_for_spawn = app.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) =
                                    crate::commands::capture::toggle_capture_window(app_for_spawn).await
                                {
                                    tracing::warn!("toggle capture failed: {e}");
                                }
                            });
                            return;
                        }
                    }
                    if let Some(spec) = cb {
                        if spec.matches(mods, key) {
                            let _ = app.emit("notez://global/command-bar", ());
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let paths = resolve_app_paths(&app.handle())?;
            tracing::info!("opening database: {:?}", paths.db);
            tracing::info!("assets dir: {:?}", paths.assets);
            let db = Db::open(&paths.db, &paths.assets)
                .map_err(|e| Box::<dyn std::error::Error>::from(format!("db open: {e}")))?;

            // Load configured shortcuts from DB (or fall back to defaults).
            let qc_spec = read_shortcut_setting(
                &db,
                SETTING_QUICK_CAPTURE,
                shortcuts::default_quick_capture(),
            );
            let cb_spec = read_shortcut_setting(
                &db,
                SETTING_COMMAND_BAR,
                shortcuts::default_command_bar(),
            );

            app.manage(db);
            app.manage(ShortcutsState::new(qc_spec, cb_spec));

            crate::setup::install_window_chrome(&app.handle());

            // Register global shortcuts. If the user-configured one fails (e.g. another
            // app holds it), the warning is logged and in-app fallbacks still work.
            let gs = app.global_shortcut();
            if let Err(e) = gs.register(qc_spec.to_shortcut()) {
                tracing::warn!("register quick-capture shortcut failed: {e}");
            }
            if let Err(e) = gs.register(cb_spec.to_shortcut()) {
                tracing::warn!("register command-bar shortcut failed: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // notes
            commands::notes::create_note,
            commands::notes::get_note,
            commands::notes::update_note,
            commands::notes::list_notes,
            commands::notes::list_trash,
            commands::notes::toggle_pin,
            commands::notes::soft_delete_note,
            commands::notes::restore_note,
            commands::notes::purge_note,
            commands::notes::empty_trash,
            commands::notes::purge_old_trash,
            // search
            commands::search::search_notes,
            commands::search::quick_lookup,
            // snapshots
            commands::snapshots::create_snapshot,
            commands::snapshots::list_snapshots,
            commands::snapshots::restore_snapshot,
            // mentions
            commands::mentions::list_backlinks,
            // settings
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::list_settings,
            // shortcuts (live-mutable)
            update_shortcut,
            get_shortcuts,
            // assets
            commands::assets::save_asset,
            commands::assets::get_asset,
            commands::assets::get_assets_dir,
            commands::assets::list_assets,
            commands::assets::gc_orphan_assets,
            // capture
            commands::capture::toggle_capture_window,
            commands::capture::hide_capture_window,
            // ai
            commands::ai::get_ai_config,
            commands::ai::set_ai_enabled,
            commands::ai::set_ai_model,
            commands::ai::set_openrouter_key,
            commands::ai::list_ai_models,
            commands::ai::generate_title,
            commands::ai::list_ai_calls,
            commands::ai::get_ai_stats,
            commands::ai::clear_ai_calls,
            // dev-only stress-test helpers (cfg'd out in release)
            #[cfg(debug_assertions)]
            commands::dev::dev_generate_notes,
            #[cfg(debug_assertions)]
            commands::dev::dev_count_generated_notes,
            #[cfg(debug_assertions)]
            commands::dev::dev_delete_generated_notes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
