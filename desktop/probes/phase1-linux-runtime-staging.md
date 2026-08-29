# Phase 1 Linux Runtime Staging Probe

Date: 2026-08-30

## Environment

- Target: `x86_64-unknown-linux-gnu`
- Runtime: Bun `1.4.0`
- App/runtime version: `2.36.0`
- Stable root and proxy homes: isolated temporary directories

## Commands

```bash
bun desktop/scripts/build-runtime.ts \
  --target x86_64-unknown-linux-gnu \
  --output <tmp>/runtime

cd <tmp>/runtime
./ocx-runtime-x86_64-unknown-linux-gnu desktop/runtime/install.ts \
  < <tmp>/install-request.json

# Run the same exact request again to prove idempotent reuse.
./ocx-runtime-x86_64-unknown-linux-gnu desktop/runtime/install.ts \
  < <tmp>/install-request.json

cd <tmp>/stable/versions/2.36.0
HOME=<tmp>/home \
OPENCODEX_HOME=<tmp>/ocx-home \
CODEX_HOME=<tmp>/codex-home \
<tmp>/runtime/ocx-runtime-x86_64-unknown-linux-gnu \
  desktop/runtime/bootstrap.ts < <tmp>/status-request.json
```

The installer request contained only `schemaVersion`, the closed target triple,
and the temporary absolute stable root. The bridge request was one v1 `status`
object. No user configuration or credentials were read.

## Result

- Builder exit: `0`
- Manifest entries: `4729`
- `desktop/runtime/install.ts` present in manifest: yes
- Source payload size: approximately `284 MiB`
- Stable generation size: approximately `284 MiB`
- First installer exit: `0`, one JSON envelope, `published=true`, `reused=false`
- Second installer exit: `0`, one JSON envelope, `published=false`, `reused=true`
- Source and stable `runtime-manifest.json`: byte-identical
- Stable-tree bridge exit: `0`
- Bridge stdout: one valid v1 `status=stopped` envelope

This proves the host-target production payload can install itself into an empty
stable root, reuse the verified generation, and run the bridge from that stable
tree without global Node/Bun/npm/ocx. It does not prove the final Tauri-installed
resource directory layout, WebView behavior, signing, service repair, or another
target platform.
