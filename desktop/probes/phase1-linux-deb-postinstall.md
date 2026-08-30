# Phase 1 Linux Debian real post-install probe

Date: 2026-08-30

## Scope and provenance

- Product source base: `7b22849e18115474253ac7cf1516d4e2587797ba` plus uncommitted Desktop Probe B work
- App/runtime version: `2.36.0`
- Target: `x86_64-unknown-linux-gnu` / Debian `amd64`
- Bun: `1.4.0`
- Tauri CLI: `2.11.4` (Rust `tauri` crate `2.11.5`)
- Cargo/rustc: `1.95.0`
- Probe image: digest-pinned `debian:trixie-slim` (`ocx-desktop-postinstall-probe:debian13`)
- Artifact: `OpenCodex_2.36.0_amd64.deb`
- Artifact SHA-256: `6fa042495b355a6c15dddf07b6eb7c3f8a0e36afb261f0c1146e60b6469921ac`
- WebKitGTK in the pinned probe image: `libwebkit2gtk-4.1-0` `2.52.6-1~deb13u1` (GTK `libgtk-3-0t64` `3.24.49-3`)
- Probe A (extract/layout) exit code: `0`
- Probe B (real post-install) exit code: `0`

The payload and `.deb` were built in the same working copy after the proven-absent
Codex `config.toml` startup no-op and the post-install harness evidence repairs.
The probe installs the package with `dpkg -i` inside `--network none --init`,
launches `/usr/bin/opencodex-desktop` as uid `10001` with zero capabilities, then
`dpkg -r`. Debian control is rejected if any maintainer script is present. The
container is created from the Docker `--quiet` build image ID (`sha256:…`), not
the mutable cache tag. Success stdout is one JSON summary. WebKitGTK is installed
in the image so the Tauri binary can start; no WebView behavior or rendering was
exercised.

## Commands

```bash
node_modules/.bin/bun desktop/scripts/build-runtime.ts \
  --target x86_64-unknown-linux-gnu \
  --output desktop/src-tauri/resources/runtime

node_modules/.bin/bun desktop/scripts/validate-packaging.ts \
  --require-real \
  --target x86_64-unknown-linux-gnu

(cd desktop && ./node_modules/.bin/tauri build --bundles deb)

node_modules/.bin/bun desktop/scripts/probe-linux-deb.ts \
  --deb desktop/src-tauri/target/release/bundle/deb/OpenCodex_2.36.0_amd64.deb \
  --sha256 6fa042495b355a6c15dddf07b6eb7c3f8a0e36afb261f0c1146e60b6469921ac

node_modules/.bin/bun desktop/scripts/probe-linux-deb-postinstall.ts \
  --deb desktop/src-tauri/target/release/bundle/deb/OpenCodex_2.36.0_amd64.deb \
  --sha256 6fa042495b355a6c15dddf07b6eb7c3f8a0e36afb261f0c1146e60b6469921ac
```

The SHA-256 must come from the trusted local build. The probe pins a private
artifact snapshot and checks the digest before `dpkg`.

## Result

```text
probe-linux-deb-postinstall: ok (package=open-codex, version=2.36.0, target=x86_64-unknown-linux-gnu, owner=desktop-direct, readyz=ready, stop=stopped, removed=true)
```

The container proved: no global node/bun/npm/ocx, and it directly asserted no
Codex CLI (`Bun.which("codex")` was null); `resource_dir()` published a stable
runtime; `current.json` matched the stable manifest identity (`id`, `version`,
`target`, `relPath=versions/2.36.0`) with `previous=null`; bridge `status`
`ready` with `owner=desktop-direct`; PID / runtime-port / owner record /
`findLiveProxy` agreement; `/healthz` identity and strict `/readyz`; structured
stop with independent absence; `dpkg -r` then independently asserted
`/usr/bin/opencodex-desktop` and `/usr/bin/ocx-runtime` gone, the installed
resource runtime path `/usr/lib/OpenCodex/resources/runtime` gone, and the
package no longer installed.

## Evidence boundary

This proves a real Linux x64 `.deb` install, App-owned desktop-direct start, and
`/readyz` on a Debian 13 image without Codex CLI or a global JS runtime. Probe A
and Probe B both exited `0`. The pinned image had WebKitGTK
`libwebkit2gtk-4.1-0` `2.52.6-1~deb13u1` installed so the process could start;
no WebView behavior or rendering was exercised. It does not prove dashboard
session bootstrap, CSRF writes, session renewal, navigation allowlisting,
tray/single-instance, service/deep-link, signing, AppImage, or another target.
Success evidence is the JSON summary above; no dynamic app logs or secrets are
recorded.

The image has no Codex `config.toml`. Startup used the proven-absent `no_config`
skip (no catalog/cache/history write, `/readyz` ready). That is not evidence
that Codex injection works when Codex is installed.
