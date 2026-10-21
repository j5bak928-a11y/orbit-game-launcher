# Publish Orbit Game Launcher to GitHub

The private GitHub repository already exists:

**https://github.com/j5bak928-a11y/orbit-game-launcher**

This folder contains the complete project and a committed `main` branch. The `origin` remote is already configured. From **PowerShell** in this folder, run:

```powershell
.\publish-to-github.ps1
```

Alternatively, with Git installed and signed in to GitHub:

```powershell
git push -u origin main
```

If Git prompts for authentication, use Git Credential Manager or `gh auth login` (GitHub CLI). Do not paste a GitHub access token into chat or save one in this repository. The publishing script will never force-push or overwrite a diverged remote.

## Verification

After pushing, open https://github.com/j5bak928-a11y/orbit-game-launcher and confirm that `src`, `tests`, `assets`, `package.json`, and `.github/workflows/ci.yml` are present. GitHub Actions runs `npm run check` and `npm test`.

Native Electron installation and Windows game launches still require separate testing.
