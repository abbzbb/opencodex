import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDecoyHomesUnchanged,
  assertMutableHomesInsideSandbox,
  buildProbeAChildEnv,
  hashRouteStaysOnOrigin,
  isPathInsideRoot,
  mutableHomesFromEnv,
  PROBE_A_SESSION_SUMMARY_KEYS,
  PROBE_SANDBOX_ENV_KEYS,
  runProbeASession,
  seedDecoyHomes,
  snapshotDecoyHomes,
  spawnProbeAChild,
  validateProbeASessionSummary,
  type DecoySymlinkCoverage,
  type ProbeASessionSummary,
  type ProbeSandboxHomes,
} from "../scripts/probe-a-session";
import { parseLoopbackOrigin } from "../runtime/origin";

setDefaultTimeout(30_000);

function validSummary(decoySymlinkCoverage: DecoySymlinkCoverage = "covered"): ProbeASessionSummary {
  return {
    schemaVersion: 1,
    bind: "loopback",
    dashboardHtml: true,
    sessionBootstrap: true,
    csrfWrite: true,
    csrfRejectedWithoutToken: true,
    sessionRenewalDocument: true,
    hashRouteUrlSameOrigin: true,
    wildcardBindHasNoSession: true,
    frameAncestorsDenied: true,
    sandboxIsolated: true,
    decoyUnchanged: true,
    decoySymlinkCoverage,
    importedPathsInsideSandbox: true,
    webviewEvidence: false,
    hideRenewalEvidence: false,
  };
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function envSnapshot(): Record<(typeof PROBE_SANDBOX_ENV_KEYS)[number], string | undefined> {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENCODEX_HOME: process.env.OPENCODEX_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    OPENCODEX_ADMIN_AUTH_TOKEN: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
    OCX_REAL_HOME: process.env.OCX_REAL_HOME,
    OCX_TEST_HOME_GUARD: process.env.OCX_TEST_HOME_GUARD,
    OCX_PROBE_SANDBOX_ROOT: process.env.OCX_PROBE_SANDBOX_ROOT,
    OCX_PROBE_DECOY_ROOT: process.env.OCX_PROBE_DECOY_ROOT,
  };
}

function makeIsolatedRoots(): { sandboxRoot: string; decoyRoot: string } {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-neg-sandbox-"));
  const decoyRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-neg-decoy-"));
  mkdirSync(join(sandboxRoot, ".opencodex"), { recursive: true });
  mkdirSync(join(sandboxRoot, ".codex"), { recursive: true });
  seedDecoyHomes(decoyRoot);
  return { sandboxRoot, decoyRoot };
}

describe("Probe A session/CSRF/navigation contract", () => {
  test("parent launcher does not import production src modules", () => {
    const parent = readFileSync(join(import.meta.dir, "../scripts/probe-a-session.ts"), "utf8");
    const contract = readFileSync(join(import.meta.dir, "../scripts/probe-a-contract.ts"), "utf8");
    expect(parent).not.toMatch(/from ["']\.\.\/\.\.\/src\//);
    expect(contract).not.toMatch(/from ["']\.\.\/\.\.\/src\//);
    expect(contract).toContain("../runtime/origin");
    expect(parent).toContain("./probe-a-contract");
    const child = readFileSync(join(import.meta.dir, "../scripts/probe-a-session-child.ts"), "utf8");
    expect(child).toContain("../../src/server");
    expect(child).toContain('await import("../../src/codex/paths")');
    expect(child).toContain("CODEX_HOME");
    expect(child).toContain("CODEX_CONFIG_PATH");
    expect(child).toContain("CODEX_PROFILE_PATH");
    expect(child).toContain("DEFAULT_CATALOG_PATH");
    expect(child).toContain("CODEX_MODELS_CACHE_PATH");
    expect(child).toContain("isTestHomeGuardArmed");
    expect(child).toContain("protectedHomeForTests");
    expect(child).toContain("protectedCodexHomeForTests");
    expect(child).not.toMatch(/^import \{[^}\n]*startServer/m);
  });

  test("parent arms the decoy as OCX_REAL_HOME and the test-home guard before spawn", () => {
    const parent = readFileSync(join(import.meta.dir, "../scripts/probe-a-session.ts"), "utf8");
    expect(parent).toContain("childEnv.OCX_REAL_HOME = args.decoyRoot");
    expect(parent).toContain('childEnv.OCX_TEST_HOME_GUARD = "1"');
    expect(parent).toContain("childEnv.OCX_PROBE_DECOY_ROOT = args.decoyRoot");
    expect(parent).not.toContain("homedir()");
    expect(parent).toContain("snapshotDecoyHomes");
    expect(parent).toContain("assertDecoyHomesUnchanged");
  });

  test("summary schema is closed and refuses WebView/hide claims", () => {
    const summary = validateProbeASessionSummary(validSummary());
    expect(Object.keys(summary)).toEqual([...PROBE_A_SESSION_SUMMARY_KEYS]);
    expect(summary.webviewEvidence).toBe(false);
    expect(summary.hideRenewalEvidence).toBe(false);
    expect(summary.sandboxIsolated).toBe(true);
    expect(summary.decoyUnchanged).toBe(true);
    expect(summary.importedPathsInsideSandbox).toBe(true);
    expect(summary.hashRouteUrlSameOrigin).toBe(true);
    expect(summary.decoySymlinkCoverage).toBe("covered");
    expect(validateProbeASessionSummary(validSummary("unsupported")).decoySymlinkCoverage).toBe("unsupported");
    expect(() => validateProbeASessionSummary({ ...validSummary(), webviewEvidence: true })).toThrow();
    expect(() => validateProbeASessionSummary({ ...validSummary(), hideRenewalEvidence: true })).toThrow();
    expect(() => validateProbeASessionSummary({ ...validSummary(), sandboxIsolated: false })).toThrow();
    expect(() => validateProbeASessionSummary({ ...validSummary(), decoySymlinkCoverage: "skipped" })).toThrow();
    expect(() => validateProbeASessionSummary({ ...validSummary(), extra: true })).toThrow();
  });

  test("hash routes stay on the exact loopback origin", () => {
    expect(hashRouteStaysOnOrigin("http://127.0.0.1:10100", "#providers")).toBe(true);
    expect(hashRouteStaysOnOrigin("http://localhost:10100", "#logs/debug")).toBe(true);
    expect(hashRouteStaysOnOrigin("http://[::1]:10100", "#dashboard/update")).toBe(true);
    expect(hashRouteStaysOnOrigin("http://192.168.1.10:10100", "#providers")).toBe(false);
    expect(hashRouteStaysOnOrigin("http://0.0.0.0:10100", "#providers")).toBe(false);
    expect(parseLoopbackOrigin("http://0.0.0.0:10100").ok).toBe(false);
  });

  test("sandbox helper rejects any mutable home outside the root", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-probe-a-canary-"));
    const inside: ProbeSandboxHomes = {
      root,
      home: root,
      userProfile: root,
      opencodexHome: join(root, ".opencodex"),
      codexHome: join(root, ".codex"),
    };
    expect(() => assertMutableHomesInsideSandbox(inside)).not.toThrow();
    expect(isPathInsideRoot(root, join(root, ".codex"))).toBe(true);
    expect(() => assertMutableHomesInsideSandbox({
      ...inside,
      codexHome: join(tmpdir(), "not-the-probe-sandbox"),
    })).toThrow(/CODEX_HOME escaped/);
    expect(() => assertMutableHomesInsideSandbox({
      ...inside,
      opencodexHome: join(tmpdir(), "not-the-probe-sandbox"),
    })).toThrow(/OPENCODEX_HOME escaped/);
    expect(() => assertMutableHomesInsideSandbox({
      ...inside,
      home: join(tmpdir(), "not-the-probe-sandbox"),
    })).toThrow(/HOME escaped/);
    const fromEnv = mutableHomesFromEnv(root, {
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: join(root, ".opencodex"),
      CODEX_HOME: join(root, ".codex"),
    });
    expect(() => assertMutableHomesInsideSandbox(fromEnv)).not.toThrow();
  });

  test("decoy tree snapshot covers files, nested paths, and rejects new files", () => {
    const decoyRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-tree-"));
    const coverage = seedDecoyHomes(decoyRoot, () => {
      throw errno("EPERM", "operation not permitted");
    });
    expect(coverage).toBe("unsupported");
    const before = snapshotDecoyHomes(decoyRoot);
    expect(before.get(".opencodex")?.kind).toBe("directory");
    expect(before.get(".codex")?.kind).toBe("directory");
    expect(before.get(".opencodex/canary")?.kind).toBe("file");
    expect(before.get(".opencodex/nested/marker")?.kind).toBe("file");
    expect(before.get(".opencodex/canary-link")).toBeUndefined();
    expect(before.get(".opencodex/canary")?.bytes?.equals(Buffer.from("opencodex-decoy-v1\n"))).toBe(true);
    assertDecoyHomesUnchanged(before, snapshotDecoyHomes(decoyRoot));
    writeFileSync(join(decoyRoot, ".opencodex", "new-file"), "intrusion\n");
    expect(() => assertDecoyHomesUnchanged(before, snapshotDecoyHomes(decoyRoot))).toThrow(/new entry/);
  });

  test("injected symlink support seeds and snapshots symlink entries", () => {
    const decoyRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-link-"));
    const coverage = seedDecoyHomes(decoyRoot, symlinkSync);
    expect(coverage).toBe("covered");
    const before = snapshotDecoyHomes(decoyRoot);
    expect(before.get(".opencodex/canary-link")?.kind).toBe("symlink");
    expect(before.get(".opencodex/canary-link")?.symlinkTarget).toBe("canary");
    expect(before.get(".codex/canary-link")?.kind).toBe("symlink");
    assertDecoyHomesUnchanged(before, snapshotDecoyHomes(decoyRoot));
  });

  test("injected EPERM seed reports unsupported and still compares the full file tree", () => {
    const decoyRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-eperm-"));
    const coverage = seedDecoyHomes(decoyRoot, () => {
      throw errno("EPERM", "operation not permitted");
    });
    expect(coverage).toBe("unsupported");
    const before = snapshotDecoyHomes(decoyRoot);
    expect([...before.keys()].some(key => before.get(key)?.kind === "symlink")).toBe(false);
    assertDecoyHomesUnchanged(before, snapshotDecoyHomes(decoyRoot));
  });

  test("seed does not swallow unrelated symlink errors", () => {
    const decoyRoot = mkdtempSync(join(tmpdir(), "ocx-probe-a-eio-"));
    expect(() => seedDecoyHomes(decoyRoot, () => {
      throw errno("EIO", "input/output error");
    })).toThrow(/input\/output error/);
  });

  test("child fails closed when the test-home guard is unarmed", () => {
    const { sandboxRoot, decoyRoot } = makeIsolatedRoots();
    const spawned = spawnProbeAChild(buildProbeAChildEnv({
      sandboxRoot,
      decoyRoot,
      extra: { OCX_TEST_HOME_GUARD: undefined },
    }));
    expect(spawned.exitCode).not.toBe(0);
    expect(`${spawned.stderr}\n${spawned.stdout}`).toMatch(/OCX_TEST_HOME_GUARD must be armed before imports/);
  });

  test("child fails closed when the decoy is not exposed as OCX_REAL_HOME", () => {
    const { sandboxRoot, decoyRoot } = makeIsolatedRoots();
    const spawned = spawnProbeAChild(buildProbeAChildEnv({
      sandboxRoot,
      decoyRoot,
      extra: { OCX_REAL_HOME: sandboxRoot },
    }));
    expect(spawned.exitCode).not.toBe(0);
    expect(`${spawned.stderr}\n${spawned.stdout}`).toMatch(/OCX_REAL_HOME must be the decoy root before imports/);
  });

  test("live child probe isolates homes, leaves the decoy unchanged, and restores parent env", async () => {
    const before = envSnapshot();
    const summary = await runProbeASession();
    expect(validateProbeASessionSummary(summary)).toEqual(validSummary(summary.decoySymlinkCoverage));
    expect(envSnapshot()).toEqual(before);
  });
});
