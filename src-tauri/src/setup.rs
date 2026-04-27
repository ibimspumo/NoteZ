use tauri::{AppHandle, Manager};

pub fn install_window_chrome(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(e) = apply_vibrancy(
            &win,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        ) {
            tracing::warn!("apply_vibrancy failed: {e:?}");
        }
    }

    let _ = win.show();
}
