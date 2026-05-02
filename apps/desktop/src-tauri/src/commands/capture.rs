use crate::error::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    utils::config::Color, LogicalPosition, LogicalSize, Manager, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

const CAPTURE_LABEL: &str = "capture";
const CAPTURE_W: f64 = 640.0;
const CAPTURE_H: f64 = 110.0;

/// Tracks whether we've installed the focus-lost-hides-window listener for
/// the current capture window. The listener is installed at first creation
/// and persists for the window's lifetime. Without this flag, an edge-case
/// path where the OS destroyed the underlying window (race during quit, app
/// nap on macOS) and we recreate it would re-attach a duplicate listener,
/// firing `hide()` twice on every focus loss.
static CAPTURE_LISTENER_INSTALLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn toggle_capture_window(app: tauri::AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            position_on_focused_monitor(&app, &win);
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(
        &app,
        CAPTURE_LABEL,
        WebviewUrl::App("index.html?window=capture".into()),
    )
    .title("Quick Capture")
    .inner_size(CAPTURE_W, CAPTURE_H)
    .min_inner_size(420.0, 90.0)
    .resizable(false)
    .always_on_top(true)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .focused(true)
    .visible(false)
    // The OS shadow on a borderless transparent window paints a square
    // halo around the content area - fighting our rounded CSS panel.
    // We draw our own shadow via box-shadow instead.
    .shadow(false)
    // Force both NSWindow and the webview backing layer to fully transparent.
    // Tauri's "transparent: true" only nukes the window background; the
    // webview itself defaults to opaque white, which bleeds through as a
    // faint square *behind* our rounded CSS panel (visible in dark wallpapers
    // as a near-black ghost rectangle).
    .background_color(Color(0, 0, 0, 0))
    .build()?;

    // Defensive: window-state plugin (and other paths) can re-enable
    // decorations / shadow after build. Pin them off once we own the window.
    let _ = win.set_decorations(false);
    let _ = win.set_shadow(false);
    let _ = win.set_background_color(Some(Color(0, 0, 0, 0)));

    // Hide the window the moment it loses focus - Spotlight-style "click
    // outside to dismiss". Anything the user typed is discarded if they
    // didn't press ⌘↵; matches macOS expectations for HUD pop-ups.
    //
    // Idempotent install: the early-return above catches the typical
    // toggle-after-build path. If we somehow reach here a second time
    // (window torn down by OS app-nap and recreated), the atomic flag
    // prevents double-listener registration.
    if CAPTURE_LISTENER_INSTALLED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let app_handle = app.clone();
        win.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                if let Some(w) = app_handle.get_webview_window(CAPTURE_LABEL) {
                    let _ = w.hide();
                }
            }
        });
    }

    position_on_focused_monitor(&app, &win);
    let _ = win.show();
    let _ = win.set_focus();

    Ok(())
}

#[tauri::command]
pub async fn hide_capture_window(app: tauri::AppHandle) -> Result<()> {
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}

/// Move the capture window to the monitor the user is currently focused on.
///
/// We use the cursor position as the proxy for "focused monitor" - it works
/// across spaces and matches what the user expects when they trigger the
/// global shortcut. We position around 1/3 from the top of the work area
/// (above the visual centre), which is where heads-up dialogs sit on macOS.
fn position_on_focused_monitor(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return;
    };

    let scale = monitor.scale_factor();
    // work_area is in physical pixels; convert to logical so it matches
    // inner_size(LogicalSize) regardless of HiDPI.
    let area = monitor.work_area();
    let area_x = area.position.x as f64 / scale;
    let area_y = area.position.y as f64 / scale;
    let area_w = area.size.width as f64 / scale;
    let area_h = area.size.height as f64 / scale;

    let x = area_x + (area_w - CAPTURE_W) / 2.0;
    let y = area_y + area_h / 3.0 - CAPTURE_H / 2.0;

    let _ = win.set_size(LogicalSize::new(CAPTURE_W, CAPTURE_H));
    let _ = win.set_position(LogicalPosition::new(x, y));
}
