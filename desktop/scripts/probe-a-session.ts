#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDecoyHomesUnchanged,
  fail,
  isPathInsideRoot,
  isSymlinkUnsupportedError,
  snapshotDecoyHomes,
  validateProbeAChildResult,
  validateProbeASessionSummary,
  type DecoySymlinkCoverage,
  type ProbeASessionSummary,
} from "./probe-a-contract";

export {
  PROBE_A_SESSION_SUMMARY_KEYS,
  PROBE_SANDBOX_ENV_KEYS,
  assertDecoyHomesUnchanged,
  assertMutableHomesInsideSandbox,
  hashRouteStaysOnOrigin,
  isPathInsideRoot,
  isSymlinkUnsupportedError,
  mutableHomesFromEnv,
  snapshotDecoyHomes,
  validateProbeASessionSummary,
  type DecoySymlinkCoverage,
  type DecoyTreeEntry,
  type ProbeASessionSummary,
  type ProbeSandboxHomes,
} from "./probe-a-contract";

export function probeAChildPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "probe-a-session-child.ts");
}

export type SeedDecoySymlink = (target: string, path: string) => void;

export function seedDecoyHomes(
  decoyRoot: string,
  symlink: SeedDecoySymlink = symlinkSync,
): DecoySymlinkCoverage {
  const opencodex = join(decoyRoot, ".opencodex");
  const codex = join(decoyRoot, ".codex");
  mkdirSync(join(opencodex, "nested"), { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(opencodex, "canary"), "opencodex-decoy-v1\n");
  writeFileSync(join(opencodex, "nested", "marker"), "nested-decoy\n");
  writeFileSync(join(codex, "canary"), "codex-decoy-v1\n");
  const probe = join(opencodex, ".symlink-capability");
  try {
    symlink("canary", probe);
  } catch (err) {
    if (isSymlinkUnsupportedError(err)) return "unsupported";
    throw err;
  }
  unlinkSync(probe);
  symlink("canary", join(opencodex, "canary-link"));
  symlink("canary", join(codex, "canary-link"));
  return "covered";
}

export function buildProbeAChildEnv(args: {
  sandboxRoot: string;
  decoyRoot: string;
  extra?: Record<string, string | undefined>;
}): Record<string, string> {
  const opencodexHome = join(args.sandboxRoot, ".opencodex");
  const codexHome = join(args.sandboxRoot, ".codex");
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.HOME = args.sandboxRoot;
  childEnv.USERPROFILE = args.sandboxRoot;
  childEnv.OPENCODEX_HOME = opencodexHome;
  childEnv.CODEX_HOME = codexHome;
  childEnv.OPENCODEX_ADMIN_AUTH_TOKEN = "desktop-probe-admin";
  childEnv.OCX_PROBE_SANDBOX_ROOT = args.sandboxRoot;
  childEnv.OCX_PROBE_DECOY_ROOT = args.decoyRoot;
  childEnv.OCX_REAL_HOME = args.decoyRoot;
  childEnv.OCX_TEST_HOME_GUARD = "1";
  if (args.extra) {
    for (const [key, value] of Object.entries(args.extra)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
  }
  return childEnv;
}

export function spawnProbeAChild(childEnv: Record<string, string>): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const spawned = Bun.spawnSync({
    cmd: [process.execPath, probeAChildPath()],
    cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

export async function runProbeASession(): Promise<ProbeASessionSummary> {
  const decoyRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-decoy-"));
  const sandboxRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-"));
  mkdirSync(join(sandboxRoot, ".opencodex"), { recursive: true });
  mkdirSync(join(sandboxRoot, ".codex"), { recursive: true });
  if (process.platform === "win32") {
    mkdirSync(join(sandboxRoot, "AppData", "Local"), { recursive: true });
    mkdirSync(join(sandboxRoot, "AppData", "Roaming"), { recursive: true });
  }
  if (isPathInsideRoot(sandboxRoot, decoyRoot) || isPathInsideRoot(decoyRoot, sandboxRoot)) {
    fail("decoy root must sit outside the probe sandbox");
  }
  if (!isPathInsideRoot(tmpdir(), decoyRoot)) {
    fail("decoy root must be created in the temp directory");
  }
  const decoySymlinkCoverage = seedDecoyHomes(decoyRoot);
  const before = snapshotDecoyHomes(decoyRoot);

  try {
    const spawned = spawnProbeAChild(buildProbeAChildEnv({ sandboxRoot, decoyRoot }));
    if (spawned.exitCode !== 0) {
      fail(`probe child exited ${spawned.exitCode}: ${spawned.stderr.trim() || spawned.stdout.trim() || "no output"}`);
    }
    const line = spawned.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const child = validateProbeAChildResult(JSON.parse(line) as unknown);
    assertDecoyHomesUnchanged(before, snapshotDecoyHomes(decoyRoot));
    if (!child.testHomeGuardArmed
      || !child.decoyHomesInsideDecoyRoot
      || !child.decoyHomesOutsideSandbox
      || !child.importedCodexPathsInsideSandbox
      || !child.homedirInsideSandbox
      || !child.configDirInsideSandbox
      || !child.adminTokenPathInsideSandbox) {
      fail("child isolation evidence is incomplete");
    }
    return {
      schemaVersion: 1,
      bind: "loopback",
      dashboardHtml: child.dashboardHtml,
      sessionBootstrap: child.sessionBootstrap,
      csrfWrite: child.csrfWrite,
      csrfRejectedWithoutToken: child.csrfRejectedWithoutToken,
      sessionRenewalDocument: child.sessionRenewalDocument,
      hashRouteUrlSameOrigin: child.hashRouteUrlSameOrigin,
      wildcardBindHasNoSession: child.wildcardBindHasNoSession,
      frameAncestorsDenied: child.frameAncestorsDenied,
      sandboxIsolated: true,
      decoyUnchanged: true,
      decoySymlinkCoverage,
      importedPathsInsideSandbox: true,
      webviewEvidence: false,
      hideRenewalEvidence: false,
    };
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
    rmSync(decoyRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const summary = validateProbeASessionSummary(await runProbeASession());
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
