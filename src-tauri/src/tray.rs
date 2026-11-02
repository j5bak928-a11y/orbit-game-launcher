//! Windows system-tray lifecycle for Orbit Launcher.
//!
//! Closing the window releases WebView2 and its GPU/renderer processes. The
//! native tray, SQLite database, and Rust game-tracking thread remain alive.
//! Reopening creates a fresh webview with the same application configuration.
//! Tauri 2 requires the "tray-icon" feature on its dependency to build this
//! module on Windows.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
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
    closing: AtomicBool,
    opening: AtomicBool,
    reopen_requested: AtomicBool,
    placement: Mutex<Option<WindowPlacement>>,
}

struct WindowPlacement {
    size: tauri::PhysicalSize<u32>,
    position: tauri::PhysicalPosition<i32>,
    maximized: bool,
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
        closing: AtomicBool::new(false),
        opening: AtomicBool::new(false),
        reopen_requested: AtomicBool::new(false),
        placement: Mutex::new(None),
    }) {
        return Err("Orbit tray state already exists.".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn install_tray<R: Runtime>(_app: &mut App<R>) -> Result<(), String> {
    Err("Orbit system tray is currently supported on Windows only.".into())
}

/// Returns true only when the main-window close was handled by the tray.
///
/// Call this FIRST in the existing .on_window_event closure. The caller should
/// A normal X-button close destroys WebView2 without stopping native tracking.
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

    let app = window.app_handle();
    let Some(webview) = app.get_webview_window("main") else {
        return false;
    };
    match release_webview_to_tray(app, webview) {
        Ok(()) => {
            api.prevent_close();
            true
        }
        Err(error) => {
            eprintln!("Orbit tray: cannot release WebView2: {error}");
            false
        }
    }
}

/// Hide first to avoid rendering while teardown is queued, then release the
/// actual native window/webview on another thread. Calling Webview2 creation
/// synchronously inside a Tauri window/tray event handler can deadlock Windows.
fn release_webview_to_tray<R: Runtime>(
    app: &AppHandle<R>,
    webview: tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let state = app
        .try_state::<TrayState>()
        .ok_or("Orbit tray is unavailable.")?;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("Orbit is shutting down.".into());
    }
    if state.closing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    if let (Ok(size), Ok(position), Ok(maximized)) = (
        webview.inner_size(),
        webview.outer_position(),
        webview.is_maximized(),
    ) {
        if let Ok(mut placement) = state.placement.lock() {
            *placement = Some(WindowPlacement {
                size,
                position,
                maximized,
            });
        }
    }
    if let Err(error) = webview.hide() {
        state.closing.store(false, Ordering::SeqCst);
        return Err(error.to_string());
    }

    let handle = app.clone();
    thread::spawn(move || {
        if let Err(error) = webview.destroy() {
            eprintln!("Orbit tray: failed to destroy WebView2 window: {error}");
            // Leave the existing native window recoverable from the tray.
        }
        // Tauri can complete native-window removal asynchronously. Do not
        // reuse the reserved "main" label until the previous window is gone.
        for _ in 0..200 {
            if handle.get_webview_window("main").is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let state = handle.state::<TrayState>();
        state.closing.store(false, Ordering::SeqCst);
        if state.reopen_requested.swap(false, Ordering::SeqCst)
            && !state.quitting.load(Ordering::SeqCst)
        {
            if let Err(error) = open_orbit(&handle) {
                eprintln!("Orbit tray: cannot reopen requested window: {error}");
            }
        }
    });
    Ok(())
}

/// Release the main WebView2 window when Performance Guard is enabled and a
/// game is running. Rust tracking and the tray continue to run independently.
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
    release_webview_to_tray(app, window)?;
    Ok(true)
}

/// Used by the tray menu and left click. A recreated UI bootstraps its state
/// from SQLite; in-progress native sessions are not affected.
pub fn open_orbit<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<TrayState>()
        .ok_or("Orbit tray is unavailable.")?;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("Orbit is shutting down.".into());
    }
    if state.closing.load(Ordering::SeqCst) {
        state.reopen_requested.store(true, Ordering::SeqCst);
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    if state.opening.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let handle = app.clone();
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let config = handle
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .ok_or("Orbit main window configuration is missing.")?;
            let window = tauri::WebviewWindowBuilder::from_config(&handle, config)
                .map_err(|error| error.to_string())?
                .visible(false)
                .build()
                .map_err(|error| error.to_string())?;
            if handle.state::<TrayState>().quitting.load(Ordering::SeqCst) {
                let _ = window.destroy();
                return Ok(());
            }
            if let Ok(placement) = handle.state::<TrayState>().placement.lock() {
                if let Some(placement) = placement.as_ref() {
                    let _ = window.set_size(tauri::Size::Physical(placement.size));
                    // A disconnected monitor may invalidate the last position.
                    // Keep the window on a connected display when reopening.
                    let x = f64::from(placement.position.x) + 120.0;
                    let y = f64::from(placement.position.y) + 100.0;
                    if window.monitor_from_point(x, y).ok().flatten().is_some() {
                        let _ = window.set_position(tauri::Position::Physical(placement.position));
                    } else {
                        let _ = window.center();
                    }
                    if placement.maximized {
                        let _ = window.maximize();
                    }
                }
            }
            window.show().map_err(|error| error.to_string())?;
            window.unminimize().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            Ok(())
        })();
        handle
            .state::<TrayState>()
            .opening
            .store(false, Ordering::SeqCst);
        if let Err(error) = result {
            // Leave the tray responsive. A later click can retry creation.
            eprintln!("Orbit tray: cannot recreate WebView2: {error}");
        }
    });
    Ok(())
}

/// Last-window destruction asks Tauri to exit. Only explicit Quit Orbit should
/// permit that; background game tracking must survive with zero UI windows.
pub fn should_keep_running<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<TrayState>()
        .is_some_and(|state| !state.quitting.load(Ordering::SeqCst))
}
