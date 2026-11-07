//! Disposable first-run Electron -> Tauri migration regressions.
//! All paths are under a fresh temporary folder; installed APPDATA is never read.

use super::{import_legacy_library_from, snapshot_rust_library_before_upgrade, LibraryDatabase};
use rusqlite::Connection;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const GAME_ID: &str = "electron-legacy-game";
const COVER: &str = "a514ec46-a598-4e28-b1c8-008c1e4fb0b7.png";
const IMAGE: &[u8] = b"\x89PNG\r\n\x1a\nlegacy-image-data";

struct MigrationFixture {
    root: PathBuf,
    source: PathBuf,
    destination: PathBuf,
    // Keeping this open ensures the source contains committed, uncheckpointed
    // WAL frames when Tauri snapshots it. Windows can run the test the same way.
    electron: Option<Connection>,
}

impl MigrationFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("orbit-migration-fixture-{}", Uuid::new_v4()));
        let source = root.join("electron");
        let destination = root.join("tauri");
        fs::create_dir_all(&source).unwrap();
        let db = Connection::open(source.join("library.sqlite")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE games (
                 id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
                 source_id TEXT NOT NULL DEFAULT '', executable TEXT NOT NULL DEFAULT '',
                 launch_uri TEXT NOT NULL DEFAULT '', install_path TEXT NOT NULL DEFAULT '',
                 cover TEXT NOT NULL DEFAULT '', banner TEXT NOT NULL DEFAULT '',
                 genre TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                 favorite INTEGER NOT NULL DEFAULT 0, total_play_seconds INTEGER NOT NULL DEFAULT 0,
                 last_played_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                 launch_args TEXT NOT NULL DEFAULT '[]', working_dir TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE sessions (
                 id TEXT PRIMARY KEY,
                 game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                 started_at TEXT NOT NULL,
                 finished_at TEXT,
                 seconds INTEGER NOT NULL DEFAULT 0
             );",
        )
        .unwrap();
        db.execute(
            "INSERT INTO games(id,name,source,source_id,cover,favorite,total_play_seconds,last_played_at,created_at,updated_at)
             VALUES (?1,'Legacy WAL game','gog','gog-2468',?2,1,1800,'2026-10-01T10:00:00Z',
                     '2026-09-01T00:00:00Z','2026-10-01T10:00:00Z')",
            [GAME_ID, COVER],
        )
        .unwrap();
        db.execute_batch(
            "INSERT INTO settings(key,value) VALUES ('theme','\"light\"');
             INSERT INTO sessions(id,game_id,started_at,finished_at,seconds)
             VALUES ('legacy-finished','electron-legacy-game','2026-10-01T09:30:00Z',
                     '2026-10-01T10:00:00Z',1800);
             INSERT INTO sessions(id,game_id,started_at,seconds)
             VALUES ('legacy-unfinished','electron-legacy-game','2026-10-02T09:30:00Z',0);",
        )
        .unwrap();
        Self {
            root,
            source,
            destination,
            electron: Some(db),
        }
    }

    fn electron(&self) -> &Connection {
        self.electron.as_ref().unwrap()
    }

    fn add_artwork(&self) {
        fs::create_dir_all(self.source.join("artwork")).unwrap();
        fs::write(self.source.join("artwork").join(COVER), IMAGE).unwrap();
        fs::write(self.source.join("artwork").join("unsafe-name.png"), IMAGE).unwrap();
    }

    fn target_db(&self) -> PathBuf {
        self.destination.join("library.sqlite")
    }
}

impl Drop for MigrationFixture {
    fn drop(&mut self) {
        self.electron.take();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn pending_snapshot_files(destination: &Path) -> usize {
    fs::read_dir(destination)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".orbit-import-")
        })
        .count()
}

#[test]
fn first_run_snapshots_uncheckpointed_wal_and_migrates_legacy_schema_without_touching_electron() {
    let fixture = MigrationFixture::new();
    fixture.add_artwork();
    assert!(
        fixture
            .source
            .join("library.sqlite-wal")
            .metadata()
            .unwrap()
            .len()
            > 0
    );

    import_legacy_library_from(&fixture.source, &fixture.destination).unwrap();

    let snapshot = Connection::open(fixture.target_db()).unwrap();
    assert_eq!(count(&snapshot, "games"), 1);
    assert_eq!(count(&snapshot, "sessions"), 2);
    assert_eq!(count(&snapshot, "settings"), 1);
    assert_eq!(
        snapshot
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(snapshot);

    assert_eq!(
        fs::read(fixture.destination.join("artwork").join(COVER)).unwrap(),
        IMAGE
    );
    assert!(!fixture
        .destination
        .join("artwork")
        .join("unsafe-name.png")
        .exists());

    {
        let mut native = LibraryDatabase::open(fixture.target_db()).unwrap();
        assert_eq!(native.get(GAME_ID).unwrap()["name"], "Legacy WAL game");
        assert_eq!(native.get(GAME_ID).unwrap()["favorite"], true);
        assert_eq!(native.get(GAME_ID).unwrap()["total_play_seconds"], 1800);
        assert_eq!(native.get_settings().unwrap()["theme"], "light");
        assert_eq!(native.recover_interrupted_sessions().unwrap(), 1);
        assert_eq!(native.recover_interrupted_sessions().unwrap(), 0);
        assert_eq!(native.get(GAME_ID).unwrap()["total_play_seconds"], 1800);
    }

    // Native's schema migration and interrupted-session recovery never mutate
    // the original Electron database or finish Electron's live sessions.
    assert_eq!(count(fixture.electron(), "games"), 1);
    assert_eq!(count(fixture.electron(), "sessions"), 2);
    assert_eq!(
        fixture
            .electron()
            .query_row(
                "SELECT finished_at FROM sessions WHERE id='legacy-unfinished'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
        None
    );
}

#[test]
fn existing_native_profile_is_untouched_even_if_electron_library_changes() {
    let fixture = MigrationFixture::new();
    fixture.add_artwork();
    {
        let mut native = LibraryDatabase::open(fixture.target_db()).unwrap();
        assert_eq!(
            native
                .upsert(&json!({"name":"Native-only game","source":"manual"}))
                .unwrap()["added"],
            true
        );
    }
    fs::create_dir_all(fixture.destination.join("artwork")).unwrap();
    fs::write(
        fixture.destination.join("artwork").join(COVER),
        b"native-original",
    )
    .unwrap();

    import_legacy_library_from(&fixture.source, &fixture.destination).unwrap();
    fixture
        .electron()
        .execute(
            "UPDATE games SET name='New Electron name' WHERE id=?1",
            [GAME_ID],
        )
        .unwrap();
    import_legacy_library_from(&fixture.source, &fixture.destination).unwrap();

    let native = LibraryDatabase::open(fixture.target_db()).unwrap();
    assert_eq!(native.count().unwrap(), 1);
    assert!(native.get(GAME_ID).unwrap().is_null());
    assert_eq!(
        fs::read(fixture.destination.join("artwork").join(COVER)).unwrap(),
        b"native-original"
    );
    assert_eq!(count(fixture.electron(), "games"), 1);
}

#[test]
fn empty_native_database_file_cannot_silently_hide_the_existing_electron_library() {
    let fixture = MigrationFixture::new();
    fs::create_dir_all(&fixture.destination).unwrap();
    // An interrupted first run can leave a zero-byte file before useful data
    // is committed. Simply checking Path::exists treats that as a real profile.
    fs::write(fixture.target_db(), b"").unwrap();

    let result = import_legacy_library_from(&fixture.source, &fixture.destination);
    assert!(
        result.is_err(),
        "an empty existing native DB must fail loudly instead of hiding the Electron library"
    );
    assert_eq!(fs::metadata(fixture.target_db()).unwrap().len(), 0);
    assert_eq!(count(fixture.electron(), "games"), 1);
    assert_eq!(count(fixture.electron(), "sessions"), 2);
}

#[test]
fn failed_artwork_directory_copy_is_retryable_without_orphaned_snapshots() {
    let fixture = MigrationFixture::new();
    fixture.add_artwork();
    fs::create_dir_all(&fixture.destination).unwrap();
    fs::write(fixture.destination.join("artwork"), b"directory-blocker").unwrap();

    assert!(import_legacy_library_from(&fixture.source, &fixture.destination).is_err());
    assert!(!fixture.target_db().exists());
    assert_eq!(count(fixture.electron(), "sessions"), 2);
    assert_eq!(
        pending_snapshot_files(&fixture.destination),
        0,
        "a failed import must clean up its temporary SQLite snapshot"
    );

    fs::remove_file(fixture.destination.join("artwork")).unwrap();
    import_legacy_library_from(&fixture.source, &fixture.destination).unwrap();
    assert!(fixture.target_db().exists());
    assert_eq!(
        fs::read(fixture.destination.join("artwork").join(COVER)).unwrap(),
        IMAGE
    );
}

#[test]
fn existing_artwork_name_collision_cannot_silently_keep_corrupt_destination() {
    let fixture = MigrationFixture::new();
    fixture.add_artwork();
    fs::create_dir_all(fixture.destination.join("artwork")).unwrap();
    fs::write(
        fixture.destination.join("artwork").join(COVER),
        b"truncated-old-copy",
    )
    .unwrap();

    let result = import_legacy_library_from(&fixture.source, &fixture.destination);
    if result.is_ok() {
        assert_eq!(
            fs::read(fixture.destination.join("artwork").join(COVER)).unwrap(),
            IMAGE,
            "successful migration must not keep a truncated copy under an expected artwork name"
        );
    } else {
        assert!(
            !fixture.target_db().exists(),
            "failure must leave the migration retryable"
        );
    }
}

#[test]
fn retry_reuses_a_complete_artwork_copy_left_by_an_interrupted_first_import() {
    let fixture = MigrationFixture::new();
    fixture.add_artwork();
    fs::create_dir_all(fixture.destination.join("artwork")).unwrap();
    fs::write(fixture.destination.join("artwork").join(COVER), IMAGE).unwrap();

    import_legacy_library_from(&fixture.source, &fixture.destination).unwrap();
    assert_eq!(
        fs::read(fixture.destination.join("artwork").join(COVER)).unwrap(),
        IMAGE
    );
    assert!(fixture.target_db().is_file());
    assert_eq!(pending_snapshot_files(&fixture.destination), 0);
    assert_eq!(count(fixture.electron(), "games"), 1);
}

#[test]
fn oversized_referenced_artwork_does_not_silently_disappear_after_successful_import() {
    let fixture = MigrationFixture::new();
    fs::create_dir_all(fixture.source.join("artwork")).unwrap();
    fs::File::create(fixture.source.join("artwork").join(COVER))
        .unwrap()
        .set_len(15 * 1024 * 1024 + 1)
        .unwrap();

    let result = import_legacy_library_from(&fixture.source, &fixture.destination);
    if result.is_ok() {
        assert!(
            fixture.destination.join("artwork").join(COVER).is_file(),
            "successful migration must preserve referenced artwork within its supported limits"
        );
    } else {
        assert!(
            !fixture.target_db().exists(),
            "failure must leave the migration retryable"
        );
    }
}

#[test]
fn failed_snapshot_on_missing_source_never_creates_a_native_library() {
    let fixture = MigrationFixture::new();
    let missing = fixture.root.join("missing-source");
    assert!(import_legacy_library_from(&missing, &fixture.destination).is_err());
    assert!(!fixture.target_db().exists());
    assert_eq!(count(fixture.electron(), "games"), 1);
    assert_eq!(pending_snapshot_files(&fixture.destination), 0);
}

fn existing_rust_profile(fixture: &MigrationFixture) -> Connection {
    fs::create_dir_all(&fixture.destination).unwrap();
    let conn = Connection::open(fixture.target_db()).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA wal_autocheckpoint=0;
         CREATE TABLE games (id TEXT PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE sessions (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, seconds INTEGER NOT NULL);
         CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO games(id,name) VALUES ('native-1','Rust preview original');
         INSERT INTO sessions(id,game_id,seconds) VALUES ('native-session','native-1',3600);",
    )
    .unwrap();
    conn
}

#[test]
fn rust_upgrade_snapshot_includes_live_wal_and_never_overwrites_an_existing_backup() {
    let fixture = MigrationFixture::new();
    let rust = existing_rust_profile(&fixture);
    assert!(
        fixture
            .destination
            .join("library.sqlite-wal")
            .metadata()
            .unwrap()
            .len()
            > 0
    );

    assert!(snapshot_rust_library_before_upgrade(&fixture.destination).unwrap());
    let backup_file = fixture.destination.join("library.before-rust-0.2.7.sqlite");
    let copy = Connection::open(&backup_file).unwrap();
    assert_eq!(count(&copy, "games"), 1);
    assert_eq!(count(&copy, "sessions"), 1);
    assert_eq!(
        copy.query_row(
            "SELECT seconds FROM sessions WHERE id='native-session'",
            [],
            |row| { row.get::<_, i64>(0) }
        )
        .unwrap(),
        3600
    );
    assert_eq!(
        copy.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(copy);
    let backup_contents = fs::read(&backup_file).unwrap();

    rust.execute(
        "INSERT INTO games(id,name) VALUES ('native-2','Game created after backup')",
        [],
    )
    .unwrap();
    assert!(!snapshot_rust_library_before_upgrade(&fixture.destination).unwrap());
    assert_eq!(fs::read(&backup_file).unwrap(), backup_contents);
    assert_eq!(count(&rust, "games"), 2);
    let old_copy = Connection::open(&backup_file).unwrap();
    assert_eq!(count(&old_copy, "games"), 1);
}

#[test]
fn unsafe_existing_pre_upgrade_backup_must_fail_without_changing_active_library() {
    let fixture = MigrationFixture::new();
    let rust = existing_rust_profile(&fixture);
    let backup_file = fixture.destination.join("library.before-rust-0.2.7.sqlite");
    fs::create_dir_all(&backup_file).unwrap();

    assert!(snapshot_rust_library_before_upgrade(&fixture.destination).is_err());
    assert_eq!(count(&rust, "games"), 1);
    assert_eq!(count(&rust, "sessions"), 1);
    assert!(backup_file.is_dir());
}

#[test]
fn zero_byte_pre_upgrade_backup_must_not_be_accepted_as_successful_protection() {
    let fixture = MigrationFixture::new();
    let rust = existing_rust_profile(&fixture);
    let backup_file = fixture.destination.join("library.before-rust-0.2.7.sqlite");
    fs::write(&backup_file, b"").unwrap();

    let result = snapshot_rust_library_before_upgrade(&fixture.destination);
    if result.is_ok() {
        let copy = Connection::open(&backup_file).unwrap();
        let preserved_games = copy
            .query_row("SELECT COUNT(*) FROM games", [], |row| row.get::<_, i64>(0))
            .unwrap_or(0);
        assert_eq!(
            preserved_games, 1,
            "claiming a backup already exists requires a valid, nonempty SQLite snapshot"
        );
    }
    assert_eq!(count(&rust, "games"), 1);
}

#[test]
fn corrupt_nonempty_pre_upgrade_backup_must_not_block_a_valid_fresh_backup_silently() {
    let fixture = MigrationFixture::new();
    let rust = existing_rust_profile(&fixture);
    let backup_file = fixture.destination.join("library.before-rust-0.2.7.sqlite");
    fs::write(&backup_file, b"not-an-sqlite-database").unwrap();

    assert!(
        snapshot_rust_library_before_upgrade(&fixture.destination).is_err(),
        "a corrupt nonempty file must not be treated as a verified historical backup"
    );
    assert_eq!(fs::read(&backup_file).unwrap(), b"not-an-sqlite-database");
    assert_eq!(count(&rust, "games"), 1);
    assert_eq!(count(&rust, "sessions"), 1);
}

#[test]
fn unrelated_valid_sqlite_file_is_not_an_orbit_pre_upgrade_backup() {
    let fixture = MigrationFixture::new();
    let rust = existing_rust_profile(&fixture);
    let backup_file = fixture.destination.join("library.before-rust-0.2.7.sqlite");
    {
        let unrelated = Connection::open(&backup_file).unwrap();
        unrelated
            .execute_batch("CREATE TABLE unrelated(data TEXT); INSERT INTO unrelated VALUES('ok');")
            .unwrap();
    }

    assert!(
        snapshot_rust_library_before_upgrade(&fixture.destination).is_err(),
        "an integrity-clean SQLite file without Orbit games must not count as a usable library backup"
    );
    assert_eq!(count(&rust, "games"), 1);
    assert!(backup_file.exists());
}
