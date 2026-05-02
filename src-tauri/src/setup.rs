use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
pub const TRAFFIC_LIGHT_INSET_X: f64 = 17.0;
#[cfg(target_os = "macos")]
pub const TRAFFIC_LIGHT_INSET_Y: f64 = 26.0;

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
        // Re-apply after vibrancy: NSVisualEffectView insertion shifts the
        // title-bar container's frame, which makes tao's drawRect-time inset
        // calculation land at the wrong y on the first paint of a release
        // build. See `mac_chrome` for the full story.
        crate::mac_chrome::apply_traffic_light_inset(
            &win,
            TRAFFIC_LIGHT_INSET_X,
            TRAFFIC_LIGHT_INSET_Y,
        );
    }

    let _ = win.show();
}
