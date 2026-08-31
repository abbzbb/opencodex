# Probe C Linux .deb systemd user-service (CI)

Date: 2026-08-31

## Evaluation

This host has a systemd user session, but a real `.deb` install would mutate the
machine package database and login units. Probe B already isolated `dpkg` in a
Debian container, and that container is `--init`, not a systemd user manager.
The physical `.deb` systemd smoke therefore runs on GitHub-hosted
`ubuntu-latest` only.

This is a **runtime-layout** `.deb` (`usr/bin/ocx-runtime` plus
`usr/lib/OpenCodex/resources/runtime`). It is not the Tauri GUI package and is
not macOS or Windows evidence. The synthetic `.deb` remains installed on the
ephemeral runner until GitHub tears the VM down; this job does not run
`dpkg -r`.

The probe is hard-gated: `GITHUB_ACTIONS=true` and
`OCX_DESTRUCTIVE_SYSTEMD_PROBE=1` (set by the workflow). Before mutation the
production unit, `default.target.wants` symlink, active/loaded service, and both
default and isolated `service-state.json` files must be absent. Presence uses
`lstat`, so a broken wants symlink still counts. Manager absence is fail-closed:
one `systemctl --user show` of `LoadState` and `ActiveState` must succeed with
known nonempty fields; only `LoadState=not-found` and `ActiveState=inactive` are
absent. Cleanup uses a separately named conservative fallback that treats
unreadable manager state as loaded/active, still unlinks the wants link before
the unit file, and removes/stops only artifacts created by this run, including
when `service-install` times out or returns failure. Successful uninstall must
restore the full captured baseline using strict observation before
`stopUninstallCleanup` is true.

The same workflow first runs the desktop-direct two-generation live probe
against the freshly built runtime (`OCX_PROBE_RUNTIME_ROOT`), before `dpkg`
and systemd mutation.

## Workflow

`.github/workflows/desktop-linux-systemd-probe.yml`

- `permissions: contents: read`
- no secrets, no `pull_request_target`, no untrusted artifacts
- `actions/checkout` pinned to `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` with
  `persist-credentials: false`
- build uses the first-party `./.github/actions/setup-project-bun`, then
  `bun run build:gui`, then `build-runtime` (so `gui/dist` exists before pack)
- path filter covers `src/**`, `package.json`, `bun.lock`, `gui/**`,
  `desktop/**`, the workflow, and the setup action
- push trigger is `main`, `preview`, and `dev` only
- two-generation live probe runs after the runtime build, before `dpkg`
- after `dpkg -i`, a prepare step writes a private directory under
  `RUNNER_TEMP` with symlinks for a fixed allowlist (`sh`, `systemctl`,
  `kill`, `ps`, `ss`, `lsof`, `cp`, `cat`) resolved from `/usr/bin` then `/bin`; it fails
  if any required tool is missing and does not include `node`, `bun`, `npm`,
  `ocx`, or `opencodex`
- systemd smoke sets step env `PATH` to that private directory and, inside the
  step, exports `PATH` to it again (`GITHUB_PATH` from setup-bun is prepended
  to the live PATH even when step env PATH is the allowlist). It then checks
  `bun`/`node`/`npm`/`ocx`/`opencodex` one at a time so a hit names the
  command and its resolved path. `OCX_DESTRUCTIVE_SYSTEMD_PROBE=1`, and
  `/usr/bin/ocx-runtime` is invoked absolutely. After the CI and
  no-global-runtime gates the probe copies `process.env.PATH` onto `env.PATH`
  so install/bridge/direct children and the systemd unit inherit the same
  restricted PATH. The unit still uses `/bin/sh -lc`, then `PATH=<baked>;
  export PATH;` before token `cat` and `exec`, because `-lc` reloads
  `/etc/profile`. Failure logs still use `PATH=/usr/bin:/bin`

## Recorded result

Job `linux-deb-systemd` **passed** at commit
`898e4bebf6bf61ec90e1c54e9df74be04d38a028`, run
[33387507384](https://github.com/abbzbb/opencodex/actions/runs/33387507384)
(2m43s). This is a runtime-layout `.deb`, not a Tauri GUI package.

1. Step `Probe desktop-direct two-generation` — recorded in
   [`probe-c-desktop-direct-two-generation.md`](./probe-c-desktop-direct-two-generation.md).
2. Step `Probe systemd from package-owned runtime` — stdout JSON:

```json
{
  "schemaVersion": 1,
  "target": "x86_64-unknown-linux-gnu",
  "package": "open-codex",
  "unitAbsoluteStablePaths": true,
  "ocxServiceIdentity": true,
  "readiness": "ready",
  "crashRestartNewPid": true,
  "repairCommitted": true,
  "repairRollback": true,
  "stopUninstallCleanup": true,
  "userConfigPreserved": true,
  "globalJsRuntimeUsed": false,
  "tauriGuiPackage": false,
  "webviewEvidence": false,
  "injectedDependencySeams": false,
  "failureFixture": "cooperative-ready-failed"
}
```

Independently of that JSON, the systemd step must prove after crash, repair
success, and repair rollback: MainPID changed, exact owner/version plus strict
`/readyz`, the full current/previous pointer pair, loaded `ExecStart` bound to
the exact `exec '<bun>' '<cli>' ` token and MainPID NUL-delimited argv[0]/argv[1]
equal to those paths, `/proc/<MainPID>/environ` PATH equal to the restricted
allowlist PATH (so `/bin/sh -lc` profile restore did not regain `/usr/bin:/bin`),
the failed candidate process is absent, the journal is cleared, and rollback
starts a new previous-generation PID. Failed repair must
return `proxy_not_ready` after a `/readyz`-hit marker from the cooperative
ready-failed fixture, which compare-before-removes its own owner/runtime/pid
records on stop and signal and writes `probe-stub-cleanup` `ok`. A differing
error code is reported as the bounded code plus a fixed message category only.
The same job's two-generation step uncovered Linux zombie liveness
(`restore_failed/owned-live-graceful-stop`); `isProcessAlive` now treats
`/proc/<pid>/stat` `Z`/`X` as not alive after `kill(pid,0)`. Exact byte canaries in isolated `OPENCODEX_HOME` and
`CODEX_HOME` (including a journal-shaped Codex file) must be unchanged after
crash, successful repair, failed-repair rollback, stop, and uninstall.

Those lines are the recorded success evidence for this Linux runtime-layout
slice. Probe C stays OPEN until macOS/Windows physical smokes, WebView,
signing/updater, and actual Tauri old/new package evidence exist. The
runtime-layout `.deb` limitation stays explicit.
