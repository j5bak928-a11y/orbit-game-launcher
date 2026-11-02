//! Windows system-tray lifecycle for Orbit Launcher.
//!
//! Closing to tray releases the WebView2 window and its renderer/GPU resources.
//! The Rust process/session polling thread keeps running until "Quit Orbit".
//! Tray reopening recreates the original UI from the packaged window config.
//! Tauri 2 requires the "tray-icon" feature on its dependency to build this
//! module on Windows.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};
use tauri::{App, AppHandle, Manager, Runtime, Window, WindowEvent};

#[cfg(target_os = "windows")]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(target_os = "windows")]
const TRAY_ID: &str = "orbit-main-tray";
#[cfg(target_os = "windows")]
const OPEN_ID: &str = "orbit-tray-open";
#[cfg(target_os = "windows")]
const QUIT_ID: &str = "orbit-tray-quit";

// Managed state provides a reliable signal that an actual tray was installed,
// and lets the close handler distinguish ordinary close from explicit quit.
pub struct TrayState {
    quitting: AtomicBool,
    // Destroy is asynchronous on Windows. Do not rebuild or reveal the old
    // WebView2 window until its label has been removed from Tauri's registry.
    retiring: AtomicBool,
    // Coalesce repeat left-clicks / Open menu actions during recreation.
    reopening: AtomicBool,
}

/// Install the Windows tray after app setup has created its main window and
/// managed database state. The caller should propagate an error on Windows:
/// hiding to a tray that failed to install would strand the application.
///
/// Integration: add mod tray; then call tray::install_tray(app) from
/// Builder::setup. See handle_window_event and hide_for_performance_guard.
#[cfg(target_os = "windows")]
pub fn install_tray<R: Runtime>(app: &mut App<R>) -> Result<(), String> {
    if app.try_state::<TrayState>().is_some() {
        return Err("Orbit tray is already installed.".into());
    }

    // The default Tauri window icon is packaged by the application. Using it
    // avoids a runtime file-path dependency on a separately bundled tray icon.
    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        "Orbit cannot create its tray: no default window icon is configured.".to_string()
    })?;

    let open = MenuItem::with_id(app, OPEN_ID, "Open Orbit", true, None::<&str>)
        .map_err(|error| format!("Cannot build Open Orbit menu item: {error}"))?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Orbit", true, None::<&str>)
        .map_err(|error| format!("Cannot build Quit Orbit menu item: {error}"))?;
    let menu = Menu::with_items(app, &[&open, &quit])
        .map_err(|error| format!("Cannot build Orbit tray menu: {error}"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Orbit — tracking playtime")
        .menu(&menu)
        // Left click restores the window; right click opens the context menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => {
                if let Err(error) = open_orbit(app) {
                    eprintln!("Orbit tray: cannot open window: {error}");
                }
            }
            QUIT_ID => {
                if let Some(state) = app.try_state::<TrayState>() {
                    // On later CloseRequested events do not intercept quit.
                    if state.quitting.swap(true, Ordering::SeqCst) {
                        return;
                    }
                }
                // This triggers RunEvent::ExitRequested and RunEvent::Exit.
                // The app's Exit hook must flush SQLite playtime sessions.
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = open_orbit(tray.app_handle()) {
                    eprintln!("Orbit tray: cannot open window: {error}");
                }
            }
        })
        .build(app)
        .map_err(|error| format!("Cannot install Orbit system tray: {error}"))?;

    // Register only after the actual native tray icon has been created.
    if !app.manage(TrayState {
        quitting: AtomicBool::new(false),
        retiring: AtomicBool::new(false),
        reopening: AtomicBool::new(false),
    }) {
        return Err("Orbit tray state already exists.".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn install_tray<R: Runtime>(_app: &mut App<R>) -> Result<(), String> {
    Err("Orbit system tray is currently supported on Windows only.".into())
}

/// The Tauri event loop normally quits when the last WebviewWindow closes.
/// Keep Orbit's Rust session tracker alive while the tray exists, but let
/// explicit Quit / restart requests exit and flush sessions.
fn should_prevent_exit(tray_exists: bool, quitting: bool, code: Option<i32>) -> bool {
    tray_exists && !quitting && code.is_none()
}

pub fn keep_background_alive<R: Runtime>(app: &AppHandle<R>, code: Option<i32>) -> bool {
    let state = app.try_state::<TrayState>();
    should_prevent_exit(
        state.is_some(),
        state
            .as_ref()
            .is_some_and(|state| state.quitting.load(Ordering::SeqCst)),
        code,
    )
}

/// Release the hidden WebView2 environment without closing Orbit's Rust
/// process. Windows dispatches native teardown asynchronously, so wait until
/// Tauri no longer owns the "main" label before permitting recreation.
/// The delay is only used by Performance Guard to let launch IPC settle.
fn retire_hidden_window<R: Runtime>(app: &AppHandle<R>, window: Window<R>, delay: Duration) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    if state.retiring.swap(true, Ordering::SeqCst) {
        return;
    }

    let handle = app.clone();
    thread::spawn(move || {
        if !delay.is_zero() {
            thread::sleep(delay);
        }
        let shutting_down = handle
            .try_state::<TrayState>()
            .is_none_or(|state| state.quitting.load(Ordering::SeqCst));
        if !shutting_down {
            if let Err(error) = window.destroy() {
                eprintln!("Orbit tray: could not release WebView2 window: {error}");
            }
            // .destroy() schedules native teardown; the registry is not
            // guaranteed to be clear immediately after it returns.
            for _ in 0..100 {
                if handle.get_webview_window("main").is_none() {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            if handle.get_webview_window("main").is_some() {
                eprintln!("Orbit tray: WebView2 teardown did not finish promptly; existing window may be reused");
            }
        }
        if let Some(state) = handle.try_state::<TrayState>() {
            state.retiring.store(false, Ordering::SeqCst);
        }
    });
}

/// Intercept close-to-tray before Tauri closes the last window. Hide first to
/// provide immediate feedback, then destroy WebView2 in a worker. The tray,
/// database and process tracker are owned by Rust and must outlive the UI.
pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) -> bool {
    if window.label() != "main" {
        return false;
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return false;
    };
    let Some(state) = window.app_handle().try_state::<TrayState>() else {
        return false;
    };
    if state.quitting.load(Ordering::SeqCst) {
        return false;
    }

    if let Err(error) = window.hide() {
        // Let the normal window-close path run rather than trapping a visible
        // window on failure. RunEvent::ExitRequested still keeps Rust alive.
        eprintln!("Orbit tray: could not hide window on close: {error}");
        return false;
    }
    api.prevent_close();
    retire_hidden_window(window.app_handle(), window.clone(), Duration::ZERO);
    true
}

/// Performance Guard used to hide Orbit but retained the whole WebView2 GPU
/// process while games ran. It now frees the UI after a short grace period so
/// the initiating launch IPC has time to return. The Rust tracker stays alive.
pub fn hide_for_performance_guard<R: Runtime>(
    app: &AppHandle<R>,
    guard_enabled: bool,
    has_running_games: bool,
) -> Result<bool, String> {
    if !guard_enabled || !has_running_games {
        return Ok(false);
    }
    let Some(state) = app.try_state::<TrayState>() else {
        return Ok(false);
    };
    if state.quitting.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let Some(window) = app.get_webview_window("main") else {
        return Ok(false);
    };
    if !window.is_visible().map_err(|error| error.to_string())? {
        return Ok(false);
    }
    window.hide().map_err(|error| error.to_string())?;
    // WebviewWindow wraps a Webview whose .window() returns the host Window.
    retire_hidden_window(app, window.as_ref().window(), Duration::from_millis(800));
    Ok(true)
}

/// Reuse the exact packaged window configuration: icon, size, background,
/// original UI assets and all Tauri permissions match the first launch.
fn show_or_create_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("Orbit's configured main window is missing")?;
    // Never build WebviewWindow from a synchronous Windows tray callback:
    // WebView2 creation can deadlock there. open_orbit spawns this worker.
    let window = tauri::WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

/// Left-click or Open Orbit brings back the launcher. While native teardown
/// is in progress, queue only one asynchronous recreation; repeated tray
/// clicks must not create duplicate windows with label "main".
pub fn open_orbit<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<TrayState>()
        .ok_or("Orbit system tray is unavailable")?;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("Orbit is shutting down.".into());
    }
    if !state.retiring.load(Ordering::SeqCst) && !state.reopening.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window("main") {
            window.show().map_err(|error| error.to_string())?;
            window.unminimize().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    if state.reopening.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let handle = app.clone();
    thread::spawn(move || {
        // Allow enough time for the previous WebView2 to disappear from the
        // runtime manager. This worker does not block the native tray loop.
        for _ in 0..120 {
            let Some(state) = handle.try_state::<TrayState>() else {
                return;
            };
            if state.quitting.load(Ordering::SeqCst) {
                state.reopening.store(false, Ordering::SeqCst);
                return;
            }
            if !state.retiring.load(Ordering::SeqCst) {
                if let Err(error) = show_or_create_window(&handle) {
                    eprintln!("Orbit tray: cannot reopen launcher UI: {error}");
                }
                state.reopening.store(false, Ordering::SeqCst);
                return;
            }
            thread::sleep(Duration::from_millis(75));
        }
        eprintln!("Orbit tray: timed out waiting for the previous WebView2 window to close");
        if let Some(state) = handle.try_state::<TrayState>() {
            state.reopening.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::should_prevent_exit;

    #[test]
    fn closing_last_webview_keeps_rust_tracking_alive() {
        assert!(should_prevent_exit(true, false, None));
        assert!(!should_prevent_exit(false, false, None));
    }

    #[test]
    fn explicit_quit_and_restart_are_never_intercepted() {
        assert!(!should_prevent_exit(true, true, None));
        assert!(!should_prevent_exit(true, false, Some(0)));
        assert!(!should_prevent_exit(true, false, Some(i32::MAX)));
    }
}
