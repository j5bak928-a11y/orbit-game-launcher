#Requires -Version 5.1
<#
.SYNOPSIS
 Real Windows integration test: closing Orbit destroys its WebView2 window,
 but MUST keep the same Rust process alive. Restoring from the tray creates
 a NEW HWND, never revives the destroyed window.
.EXAMPLE
 powershell -NoProfile -NonInteractive -File tests/windows/tauri-tray-runtime.ps1 -ProcessId 12345 -AllowWindowClose
.EXAMPLE
 powershell -NoProfile -File tests/windows/tauri-tray-runtime.ps1 -ProcessId 12345 -AllowWindowClose -VerifyTrayRestore
.NOTES
 Requires an already-running Tauri preview started with an expendable test
 library/profile. This script DOES NOT launch Orbit, delete user data, terminate
 processes, or click arbitrary tray controls. -VerifyTrayRestore gives an
 operator 30 seconds to click the REAL "Open Orbit" tray menu item.
 A pre-fix hide-to-tray build SHOULD FAIL the destroyed-HWND assertion.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ProcessId,
    [switch]$AllowWindowClose,
    [switch]$VerifyTrayRestore,
    [switch]$InteropSmoke,
    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $AllowWindowClose -and -not $InteropSmoke) {
    throw 'Refusing to send WM_CLOSE without explicit -AllowWindowClose.'
}

if (-not $InteropSmoke) {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $binary = try { [System.IO.Path]::GetFileName($process.Path) } catch { '' }
    if ($binary -ine 'orbit-launcher.exe') {
        throw "Refusing PID ${ProcessId}: expected orbit-launcher.exe; found '$binary'."
    }
    $startedAt = $process.StartTime.ToUniversalTime().ToString('o')
}

if (-not ('OrbitTrayWindowProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OrbitTrayWindowProbe {
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc proc, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    public static long[] OrbitWindows(int processId) {
        var result = new List<long>();
        EnumWindows((hwnd, data) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == (uint)processId) {
                var title = new StringBuilder(256);
                GetWindowText(hwnd, title, title.Capacity);
                if (title.ToString().IndexOf("Orbit Launcher", StringComparison.OrdinalIgnoreCase) >= 0)
                    result.Add(hwnd.ToInt64());
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static bool RequestClose(long hwnd) {
        return PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
    public static bool Exists(long hwnd) { return IsWindow(new IntPtr(hwnd)); }
    public static bool Visible(long hwnd) { return IsWindowVisible(new IntPtr(hwnd)); }
}
'@
}

if ($InteropSmoke) {
    # Exercise real P/Invoke symbol resolution and HWND enumeration without
    # touching the desktop: useful in CI with no Orbit session running.
    $windows = @([OrbitTrayWindowProbe]::OrbitWindows($ProcessId))
    [pscustomobject]@{
        schema = 'orbit.tray-interop.v1'
        rootPid = $ProcessId
        enumerated = $true
        windowCount = $windows.Count
    } | ConvertTo-Json -Compress
    return
}

function Assert-RootAlive {
    $current = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $current) {
        throw "Orbit Rust process $ProcessId unexpectedly exited."
    }
    if ($current.StartTime.ToUniversalTime().ToString('o') -ne $startedAt) {
        throw 'Rust PID was recycled; the original launcher exited.'
    }
}

$visible = @([OrbitTrayWindowProbe]::OrbitWindows($ProcessId) |
    Where-Object { [OrbitTrayWindowProbe]::Visible([long]$_) })
if ($visible.Count -ne 1) {
    throw "Expected exactly one visible Orbit main HWND, found $($visible.Count)."
}
$measure = Join-Path $PSScriptRoot 'orbit-process-metrics.ps1'
$before = & $measure -ProcessId $ProcessId -Samples 1 | ConvertFrom-Json
$oldHwnd = [long]$visible[0]
if (-not [OrbitTrayWindowProbe]::RequestClose($oldHwnd)) {
    throw "Win32 PostMessage(WM_CLOSE) failed for HWND $oldHwnd."
}

$deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    Assert-RootAlive
    if (-not [OrbitTrayWindowProbe]::Exists($oldHwnd)) { break }
    Start-Sleep -Milliseconds 150
} while ([datetime]::UtcNow -lt $deadline)
if ([OrbitTrayWindowProbe]::Exists($oldHwnd)) {
    throw 'Close did not DESTROY the Orbit native HWND. Hiding WebView2 is not sufficient.'
}
Assert-RootAlive
# Tauri must not spontaneously recreate while the user has not requested Open.
Start-Sleep -Milliseconds 750
$remaining = @([OrbitTrayWindowProbe]::OrbitWindows($ProcessId))
if ($remaining.Count -ne 0) {
    throw "Orbit recreated a main window before tray Open: $($remaining -join ', ')."
}
$afterClose = & $measure -ProcessId $ProcessId -Samples 1 | ConvertFrom-Json

$restoredHwnd = $null
$afterRestore = $null
if ($VerifyTrayRestore) {
    Write-Host 'ACTION REQUIRED: Open Orbit from its system-tray menu (not a new EXE).' -ForegroundColor Yellow
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Assert-RootAlive
        $opened = @([OrbitTrayWindowProbe]::OrbitWindows($ProcessId) |
            Where-Object { [OrbitTrayWindowProbe]::Visible([long]$_) })
        if ($opened.Count -eq 1) {
            $restoredHwnd = [long]$opened[0]
            break
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    if ($null -eq $restoredHwnd) { throw 'Tray Open did not recreate a visible main window.' }
    if ($restoredHwnd -eq $oldHwnd) {
        throw 'Tray Open reused the destroyed HWND instead of creating a new window.'
    }
    Assert-RootAlive
    $afterRestore = & $measure -ProcessId $ProcessId -Samples 1 | ConvertFrom-Json
}

[pscustomobject]@{
    schema = 'orbit.tray-lifecycle.v1'
    result = 'PASS'
    rootPid = $ProcessId
    processSurvivedClose = $true
    oldHwndDestroyed = $true
    restored = ($null -ne $restoredHwnd)
    newHwnd = $restoredHwnd
    oldHwnd = $oldHwnd
    beforeCloseMiB = $before.lastWorkingSetMiB
    afterCloseMiB = $afterClose.lastWorkingSetMiB
    closedWorkingSetDeltaMiB = [math]::Round($afterClose.lastWorkingSetMiB - $before.lastWorkingSetMiB, 2)
    beforeCloseProcessCount = $before.samples[0].processCount
    afterCloseProcessCount = $afterClose.samples[0].processCount
    afterRestoreMiB = if ($null -ne $afterRestore) { $afterRestore.lastWorkingSetMiB } else { $null }
} | ConvertTo-Json -Compress
