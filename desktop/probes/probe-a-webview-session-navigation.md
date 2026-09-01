# Probe A WebView session, CSRF, and navigation (HTTP + policy)

Date: 2026-09-01

## Scope and provenance

- Product source base: `app/desktop` plus Probe A review-fix rounds
- App/runtime version: `2.36.0`
- Isolated child process: HOME, USERPROFILE, OPENCODEX_HOME, CODEX_HOME
- Parent is stdlib plus `desktop/scripts/probe-a-contract.ts` / `desktop/runtime/origin` (not stdlib-only, and not `src/`)
- Child `OCX_REAL_HOME` is the outside-root decoy; `OCX_TEST_HOME_GUARD=1` is set before production imports
- Outside-root decoy `.opencodex` and `.codex` trees must remain byte-for-byte and metadata stable (entries, bytes, type, size, mode; symlink/type only when `decoySymlinkCoverage=covered`)
- Native Codex/Grok/Claude Desktop integrations explicitly disabled in the child config

This records the automated Probe A contract. It does **not** close Probe A.
Physical top-level WebView rendering, a 6-minute hide/reopen write, a real
OAuth click, and macOS/Windows WebView evidence remain OPEN.

## Commands

```bash
cargo fmt --check --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path desktop/src-tauri/Cargo.toml
bun x tsc --noEmit -p desktop/tsconfig.json
bun scripts/test.ts --root ./desktop/tests
bun desktop/scripts/probe-a-session.ts
bun run privacy:scan
git diff --check
```

## Result

```text
{"schemaVersion":1,"bind":"loopback","dashboardHtml":true,"sessionBootstrap":true,"csrfWrite":true,"csrfRejectedWithoutToken":true,"sessionRenewalDocument":true,"hashRouteUrlSameOrigin":true,"wildcardBindHasNoSession":true,"frameAncestorsDenied":true,"sandboxIsolated":true,"decoyUnchanged":true,"decoySymlinkCoverage":"covered","importedPathsInsideSandbox":true,"webviewEvidence":false,"hideRenewalEvidence":false}
```

`hashRouteUrlSameOrigin` is HTTP URL construction in the isolated child, not
Rust WebView navigation (that remains cargo-tested). `decoySymlinkCoverage` is
`covered` on this Linux host; Windows without Developer Mode reports
`unsupported` and must not be read as symlink evidence.

`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and
`cargo test` for `desktop/src-tauri` passed (104 lib tests). Desktop TypeScript
`tsc --noEmit` passed. `bun scripts/test.ts --root ./desktop/tests` passed
(280 tests). Success stdout of `probe-a-session.ts` is the single JSON object
above.
`sandboxIsolated` is claimed only after the child proves the test-home guard is
armed, decoy-protected homes sit inside the decoy root and outside the sandbox,
`src/codex/paths` module-load constants resolve inside the sandbox, and the
parent full-tree decoy snapshot is unchanged. No session tokens, CSRF tokens,
request bodies, or account identifiers are written here.

## Evidence boundary

Proven in automation:

- Identity-bearing attach (origin + pid + owner + version)
- Status-only Tray Open / single-instance; no bootstrap after Stop
- Epoch/CAS drops stale ready rollback and out-of-order stopped/ready
- Explicit Quit holds the transition lock from spec resolution through stop and
  Exit/StayVisible; Tray Status resolves `default_bridge_spec` only while locked
- Stale attach commit syncs policy from the held ledger (no mutex reentry)
- Platform-specific canonical app URL (Unix `tauri://localhost/`, Windows/Android
  default `http://tauri.localhost/`); inactive tauri/http/https forms rejected.
  Non-default ports are rejected. `url::Url` drops explicit HTTP `:80`, so
  `http://tauri.localhost:80/` is the same origin as `http://tauri.localhost/`.
- Shell reveal hides an attached dashboard, queues `PendingShell`, and does
  not show on `eval` dispatch. Canonical `PageLoadEvent::Finished` blocking-locks
  phase then the consolidated shell session (not `try_lock`, not the
  transition mutex), may dispatch eval, and does not show. Show happens only
  after `ack_shell_render` CAS (canonical URL + epoch + marker + attempt + Running).
  One delayed ack timer is armed only after a successful eval dispatch. Eval
  dispatch failure keeps the attempt and enqueues one immediate background
  handoff; PageLoad never hide/navigates on Err. Reload CAS enters
  `ReloadingShell { epoch, generation }` (not dispatchable). Retry navigate uses
  `?ocx-reload=<generation>` (query, not fragment; WebView2 fragment-only
  Navigate does not emit Finished). Invalid generation does not mint a URL.
  PageLoad classifies `payload.url()` only. Matching
  generation may return to `PendingShell` and arm the next eval. Window missing,
  navigate dispatch Err, or load-watchdog expiry exact-CAS that generation to
  Hidden. `WebView::navigate` Ok is dispatch-only. Physical diagnostic rendering
  remains OPEN. Live epoch recheck still drops shell E after attach E+1 has started.
- Live loopback session bootstrap, CSRF write, renewal document
- Probe parent does not import `src/`; child isolation env, decoy `OCX_REAL_HOME`,
  and `OCX_TEST_HOME_GUARD` are set first. Child asserts `src/codex/paths`
  constants plus armed protected decoy homes.
- Open/Status/bootstrap require `QuitPhase::Running` after the transition lock
- `LoadingShell` until the first canonical Finished (marks `Shell` without
  showing when there is no diagnostic). `eval` is dispatch-only; the window
  is shown only after a canonical-URL `ack_shell_render` CAS on epoch+marker+attempt
  while phase is Running. Physical diagnostic rendering remains OPEN.
- Final attach/reveal/show abort when phase is no longer Running. `fail_pending_shell`
  is CAS on the exact PendingShell epoch+marker and does not clobber Shell.

Not proven:

- Tauri WebView rendering or navigation callbacks on a display
- Hide for 6 minutes then the first management write
- OAuth URL actually opening the platform browser from a WebView click
- macOS / Windows WebView
