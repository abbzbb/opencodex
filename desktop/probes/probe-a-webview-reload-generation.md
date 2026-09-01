# Probe A generation-reload transport (query, not fragment)

Date: 2026-09-01

## Scope

Retry navigations for `ReloadingShell` use a canonical app-local **query**
URL `?ocx-reload=<uuid>`, not `#ocx-reload-<uuid>`. WebView2 `Navigate`
does not fire navigation when only the fragment changes, so a fragment-only
retry cannot produce `PageLoadEvent::Finished` on pinned WRY 0.55.1 /
Windows.

**Authoritative proof** of URL grammar, generation correlation, ReloadingShell
CAS, and watchdog behavior is:

```bash
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib
```

`bun desktop/scripts/probe-a-reload-generation.ts` is a **source-sentinel**
only: it inspects Desktop sources and refuses physical WebView claims. It does
not execute Rust classification or a WebView.

This does **not** prove a physical WebView, Windows WebView2
`NavigationCompleted`, or Tauri `PageLoadEvent::Finished` on a display.

## Commands

```bash
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib
bun desktop/scripts/probe-a-reload-generation.ts
bun scripts/test.ts --root ./desktop/tests
```

## Result

Source-sentinel stdout (not a substitute for the cargo lib tests):

```text
{"schemaVersion":1,"kind":"source-sentinel","authoritativeCommand":"cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib","sourceQueryBuilder":true,"sourceFragmentBuilder":false,"sourceConsecutiveGenerationTest":true,"sourcePayloadUrlClassification":true,"physicalWebviewEvidence":false,"windowsWebView2NavigateFinished":false}
```

## Evidence boundary

Proven in `cargo test --locked --lib` (Rust):

- Raw query must be exactly `ocx-reload=<lowercase hyphenated UUID>` from
  `Uuid::hyphenated().to_string()`. Classification compares `url.query()`
  byte-for-byte to that serialization; it does not use `query_pairs()`.
- Invalid generation does not mint a URL
- Encoded key (`%6fcx-reload=`), encoded hyphens (`%2D`), uppercase UUIDs,
  duplicates, extra keys, empty query, and fragments are rejected.
  Userinfo and path drift are rejected. Non-default ports are rejected.
  Explicit default HTTP `:80` is omitted by `url::Url` and classifies as
  canonical same-origin (not a raw-spelling reject). Custom-scheme
  `tauri://localhost:80/` keeps the port and is rejected.
- Consecutive generations produce distinct real-document (query) URLs
- PageLoad classifies `payload.url()` only
- ReloadingShell CAS and stale watchdog no-op

Source-sentinel only:

- Presence of the query builder and `payload.url()` classification in source

Not proven (OPEN):

- Physical Windows WebView2 `Navigate` + `NavigationCompleted` for `?ocx-reload=`
- Tauri `PageLoadEvent::Finished` payload.url() on a live display
- macOS WKWebView / Linux WebKit generation reload
