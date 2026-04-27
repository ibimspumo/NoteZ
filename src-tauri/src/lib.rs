mod commands;
mod db;
mod error;
mod models;
mod setup;

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::db::Db;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("notez=debug,info")))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
                    if key == Code::KeyN
                        && mods.contains(Modifiers::SUPER)
                        && mods.contains(Modifiers::SHIFT)
                    {
                        let _ = app.emit("notez://global/quick-capture", ());
                        let app_for_spawn = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) =
                                crate::commands::capture::toggle_capture_window(app_for_spawn).await
                            {
                                tracing::warn!("toggle capture failed: {e}");
                            }
                        });
                    } else if key == Code::KeyK && mods.contains(Modifiers::SUPER) {
                        let _ = app.emit("notez://global/command-bar", ());
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
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
            app.manage(db);

            crate::setup::install_window_chrome(&app.handle());

            // Register global shortcuts.
            let gs = app.global_shortcut();
            let quick_capture =
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyN);
            let command_bar = Shortcut::new(Some(Modifiers::SUPER), Code::KeyK);
            if let Err(e) = gs.register(quick_capture) {
                tracing::warn!("register quick-capture shortcut failed: {e}");
            }
            if let Err(e) = gs.register(command_bar) {
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
            // assets
            commands::assets::save_asset,
            commands::assets::get_asset,
            commands::assets::get_assets_dir,
            commands::assets::list_assets,
            commands::assets::gc_orphan_assets,
            // capture
            commands::capture::toggle_capture_window,
            commands::capture::hide_capture_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
