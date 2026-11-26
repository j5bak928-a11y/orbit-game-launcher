#Requires -Version 5.1
<#
.SYNOPSIS
 Build and bundle a Rust/Tauri Windows release without GitHub Actions.
.NOTES
 Requires the installed stable-x86_64-pc-windows-gnullvm Rust toolchain,
 LLVM-MinGW (clang.exe and libunwind.dll), Node/npm and 7-Zip. This script
 never runs or installs Orbit and never opens real application profiles.
 A GNU-LLVM build needs WebView2Loader.dll and libunwind.dll next to its EXE:
 Tauri does not automatically include those runtime DLLs in NSIS/MSI.
#>
[CmdletBinding()]
param([switch]$SkipRustTests)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$target = 'x86_64-pc-windows-gnullvm'
$release = Join-Path $root "src-tauri/target/$target/release"
$dist = Join-Path $release 'local-distribution'
$conf = Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$name = [string]$conf.productName
$version = [string]$conf.version

foreach ($tool in @('cargo.exe', 'npx.cmd', 'clang.exe')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Missing $tool (required for local Tauri packaging)."
    }
}
$sevenZipCommand = Get-Command '7z.exe' -ErrorAction SilentlyContinue
$sevenZip = if ($sevenZipCommand) { $sevenZipCommand.Source } else {
    Join-Path $env:ProgramFiles '7-Zip/7z.exe'
}
if (-not (Test-Path -LiteralPath $sevenZip)) { throw 'Missing 7-Zip (7z.exe).' }

$llvmBin = Split-Path (Get-Command 'clang.exe' -ErrorAction Stop).Source -Parent
$unwind = Join-Path $llvmBin 'libunwind.dll'
if (-not (Test-Path -LiteralPath $unwind)) {
    throw "LLVM-MinGW runtime not found next to clang.exe: $unwind"
}

$before = @{}
foreach ($key in @('RUSTUP_TOOLCHAIN', 'CARGO_BUILD_JOBS', 'CC', 'CXX', 'RUSTFLAGS', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
    $before[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

function Get-Sha256([string]$path) {
    $digest = [Security.Cryptography.SHA256]::Create()
    $inputFile = [IO.File]::OpenRead($path)
    try { [BitConverter]::ToString($digest.ComputeHash($inputFile)).Replace('-', '').ToLowerInvariant() }
    finally { $inputFile.Dispose(); $digest.Dispose() }
}

Push-Location $root
try {
    $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnullvm'
    $env:CARGO_BUILD_JOBS = '4'
    $env:CC = 'clang.exe'
    $env:CXX = 'clang++.exe'

    $signingKey = [Environment]::GetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY', 'Process')
    $updaterKeyPath = [Environment]::GetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY_PATH', 'Process')
    if ([string]::IsNullOrWhiteSpace($signingKey) -and [string]::IsNullOrWhiteSpace($updaterKeyPath)) {
        $defaultUpdaterKey = Join-Path $env:USERPROFILE '.tauri\orbit-updater.key'
        if (Test-Path -LiteralPath $defaultUpdaterKey) {
            $updaterKeyPath = $defaultUpdaterKey
            $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $updaterKeyPath
            if ($null -eq [Environment]::GetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'Process')) {
                $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
            }
        }
    }
    $hasUpdaterKey = (-not [string]::IsNullOrWhiteSpace($signingKey)) -or
        ((-not [string]::IsNullOrWhiteSpace($updaterKeyPath)) -and (Test-Path -LiteralPath $updaterKeyPath))

    & npm.cmd run tauri:stage
    if ($LASTEXITCODE -ne 0) { throw 'Tauri frontend staging failed.' }

    if (-not $SkipRustTests) {
        Push-Location (Join-Path $root 'src-tauri')
        try {
            & cargo.exe test --locked --lib
            if ($LASTEXITCODE -ne 0) { throw 'Native Rust tests failed; refusing to bundle.' }
        } finally { Pop-Location }
    }

    # Strip user profile and workspace paths from release panic/source strings.
    $cargoHome = if (-not [string]::IsNullOrWhiteSpace($env:CARGO_HOME)) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
    $remapFlags = @(
        "--remap-path-prefix=$root=/orbit",
        "--remap-path-prefix=$cargoHome=/cargo",
        "--remap-path-prefix=$($env:USERPROFILE)=/user"
    )
    $existingRustflags = $before['RUSTFLAGS']
    $env:RUSTFLAGS = if ([string]::IsNullOrWhiteSpace($existingRustflags)) {
        $remapFlags -join ' '
    } else {
        "$existingRustflags $($remapFlags -join ' ')"
    }

    # Build once without bundling so the WebView2 SDK loader is generated.
    & npx.cmd tauri build --target $target --no-bundle --no-sign --ci
    if ($LASTEXITCODE -ne 0) { throw 'Tauri standalone compilation failed.' }
    $loader = Join-Path $release 'WebView2Loader.dll'
    if (-not (Test-Path -LiteralPath $loader)) { throw "Missing built WebView2 loader: $loader" }

    $runtime = Join-Path $release 'local-bundle-runtime'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    foreach ($file in @(@{source=$unwind;name='libunwind.dll'}, @{source=$loader;name='WebView2Loader.dll'})) {
        Copy-Item -LiteralPath $file.source -Destination (Join-Path $runtime $file.name) -Force
    }
    $resources = @{}
    foreach ($nameOfDll in @('libunwind.dll', 'WebView2Loader.dll')) {
        $resources[(Join-Path $runtime $nameOfDll)] = $nameOfDll
    }
    $bundleOverlay = @{resources=$resources}
    if ($hasUpdaterKey) {
        $bundleOverlay.createUpdaterArtifacts = $true
    }
    $overlay = Join-Path $release 'local-bundle-resources.json'
    @{bundle=$bundleOverlay} | ConvertTo-Json -Depth 6 |
        Set-Content -LiteralPath $overlay -Encoding UTF8

    $nsis = Join-Path $release "bundle/nsis/${name}_${version}_x64-setup.exe"
    $msi = Join-Path $release "bundle/msi/${name}_${version}_x64_en-US.msi"
    Remove-Item -LiteralPath "$nsis.sig" -Force -ErrorAction SilentlyContinue

    & npx.cmd tauri build --target $target --bundles nsis,msi --no-sign --ci --config $overlay
    if ($LASTEXITCODE -ne 0) { throw 'Tauri NSIS/MSI packaging failed.' }
    foreach ($file in @($nsis, $msi)) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Missing installer: $file" }
    }
    $nsisFiles = & $sevenZip l -slt $nsis
    if ($LASTEXITCODE -ne 0 -or
        -not ($nsisFiles -match '^Path = WebView2Loader\.dll$') -or
        -not ($nsisFiles -match '^Path = libunwind\.dll$')) {
        throw 'NSIS installer is missing the GNU-LLVM runtime DLLs.'
    }

    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($msi, 0) # read-only
    $view = $database.OpenView('SELECT `FileName` FROM `File`')
    $view.Execute()
    $msiNames = @()
    try {
        while ($true) {
            $record = $view.Fetch()
            if ($null -eq $record) { break }
            $msiNames += $record.StringData(1)
        }
    } finally { $view.Close() }
    foreach ($dll in @('WebView2Loader.dll', 'libunwind.dll')) {
        if (-not ($msiNames -match [regex]::Escape($dll))) { throw "MSI missing $dll" }
    }

    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $portable = Join-Path $dist 'portable'
    New-Item -ItemType Directory -Force -Path $portable | Out-Null
    Copy-Item -LiteralPath (Join-Path $release 'orbit-launcher.exe') -Destination $portable -Force
    Copy-Item -LiteralPath (Join-Path $runtime 'libunwind.dll') -Destination $portable -Force
    Copy-Item -LiteralPath (Join-Path $runtime 'WebView2Loader.dll') -Destination $portable -Force
    $zip = Join-Path $dist "Orbit-Launcher-Portable-$version.zip"
    Compress-Archive -Path (Join-Path $portable '*') -DestinationPath $zip -CompressionLevel Optimal -Force

    $artifacts = @($nsis, $msi, $zip)
    if ($hasUpdaterKey) {
        $nsisSig = "$nsis.sig"
        if (-not (Test-Path -LiteralPath $nsisSig)) {
            if (-not [string]::IsNullOrWhiteSpace($updaterKeyPath)) {
                & npx.cmd tauri signer sign --private-key-path $updaterKeyPath --app-version $version $nsis
            } else {
                & npx.cmd tauri signer sign --app-version $version $nsis
            }
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nsisSig)) {
                throw "Missing or failed updater signature: $nsisSig"
            }
        }
        $distSetup = Join-Path $dist "Orbit-Launcher-Setup-$version.exe"
        $distSig = Join-Path $dist "Orbit-Launcher-Setup-$version.exe.sig"
        Copy-Item -LiteralPath $nsis -Destination $distSetup -Force
        Copy-Item -LiteralPath $nsisSig -Destination $distSig -Force
        $signature = (Get-Content -LiteralPath $distSig -Raw).Trim()
        if ([string]::IsNullOrWhiteSpace($signature)) {
            throw "Updater signature file is empty: $distSig"
        }
        $latestJsonObj = [ordered]@{
            version = $version
            notes = "Orbit Launcher v$version"
            pub_date = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
            platforms = [ordered]@{
                'windows-x86_64' = [ordered]@{
                    signature = $signature
                    url = "https://github.com/j5bak928-a11y/orbit-game-launcher/releases/download/v$version/Orbit-Launcher-Setup-$version.exe"
                }
            }
        }
        $latestJsonPath = Join-Path $dist 'latest.json'
        [IO.File]::WriteAllText($latestJsonPath, ($latestJsonObj | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        $artifacts += @($distSetup, $distSig, $latestJsonPath)
    }

    $manifest = $artifacts | ForEach-Object {
        [pscustomobject]@{path=$_;bytes=(Get-Item -LiteralPath $_).Length;sha256=(Get-Sha256 $_)}
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $dist 'manifest.json') -Encoding UTF8
    $manifest | Format-Table -AutoSize | Out-String | Write-Output
    if ($hasUpdaterKey) {
        Write-Output "PASS: local Tauri Rust $version with signed updater artifacts ($distSetup, $distSig, latest.json); both installers contain the runtime DLLs."
    } else {
        Write-Output "PASS: unsigned local Tauri Rust $version; both installers contain the runtime DLLs."
    }
} finally {
    Pop-Location
    foreach ($key in $before.Keys) {
        [Environment]::SetEnvironmentVariable($key, $before[$key], 'Process')
    }
}
