//! macOS title-bar chrome helpers.
//!
//! Tauri 2's `trafficLightPosition` config maps to tao's
//! `with_traffic_light_inset`, which hooks `drawRect:` on the root content
//! view to re-position the close/minimize/zoom cluster on every redraw.
//! The catch: tao only mutates the buttons' *X* origin and resizes the
//! title-bar container; the *Y* origin is left at whatever AppKit picked
//! during the initial layout pass. That initial Y differs between a
//! bundled `.app` (the GitHub release) and an unbundled `cargo run` (the
//! `pnpm tauri dev` shell), so the same `trafficLightPosition: { y: 26 }`
//! config produces visibly different vertical positions.
//!
//! Our `apply_traffic_light_inset` re-resizes the title-bar container the
//! same way tao does, then explicitly *centers* the three buttons inside
//! it - removing the dependency on AppKit's initial Y. tao's drawRect hook
//! preserves the Y we set on subsequent redraws (its loop only writes
//! `origin.x`), so once we've nailed Y down it stays.
//!
//! Called from `setup` after `apply_vibrancy` (the visual-effect view
//! insertion is one of the things that perturbs the initial Y), and from
//! `lib.rs` on `Resized` / `ThemeChanged` (window-state restoration and
//! the first dark-mode probe both kick the title-bar container around).

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

        // Resize the title-bar container so it's `close.height + y` tall,
        // anchored to the top of the window. NSWindow uses bottom-left
        // origin, so a container whose top touches the window top has
        // `origin.y = window.height - container.height`.
        let close_rect = close_view.frame();
        let button_height = close_rect.size.height;
        let title_bar_height = button_height + y;
        let window_height = ns_window.frame().size.height;
        let mut title_bar_rect = title_bar_container.frame();
        title_bar_rect.size.height = title_bar_height;
        title_bar_rect.origin.y = window_height - title_bar_height;
        title_bar_container.setFrame(title_bar_rect);

        // X spacing: keep the same gap between buttons that AppKit's
        // initial layout chose. The first run captures the system value;
        // subsequent runs are idempotent (mini.x - close.x stays
        // `space_between` once we've set them).
        let mini_rect = mini_view.frame();
        let space_between = mini_rect.origin.x - close_rect.origin.x;

        // Y position: vertically center the buttons inside the resized
        // title-bar container. With container height = button.h + y, the
        // visual center of the cluster lands at y/2 + button.h/2 below the
        // window top - independent of whatever Y AppKit stamped on the
        // buttons during the initial layout pass. With y=26 and the
        // standard 14px button, that puts the cluster center at ~20px
        // below the top, which matches the dev build's appearance.
        let button_y = title_bar_rect.origin.y + (title_bar_height - button_height) / 2.0;

        for (i, button) in [close_view, mini_view, zoom_view].iter().enumerate() {
            let mut origin = button.frame().origin;
            origin.x = x + (i as f64 * space_between);
            origin.y = button_y;
            button.setFrameOrigin(origin);
        }
    });

    if let Err(e) = dispatch {
        tracing::warn!("traffic light inset dispatch failed: {e}");
    }
}
