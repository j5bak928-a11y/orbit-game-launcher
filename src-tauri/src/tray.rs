//! Windows system-tray lifecycle for Orbit Launcher.
//!
//! Closing the window releases WebView2 and its GPU/renderer processes. The
//! native tray, SQLite database, and Rust game-tracking thread remain alive.
//! Reopening creates a fresh webview with the same application configuration.
//! Tauri 2 requires the "tray-icon" feature on its dependency to build this
//! module on Windows.

#[cfg(target_os = "windows")]
use std::sync::{atomic::AtomicU64, OnceLock};
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
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(target_os = "windows")]
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "windows")]
const LAUNCH_PREFIX: &str = "orbit-tray-launch:";

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
    #[cfg(target_os = "windows")]
    menu_refresh_queued: AtomicBool,
    #[cfg(target_os = "windows")]
    menu_refresh_dirty: AtomicBool,
    #[cfg(target_os = "windows")]
    menu_generation: AtomicU64,
    #[cfg(target_os = "windows")]
    menu_key: Mutex<String>,
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
pub fn install_tray(app: &mut App) -> Result<(), String> {
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
        .tooltip("Orbit Launcher")
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
            menu_id => {
                let Some(id) = menu_id.strip_prefix(LAUNCH_PREFIX) else {
                    return;
                };
                if app
                    .try_state::<TrayState>()
                    .is_some_and(|state| state.quitting.load(Ordering::SeqCst))
                {
                    return;
                }
                let id = id.to_string();
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = crate::launch_game(&app, &id) {
                        app.dialog()
                            .message(error)
                            .title("Orbit Launcher")
                            .show(|_| {});
                    }
                });
            }
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
        menu_refresh_queued: AtomicBool::new(false),
        menu_refresh_dirty: AtomicBool::new(false),
        menu_generation: AtomicU64::new(0),
        menu_key: Mutex::new(String::new()),
    }) {
        return Err("Orbit tray state already exists.".into());
    }
    request_menu_refresh(app.handle());
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn install_tray<R: Runtime>(_app: &mut App<R>) -> Result<(), String> {
    Err("Orbit system tray is currently supported on Windows only.".into())
}

#[cfg(target_os = "windows")]
pub fn request_menu_refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    if state.quitting.load(Ordering::SeqCst) {
        return;
    }
    state.menu_generation.fetch_add(1, Ordering::SeqCst);
    state.menu_refresh_dirty.store(true, Ordering::SeqCst);
    if state.menu_refresh_queued.swap(true, Ordering::SeqCst) {
        return;
    }

    let menu_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || loop {
        let state = menu_app.state::<TrayState>();
        while state.menu_refresh_dirty.swap(false, Ordering::SeqCst)
            && !state.quitting.load(Ordering::SeqCst)
        {
            let generation = state.menu_generation.load(Ordering::SeqCst);
            match prepare_menu_snapshot(&menu_app, &state) {
                Ok(Some((key, language, games))) => {
                    let apply_app = menu_app.clone();
                    if let Err(error) = menu_app.run_on_main_thread(move || {
                        let state = apply_app.state::<TrayState>();
                        if state.quitting.load(Ordering::SeqCst)
                            || state.menu_generation.load(Ordering::SeqCst) != generation
                        {
                            return;
                        }
                        if let Err(error) =
                            apply_menu_snapshot(&apply_app, &state, key, language, games)
                        {
                            eprintln!("Orbit tray: cannot refresh menu: {error}");
                        }
                    }) {
                        eprintln!("Orbit tray: cannot schedule menu refresh: {error}");
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("Orbit tray: cannot read menu state: {error}"),
            }
        }
        state.menu_refresh_queued.store(false, Ordering::SeqCst);
        if !state.menu_refresh_dirty.load(Ordering::SeqCst)
            || state.quitting.load(Ordering::SeqCst)
            || state.menu_refresh_queued.swap(true, Ordering::SeqCst)
        {
            break;
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn request_menu_refresh(_app: &AppHandle) {}

#[cfg(target_os = "windows")]
fn windows_language() -> Option<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultLocaleName(name: *mut u16, name_len: i32) -> i32;
    }
    // LOCALE_NAME_MAX_LENGTH includes the trailing terminator.
    let mut name = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
    if (2..=85).contains(&len) {
        String::from_utf16(&name[..len as usize - 1]).ok()
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn native_label(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    // Win32 treats one ampersand as a mnemonic rather than display text.
    cleaned.replace('&', "&&")
}

#[cfg(target_os = "windows")]
fn tray_translations() -> Result<&'static serde_json::Value, String> {
    static TRANSLATIONS: OnceLock<Result<serde_json::Value, String>> = OnceLock::new();
    match TRANSLATIONS.get_or_init(|| {
        serde_json::from_str(include_str!("../tray-labels.json")).map_err(|e| e.to_string())
    }) {
        Ok(value) => Ok(value),
        Err(error) => Err(error.clone()),
    }
}

#[cfg(target_os = "windows")]
fn prepare_menu_snapshot(
    app: &AppHandle,
    state: &TrayState,
) -> Result<Option<(String, String, serde_json::Value)>, String> {
    let orbit = app.state::<crate::OrbitState>();
    // Drop active before acquiring the SQLite lock. Launch/poll can need both.
    let active_ids: Vec<String> = orbit
        .active
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .map(|(session_id, _)| session_id.clone())
        .collect();
    let (games, mut language) = {
        let db = orbit.db.lock().map_err(|e| e.to_string())?;
        (
            db.tray_games(&active_ids)?,
            db.get_settings()?["language"]
                .as_str()
                .unwrap_or("en")
                .to_string(),
        )
    };
    if language == "system" {
        language = windows_language().unwrap_or_else(|| "en".into());
    }
    let language = language
        .split('-')
        .next()
        .unwrap_or("en")
        .to_ascii_lowercase();
    let key = format!("{language}/{games}");
    let previous = state.menu_key.lock().map_err(|e| e.to_string())?;
    if *previous == key {
        return Ok(None);
    }
    Ok(Some((key, language, games)))
}

#[cfg(target_os = "windows")]
fn apply_menu_snapshot(
    app: &AppHandle,
    state: &TrayState,
    key: String,
    language: String,
    games: serde_json::Value,
) -> Result<(), String> {
    let mut previous = state.menu_key.lock().map_err(|e| e.to_string())?;
    if *previous == key {
        return Ok(());
    }
    let translations = tray_translations()?;
    let labels = translations
        .get(language.as_str())
        .unwrap_or(&translations["en"]);
    let label = |key: &str| labels[key].as_str().unwrap_or("");
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    let open = MenuItem::with_id(app, OPEN_ID, label("open"), true, None::<&str>)
        .map_err(|e| e.to_string())?;
    menu.append(&open).map_err(|e| e.to_string())?;

    let active = games["active"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if active.is_empty() {
        let idle = MenuItem::new(app, label("inactive"), false, None::<&str>)
            .map_err(|e| e.to_string())?;
        menu.append(&idle).map_err(|e| e.to_string())?;
    }
    for game in active {
        let name = game["name"].as_str().unwrap_or("");
        let time = game["started_at"]
            .as_str()
            .and_then(|start| chrono::DateTime::parse_from_rfc3339(start).ok());
        let text = if let Some(time) = time {
            let local = time
                .with_timezone(&chrono::Local)
                .format("%d/%m %H:%M")
                .to_string();
            format!("{name} · {}", label("tracking").replace("{time}", &local))
        } else {
            name.into()
        };
        let entry = MenuItem::new(app, native_label(&text), false, None::<&str>)
            .map_err(|e| e.to_string())?;
        menu.append(&entry).map_err(|e| e.to_string())?;
    }

    for group in ["favorites", "recent"] {
        let Some(entries) = games[group]
            .as_array()
            .filter(|entries| !entries.is_empty())
        else {
            continue;
        };
        let submenu = Submenu::new(app, label(group), true).map_err(|e| e.to_string())?;
        for game in entries {
            let id = game["id"].as_str().unwrap_or("");
            let name = game["name"].as_str().unwrap_or("");
            let enabled = !active.iter().any(|entry| entry["id"] == id);
            let entry = MenuItem::with_id(
                app,
                format!("{LAUNCH_PREFIX}{id}"),
                native_label(name),
                enabled,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            submenu.append(&entry).map_err(|e| e.to_string())?;
        }
        menu.append(&submenu).map_err(|e| e.to_string())?;
    }
    let separator = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, QUIT_ID, label("quit"), true, None::<&str>)
        .map_err(|e| e.to_string())?;
    menu.append_items(&[&separator, &quit])
        .map_err(|e| e.to_string())?;
    app.tray_by_id(TRAY_ID)
        .ok_or("Orbit tray is unavailable.")?
        .set_menu(Some(menu))
        .map_err(|e| e.to_string())?;
    *previous = key;
    Ok(())
}

/// Returns true only when the main-window close was handled by the tray.
///
/// Call this FIRST in the existing .on_window_event closure. The caller should
/// A normal X-button close destroys WebView2 without stopping native tracking.
pub fn handle_window_event(window: &Window, event: &WindowEvent) -> bool {
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
fn release_webview_to_tray(app: &AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    let state = app
        .try_state::<TrayState>()
        .ok_or("Orbit tray is unavailable.")?;
    if state.quitting.load(Ordering::SeqCst) {
        return Err("Orbit is shutting down.".into());
    }
    if state.closing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    if !webview.is_minimized().unwrap_or(false) && !webview.is_fullscreen().unwrap_or(false) {
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
pub fn hide_for_performance_guard(
    app: &AppHandle,
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
pub fn open_orbit(app: &AppHandle) -> Result<(), String> {
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
        crate::updates::maybe_check_on_reopen(app);
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
            crate::sync_saved_window_theme(&handle);
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
            crate::updates::maybe_check_on_reopen(&handle);
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

pub fn set_quitting<R: Runtime>(app: &AppHandle<R>, quitting: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.quitting.store(quitting, Ordering::SeqCst);
    }
}
