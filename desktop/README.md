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
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path desktop/src-tauri/Cargo.toml

# Target-native payload (run on the matching target host)
bun desktop/scripts/build-runtime.ts \
  --target x86_64-unknown-linux-gnu \
  --output desktop/src-tauri/resources/runtime
bun desktop/scripts/validate-packaging.ts --require-real \
  --target x86_64-unknown-linux-gnu
```

Do not run the repository-wide `bun run test` for desktop-only runtime/staging
work.

## Current limitations

- Phase 1 foundation. The shell, bridge, and stable runtime are not a releasable App yet.
- Target-native payload generation now produces a production dependency closure,
  target Bun/keyring packages, and a verified manifest. Debug builds may create a
  compile placeholder, while release builds require the real resource payload.
- Stable staging is Bun-native and injectable (`expectedTarget`,
  `enforceExecutableBit`), but App startup does not yet deploy the packaged Tauri
  resource into the per-user stable root before bridge bootstrap.
- `current.json` is an atomic file pointer. It is not a symlink contract.
- One rollback generation is retained. Older trees are pruned only when no
  current/previous pointer or `isVersionReferenced` guard names them.
- Desktop does not read, cache, inject, or log dashboard sessions, management
  tokens, API keys, or OAuth tokens.
- Automatic updates are not enabled. Signed installers and updater
  fault-injection are later-phase gates.
- Linux AppImage is portable-only: no service, deep-link, or autoupdate promise
  until a post-install probe proves otherwise.

## Platform smoke gaps

None of the PLAN §9.2 install-time smokes have been run. Explicit gaps:

| Gap | Platforms |
|---|---|
| Clean machine without Node/Bun/npm/global `ocx` | macOS arm64/x64, Windows x64, Linux x64 `.deb` |
| Packaged resource → stable runtime → `src/cli/index.ts start` → `/readyz` | all first-ship targets |
| Target-native module load (no host-arch stand-in) | all first-ship targets |
| Session bootstrap, CSRF write, 6-minute hide/reopen renewal | all first-ship WebViews |
| Exact-origin navigation + system-browser handoff | all first-ship WebViews |
| Cold/hot start, 20× double-click, single-instance | all first-ship targets |
| Tray quit / Cmd+Q stop+restore; dashboard Stop does not respawn | all first-ship targets |
| `desktop-service` install/crash-restart/repair/rollback | macOS, Windows, Linux `.deb` (not AppImage) |
| Surviving desktop-direct re-attest after shell crash | all first-ship targets |
| External npm proxy: connect only, no migrate/update | all first-ship targets |
| Signed update + rollback fault injection | not started; autoupdate UI must stay off |

Probe evidence, when it exists, belongs in `desktop/probes/` (commands, versions,
redacted logs, screenshots). No tokens, request bodies, or account identifiers.
