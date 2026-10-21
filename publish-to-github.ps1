# Push this existing local Orbit repository to its matching private GitHub repository.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required. Install Git for Windows first: https://git-scm.com/download/win'
}

$expected = 'https://github.com/j5bak928-a11y/orbit-game-launcher.git'
$remote = (& git remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $remote) {
    & git remote add origin $expected
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the origin remote.' }
} elseif ($remote.Trim() -ne $expected) {
    throw "Origin points to '$remote'. Expected '$expected'. Check before pushing."
}

$branch = (& git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw "Expected the main branch, found '$branch'."
}

$changes = (& git status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'Could not check git status.' }
if ($changes) { throw 'Uncommitted changes detected. Commit or stash them before publishing.' }

Write-Host 'Publishing the Orbit Launcher main branch to GitHub...'
& git push --set-upstream origin main
if ($LASTEXITCODE -ne 0) {
    throw 'GitHub push failed. Check Git authentication and whether the remote already has commits. No force push was attempted.'
}
Write-Host 'Published: https://github.com/j5bak928-a11y/orbit-game-launcher'
