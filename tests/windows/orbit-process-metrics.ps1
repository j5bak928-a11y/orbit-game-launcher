#Requires -Version 5.1
<#
.SYNOPSIS
 Measure Orbit's complete Windows process tree (Rust/Electron plus WebView2).
.EXAMPLE
 powershell -NoProfile -File tests/windows/orbit-process-metrics.ps1 -ProcessId 1234 -Samples 5 -IntervalMs 1000
.NOTES
 Never launches or terminates a process. MiB totals are sums of working sets,
 not deduplicated resident physical RAM. Child and parent pages may overlap.
 CPU percentage uses one logical CPU as 100%; multicore usage can exceed 100%.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ProcessId,
    [ValidateRange(1, 120)]
    [int]$Samples = 3,
    [ValidateRange(100, 60000)]
    [int]$IntervalMs = 1000,
    [string]$CsvPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-TreeSample {
    param([int]$RootProcessId)
    # Re-enumerate every sample: WebView2 children may spawn/exit while hidden.
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $byId = @{}
    $children = @{}
    foreach ($item in $processes) {
        $id = [int]$item.ProcessId
        $byId[$id] = $item
        $parent = [int]$item.ParentProcessId
        if (-not $children.ContainsKey($parent)) {
            $children[$parent] = [System.Collections.Generic.List[int]]::new()
        }
        $children[$parent].Add($id)
    }
    if (-not $byId.ContainsKey($RootProcessId)) {
        throw "Process $RootProcessId is not running."
    }
    $pending = [System.Collections.Generic.Queue[int]]::new()
    $pending.Enqueue($RootProcessId)
    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $rows = [System.Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0) {
        $id = $pending.Dequeue()
        if (-not $seen.Add($id)) { continue }
        $item = $byId[$id]
        if ($null -eq $item) { continue }
        $alive = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($null -eq $alive) { continue }
        $row = [pscustomobject]@{
            pid = $id
            parentPid = [int]$item.ParentProcessId
            name = [string]$item.Name
            startedAt = ([datetime]$item.CreationDate).ToUniversalTime().ToString('o')
            workingSetBytes = [long]$alive.WorkingSet64
            privateBytes = [long]$alive.PrivateMemorySize64
            cpuSeconds = if ($null -eq $alive.CPU) { 0.0 } else { [double]$alive.CPU }
        }
        $rows.Add($row)
        if ($children.ContainsKey($id)) {
            foreach ($child in $children[$id]) {
                # Avoid reporting unrelated processes when a parent PID has
                # been recycled. Child creation cannot precede its real parent.
                if ([datetime]$byId[$child].CreationDate -ge [datetime]$item.CreationDate) {
                    $pending.Enqueue($child)
                }
            }
        }
    }
    if ($rows.Count -eq 0) { throw "Process $RootProcessId exited during sampling." }
    $working = [long]0
    $private = [long]0
    $cpu = [double]0
    foreach ($row in $rows) {
        $working += $row.workingSetBytes
        $private += $row.privateBytes
        $cpu += $row.cpuSeconds
    }
    return [pscustomobject]@{
        at = [datetime]::UtcNow.ToString('o')
        rootPid = $RootProcessId
        processCount = $rows.Count
        workingSetMiB = [math]::Round($working / 1MB, 2)
        privateMiB = [math]::Round($private / 1MB, 2)
        cpuSeconds = [math]::Round($cpu, 3)
        processes = @($rows.ToArray())
    }
}

$measurements = [System.Collections.Generic.List[object]]::new()
for ($i = 0; $i -lt $Samples; $i++) {
    if ($i -gt 0) { Start-Sleep -Milliseconds $IntervalMs }
    $measurements.Add((Get-TreeSample -RootProcessId $ProcessId))
}
$first = $measurements[0]
$last = $measurements[$measurements.Count - 1]
if ($last.processes[0].startedAt -ne $first.processes[0].startedAt) {
    throw "Root PID was reused during measurement; discard this result."
}
$seconds = ([datetime]$last.at - [datetime]$first.at).TotalSeconds
$cpuPercent = if ($seconds -gt 0) {
    [math]::Round(100 * ($last.cpuSeconds - $first.cpuSeconds) / $seconds, 2)
} else { $null }
$result = [pscustomobject]@{
    schema = 'orbit.process-tree.v1'
    rootPid = $ProcessId
    samples = @($measurements.ToArray())
    lastWorkingSetMiB = $last.workingSetMiB
    lastPrivateMiB = $last.privateMiB
    cpuPercentOneCore = $cpuPercent
    note = 'Summed process working sets (including WebView2 descendants); overlapping pages are not deduplicated.'
}
if ($CsvPath) {
    $measurements | Select-Object at,rootPid,processCount,workingSetMiB,privateMiB,cpuSeconds |
        Export-Csv -LiteralPath $CsvPath -NoTypeInformation -Encoding UTF8
}
$result | ConvertTo-Json -Depth 8 -Compress
