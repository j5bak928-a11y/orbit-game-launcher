#Requires -Version 5.1
<#
.SYNOPSIS
 Read-only inspection of an Orbit Tauri Windows build, installer, backup or
 Electron SQLite header. Never launches an EXE, installs anything, writes to a
 profile, changes file attributes, connects to the network, or opens SQLite RW.
.EXAMPLE
 powershell -NoProfile -File tests/windows/tauri-release-readonly.ps1 -ArtifactPath 'C:\Review\orbit-launcher.exe'
.EXAMPLE
 powershell -NoProfile -File tests/windows/tauri-release-readonly.ps1 -LegacyDbPath 'C:\CopiedFixture\library.sqlite' -BackupPath 'C:\Review\backup.orbit'
.NOTES
 A 'Valid' Authenticode signature alone does not confirm that the *expected*
 Orbit publisher signed the file; compare signer thumbprints out of band.
 The database check inspects only the SQLite header, NOT data correctness,
 migration, WAL consistency, table schema or backup restorability.
#>
[CmdletBinding()]
param(
    [string]$ArtifactPath,
    [string]$LegacyDbPath,
    [string]$BackupPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ($ArtifactPath -or $LegacyDbPath -or $BackupPath)) {
    throw 'Specify at least one explicit read-only file path.'
}

function Read-Header {
    param([string]$Path, [int]$Count)
    $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $bytes = [byte[]]::new($Count)
        $read = $file.Read($bytes, 0, $Count)
        if ($read -eq 0) { return ,([byte[]]@()) }
        return ,([byte[]]$bytes[0..($read - 1)])
    } finally {
        $file.Dispose()
    }
}

$result = [ordered]@{
    schema = 'orbit.release-readonly.v1'
    atUtc = [datetime]::UtcNow.ToString('o')
    artifact = $null
    database = $null
    backup = $null
    mutatingActions = 0
}
if ($ArtifactPath) {
    $artifact = Get-Item -LiteralPath $ArtifactPath -ErrorAction Stop
    if ($artifact.PSIsContainer -or $artifact.Extension -notin @('.exe', '.msi')) {
        throw 'Artifact must be a regular .exe or .msi file.'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
    $signer = if ($null -ne $signature.SignerCertificate) {
        $signature.SignerCertificate.Thumbprint
    } else { $null }
    $result.artifact = [ordered]@{
        fileName = $artifact.Name
        sizeBytes = [long]$artifact.Length
        sha256 = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureStatus = [string]$signature.Status
        signerThumbprint = $signer
        signed = ([string]$signature.Status -eq 'Valid')
        publisherVerified = $false # requires out-of-band expected certificate
    }
}
if ($LegacyDbPath) {
    $db = Get-Item -LiteralPath $LegacyDbPath -ErrorAction Stop
    if ($db.PSIsContainer) { throw 'SQLite input must be a file.' }
    $bytes = Read-Header -Path $db.FullName -Count 16
    $expected = [System.Text.Encoding]::ASCII.GetBytes("SQLite format 3" + [char]0)
    $valid = ($bytes.Length -eq 16 -and
        [System.BitConverter]::ToString($bytes) -eq [System.BitConverter]::ToString($expected))
    $result.database = [ordered]@{
        sizeBytes = [long]$db.Length
        validHeader = $valid
        readOnly = $true
        note = 'Header only; SQLite tables, migrations and active WAL are not inspected.'
    }
}
if ($BackupPath) {
    $backup = Get-Item -LiteralPath $BackupPath -ErrorAction Stop
    if ($backup.PSIsContainer -or $backup.Extension -notin @('.orbit', '.json')) {
        throw 'Backup must be a .orbit or .json file.'
    }
    if ($backup.Length -gt 128MB) { throw 'Backup exceeds 128 MiB read-only inspection cap.' }
    $header = Read-Header -Path $backup.FullName -Count 2
    $isGzip = $header.Length -eq 2 -and $header[0] -eq 0x1f -and $header[1] -eq 0x8b
    $validMagic = if ($backup.Extension -eq '.orbit') { $isGzip } else { -not $isGzip }
    $result.backup = [ordered]@{
        fileName = $backup.Name
        sizeBytes = [long]$backup.Length
        expectedHeader = $validMagic
        note = 'Read-only archive header check; use the opt-in Node decoder for complete format validation.'
    }
}
[pscustomobject]$result | ConvertTo-Json -Depth 6 -Compress
