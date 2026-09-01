#!/bin/sh
set -eu

artifact=/probe/artifact.deb
package=open-codex
install_log=/probe/dpkg-install.log
remove_log=/probe/dpkg-remove.log
harness_log=/home/probe/harness.log
result=/home/probe/probe-result.json

cleanup() {
  if dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -qx installed; then
    dpkg -r "$package" >"$remove_log" 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

[ -f "$artifact" ] || { echo "post-install probe artifact missing" >&2; exit 1; }
[ ! -L "$artifact" ] || { echo "post-install probe artifact must be regular" >&2; exit 1; }
[ "$(sha256sum "$artifact" | cut -d ' ' -f 1)" = "${EXPECTED_DEB_SHA256:-}" ] \
  || { echo "post-install probe artifact digest mismatch" >&2; exit 1; }

dpkg -i "$artifact" >"$install_log" 2>&1 \
  || { echo "post-install package install failed" >&2; exit 1; }

package_name=$(dpkg-query -W -f='${binary:Package}' "$package")
version=$(dpkg-query -W -f='${Version}' "$package")
architecture=$(dpkg-query -W -f='${Architecture}' "$package")
[ "$package_name" = "$package" ] || { echo "post-install package identity mismatch" >&2; exit 1; }
[ "$architecture" = amd64 ] || { echo "post-install package architecture mismatch" >&2; exit 1; }
case "$version" in
  *[!A-Za-z0-9.+:~_-]*|'') echo "post-install package version is unsafe" >&2; exit 1 ;;
esac

[ -x /usr/bin/opencodex-desktop ] || { echo "installed desktop executable missing" >&2; exit 1; }
[ -x /usr/bin/ocx-runtime ] || { echo "installed runtime executable missing" >&2; exit 1; }
[ -d /usr/lib/OpenCodex/resources/runtime ] || { echo "installed runtime resource missing" >&2; exit 1; }

if ! runuser -u probe -- env -i \
  HOME=/home/probe \
  XDG_DATA_HOME=/home/probe/xdg-data \
  XDG_CONFIG_HOME=/home/probe/xdg-config \
  XDG_CACHE_HOME=/home/probe/xdg-cache \
  XDG_STATE_HOME=/home/probe/xdg-state \
  XDG_RUNTIME_DIR=/home/probe/xdg-runtime \
  OPENCODEX_HOME=/home/probe/opencodex \
  CODEX_HOME=/home/probe/codex \
  TMPDIR=/home/probe/tmp \
  PATH=/usr/bin:/bin \
  LANG=C.UTF-8 \
  NO_COLOR=1 \
  OCX_PROBE_PACKAGE_VERSION="$version" \
  OCX_PROBE_RESULT_PATH="$result" \
  /usr/bin/ocx-runtime /usr/local/lib/ocx-linux-deb-postinstall.ts \
  >"$harness_log" 2>&1; then
  diagnostic=$(tail -n 1 "$harness_log" 2>/dev/null || true)
  case "$diagnostic" in
    post-install-harness:\ *) printf '%s\n' "$diagnostic" >&2 ;;
    *) echo "post-install runtime harness failed" >&2 ;;
  esac
  exit 1
fi

[ "$(cat "$result" 2>/dev/null || true)" = '{"ok":true}' ] \
  || { echo "post-install runtime proof missing" >&2; exit 1; }

dpkg -r "$package" >"$remove_log" 2>&1 \
  || { echo "post-install package removal failed" >&2; exit 1; }
trap - EXIT HUP INT TERM

[ ! -e /usr/bin/opencodex-desktop ] || { echo "desktop executable survived package removal" >&2; exit 1; }
[ ! -e /usr/bin/ocx-runtime ] || { echo "runtime executable survived package removal" >&2; exit 1; }
[ ! -e /usr/lib/OpenCodex/resources/runtime ] || { echo "installed runtime resource survived package removal" >&2; exit 1; }
pkg_status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
[ "$pkg_status" != installed ] || { echo "package remained installed after removal" >&2; exit 1; }

printf '{"schemaVersion":1,"package":"open-codex","version":"%s","architecture":"amd64","target":"x86_64-unknown-linux-gnu","installed":true,"appLaunched":true,"stableRuntime":"published","bridgeStatus":"ready","owner":"desktop-direct","health":"ok","readiness":"ready","stop":"stopped","proxyAbsent":true,"packageRemoved":true,"webviewEvidence":false}\n' "$version"
