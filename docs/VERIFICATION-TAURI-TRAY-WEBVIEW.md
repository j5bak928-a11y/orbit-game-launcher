# Orbit Tauri: Windows tray / WebView2 release regression

This covers the **new** tray lifecycle: clicking the main window's X destroys
the native window/WebView2 (to release its renderer/GPU allocation) but keeps
the Rust backend alive for process tracking and playtime persistence. The
tray's **Open Orbit** action creates a *new* native window. It must not revive
the old HWND. **Quit Orbit** is the explicit full-process exit.

Do not reuse the previous hide-to-tray acceptance criterion. A hidden HWND is
now a regression, even if the process stays alive and tracking works.

## Automated Windows tests

~~~powershell
node --test tests/tauri-tray-runtime.test.cjs
~~~

The default run exercises real Windows process enumeration and native Win32
interop without touching a running Orbit process. It verifies that process-tree
metrics include a test-owned child process, totals agree with the actual
Windows per-process counters, missing PIDs fail, and a non-Orbit PID cannot
be closed by the lifecycle script. The live Tauri regression is **skipped**
unless the user explicitly opts in with a known PID.

## Real Tauri lifecycle verification (operator-controlled)

1. Install or run the freshly built **Rust** preview on a Windows desktop with
   a disposable test library/profile. A previously packaged binary may still
   have the *old* hide-to-tray logic and is not a valid build for this test.
2. Find its PID using Get-Process orbit-launcher and confirm the executable
   is orbit-launcher.exe; do not point the harness at Electron.
3. With Orbit's main window visible, run:

~~~powershell
$env:ORBIT_TAURI_E2E_PID = '12345'  # replace with the running Rust PID
$env:ORBIT_TAURI_ALLOW_CLOSE = 'yes'
node --test tests/tauri-tray-runtime.test.cjs
~~~

The live check sends a real WM_CLOSE to the visible Orbit native window,
waits for its **HWND to be destroyed**, verifies that the original Rust PID
and creation time are unchanged, and rejects unsolicited window recreation.
It records complete process-tree working set **before and after** close.
It does not kill Orbit, manipulate the database, or restart the executable.

To also verify tray **Open Orbit** (manual interaction required):

~~~powershell
$env:ORBIT_TAURI_E2E_RESTORE = 'yes'
node --test tests/tauri-tray-runtime.test.cjs
~~~

After the main window closes, select **Open Orbit** from Orbit's actual
notification-area tray icon within 30 seconds. The test checks that the new
window is visible, has a **different HWND**, and belongs to the *same* Rust
PID. An invisible/nonexistent tray icon or failure to reopen is a regression.
If operating from a terminal that buffers child output, select the tray item
immediately once the window closes.

For direct interactive execution, with on-screen prompts:

~~~powershell
powershell -NoProfile -File tests/windows/tauri-tray-runtime.ps1 -ProcessId 12345 -AllowWindowClose -VerifyTrayRestore
~~~

The script **refuses** to close any process not named orbit-launcher.exe
and requires the explicit -AllowWindowClose flag.

## Complete process-tree RAM / CPU measurement

~~~powershell
powershell -NoProfile -File tests/windows/orbit-process-metrics.ps1 -ProcessId 12345 -Samples 5 -IntervalMs 1000 -CsvPath "$env:TEMP\orbit-process-metrics.csv"
~~~

Use the **same machine**, similar OS idle state and running game conditions
to capture the visible, closed-to-tray, and reopened states separately.
Compare lastWorkingSetMiB, lastPrivateMiB, cpuPercentOneCore,
processCount and individual processes entries. WebView2 renderer/GPU
descendants may persist briefly after close; capture a second post-close
measurement after a few seconds. The app's Rust parent RSS alone is **not**
the application's total RAM.

The script uses Win32_Process parent relationships and process creation
times to exclude recycled PID ancestry. Working sets are summed per
process; this is **not** deduplicated physical RAM, and shared pages may
appear in multiple processes. CPU percentages are normalized to one core,
so multicore usage may exceed 100%. No benchmark threshold is hardcoded
because WebView2/GPU allocation varies by Windows build, graphics stack and
system load. Report before/after deltas rather than claiming a fixed saving.

## Additional session integrity checks

Keep an actual direct-launch game running, close Orbit, wait at least two
10-second polling cycles, reopen from the tray, and verify that the same
running game appears and its persisted playtime advances. Then select
**Quit Orbit** from the tray; confirm it exits and that reopening Orbit
recovers/finishes the session without duplicate records. These steps involve
real installed games and library data and are intentionally operator-driven;
they cannot be proven by source-text assertions.

Do not make the native close-to-tray change GO merely because a source regex,
mock, or Node unit test passes: the opt-in HWND/PID test must pass against
the actual newly compiled Windows Tauri binary.
