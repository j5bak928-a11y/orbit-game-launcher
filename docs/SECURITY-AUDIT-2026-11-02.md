# Orbit Launcher security audit — 2026-11-02

**Scope:** `j5bak928-a11y/orbit-game-launcher` at `main` base `7fb1038771145884f44824d9ad290656c3d147fa`, including Electron and Rust/Tauri preview, Windows helper, renderer, dependency locks and release workflows. This is a source/dependency audit, **not** a Windows dynamic penetration test or a guarantee of absence of vulnerabilities.

## Executive findings

- **No confirmed critical/high-severity dependency advisories** in the GitHub Actions scans of the full npm lockfile and Rust Cargo.lock.
- **15 moderate npm audit entries**, all in `dev: true` package-lock entries in the Electron build-tool dependency graph; they stem from one underlying `minimatch` advisory. **Not fixed.**
- **One RustSec unsoundness warning:** `glib 0.18.5` (`RUSTSEC-2024-0429`), a transitive GTK/Linux dependency, plus **one unmaintained crate warning** (`proc-macro-error 1.0.4`, `RUSTSEC-2024-0370`). RustSec classified **zero entries under vulnerabilities**; these warnings still require ownership.
- Basic tracked-file credential-pattern scan: **0 matches**. Does not cover high-entropy secrets, environment values, external services, or complete git history.
- Electron IPC, Tauri capabilities, network artwork fetches, file/binary launching, portable backups and release configuration received a targeted source review; see controls and follow-ups below.

## Executed security scans

[Initial scan run 41368690036](https://github.com/j5bak928-a11y/orbit-game-launcher/actions/runs/41368690036) and [four-job scan run 41369304471](https://github.com/j5bak928-a11y/orbit-game-launcher/actions/runs/41369304471) on PR #23:

| Check | Result | Interpretation |
| --- | --- | --- |
| `npm audit --json`, entire lockfile including developer dependencies | 0 critical, 0 high, **15 moderate**, 0 low | CI gate passes at high/critical, **not** a clean advisory report |
| `cargo audit --json --file src-tauri/Cargo.lock`, RustSec DB | 0 vulnerability entries; **1 unsound**, **1 unmaintained** warning | CI gate passes, warnings tracked below |
| Tracked source regex scan for common GitHub/AWS/Slack credentials and private keys | 0 matches | Limited pattern-based check; not proof that no secrets exist |
| Semgrep OSS `p/security-audit`, `src`, `src-tauri/src`, `scripts`, `.github/workflows` | **0 findings / 0 blocking** | Automated rule-based static scan, not comprehensive proof of exploit absence |
| Existing `Verify source` JS tests on PR | passed | Functional regression check, not a dedicated SAST engine |

Scan artifacts: `orbit-security-npm`, `orbit-security-rustsec` and `orbit-security-semgrep` in the linked historical runs. **Workflow maintenance update (November 2026):** `security-audit.yml` is now manual-only (`workflow_dispatch`) while hosted Actions are billing-blocked. These historical results must not be presented as a current automatic security gate; perform local security checks before shipping changes.

## Finding 1 — Moderate: build-time minimatch denial of service (open)

- Advisory: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), CVE-2026-118764.
- Locked: `minimatch 10.2.6`, which is affected (`<11.0.1`); patched release `11.0.1`.
- The advisory describes CPU/memory amplification when processing attacker-controlled glob patterns with `optimizationLevel >= 2`.
- npm reports 15 moderate *package entries* because the single advisory propagates through `glob`, `@electron/asar`, `app-builder-lib`, `electron-builder`, `ejs`, etc. They are **not 15 independently confirmed exploit primitives**.
- All 15 affected lockfile package entries are `dev: true`, used in the build/packaging toolchain. The published application's normal runtime is not shown to accept untrusted glob patterns through this dependency.
- npm's automatic "fix available" suggests a major downgrade of `electron-builder` to `20.23.1`; **do not use `npm audit fix --force` blindly**. It would replace a modern build tool with an obsolete major release.
- **Action:** evaluate a compatible `electron-builder`/upstream dependency release; test any `minimatch` override against actual Windows NSIS, portable build and cross-platform packaging before adopting it. Keep auditing dev dependencies.

## Finding 2 — RustSec unsoundness warning: glib 0.18.5 (open)

- Advisory: `RUSTSEC-2024-0429` / `GHSA-wrw7-89jp-8q8g`.
- Affected `glib::VariantStrIter` iteration can trigger undefined behavior/crashes; patched `glib >= 0.20.0`.
- `glib 0.18.5` is in the locked Rust dependency graph through GTK/WebKit-related dependencies. The primary reviewed Windows/Tauri path does not establish that the vulnerable function is called. **Reachability is not proven**.
- **Action:** trace the Linux GTK/WebKit dependency path and upgrade the compatible GTK/Tauri/Wry stack where feasible; test Linux before making a runtime-impact claim.

## Finding 3 — Maintenance warning: proc-macro-error 1.0.4 (open)

- RustSec `RUSTSEC-2024-0370`: unmaintained package, not a reported exploit.
- **Action:** identify its transitive parent and migrate to a maintained dependency when supported upstream.

## Finding 4 — Release integrity: unsigned Windows builds (release gate)

- `.github/workflows/windows-build.yml` allows a manually authorized `publish_release` with unsigned installers, while `src/core/updates.cjs` correctly disables automatic update installation until signing/publisher trust are configured.
- `src-tauri/tauri.conf.json` builds unsigned preview NSIS/MSI separately from Electron.
- Unsigned distribution is vulnerable to publisher impersonation and raises SmartScreen warnings; a checksum manifest alone does not authenticate a trusted publisher.
- **Action:** before declaring either variant production-trusted, configure code signing, verify Authenticode signatures/publisher identity and a trusted distribution/update feed. Do not promote the experimental Rust preview without manual application testing.

## Finding 5 — Defense in depth: Tauri CSP and injected API (hardening)

- `src-tauri/tauri.conf.json` sets `app.security.csp: null` and `withGlobalTauri: true`.
- The renderer's `src/ui/index.html` **does** contain a restrictive CSP meta tag (`script-src 'self'`, `object-src 'none'`, `frame-src 'none'`, etc.). `scripts/prepare-tauri.cjs` expands only required custom artwork and IPC origins. Thus **this is not a confirmed exploitable XSS**.
- With an IPC API exposed to the renderer, a renderer injection would be a serious trust-boundary failure. Using a Tauri-level CSP/security configuration with tested compatibility would add defense in depth beyond the HTML meta policy.
- **Action:** validate a Tauri-managed CSP and keep any external navigation blocked by policy. Add regression tests for untrusted game names/artwork metadata rendered as HTML.

## Other controls inspected

| Surface | Observed protection / limitations |
| --- | --- |
| Electron IPC, `src/main.cjs` / `src/preload.cjs` | Context isolation, sandbox and no Node integration; main-frame sender checks, method allowlist; denied window opening and navigation. |
| Tauri IPC, `src-tauri/src/lib.rs` / capabilities | Local `main` window capability; bridge handles named methods. Current `tauri 2.12.5` is newer than patched versions for GHSA-w28w-mhc8-qvjv (`>=2.11.6`) and GHSA-7gmj-67g7-phm9 (`>=2.11.1`). |
| Renderer, `src/ui/app.js` / controller mode | Escapes game titles and attribute text in inspected template paths; local artwork token patterns constrained. This is not a complete DOM-fuzzing result. |
| Windows game launching | Rust uses `std::process::Command` with argument arrays; Electron uses `spawn(..., shell:false)`; allowed external launcher URI schemes are explicitly enumerated. User-selected executables are intentionally executable by design. |
| Steam/Epic online artwork | HTTPS exact host/path allowlist, redirects disabled in Rust reqwest client, bounded response sizes/short timeouts, setting and Performance Guard checks before requests. |
| Library/backups | SQLite placeholders for dynamic values in inspected paths, safe hard-coded SQL identifiers for migration/sort; gzip/archive limits, validated artwork tokens and import caps, atomic backup writes; no confirmed path traversal in reviewed flows. |
| Native Windows process helper | Read-only process enumeration with `PROCESS_QUERY_LIMITED_INFORMATION`; no elevation or injection path identified. |
| GitHub Actions | Least-privilege `contents: read` for validation jobs; release job receives `contents: write` only for manually authorized release. Many third-party actions use mutable tags rather than full commit SHA pins; pinning and Dependabot maintenance are future hardening work. |

## Remaining verification / limits

1. Security scanners analyzed **dependency locks** and patterns in **tracked current text files**. The pattern scan is not historical or entropy-based secret scanning. Run a full git-history scan before a public production release.
2. This audit **did not run** interactive Windows attack tests, malware scanning of distributable EXEs, a WebView2 exploit harness, code-signing checks, or dynamic fuzzing of hostile backup/images/protocol URIs.
3. Semgrep OSS `p/security-audit` source scanning was executed in run 41369304471 and reported **0 findings**. This rule set does not comprehensively cover every Rust unsafe block, C++ vulnerability, or business-logic flaw; no CodeQL analysis or external penetration test was performed. CodeQL upload on a private personal repository can require GitHub Code Security availability.
4. Re-test on Windows after future security patches and confirm the full app/child-process boundary and signature state, not merely Rust-parent metrics.
5. Re-run the weekly workflow and triage new RustSec and npm advisories, including moderate findings.

## Priority order

**P1:** plan a safe fix for `minimatch` via Electron build dependency chain; address `glib` on supported Linux configurations if reachable.  
**P1 release gate:** signed Windows distributions + publisher verification before public trusted release.  
**P2:** Tauri-level CSP and secure navigation test, SHA-pin CI actions, Dependabot for npm/Cargo; full history secret scan and dynamic malicious-content tests.

**Verdict:** Semgrep found 0 issues under the selected rules and no critical/high dependency advisories were reported, but **NOT a clean security bill**: the 15 moderate npm entries and two RustSec warnings remain open. Do not describe Orbit as guaranteed secure or release-ready solely because CI is green.
