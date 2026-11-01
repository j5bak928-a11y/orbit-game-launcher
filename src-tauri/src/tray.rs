//! Windows system-tray lifecycle for Orbit Launcher.
//!
//! The webview and the Rust process/session polling thread keep running while
//! the main window is hidden. Only the explicit "Quit Orbit" menu item exits.
//! Tauri 2 requires the "tray-icon" feature on its dependency to build this
//! module on Windows.

use std::sync::atomic::{AtomicBool, Ordering};
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
    }) {
        return Err("Orbit tray state already exists.".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn install_tray<R: Runtime>(_app: &mut App<R>) -> Result<(), String> {
    Err("Orbit system tray is currently supported on Windows only.".into())
}

/// Returns true only when the main-window close was handled by hiding it.
///
/// Call this FIRST in the existing .on_window_event closure. The caller should
/// return immediately on true, before its existing Destroyed cleanup branch.
/// A normal X-button close keeps the Rust event loop and playtime polling alive.
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
        // Leave closing behavior intact if the native hide call failed.
        eprintln!("Orbit tray: cannot hide window on close: {error}");
        return false;
    }
    api.prevent_close();
    true
}

/// Hide the main window when Performance Guard is enabled and at least one
/// game is running. The launcher process and playtime tracking remain active.
///
/// Pass the current settings flag and running-session status from lib.rs:
/// tray::hide_for_performance_guard(app, guard_enabled, has_running_games).
/// Returns true if Orbit actually hid the main window.
pub fn hide_for_performance_guard<R: Runtime>(
    app: &AppHandle<R>,
    guard_enabled: bool,
    has_running_games: bool,
) -> Result<bool, String> {
    if !guard_enabled || !has_running_games {
        return Ok(false);
    }
    let Some(state) = app.try_state::<TrayState>() else {
        // If tray creation failed, do not hide an unrecoverable window.
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
    Ok(true)
}

/// Used by both the menu and primary tray click. Does not recreate the window,
/// which would lose frontend state and potentially interrupt active sessions.
pub fn open_orbit<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app
        .try_state::<TrayState>()
        .is_some_and(|state| state.quitting.load(Ordering::SeqCst))
    {
        return Err("Orbit is shutting down.".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Orbit main window is unavailable.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}
