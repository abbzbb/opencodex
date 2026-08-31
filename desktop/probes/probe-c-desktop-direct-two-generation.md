# Probe C real-process two-generation desktop-direct

Date: 2026-08-31

## Scope

Real packaged/stable runtime child processes and filesystem-backed
`desktop-direct-owner.json` / `runtime-port.json` records. No injected
`startDirect` / `findLiveProxy` fakes. Isolated temp homes. Not physical
launchd, WinSW, or systemd.

This is **source-overlay live-process evidence**. The candidate tree is the
freshly built runtime (`OCX_PROBE_RUNTIME_ROOT` in CI, or the packaged payload
under `desktop/src-tauri/resources/runtime` locally) with current
`desktop/runtime` and `src` overlaid so `runtime-activate` exists. It is **not**
evidence of two immutable packaged Desktop releases. Actual Tauri old/new
package evidence remains OPEN.

The failed candidate is a **cooperative ready-failed fixture** (`failureFixture:
cooperative-ready-failed`): a manifest-valid CLI that starts, consumes the
launch descriptor, publishes owner/runtime records, hits `/readyz` with
`failed`, then honors `POST /api/stop`. It is not a chmod of the staged Bun
binary and not a second packaged release.

The live ready-failed rollback is **CI-pending**. It runs on GitHub-hosted
`ubuntu-latest` in `.github/workflows/desktop-linux-systemd-probe.yml` after
the runtime is built and before `dpkg`/systemd mutation, using
`OCX_PROBE_RUNTIME_ROOT`. Local host zombie/reaping is an environment
limitation, not a recorded success.

## Commands

Live probe (CI):

```bash
OCX_PROBE_RUNTIME_ROOT=<built-runtime> bun desktop/scripts/probe-desktop-direct-two-generation.ts
```

Contract tests (local / PR):

```bash
bun run typecheck
bun run typecheck:desktop

bun test ./desktop/tests/probe-desktop-direct-two-generation.test.ts
bun test ./desktop/tests/probe-linux-deb-systemd.test.ts
bun test ./tests/ci-workflows.test.ts
```

Stdout is one JSON object. No tokens, account ids, request bodies, or user paths.

## Recorded result

Live two-generation ready-failed rollback: **CI-pending**. No local exit-0
rollback result is recorded for this revision. Observe job
`linux-deb-systemd` step `Probe desktop-direct two-generation` for the exact
commit. The JSON shape on success is:

```json
{
  "schemaVersion": 1,
  "target": "x86_64-unknown-linux-gnu",
  "oldVersion": "2.36.0",
  "newVersion": "2.36.0+new",
  "survivorReattest": true,
  "activateCommitted": true,
  "childRecordsReady": true,
  "candidateFailureRolledBack": true,
  "conflictFailClosed": true,
  "generationsRetained": true,
  "filesystemOwnerRecords": true,
  "injectedDependencySeams": false,
  "webviewEvidence": false,
  "sourceOverlay": true,
  "failureFixture": "cooperative-ready-failed"
}
```

`oldVersion` is the built runtime version; `newVersion` / fail version are
allocated so they cannot collide with that source version.

## Proven when the CI command exits 0

- Second bootstrap re-attests the surviving direct child (same PID).
- `runtime-activate` of a staged newer generation starts from the new absolute
  Bun/CLI paths. Owner-record canonical paths and NUL-delimited `/proc` argv
  match `newRoot` exactly (`argv[0]` Bun, `argv[1]` CLI). `current=new`,
  `previous=old` commit only after child records and strict `/readyz`.
- A cooperative ready-failed fixture starts, consumes the launch descriptor,
  publishes filesystem owner/runtime records, writes a `/readyz`-only hit
  marker, and returns strict `/readyz` failed. After publish it retains/reads
  that `ownerId`. On `/api/stop` and SIGTERM/SIGINT it compare-before-removes
  its own owner, runtime-port, and pid records with the production APIs scoped
  to that PID/`ownerId`, then exits after flushing the stop JSON. The production
  operation fails with `proxy_not_ready` after that start. If the code differs,
  the probe diagnostic is only the bounded error code and a fixed message
  category. Pre-failure PID is stopped, the
  candidate PID existed and is absent afterward, the restored PID differs from
  both, restored owner records plus argv match the previous generation's exact
  canonical Bun/CLI paths, and the activation journal is absent.
- Tampered ownership fails closed: `current.json` bytes stay identical and every
  staged generation, including the failed candidate, is re-verified.

## Evidence boundary

This does not close Probe C. It does not prove two immutable Tauri packaged
releases, macOS launchd, Windows scheduler/WinSW, Linux `.deb` systemd
user-service smoke, WebView, or autoupdate. The Linux `.deb` systemd slice is
in the same workflow after this step and is separately unproven until that
step is green for the exact commit.
