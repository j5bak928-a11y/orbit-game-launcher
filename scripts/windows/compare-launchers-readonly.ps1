#Requires -Version 5.1
<#
.SYNOPSIS
 Read-only, same-machine snapshot of running game launcher process groups.
 Does not start/stop applications, install software, or touch user profiles.
.NOTES
 WorkingSet sums resident process pages (shared pages may be counted in more
 than one process). CPU uses total process CPU-time delta normalized to all
 logical processors; it is not a precise energy or battery measurement.
 Run each launcher separately at idle with a similar library and no game open.
#>
[CmdletBinding()]
param([ValidateRange(1,30)][int]$SampleSeconds=5)

$ErrorActionPreference='Stop'
$launchers=@(
    @{Name='Orbit Electron'; Executables=@('Orbit Launcher.exe')},
    @{Name='Orbit Rust Preview'; Executables=@('orbit-launcher.exe')},
    @{Name='Steam'; Executables=@('steam.exe','steamwebhelper.exe')},
    @{Name='Epic Games Launcher'; Executables=@('EpicGamesLauncher.exe','EpicWebHelper.exe')},
    @{Name='Playnite'; Executables=@('Playnite.DesktopApp.exe','Playnite.FullscreenApp.exe')},
    @{Name='Heroic Games Launcher'; Executables=@('Heroic.exe','Heroic Games Launcher.exe')},
    @{Name='Ascendara'; Executables=@('Ascendara.exe')}
)

function Snapshot {
    $inventory=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)
    $metrics=@{}
    foreach($process in (Get-Process -ErrorAction SilentlyContinue)) {
        try {
            $metrics[[int]$process.Id]=[pscustomobject]@{
                MemoryBytes=[long]$process.WorkingSet64
                CpuSeconds=if($null -eq $process.CPU){$null}else{[double]$process.CPU}
            }
        } catch { # Access to some protected processes can be denied.
        }
    }
    return @{ Inventory=$inventory; Metrics=$metrics }
}

function Group-ProcessIds {
    param($Inventory,[string[]]$Executables)
    $names=@{};foreach($name in $Executables){$names[$name.ToLowerInvariant()]=$true}
    $ids=New-Object 'System.Collections.Generic.HashSet[int]'
    $queue=New-Object 'System.Collections.Generic.Queue[int]'
    foreach($process in $Inventory) {
        if($null -eq $process.Name){continue}
        if($names.ContainsKey($process.Name.ToLowerInvariant()) -and $ids.Add([int]$process.ProcessId)) {
            $queue.Enqueue([int]$process.ProcessId)
        }
    }
    # Count WebView2/Chromium helpers under the launcher's own root, without
    # including an unrelated browser process with the same executable name.
    while($queue.Count -gt 0){
        $parent=$queue.Dequeue()
        foreach($process in $Inventory){
            if([int]$process.ParentProcessId -eq $parent -and $ids.Add([int]$process.ProcessId)){
                $queue.Enqueue([int]$process.ProcessId)
            }
        }
    }
    return @($ids | ForEach-Object { [int]$_ })
}

$first=Snapshot
$timer=[Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $SampleSeconds
$second=Snapshot
$timer.Stop()
$elapsed=[Math]::Max(.001,$timer.Elapsed.TotalSeconds)
$cores=[Math]::Max(1,[Environment]::ProcessorCount)

foreach($launcher in $launchers){
    $ids=@(Group-ProcessIds -Inventory $second.Inventory -Executables $launcher.Executables)
    $memory=[double]0;$cpu=[double]0;$matched=0;$validCpu=0
    foreach($id in $ids){
        $current=$second.Metrics[[int]$id]
        if($null -eq $current){continue}
        $matched++
        $memory+=$current.MemoryBytes
        $previous=$first.Metrics[[int]$id]
        if($null -ne $previous -and $null -ne $current.CpuSeconds -and $null -ne $previous.CpuSeconds){
            $validCpu++;$cpu+=[Math]::Max(0,$current.CpuSeconds-$previous.CpuSeconds)
        }
    }
    [pscustomobject]@{
        Launcher=$launcher.Name
        Status=if($matched){'Running'}else{'Not running'}
        Processes=$matched
        WorkingSetMiB=if($matched){[Math]::Round($memory/1MB,1)}else{$null}
        CpuPercent=if($matched -and $validCpu){[Math]::Round($cpu/$elapsed/$cores*100,2)}else{$null}
        CpuSamples=$validCpu
        Seconds=[Math]::Round($elapsed,1)
    }
}
