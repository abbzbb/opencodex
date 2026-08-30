# Phase 1 Linux Debian resource-layout probe

Date: 2026-08-30

## Scope and provenance

- Product source base: `7b22849e18115474253ac7cf1516d4e2587797ba` plus uncommitted Desktop Probe B work
- App/runtime version: `2.36.0`
- Target: `x86_64-unknown-linux-gnu` / Debian `amd64`
- Bun: `1.4.0`
- Tauri CLI: `2.11.4` (Rust `tauri` crate `2.11.5`)
- Cargo/rustc: `1.95.0`
- `dpkg-deb`: `1.22.22`
- GTK/WebKitGTK present: `3.24.49` / `2.52.5`
- Artifact: `OpenCodex_2.36.0_amd64.deb`
- Artifact SHA-256: `6fa042495b355a6c15dddf07b6eb7c3f8a0e36afb261f0c1146e60b6469921ac`
- Probe A (extract/layout) exit code: `0`

The payload and `.deb` were built in the same working copy. The probe extracted
the package with `dpkg-deb`; it did not install it or run maintainer scripts.

## Commands

```bash
(cd desktop && ../node_modules/.bin/bun install --no-save --ignore-scripts)

node_modules/.bin/bun desktop/scripts/build-runtime.ts \
  --target x86_64-unknown-linux-gnu \
  --output desktop/src-tauri/resources/runtime

(cd desktop && ./node_modules/.bin/tauri build --bundles deb)

node_modules/.bin/bun desktop/scripts/validate-packaging.ts \
  --require-real \
  --target x86_64-unknown-linux-gnu

node_modules/.bin/bun desktop/scripts/probe-linux-deb.ts \
  --deb desktop/src-tauri/target/release/bundle/deb/OpenCodex_2.36.0_amd64.deb \
  --sha256 6fa042495b355a6c15dddf07b6eb7c3f8a0e36afb261f0c1146e60b6469921ac
```

The SHA-256 must come from the trusted local build or an independently trusted
release channel. The check occurs before any executable from the archive runs.

## Observed extracted package payload layout

```text
usr/bin/opencodex-desktop
usr/bin/ocx-runtime
usr/lib/OpenCodex/resources/runtime/runtime-manifest.json
usr/lib/OpenCodex/resources/runtime/ocx-runtime-x86_64-unknown-linux-gnu
usr/lib/OpenCodex/resources/runtime/desktop/runtime/install.ts
```

This matches the production resolver contract: the packaged sidecar is next to
the app executable, and Tauri's Linux resource directory contains the relative
`resources/runtime` tree.

## Result

```text
probe-linux-deb: ok (package=open-codex, version=2.36.0, arch=amd64, target=x86_64-unknown-linux-gnu, manifest=ocx-runtime-2.36.0-x86_64-unknown-linux-gnu, files=4730, payloadBytes=283749724, debSha256=6fa042495b355a6c15dddf07b6eb7c3f8a0e36afb261f0c1146e60b6469921ac, sidecarSha256=33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b, install=published+reused, status=stopped, native=ok, pathIsolation=empty)
```

The probe verified the extracted runtime tree against its manifest, including
executable bits and the target-native keyring module. The packaged sidecar,
resource runtime ELF, and manifest entry had the same SHA-256. In a fresh
mode-0700 jail, the first fixed installer request published `current.json`, the
second reused the identical generation, the stable bridge returned
`status=stopped`, and the stable target-native keyring module loaded. Child
`PATH` pointed to an empty directory; no global Node, Bun, npm, or `ocx` could
participate. The jail was deleted after the run.

## Evidence boundary

This proves the extracted Linux x64 `.deb` resource layout, payload integrity,
stable runtime publication/reuse, stable bridge loading, and target-native
module loading. It does not prove `dpkg` maintainer scripts, a live
`AppHandle::path().resource_dir()` call, proxy start or `/readyz`, WebView
startup, session/CSRF behavior, navigation, tray/single-instance behavior,
service/deep-link integration, signing, AppImage, or another target.

The host had no X11/Wayland compositor, so the Tauri app was intentionally not
launched and this evidence is not labeled as a WebView smoke.
