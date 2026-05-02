//! Cross-window backend → frontend events.
//!
//! Tauri 2 keeps the event bus per-app (not per-window) by default, so
//! `app.emit(name, payload)` reaches every webview that subscribed via
//! `listen()`. We wrap the emit so callers don't have to know the event
//! name format - it's an implementation detail of the contract.

use crate::constants::EVENT_SETTINGS_CHANGED;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct SettingsChanged<'a> {
    pub key: &'a str,
}

/// Tell every window that a setting just changed.
///
/// Best-effort: log on failure but never bubble up. If a window has been
/// destroyed mid-emit, the bus simply skips it.
pub fn emit_settings_changed(app: &AppHandle, key: &str) {
    if let Err(e) = app.emit(EVENT_SETTINGS_CHANGED, SettingsChanged { key }) {
        tracing::warn!("emit_settings_changed({key}): {e}");
    }
}
