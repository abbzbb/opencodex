# Phase 1 Linux Runtime Closure Probe

Date: 2026-08-29

## Environment

- Target: `x86_64-unknown-linux-gnu`
- Runtime: Bun `1.4.0`
- App/runtime version: `2.36.0`
- Global Node/Bun/npm/ocx: not used by the generated payload smoke

## Commands

```bash
bun desktop/scripts/build-runtime.ts \
  --target x86_64-unknown-linux-gnu \
  --output <temporary-output>/runtime

cargo check --release --manifest-path desktop/src-tauri/Cargo.toml
bun desktop/scripts/validate-packaging.ts --require-real \
  --target x86_64-unknown-linux-gnu

<temporary-output>/runtime/ocx-runtime-x86_64-unknown-linux-gnu \
  desktop/runtime/bootstrap.ts
```

The bridge request was supplied as one v1 `status` JSON object on stdin with an
isolated empty `HOME`, `OPENCODEX_HOME`, and `CODEX_HOME`.

## Result

- Builder exit: `0`
- Manifest entries: `4728`
- Payload size: approximately `284 MiB`
- Retained Bun native package: `bun-linux-x64`
- Retained keyring native package: `keyring-linux-x64-gnu`
- Native keyring import smoke: pass
- Tauri release-profile check with the real resource payload: pass
- Real sidecar/resource packaging validation: pass
- Release-profile check after removing the real payload: refused with the expected fail-closed diagnostic
- Bridge exit: `0`
- Bridge stdout: one valid v1 `status=stopped` envelope
- Bridge stderr: `0` bytes

This proves the host-target production dependency closure and short-lived bridge
execution. It does not prove Tauri resource staging, installation, WebView behavior,
service repair, signing, or another target platform.
