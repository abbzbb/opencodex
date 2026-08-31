# Probe C service/runtime transaction (deterministic)

Date: 2026-08-31

## Scope and provenance

- App/runtime version: `2.36.0`
- Runtime: Bun `1.4.0`
- Isolated temporary stable roots (not homedir, XDG, or `OPENCODEX_HOME`)
- Service managers in this evidence are **injected fakes/seams**, not physical
  launchd, Task Scheduler, WinSW, or systemd processes

This records the deterministic transaction foundation and production bridge
wiring for PLAN Probe C. It does not close Probe C. Physical macOS launchd,
Windows scheduler/WinSW, Linux `.deb` systemd service smoke, and real packaged
desktop-direct survivor/update processes remain unproven.

## Commands

Recorded run used `OCX_TEST_NO_QUEUE=1`.

```bash
bun run typecheck
bun run typecheck:desktop

bun run test -- ./desktop/tests/service-activation.test.ts
bun run test -- \
  ./desktop/tests/codec.test.ts \
  ./desktop/tests/protocol.test.ts \
  ./desktop/tests/deadline.test.ts \
  ./desktop/tests/handlers.test.ts \
  ./desktop/tests/service-activation.test.ts

cargo test --manifest-path desktop/src-tauri/Cargo.toml

bun test ./desktop/tests

bun run test -- \
  ./desktop/tests/activation-journal.test.ts \
  ./desktop/tests/handlers.test.ts \
  ./desktop/tests/activation-lock.test.ts \
  ./desktop/tests/staging.test.ts \
  ./desktop/tests/install.test.ts \
  ./tests/service-runtime-identity.test.ts \
  ./tests/desktop-owner.test.ts \
  ./tests/service.test.ts \
  ./tests/stop-transaction.test.ts
```

No user configuration, tokens, account identifiers, or raw request bodies were
read or recorded.

## Result

- `bun run typecheck`: exit `0`
- `bun run typecheck:desktop`: exit `0`
- `desktop/tests/service-activation.test.ts`: `71` pass / `0` fail / `431` expects
- Remaining focused files above (`9` files): `254` pass / `0` fail / `1101` expects
- Production runtime activation focused files (`5` files): `143` pass / `0` fail / `981` expects
- Full Desktop suite: `243` pass / `0` fail / `1555` expects
- Tauri Rust unit tests: `45` pass / `0` fail

## Observed deterministic behavior

All install/repair/start/stop/uninstall/diagnose calls below are fake seams
unless an item names a real OS process.

- **Activation journal.** Owner-only checksummed exact-key envelope
  `ocx-activation-journal-v1` under `<stable-root>/activation.journal`. POSIX
  observe rejects a non-0600 mode. Write is temp + file fsync + rename; POSIX
  directory fsync failure fails the write. Compare-before replace/delete. The
  journal is intent; commit is delete after `current.json` is the intended
  post-image and candidate health is re-proven. Pointer remains the durable
  oracle.
- **Activation lock.** Cross-process directory lock
  `<stable-root>/activation.lock` with owner token, live PID, and
  compare-before-reclaim. Distinct from `current.lock` and the start lock. A
  real OS child that wrote a journal and held the lock was `SIGKILL`ed; the
  next owner recovered (fake service manager).
- **Verified stable resolution.** `runtimeManifestId` resolves through the
  hash-verified per-user stable store (`versions/<version>` and parent stable
  root). Canonical root is the identity parent, not `HOME` / XDG /
  `OPENCODEX_HOME`.
- **Exact service paths.** Candidate bun/cli compared with canonical path
  equality. Path races after ready or publish roll back or fail closed per
  inspect/ownership evidence; PID is corroboration only.
- **Transaction.** Snapshot current pointer + service state/paths; stop owned
  live/service and independently prove absence; install or repair to candidate
  absolute Bun/CLI; start; require identity-checked loopback `/readyz`; only
  then CAS-publish full `current.json` (current + previous); delete journal.
- **Partial install cleanup.** A mutation that writes service paths then throws
  rolls back; residual service does not restart desktop-direct.
- **Three-generation rollback.** Post-publish failure of C over B/A restores
  exact B/A and keeps generation A hash-verified.
- **Post-image finalize/rollback.** Healthy candidate (including replacement
  PID of the same identity) finalizes. Absent live with the journal pid marked
  dead rolls the published pointer back. Alive journal pid with no matching live
  record is `restore_failed`: pointer stays post-image, journal remains, no
  signal/restore/restart.
- **Successor / foreign / PID fail-closed.** Foreign live after publish retains
  the journal and does not rewind. Recycled journal pid without a runtime record
  is not signaled. Same-pid live that is not a proven owner is not stopped.
- **`canRespawn` absence window.** A proven manager stop
  `{ state: "stopped", canRespawn: true }` (fake outcome) does not by itself
  reject rollback. Even when the first post-stop live probe is absent, rollback
  invokes shared `runStopTransaction` and accepts only its proven `proxyAbsent`
  (existing `restore_failed` + `proxyAbsent: true` continues). First-absent then
  respawn during that window fails closed and keeps the journal. Stable absence
  through the window allows rollback to complete. No second window constant.
- **Bootstrap / status / staging journal awareness.** `status` peeks a live lock
  or valid/unreadable journal as pending and does not recover. `bootstrap`
  acquires the activation lock and recovers a valid stale journal without extra
  starts. Staging/install refuses to publish around an unresolved journal.
- **Production direct activation wiring.** With an existing current generation,
  Rust bootstraps/reconciles the old bridge before packaged staging. A distinct
  staged candidate is sent back to that old bridge only as a verified manifest
  id through `runtime-activate` after the old generation advertises that closed
  capability; the handler hard-codes direct mode and rejects
  external/service/conflict owners before stop. Success requires the bridge
  transaction to report ready plus an exact Rust re-read of
  `current=candidate, previous=old`, followed by bridge resolution and bootstrap
  from the new generation. Both bridge timeout envelopes and Rust watchdog
  timeouts inspect the candidate/previous post-image, resolve the bridge from
  that observed current, require matching owner/version/readiness, and compare
  the pointer again. The bridge allows a bounded best-effort abort-cleanup
  grace; cleanup still sees the aborted operation signal, so an unresolved
  journal is recovered by the next bootstrap. Activation is never replayed.

## Evidence boundary

This proves the Desktop bridge service-activation transaction against injectable
fakes and the shared stop-transaction absence window. It is **not** physical
platform service smoke and does not prove:

- macOS launchd install/crash-restart/repair/rollback
- Windows Task Scheduler or WinSW
- Linux `.deb` systemd user service
- packaged desktop-direct survivor re-attest after a real shell crash
- real-child old-to-new desktop-direct update and failed-update restart from
  the previous absolute paths (the production bridge path is wired; current
  deterministic child/service effects are injected seams)
- WebView, session/CSRF, navigation, tray, single-instance, signing, or
  autoupdate

Architect **WATCH** (not a code blocker): service-path / global-stop shared-lock
race remains open. Probe C stays **OPEN**.
