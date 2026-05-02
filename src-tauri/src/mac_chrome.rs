//! macOS title-bar chrome helpers.
//!
//! Tauri 2's `trafficLightPosition` config maps to tao's
//! `with_traffic_light_inset`, which hooks `drawRect:` on the root content
//! view to re-position the close/minimize/zoom cluster on every redraw. The
//! first invocation lands at a transient layout state - in particular,
//! after `apply_vibrancy` injects an `NSVisualEffectView` the title-bar
//! container's frame shifts, and bundled (`.app`) vs unbundled launches
//! exercise slightly different AppKit init orderings. The visible result:
//! traffic lights sit a few pixels lower in the GitHub-built release than
//! in `pnpm tauri dev`.
//!
//! `apply_traffic_light_inset` re-runs the same arithmetic tao uses,
//! dispatched onto the main thread at a known-good moment (post-vibrancy in
//! setup, plus on `Resized` / `ThemeChanged`), so the two builds agree.

use tauri::{Runtime, WebviewWindow};

pub fn apply_traffic_light_inset<R: Runtime>(window: &WebviewWindow<R>, x: f64, y: f64) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    let ns_window_ptr = match window.ns_window() {
        Ok(p) => p as usize,
        Err(e) => {
            tracing::warn!("ns_window unavailable: {e}");
            return;
        }
    };

    let dispatch = window.run_on_main_thread(move || unsafe {
        let ns_window: &NSWindow = &*(ns_window_ptr as *const NSWindow);

        let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
        else {
            return;
        };
        let Some(zoom) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
            return;
        };

        // NSButton -> NSControl -> NSView. Re-borrow as &NSView so the
        // generated NSView methods (frame, superview, setFrameOrigin) are
        // in scope.
        let close_view: &NSView = &close;
        let mini_view: &NSView = &miniaturize;
        let zoom_view: &NSView = &zoom;

        let Some(close_super) = close_view.superview() else {
            return;
        };
        let Some(title_bar_container) = close_super.superview() else {
            return;
        };

        let close_rect = close_view.frame();
        let title_bar_height = close_rect.size.height + y;
        let mut title_bar_rect = title_bar_container.frame();
        title_bar_rect.size.height = title_bar_height;
        title_bar_rect.origin.y = ns_window.frame().size.height - title_bar_height;
        title_bar_container.setFrame(title_bar_rect);

        let mini_rect = mini_view.frame();
        let space_between = mini_rect.origin.x - close_rect.origin.x;

        for (i, button) in [close_view, mini_view, zoom_view].iter().enumerate() {
            let mut rect = button.frame();
            rect.origin.x = x + (i as f64 * space_between);
            button.setFrameOrigin(rect.origin);
        }
    });

    if let Err(e) = dispatch {
        tracing::warn!("traffic light inset dispatch failed: {e}");
    }
}
