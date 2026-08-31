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
- build uses the first-party `./.github/actions/setup-project-bun`
- path filter covers `src/**`, `package.json`, `bun.lock`, `gui/**`,
  `desktop/**`, the workflow, and the setup action
- push trigger is `main`, `preview`, and `dev` only
- two-generation live probe runs after the runtime build, before `dpkg`
- systemd smoke resets `PATH=/usr/bin:/bin`, sets
  `OCX_DESTRUCTIVE_SYSTEMD_PROBE=1`, and invokes `/usr/bin/ocx-runtime` only
- failure logs are bounded `systemctl`/`journalctl` tails

## After push, observe

Job `linux-deb-systemd` is **CI-pending** for the exact commit. Both of these
must exit 0:

1. Step `Probe desktop-direct two-generation` — path-free two-generation JSON
   (`sourceOverlay: true`, `failureFixture: cooperative-ready-failed`). See
   [`probe-c-desktop-direct-two-generation.md`](./probe-c-desktop-direct-two-generation.md).
2. Step `Probe systemd from package-owned runtime` — one JSON line:

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
equal to those paths, the failed candidate process is absent, the journal is
cleared, and rollback starts a new previous-generation PID. Failed repair must
return `proxy_not_ready` after a `/readyz`-hit marker from the cooperative
ready-failed fixture. Exact byte canaries in isolated `OPENCODEX_HOME` and
`CODEX_HOME` (including a journal-shaped Codex file) must be unchanged after
crash, successful repair, failed-repair rollback, stop, and uninstall.

Those lines are the only success evidence. Probe C stays OPEN until this job is
green for the exact commit, and until macOS/Windows physical smokes and actual
Tauri old/new package evidence exist. The runtime-layout `.deb` limitation stays
explicit.
