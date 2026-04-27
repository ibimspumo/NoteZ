use crate::error::Result;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const CAPTURE_LABEL: &str = "capture";

#[tauri::command]
pub async fn toggle_capture_window(app: tauri::AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Ok(());
    }

    let _win = WebviewWindowBuilder::new(
        &app,
        CAPTURE_LABEL,
        WebviewUrl::App("index.html?window=capture".into()),
    )
    .title("Quick Capture")
    .inner_size(560.0, 200.0)
    .min_inner_size(420.0, 160.0)
    .resizable(true)
    .always_on_top(true)
    .decorations(true)
    .transparent(true)
    .skip_taskbar(true)
    .focused(true)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let _ = apply_vibrancy(
            &_win,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(12.0),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn hide_capture_window(app: tauri::AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}
