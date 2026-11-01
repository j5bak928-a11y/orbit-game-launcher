//! Orbit Rust SQLite benchmark, aligned with npm run bench.
//!
//! Run from the repository root:
//!   cargo run --release --manifest-path src-tauri/Cargo.toml --example benchmark
//!   npm run bench
//!
//! Both programs:
//! * Build each of three independent temporary, file-backed SQLite libraries.
//! * Generate 5,000 games before starting the insert timer. Every game has
//!   name "Game 00000" ... "Game 04999", Steam source_id 100000+i,
//!   matching steam://rungameid/ URI, and a ["sample"] tag.
//! * Time batched upsert (100 transactions of 50 games), the default
//!   alphabetically sorted full-library list, then 100 lookups at list
//!   positions 0, 50, 100, ..., 4950.
//! * Sample process resident memory immediately after the list, before the
//!   lookups; verify 5,000 persisted records and 100 successful lookups.
//! * Report per-run milliseconds (rounded to 0.1) and the median of 3 runs.
//!
//! Only DB metrics are comparable. npm's benchmark additionally scans a test
//! folder; discovery is outside this standalone database benchmark. Startup,
//! synthetic input creation, opening the database, and cleanup are unmeasured.
//! Compare sequentially on the SAME idle machine, same filesystem and power
//! settings; use a --release Rust build for representative performance.
//! Process RSS includes each runtime's overhead (Node/V8 vs native Rust).
//! Windows uses working-set size, Linux uses VmRSS; other OSes report null.
//! These informational timings are not product performance guarantees.

#[path = "../src/database.rs"]
#[allow(dead_code)]
mod database;

use database::LibraryDatabase;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Instant;
use uuid::Uuid;

const GAMES: usize = 5_000;
const BATCH: usize = 50;
const LOOKUPS: usize = 100;
const SAMPLES: usize = 3;
const METRICS: [&str; 4] = ["insertMs", "listMs", "lookup100Ms", "rssMiB"];

struct TemporaryLibrary(PathBuf);

impl TemporaryLibrary {
    fn create() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("orbit-rust-perf-{}", Uuid::new_v4()));
        std::fs::create_dir(&path)
            .map_err(|e| format!("Cannot create temporary directory: {e}"))?;
        Ok(Self(path))
    }

    fn database_path(&self) -> PathBuf {
        self.0.join("games.sqlite")
    }
}

impl Drop for TemporaryLibrary {
    fn drop(&mut self) {
        // LibraryDatabase is dropped before this guard, so even Windows
        // can remove the database and its WAL/SHM companions.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn elapsed_ms(started: Instant) -> f64 {
    round_tenth(started.elapsed().as_secs_f64() * 1_000.0)
}

#[cfg(windows)]
fn resident_bytes() -> Option<u64> {
    use std::ffi::c_void;
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    let mut counters = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    // SAFETY: Both imported functions are Windows system APIs; counters
    // points to a live, correctly sized PROCESS_MEMORY_COUNTERS structure.
    let size = counters.cb;
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
    if ok == 0 {
        None
    } else {
        Some(counters.working_set_size as u64)
    }
}

#[cfg(target_os = "linux")]
fn resident_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kb = line.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    kb.checked_mul(1024)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn resident_bytes() -> Option<u64> {
    None
}

fn synthetic_games() -> Vec<Value> {
    (0..GAMES)
        .map(|i| {
            let steam_id = 100_000 + i;
            json!({
                "name": format!("Game {i:05}"),
                "source": "steam",
                "source_id": steam_id.to_string(),
                "launch_uri": format!("steam://rungameid/{steam_id}"),
                "tags": ["sample"]
            })
        })
        .collect()
}

fn run_sample() -> Result<Value, String> {
    let folder = TemporaryLibrary::create()?;
    let mut db = LibraryDatabase::open(folder.database_path())?;
    let games = synthetic_games();

    let insert_start = Instant::now();
    for chunk in games.chunks(BATCH) {
        db.upsert_batch(chunk)?;
    }
    let insert_ms = elapsed_ms(insert_start);

    let list_start = Instant::now();
    let all = db.list("name")?;
    let list_ms = elapsed_ms(list_start);

    // Matches Node's process.memoryUsage().rss placement exactly.
    let rss_mib = resident_bytes().map(|bytes| round_tenth(bytes as f64 / (1024.0 * 1024.0)));

    let rows = all
        .as_array()
        .ok_or("Library list did not return an array")?;
    if rows.len() != GAMES {
        return Err(format!("Expected {GAMES} games, got {}", rows.len()));
    }
    let lookup_start = Instant::now();
    let mut found = 0;
    for i in 0..LOOKUPS {
        let id = rows[i * BATCH]["id"]
            .as_str()
            .ok_or_else(|| format!("Game at index {} has no id", i * BATCH))?;
        let result = db.get(id)?;
        if result["id"].as_str() != Some(id) {
            return Err(format!("Lookup returned the wrong game for id {id}"));
        }
        found += 1;
    }
    let lookup_ms = elapsed_ms(lookup_start);

    if found != LOOKUPS || db.count()? != GAMES as i64 {
        return Err("Benchmark integrity check failed".into());
    }

    // Drop in this order so temporary SQLite files can be deleted on Windows.
    drop(db);
    drop(folder);
    Ok(json!({
        "insertMs": insert_ms,
        "listMs": list_ms,
        "lookup100Ms": lookup_ms,
        "rssMiB": rss_mib,
        "games": GAMES
    }))
}

fn median(samples: &[Value], key: &str) -> Value {
    let mut values: Vec<f64> = samples
        .iter()
        .filter_map(|sample| sample[key].as_f64())
        .filter(|number| number.is_finite())
        .collect();
    if values.len() != samples.len() {
        return Value::Null;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    json!(values[values.len() / 2])
}

fn benchmark() -> Result<Value, String> {
    let samples = (0..SAMPLES)
        .map(|_| run_sample())
        .collect::<Result<Vec<_>, _>>()?;
    let mut medians = serde_json::Map::new();
    for key in METRICS {
        medians.insert(key.to_string(), median(&samples, key));
    }
    Ok(json!({
        "environment": {
            "backend": "rust-rusqlite",
            "platform": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "build": if cfg!(debug_assertions) { "debug" } else { "release" },
            "rssMeasurement": if cfg!(windows) {
                "GetProcessMemoryInfo.WorkingSetSize"
            } else if cfg!(target_os = "linux") {
                "/proc/self/status VmRSS"
            } else {
                "unavailable"
            },
            "baseline": "npm run bench (tests/performance.cjs)",
            "scope": "database-only (excludes Node discovery scan)"
        },
        "samples": samples,
        "median": medians
    }))
}

fn main() {
    match benchmark() {
        Ok(report) => println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("JSON serialization")
        ),
        Err(error) => {
            eprintln!("Orbit Rust SQLite benchmark failed: {error}");
            std::process::exit(1);
        }
    }
}
