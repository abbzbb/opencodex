import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseLoopbackOrigin } from "../runtime/origin";

export const PROBE_SANDBOX_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCODEX_HOME",
  "CODEX_HOME",
  "OPENCODEX_ADMIN_AUTH_TOKEN",
  "OCX_REAL_HOME",
  "OCX_TEST_HOME_GUARD",
  "OCX_PROBE_SANDBOX_ROOT",
  "OCX_PROBE_DECOY_ROOT",
] as const;

export const PROBE_A_SESSION_SUMMARY_KEYS = [
  "schemaVersion",
  "bind",
  "dashboardHtml",
  "sessionBootstrap",
  "csrfWrite",
  "csrfRejectedWithoutToken",
  "sessionRenewalDocument",
  "hashRouteUrlSameOrigin",
  "wildcardBindHasNoSession",
  "frameAncestorsDenied",
  "sandboxIsolated",
  "decoyUnchanged",
  "decoySymlinkCoverage",
  "importedPathsInsideSandbox",
  "webviewEvidence",
  "hideRenewalEvidence",
] as const;

export type DecoySymlinkCoverage = "covered" | "unsupported";

export type ProbeASessionSummary = {
  schemaVersion: 1;
  bind: "loopback";
  dashboardHtml: true;
  sessionBootstrap: true;
  csrfWrite: true;
  csrfRejectedWithoutToken: true;
  sessionRenewalDocument: true;
  hashRouteUrlSameOrigin: true;
  wildcardBindHasNoSession: true;
  frameAncestorsDenied: true;
  sandboxIsolated: true;
  decoyUnchanged: true;
  decoySymlinkCoverage: DecoySymlinkCoverage;
  importedPathsInsideSandbox: true;
  webviewEvidence: false;
  hideRenewalEvidence: false;
};

export type ProbeSandboxHomes = {
  root: string;
  home: string;
  userProfile: string;
  opencodexHome: string;
  codexHome: string;
};

export type DecoyEntryKind = "file" | "directory" | "symlink" | "other";

export type DecoyTreeEntry = {
  rel: string;
  kind: DecoyEntryKind;
  size: number;
  mode: number;
  mtimeMs: number;
  uid: number;
  gid: number;
  nlink: number;
  symlinkTarget: string | null;
  bytes: Buffer | null;
};

type JsonRecord = Record<string, unknown>;

export function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}

function canonicalize(path: string): string {
  let current = resolve(path);
  const unresolved: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...unresolved.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      unresolved.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export function isSymlinkUnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

export function isPathInsideRoot(root: string, target: string): boolean {
  const rel = relative(canonicalize(root), canonicalize(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function pathsAreSame(left: string, right: string): boolean {
  return isPathInsideRoot(left, right) && isPathInsideRoot(right, left);
}

export function mutableHomesFromEnv(root: string, env: NodeJS.ProcessEnv = process.env): ProbeSandboxHomes {
  return {
    root,
    home: env.HOME ?? "",
    userProfile: env.USERPROFILE ?? env.HOME ?? "",
    opencodexHome: env.OPENCODEX_HOME ?? "",
    codexHome: env.CODEX_HOME ?? "",
  };
}

export function assertMutableHomesInsideSandbox(homes: ProbeSandboxHomes): void {
  if (!homes.root || !homes.home || !homes.userProfile || !homes.opencodexHome || !homes.codexHome) {
    fail("probe sandbox homes are incomplete");
  }
  for (const [label, value] of [
    ["HOME", homes.home],
    ["USERPROFILE", homes.userProfile],
    ["OPENCODEX_HOME", homes.opencodexHome],
    ["CODEX_HOME", homes.codexHome],
  ] as const) {
    if (!isPathInsideRoot(homes.root, value)) {
      fail(`${label} escaped the probe sandbox`);
    }
  }
}

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

function entryKind(stat: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}): DecoyEntryKind {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function snapshotEntry(root: string, abs: string): DecoyTreeEntry {
  const stat = lstatSync(abs);
  const kind = entryKind(stat);
  return {
    rel: posixRel(root, abs),
    kind,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    symlinkTarget: kind === "symlink" ? readlinkSync(abs) : null,
    bytes: kind === "file" ? readFileSync(abs) : null,
  };
}

function walkDecoyTree(root: string, dir: string, out: Map<string, DecoyTreeEntry>): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const entry = snapshotEntry(root, abs);
    out.set(entry.rel, entry);
    if (entry.kind === "directory") walkDecoyTree(root, abs, out);
  }
}

export function snapshotDecoyHomes(decoyRoot: string): Map<string, DecoyTreeEntry> {
  const out = new Map<string, DecoyTreeEntry>();
  for (const name of [".opencodex", ".codex"] as const) {
    const abs = join(decoyRoot, name);
    try {
      lstatSync(abs);
    } catch {
      fail(`decoy ${name} is missing`);
    }
    const entry = snapshotEntry(decoyRoot, abs);
    out.set(entry.rel, entry);
    if (entry.kind === "directory") walkDecoyTree(decoyRoot, abs, out);
  }
  if (out.size === 0) fail("decoy OpenCodex/Codex trees are empty");
  return out;
}

export function assertDecoyHomesUnchanged(
  before: Map<string, DecoyTreeEntry>,
  after: Map<string, DecoyTreeEntry>,
): void {
  for (const rel of after.keys()) {
    if (!before.has(rel)) fail(`decoy grew a new entry: ${rel}`);
  }
  for (const [rel, expected] of before) {
    const actual = after.get(rel);
    if (!actual) fail(`decoy lost entry: ${rel}`);
    if (actual.kind !== expected.kind
      || actual.size !== expected.size
      || actual.mode !== expected.mode
      || actual.mtimeMs !== expected.mtimeMs
      || actual.uid !== expected.uid
      || actual.gid !== expected.gid
      || actual.nlink !== expected.nlink
      || actual.symlinkTarget !== expected.symlinkTarget) {
      fail(`decoy ${rel} metadata changed`);
    }
    if (expected.bytes !== null || actual.bytes !== null) {
      if (!expected.bytes || !actual.bytes || !actual.bytes.equals(expected.bytes)) {
        fail(`decoy ${rel} bytes changed`);
      }
    }
  }
}

export function validateProbeASessionSummary(value: unknown): ProbeASessionSummary {
  if (!isRecord(value) || !exactKeys(value, PROBE_A_SESSION_SUMMARY_KEYS)) {
    fail("probe A session summary fields are invalid");
  }
  if (value.schemaVersion !== 1
    || value.bind !== "loopback"
    || value.dashboardHtml !== true
    || value.sessionBootstrap !== true
    || value.csrfWrite !== true
    || value.csrfRejectedWithoutToken !== true
    || value.sessionRenewalDocument !== true
    || value.hashRouteUrlSameOrigin !== true
    || value.wildcardBindHasNoSession !== true
    || value.frameAncestorsDenied !== true
    || value.sandboxIsolated !== true
    || value.decoyUnchanged !== true
    || (value.decoySymlinkCoverage !== "covered" && value.decoySymlinkCoverage !== "unsupported")
    || value.importedPathsInsideSandbox !== true
    || value.webviewEvidence !== false
    || value.hideRenewalEvidence !== false) {
    fail("probe A session summary values are invalid");
  }
  return value as ProbeASessionSummary;
}

export function hashRouteStaysOnOrigin(origin: string, hash: string): boolean {
  const parsed = parseLoopbackOrigin(origin);
  if (!parsed.ok) return false;
  try {
    const url = new URL(`${parsed.origin}/${hash.startsWith("#") ? hash : `#${hash}`}`);
    return url.origin === parsed.origin && url.hash.length > 1;
  } catch {
    return false;
  }
}

export type ProbeAChildResult = {
  schemaVersion: 1;
  bind: "loopback";
  dashboardHtml: true;
  sessionBootstrap: true;
  csrfWrite: true;
  csrfRejectedWithoutToken: true;
  sessionRenewalDocument: true;
  hashRouteUrlSameOrigin: true;
  wildcardBindHasNoSession: true;
  frameAncestorsDenied: true;
  homedirInsideSandbox: true;
  configDirInsideSandbox: true;
  adminTokenPathInsideSandbox: true;
  importedCodexPathsInsideSandbox: true;
  testHomeGuardArmed: true;
  decoyHomesInsideDecoyRoot: true;
  decoyHomesOutsideSandbox: true;
  webviewEvidence: false;
  hideRenewalEvidence: false;
};

const CHILD_KEYS = [
  "schemaVersion",
  "bind",
  "dashboardHtml",
  "sessionBootstrap",
  "csrfWrite",
  "csrfRejectedWithoutToken",
  "sessionRenewalDocument",
  "hashRouteUrlSameOrigin",
  "wildcardBindHasNoSession",
  "frameAncestorsDenied",
  "homedirInsideSandbox",
  "configDirInsideSandbox",
  "adminTokenPathInsideSandbox",
  "importedCodexPathsInsideSandbox",
  "testHomeGuardArmed",
  "decoyHomesInsideDecoyRoot",
  "decoyHomesOutsideSandbox",
  "webviewEvidence",
  "hideRenewalEvidence",
] as const;

export function validateProbeAChildResult(value: unknown): ProbeAChildResult {
  if (!isRecord(value) || !exactKeys(value, CHILD_KEYS)) {
    fail("probe A child result fields are invalid");
  }
  if (value.schemaVersion !== 1
    || value.bind !== "loopback"
    || value.dashboardHtml !== true
    || value.sessionBootstrap !== true
    || value.csrfWrite !== true
    || value.csrfRejectedWithoutToken !== true
    || value.sessionRenewalDocument !== true
    || value.hashRouteUrlSameOrigin !== true
    || value.wildcardBindHasNoSession !== true
    || value.frameAncestorsDenied !== true
    || value.homedirInsideSandbox !== true
    || value.configDirInsideSandbox !== true
    || value.adminTokenPathInsideSandbox !== true
    || value.importedCodexPathsInsideSandbox !== true
    || value.testHomeGuardArmed !== true
    || value.decoyHomesInsideDecoyRoot !== true
    || value.decoyHomesOutsideSandbox !== true
    || value.webviewEvidence !== false
    || value.hideRenewalEvidence !== false) {
    fail("probe A child result values are invalid");
  }
  return value as ProbeAChildResult;
}
