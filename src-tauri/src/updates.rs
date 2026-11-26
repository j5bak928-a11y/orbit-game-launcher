use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(4);
const PROGRESS_EMIT_STEP_BYTES: u64 = 512 * 1024;

pub(crate) const MSG_IDLE: &str = "Ready to check for updates.";
pub(crate) const MSG_CHECKING: &str = "Checking for updates…";
pub(crate) const MSG_UP_TO_DATE: &str = "Orbit Launcher is up to date.";
pub(crate) const MSG_DOWNLOADING: &str = "Downloading verified update…";
pub(crate) const MSG_READY: &str = "Update downloaded and verified. Ready to install.";
pub(crate) const MSG_INSTALLING: &str = "Installing verified update…";
pub(crate) const MSG_UNREACHABLE: &str = "Could not reach the update server.";
pub(crate) const MSG_BAD_MANIFEST: &str = "Update feed response could not be read.";
pub(crate) const MSG_BAD_SIGNATURE: &str = "Downloaded update failed signature verification.";
pub(crate) const MSG_INSTALL_FAILED: &str = "Could not install update.";
pub(crate) const MSG_BUSY_GAME: &str = "Finish running games before installing an update.";
pub(crate) const MSG_NO_PREPARED: &str = "No verified update is ready to install.";
pub(crate) const MSG_CHECK_FAILED: &str = "Could not check for updates right now.";
pub(crate) const MSG_IN_PROGRESS: &str = "An update check is already in progress.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateStatusSnapshot {
    pub state: &'static str,
    pub message: &'static str,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
    pub progress_percent: Option<u8>,
}

impl UpdateStatusSnapshot {
    fn idle() -> Self {
        Self {
            state: "idle",
            message: MSG_IDLE,
            version: None,
            notes: None,
            downloaded: None,
            total: None,
            progress_percent: None,
        }
    }

    fn checking() -> Self {
        Self {
            state: "checking",
            message: MSG_CHECKING,
            version: None,
            notes: None,
            downloaded: None,
            total: None,
            progress_percent: None,
        }
    }

    fn up_to_date() -> Self {
        Self {
            state: "up-to-date",
            message: MSG_UP_TO_DATE,
            version: None,
            notes: None,
            downloaded: None,
            total: None,
            progress_percent: None,
        }
    }

    fn downloading(
        version: &str,
        downloaded: u64,
        total: Option<u64>,
        progress_percent: Option<u8>,
    ) -> Self {
        Self {
            state: "downloading",
            message: MSG_DOWNLOADING,
            version: Some(version.to_string()),
            notes: None,
            downloaded: Some(downloaded),
            total,
            progress_percent,
        }
    }

    fn ready(version: &str, notes: Option<&str>, byte_len: u64) -> Self {
        Self {
            state: "ready",
            message: MSG_READY,
            version: Some(version.to_string()),
            notes: notes.map(str::to_string),
            downloaded: Some(byte_len),
            total: Some(byte_len),
            progress_percent: Some(100),
        }
    }

    fn installing(version: &str) -> Self {
        Self {
            state: "installing",
            message: MSG_INSTALLING,
            version: Some(version.to_string()),
            notes: None,
            downloaded: None,
            total: None,
            progress_percent: Some(100),
        }
    }

    fn error(message: &'static str) -> Self {
        Self {
            state: "error",
            message,
            version: None,
            notes: None,
            downloaded: None,
            total: None,
            progress_percent: None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "state": self.state,
            "message": self.message,
            "version": self.version,
            "notes": self.notes,
            "downloaded": self.downloaded,
            "total": self.total,
            "progressPercent": self.progress_percent,
        })
    }
}

struct PreparedUpdate {
    update: Update,
    bytes: Vec<u8>,
}

struct UpdateInner {
    in_flight: bool,
    status: UpdateStatusSnapshot,
    prepared: Option<PreparedUpdate>,
}

/// Coordinates background update checks, Minisign-verified downloads, and safe installs.
#[derive(Clone)]
pub struct UpdateManager {
    inner: Arc<Mutex<UpdateInner>>,
}

impl UpdateManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(UpdateInner {
                in_flight: false,
                status: UpdateStatusSnapshot::idle(),
                prepared: None,
            })),
        }
    }
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Returns the latest serialized updater state for UI initialization.
pub fn current_status(app: &AppHandle) -> Value {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return UpdateStatusSnapshot::idle().to_json();
    };
    let Ok(inner) = manager.inner.lock() else {
        return UpdateStatusSnapshot::error(MSG_CHECK_FAILED).to_json();
    };
    inner.status.to_json()
}

/// Runs a single delayed startup update check when `autoUpdates` is enabled.
pub fn maybe_start_background_check(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_CHECK_DELAY);
        if crate::auto_updates_enabled(&handle) {
            let _ = start_check(&handle);
        }
    });
}

/// Starts a background check-and-download cycle if one is not already active.
pub fn start_check(app: &AppHandle) -> Value {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return UpdateStatusSnapshot::error(MSG_CHECK_FAILED).to_json();
    };
    let snapshot = {
        let Ok(mut inner) = manager.inner.lock() else {
            return UpdateStatusSnapshot::error(MSG_CHECK_FAILED).to_json();
        };
        if inner.in_flight {
            return inner.status.to_json();
        }
        inner.in_flight = true;
        inner.status = UpdateStatusSnapshot::checking();
        inner.status.to_json()
    };
    emit_status(app, &snapshot);

    let handle = app.clone();
    std::thread::spawn(move || run_check_and_download(&handle));
    snapshot
}

/// Verifies and installs the prepared update once no games are launching or active.
pub fn install_prepared(app: &AppHandle) -> Result<(), String> {
    if crate::has_busy_game(app) {
        return Err(MSG_BUSY_GAME.to_string());
    }
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return Err(MSG_INSTALL_FAILED.to_string());
    };
    let (prepared, previous_status) = {
        let Ok(mut inner) = manager.inner.lock() else {
            return Err(MSG_INSTALL_FAILED.to_string());
        };
        if inner.in_flight {
            return Err(MSG_IN_PROGRESS.to_string());
        }
        let Some(prepared) = inner.prepared.take() else {
            return Err(MSG_NO_PREPARED.to_string());
        };
        let previous = inner.status.clone();
        inner.in_flight = true;
        inner.status = UpdateStatusSnapshot::installing(&prepared.update.version);
        (prepared, previous)
    };
    emit_snapshot(
        app,
        &UpdateStatusSnapshot::installing(&prepared.update.version),
    );

    if let Err(err) = prepared.update.verify(&prepared.bytes) {
        rollback_failed_install(app, None, previous_status, false);
        let msg = classify_download_error(&err);
        set_and_emit(app, UpdateStatusSnapshot::error(msg));
        return Err(msg.to_string());
    }

    if crate::has_busy_game(app) {
        rollback_failed_install(app, Some(prepared), previous_status, true);
        return Err(MSG_BUSY_GAME.to_string());
    }

    crate::settle_sessions(app);
    crate::tray::set_quitting(app, true);

    match prepared.update.install(&prepared.bytes) {
        Ok(()) => {
            #[cfg(not(windows))]
            app.restart();
            Ok(())
        }
        Err(err) => {
            crate::tray::set_quitting(app, false);
            let keep_prepared = !is_signature_error(&err);
            let msg = classify_install_error(&err);
            rollback_failed_install(
                app,
                keep_prepared.then_some(prepared),
                previous_status,
                false,
            );
            set_and_emit(app, UpdateStatusSnapshot::error(msg));
            Err(msg.to_string())
        }
    }
}

fn rollback_failed_install(
    app: &AppHandle,
    prepared: Option<PreparedUpdate>,
    previous_status: UpdateStatusSnapshot,
    restore_status: bool,
) {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return;
    };
    let emitted = {
        let Ok(mut inner) = manager.inner.lock() else {
            return;
        };
        inner.in_flight = false;
        if let Some(item) = prepared {
            inner.prepared = Some(item);
        }
        if restore_status {
            inner.status = previous_status;
            Some(inner.status.to_json())
        } else {
            None
        }
    };
    if let Some(snapshot) = emitted {
        emit_status(app, &snapshot);
    }
}

fn run_check_and_download(app: &AppHandle) {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return;
    };
    let update = match check_for_update(app) {
        Ok(Some(update)) => update,
        Ok(None) => {
            clear_prepared_and_finish(app, UpdateStatusSnapshot::up_to_date());
            return;
        }
        Err(msg) => {
            finish_with_status(app, UpdateStatusSnapshot::error(msg));
            return;
        }
    };

    if reuse_prepared_if_matching(app, &update) {
        return;
    }

    let version = update.version.clone();
    let notes = update.body.clone();
    set_and_emit(
        app,
        UpdateStatusSnapshot::downloading(&version, 0, None, Some(0)),
    );

    let mut downloaded_bytes: u64 = 0;
    let mut last_percent: Option<u8> = None;
    let mut last_bytes: u64 = 0;
    let download_result = tauri::async_runtime::block_on(update.download(
        |chunk_len, total| {
            downloaded_bytes = downloaded_bytes.saturating_add(chunk_len as u64);
            let percent = compute_progress_percent(downloaded_bytes, total);
            let should_emit = match (percent, last_percent) {
                (Some(p), Some(prev)) => p >= prev.saturating_add(2),
                (Some(_), None) => true,
                (None, _) => {
                    downloaded_bytes.saturating_sub(last_bytes) >= PROGRESS_EMIT_STEP_BYTES
                }
            };
            if should_emit {
                last_percent = percent;
                last_bytes = downloaded_bytes;
                set_and_emit(
                    app,
                    UpdateStatusSnapshot::downloading(&version, downloaded_bytes, total, percent),
                );
            }
        },
        || {},
    ));

    match download_result {
        Ok(bytes) => {
            let byte_len = bytes.len() as u64;
            let ready = UpdateStatusSnapshot::ready(&version, notes.as_deref(), byte_len);
            let snapshot = {
                let Ok(mut inner) = manager.inner.lock() else {
                    return;
                };
                inner.prepared = Some(PreparedUpdate { update, bytes });
                inner.in_flight = false;
                inner.status = ready;
                inner.status.to_json()
            };
            emit_status(app, &snapshot);
        }
        Err(err) => {
            let msg = classify_download_error(&err);
            clear_prepared_and_finish(app, UpdateStatusSnapshot::error(msg));
        }
    }
}

fn reuse_prepared_if_matching(app: &AppHandle, announced: &Update) -> bool {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return false;
    };
    let emitted = {
        let Ok(mut inner) = manager.inner.lock() else {
            return false;
        };
        let ready = {
            let Some(prepared) = inner.prepared.as_ref() else {
                return false;
            };
            if prepared.update.version != announced.version
                || prepared.update.verify(&prepared.bytes).is_err()
            {
                return false;
            }
            UpdateStatusSnapshot::ready(
                &prepared.update.version,
                prepared.update.body.as_deref(),
                prepared.bytes.len() as u64,
            )
        };
        inner.in_flight = false;
        inner.status = ready;
        inner.status.to_json()
    };
    emit_status(app, &emitted);
    true
}

fn check_for_update(app: &AppHandle) -> Result<Option<Update>, &'static str> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|_| MSG_CHECK_FAILED)?;
    tauri::async_runtime::block_on(updater.check()).map_err(|err| classify_check_error(&err))
}

fn compute_progress_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|&value| value > 0)?;
    let pct = downloaded.saturating_mul(100) / total;
    Some(pct.min(100) as u8)
}

fn is_signature_error(err: &UpdaterError) -> bool {
    matches!(
        err,
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_)
    ) || err.to_string().contains("signed version")
}

fn classify_check_error(err: &UpdaterError) -> &'static str {
    if is_signature_error(err) {
        return MSG_BAD_SIGNATURE;
    }
    match err {
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) | UpdaterError::ReleaseNotFound => {
            MSG_UNREACHABLE
        }
        UpdaterError::Serialization(_)
        | UpdaterError::UrlParse(_)
        | UpdaterError::Semver(_)
        | UpdaterError::TargetNotFound(_)
        | UpdaterError::TargetsNotFound(_) => MSG_BAD_MANIFEST,
        _ => MSG_CHECK_FAILED,
    }
}

fn classify_download_error(err: &UpdaterError) -> &'static str {
    if is_signature_error(err) {
        return MSG_BAD_SIGNATURE;
    }
    match err {
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => MSG_UNREACHABLE,
        _ => MSG_CHECK_FAILED,
    }
}

fn classify_install_error(err: &UpdaterError) -> &'static str {
    if is_signature_error(err) {
        MSG_BAD_SIGNATURE
    } else {
        MSG_INSTALL_FAILED
    }
}

fn clear_prepared_and_finish(app: &AppHandle, status: UpdateStatusSnapshot) {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return;
    };
    let snapshot = {
        let Ok(mut inner) = manager.inner.lock() else {
            return;
        };
        inner.prepared = None;
        inner.in_flight = false;
        inner.status = status;
        inner.status.to_json()
    };
    emit_status(app, &snapshot);
}

fn finish_with_status(app: &AppHandle, status: UpdateStatusSnapshot) {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return;
    };
    let snapshot = {
        let Ok(mut inner) = manager.inner.lock() else {
            return;
        };
        inner.in_flight = false;
        inner.status = status;
        inner.status.to_json()
    };
    emit_status(app, &snapshot);
}

fn set_and_emit(app: &AppHandle, status: UpdateStatusSnapshot) {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return;
    };
    let snapshot = {
        let Ok(mut inner) = manager.inner.lock() else {
            return;
        };
        inner.status = status;
        inner.status.to_json()
    };
    emit_status(app, &snapshot);
}

fn emit_snapshot(app: &AppHandle, status: &UpdateStatusSnapshot) {
    emit_status(app, &status.to_json());
}

fn emit_status(app: &AppHandle, snapshot: &Value) {
    crate::emit(app, json!({"type": "updateStatus", "status": snapshot}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_progress_percent_handles_bounds_and_unknown_total() {
        assert_eq!(compute_progress_percent(500, None), None);
        assert_eq!(compute_progress_percent(500, Some(0)), None);
        assert_eq!(compute_progress_percent(0, Some(1000)), Some(0));
        assert_eq!(compute_progress_percent(250, Some(1000)), Some(25));
        assert_eq!(compute_progress_percent(1500, Some(1000)), Some(100));
    }

    #[test]
    fn classify_errors_sanitizes_network_manifest_and_signature_failures() {
        assert_eq!(
            classify_check_error(&UpdaterError::ReleaseNotFound),
            MSG_UNREACHABLE
        );
        assert_eq!(
            classify_check_error(&UpdaterError::TargetNotFound("windows-x86_64".into())),
            MSG_BAD_MANIFEST
        );
        assert_eq!(
            classify_download_error(&UpdaterError::SignatureUtf8("bad".into())),
            MSG_BAD_SIGNATURE
        );
        assert_eq!(
            classify_install_error(&UpdaterError::SignatureUtf8("bad".into())),
            MSG_BAD_SIGNATURE
        );
        assert_eq!(
            classify_install_error(&UpdaterError::TempDirNotFound),
            MSG_INSTALL_FAILED
        );
    }
}
