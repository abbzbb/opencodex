# OpenCodex Desktop

Native shell around the existing Bun proxy. Product boundaries live in
[`PLAN.md`](./PLAN.md). This directory is a downstream App unit; it does not
rewrite `src/` authentication, routing, or stop/restore.

## Ownership

Desktop never infers owner from PID, port, `OCX_SERVICE=1`, or file existence
alone.

| Owner | Meaning | App may |
|---|---|---|
| `existing-external` | npm or another launcher | connect only; no update/migrate/delete |
| `desktop-direct` | App-started proxy, no service; owner/runtime records agree | stop, update via stable runtime, restart |
| `desktop-service` | service Bun/CLI paths sit in the Desktop stable runtime | repair/start/stop/uninstall that service |
| `unknown/conflict` | evidence missing or mismatched | fail closed; show repair commands; do not delete the runtime tree |

`stop` still uses the shared CLI transaction and the same home/identity checks.
That permission does not extend to updating or deleting an external install tree.

## Lifecycle

| Event | Owner | Required result |
|---|---|---|
| Cold start, no service/proxy | bridge | start one desktop-direct, wait `/readyz`, then show the window |
| Cold start, service installed + startable | bridge + `src/service.ts` | start/wait service; do not spawn a direct child |
| Cold start, service installed + not-startable/conflict | bridge | fail closed; no direct fallback |
| Any live OpenCodex proxy | bridge | attach the canonical origin; do not start a second proxy |
| Second App launch | single-instance | hand argv/deep link to the first instance and focus it |
| Close window | Rust shell | hide to tray; proxy keeps running |
| Tray quit / Cmd+Q | bridge stop | stop + restore + prove absent, then exit; on failure keep the shell |
| Dashboard Stop | proxy + Rust shell | show stopped; do not auto-respawn |
| desktop-direct crash | Rust shell | show failure and Retry; no restart loop |
| service child crash | `src/service.ts` | wait for the supervisor replacement and re-bootstrap |
| Shell killed/crash | OS | no implicit stop; next launch reconnects |
| Shutdown/logout | OS + existing lifecycle | no second restore path |

## Data layout

The App copies a target-specific payload from signed resources into a per-user
**stable runtime root** (shell-resolved app data, not `~/.opencodex`). Service
and desktop-direct processes must never point at a DMG/AppImage mount or an
in-place overwritten resource path.

```text
<stable-root>/
  current.json          # atomic pointer, not a symlink
  current.lock          # exclusive publisher lock (transient)
  versions/<version>/   # hash-verified payload plus runtime-manifest.json
  staging/<temp>/       # unpublished copy; never current
```

`current.json` names the active generation and at most one previous generation
for rollback. Publication is compare-and-swap. A failed stage or publish must
leave the previous current tree runnable. `staging/` and `versions/` must be
real directories under the stable root; child symlinks are rejected.

App bootstrap uses two separate closed process contracts. The packaged Bun first
runs `desktop/runtime/install.ts` from Tauri's resolved resource directory. Its
stdin contains only schema version, target triple, and the per-user stable root;
its stdout is one bounded JSON object. It publishes only when `current.json` is
missing, reuses an identical generation, and leaves a different current active
while retaining the newly staged candidate. Rust then runs the existing v1
`desktop/runtime/bootstrap.ts` bridge from the verified stable generation. The
installer is not a v1 bridge operation and neither process accepts arbitrary
CLI argv.

`OPENCODEX_HOME` (`~/.opencodex`) stays the proxy config/credential/log home and
is not migrated by Desktop. `$CODEX_HOME` journals are not touched.

## Commands

```bash
# Desktop runtime + tests (noEmit)
bun x tsc --noEmit -p desktop/tsconfig.json

# Isolated desktop tests. Root bunfig only discovers tests/, so reset the root
# and keep scripts/test.ts for an isolated home and the machine test lock.
bun scripts/test.ts --root ./desktop/tests

# Tauri/Rust, once the crate is the change under test
cargo fmt --check --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib

# Target-native payload (run on the matching target host)
bun desktop/scripts/build-runtime.ts \
  --target x86_64-unknown-linux-gnu \
  --output desktop/src-tauri/resources/runtime
bun desktop/scripts/validate-packaging.ts --require-real \
  --target x86_64-unknown-linux-gnu

# Probe A HTTP session/CSRF/renewal contract (not a physical WebView).
# Stdlib plus desktop contract/runtime origin parent installs HOME/USERPROFILE/
# OPENCODEX_HOME/CODEX_HOME in a child process before any src/server import.
# An outside-root decoy home must remain byte-for-byte unchanged.
# Local shell eval is dispatch-only; diagnostic show waits for an app-local
# DOM ack (canonical URL + epoch + marker + attempt). Reload is generation-
# bound ReloadingShell via ?ocx-reload=<lowercase-hyphenated-uuid> (raw query,
# not fragment, not a percent-encoded alias). PageLoad classifies payload.url()
# only. Non-default ports are rejected; url::Url drops explicit HTTP :80, so
# that spelling is canonical same-origin. Navigate Ok is dispatch-only.
# Physical WebView rendering remains OPEN.
bun desktop/scripts/probe-a-session.ts

# After building a release .deb, verify its extracted install layout without
# installing it or launching the WebView. This executes the packaged runtime;
# use only a trusted local build or a digest from a trusted release channel.
bun desktop/scripts/probe-linux-deb.ts \
  --deb desktop/src-tauri/target/release/bundle/deb/OpenCodex_2.36.0_amd64.deb \
  --sha256 <trusted-lowercase-sha256>

# Real dpkg install in a pinned Debian 13 container. Proves desktop-direct
# /readyz and structured stop. Does not prove WebView/session/CSRF/navigation.
bun desktop/scripts/probe-linux-deb-postinstall.ts \
  --deb desktop/src-tauri/target/release/bundle/deb/OpenCodex_2.36.0_amd64.deb \
  --sha256 <trusted-lowercase-sha256>
```

Do not run the repository-wide `bun run test` for desktop-only runtime/staging
work.

## Current limitations

- Phase 1 foundation. The shell, bridge, and stable runtime are not a releasable App yet.
- Target-native payload generation now produces a production dependency closure,
  target Bun/keyring packages, and a verified manifest. Debug builds may create a
  compile placeholder, while release builds require the real resource payload.
- App startup deploys the packaged Tauri resource into the per-user stable root
  before bridge bootstrap. Debug builds skip that deployment only when
  `OCX_DESKTOP_RUNTIME_ROOT` explicitly selects a development runtime tree;
  release builds never honor the override.
- `current.json` is an atomic file pointer. It is not a symlink contract.
- Ownership-aware activation retains one rollback generation and prunes older
  trees only when no current/previous pointer or `isVersionReferenced` guard
  names them. First-start packaged sync retains every staged version until that
  later activation transaction has service/PID ownership evidence.
- Desktop does not read, cache, inject, or log dashboard sessions, management
  tokens, API keys, or OAuth tokens.
- Automatic updates are not enabled. Signed installers and updater
  fault-injection are later-phase gates.
- Linux AppImage is portable-only: no service, deep-link, or autoupdate promise
  until a post-install probe proves otherwise.

## Platform smoke gaps

The full PLAN §9.2 install-time smokes have not been run. Linux x64 Debian now
has two probes:

- Extracted layout / stopped stable `status`:
  [`phase1-linux-deb-resource-layout.md`](./probes/phase1-linux-deb-resource-layout.md)
- Real `dpkg` install, App launch, `desktop-direct` `/readyz`, structured stop,
  package removal:
  [`phase1-linux-deb-postinstall.md`](./probes/phase1-linux-deb-postinstall.md)

Deterministic Probe C transaction foundation is implemented
([`probe-c-service-runtime-transaction.md`](./probes/probe-c-service-runtime-transaction.md)):
checksummed owner-only journal, cross-process activation lock, verified stable
resolution, exact service paths, stop / install-or-repair / start / strict
ready / full-pointer publish, rollback, and the canonical `canRespawn` absence
window. The production shell now preflights the old generation before staging,
issues a closed `runtime-activate` request only for a proven `desktop-direct`,
verifies the committed new/previous pointer, and bootstraps again from the new
generation. The old generation must advertise that operation in
`allowedMutations`; pre-feature development packages have no in-place upgrade
compatibility promise. Timeout envelopes and process-watchdog timeouts both
reconcile through the bridge selected by the observed current pointer and
require owner/version/readiness plus a second pointer read. Cleanup after abort
is best-effort; a pending durable journal is recovered by the next bootstrap
rather than treated as a completed rollback. Service/process managers in this
evidence are fakes/seams, not
physical platform or packaged old/new child smoke. A real-process two-generation
desktop-direct probe is in
[`probe-c-desktop-direct-two-generation.md`](./probes/probe-c-desktop-direct-two-generation.md).
That probe is source-overlay live-process evidence (packaged payload plus current
`desktop/runtime` and `src`), not two immutable packaged Desktop releases. Actual
Tauri old/new package evidence remains OPEN. The live ready-failed rollback and
the Linux runtime-layout `.deb` systemd user-service smoke are recorded pass
for commit `898e4bebf6bf61ec90e1c54e9df74be04d38a028` in
`.github/workflows/desktop-linux-systemd-probe.yml` job `linux-deb-systemd`
(run [33387507384](https://github.com/abbzbb/opencodex/actions/runs/33387507384),
2m43s; [`probe-c-linux-deb-systemd.md`](./probes/probe-c-linux-deb-systemd.md)).
The `.deb` is a runtime-layout package, not macOS/Windows or Tauri GUI
evidence. The systemd step PATH is a private `RUNNER_TEMP` allowlist,
re-exported inside the step so `GITHUB_PATH` from setup-bun cannot prepend
`bun` (step env PATH alone is not the live PATH). That workflow also covers
Linux zombie liveness (`/proc/<pid>/stat` `Z`/`X` after `kill(pid,0)`), which
it uncovered as `restore_failed/owned-live-graceful-stop`. Probe C remains
OPEN. The service-path / global-stop shared-lock race remains WATCH.

Neither Linux `.deb` probe is WebView, session/CSRF, or navigation evidence.
HTTP-level Probe A evidence is in
[`probe-a-webview-session-navigation.md`](./probes/probe-a-webview-session-navigation.md):
loopback dashboard session bootstrap, CSRF write, `/opencodex-session` renewal
document, wildcard bind without a session, exact-origin hash-route URLs,
revocable identity-bearing attachment, platform-specific canonical app-local
allowlist, serialized status/attach transactions, and new-window deny. The live
probe parent is stdlib plus the desktop contract/`runtime/origin` (it does not
import `src/`); the child is spawned with isolation env, `OCX_TEST_HOME_GUARD`,
and `OCX_REAL_HOME` pointing at an outside-root decoy whose `.opencodex` and
`.codex` trees must stay unchanged. It does not prove a physical WebView, a
6-minute hide/reopen, or an OAuth click.
The post-install probe directly asserted no Codex CLI and checked the full
`current.json` identity plus uninstall (resource tree gone and package not
installed). `/readyz` used the proven-absent `config.toml` no-op.

Explicit gaps:

| Gap | Platforms |
|---|---|
| Clean machine without Node/Bun/npm/global `ocx` | macOS arm64/x64, Windows x64; Linux x64 `.deb` passed in Debian 13 Docker |
| Installed App resource layout → stable runtime → `src/cli/index.ts start` → `/readyz` | macOS/Windows still open; Linux x64 `.deb` passed post-install `/readyz` without WebView |
| Target-native module load (no host-arch stand-in) | macOS arm64/x64 and Windows x64; Linux x64 passed from the extracted `.deb` stable generation |
| Session bootstrap, CSRF write, 6-minute hide/reopen renewal | HTTP bootstrap/CSRF/renewal document proven in a HOME/CODEX_HOME sandbox; physical WebView and 6-minute hide/reopen still open on all first-ship WebViews |
| Exact-origin navigation + system-browser handoff | Identity-bearing attach, app-local allowlist, transactional rollback, and new-window deny proven in Rust; physical WebView click/OAuth handoff still open on all first-ship WebViews |
| Cold/hot start, 20× double-click, single-instance | all first-ship targets |
| Tray quit / Cmd+Q stop+restore; dashboard Stop does not respawn | all first-ship targets |
| `desktop-service` install/crash-restart/repair/rollback | macOS, Windows, Linux `.deb` (not AppImage) |
| Surviving desktop-direct re-attest after shell crash | all first-ship targets |
| External npm proxy: connect only, no migrate/update | all first-ship targets |
| Signed update + rollback fault injection | not started; autoupdate UI must stay off |

Probe evidence, when it exists, belongs in `desktop/probes/` (commands, versions,
redacted logs, screenshots). No tokens, request bodies, or account identifiers.
