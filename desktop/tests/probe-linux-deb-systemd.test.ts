import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createRuntimeManifestFromFiles,
  runtimeManifestId,
  writeRuntimeManifestFile,
} from "../runtime/manifest";
import { packLinuxRuntimeDeb } from "../scripts/pack-linux-runtime-deb";
import { LINUX_DEB_APP_REL, LINUX_DEB_PACKAGE, LINUX_DEB_SIDECAR_REL } from "../scripts/probe-linux-deb";
import {
  SYSTEMD_SUMMARY_KEYS,
  validateSystemdProbeSummary,
  type SystemdProbeSummary,
} from "../scripts/probe-linux-deb-systemd";
import {
  assertDestructiveSystemdProbeAllowed,
  cleanupCreatedSystemdArtifacts,
  entryExists,
  interpretSystemdShow,
  jsonLooksPathFree,
  managerFlagsFromStates,
  requireAbsentSystemdProbeSurface,
  systemdManagerFlagsForCleanup,
  unlinkIfExists,
  type SystemdProbeSurface,
} from "../scripts/probe-c-support";

const tempDirs: string[] = [];
const posixTest = process.platform !== "win32" ? test : test.skip;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-systemd-probe-"));
  tempDirs.push(dir);
  return dir;
}

function writeRegular(path: string, body: string, executable = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (executable) chmodSync(path, 0o755);
}

function validSummary(): SystemdProbeSummary {
  return {
    schemaVersion: 1,
    target: "x86_64-unknown-linux-gnu",
    package: LINUX_DEB_PACKAGE,
    unitAbsoluteStablePaths: true,
    ocxServiceIdentity: true,
    readiness: "ready",
    crashRestartNewPid: true,
    repairCommitted: true,
    repairRollback: true,
    stopUninstallCleanup: true,
    userConfigPreserved: true,
    globalJsRuntimeUsed: false,
    tauriGuiPackage: false,
    webviewEvidence: false,
    injectedDependencySeams: false,
    failureFixture: "cooperative-ready-failed",
  };
}

function absentSurface(): SystemdProbeSurface {
  return {
    unitExists: false,
    wantsExists: false,
    serviceActive: false,
    unitLoaded: false,
    defaultServiceStateExists: false,
    isolatedServiceStateExists: false,
  };
}

describe("linux deb systemd probe contract", () => {
  test("accepts the exact path-free summary", () => {
    const summary = validateSystemdProbeSummary(validSummary());
    expect(Object.keys(summary)).toEqual([...SYSTEMD_SUMMARY_KEYS]);
    expect(jsonLooksPathFree(summary)).toBe(true);
    expect(summary.tauriGuiPackage).toBe(false);
  });

  test("rejects extra keys and GUI or global-runtime claims", () => {
    expect(() => validateSystemdProbeSummary({ ...validSummary(), extra: 1 })).toThrow();
    expect(() => validateSystemdProbeSummary({ ...validSummary(), tauriGuiPackage: true })).toThrow();
    expect(() => validateSystemdProbeSummary({ ...validSummary(), globalJsRuntimeUsed: true })).toThrow();
    expect(() => validateSystemdProbeSummary({ ...validSummary(), injectedDependencySeams: true })).toThrow();
    expect(() => validateSystemdProbeSummary({ ...validSummary(), failureFixture: "chmod-0644" })).toThrow();
  });

  test("safety gate requires GitHub Actions and explicit opt-in", () => {
    const previousActions = process.env.GITHUB_ACTIONS;
    const previousOptIn = process.env.OCX_DESTRUCTIVE_SYSTEMD_PROBE;
    try {
      delete process.env.GITHUB_ACTIONS;
      process.env.OCX_DESTRUCTIVE_SYSTEMD_PROBE = "1";
      expect(() => assertDestructiveSystemdProbeAllowed()).toThrow(/CI-only/);
      process.env.GITHUB_ACTIONS = "true";
      delete process.env.OCX_DESTRUCTIVE_SYSTEMD_PROBE;
      expect(() => assertDestructiveSystemdProbeAllowed()).toThrow(/OCX_DESTRUCTIVE_SYSTEMD_PROBE/);
      process.env.GITHUB_ACTIONS = "true";
      process.env.OCX_DESTRUCTIVE_SYSTEMD_PROBE = "1";
      expect(() => assertDestructiveSystemdProbeAllowed()).not.toThrow();
    } finally {
      if (previousActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previousActions;
      if (previousOptIn === undefined) delete process.env.OCX_DESTRUCTIVE_SYSTEMD_PROBE;
      else process.env.OCX_DESTRUCTIVE_SYSTEMD_PROBE = previousOptIn;
    }
  });

  test("refuses to mutate when a production unit or service-state already exists", () => {
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      unitExists: true,
    })).toThrow(/unit already exists/);
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      wantsExists: true,
    })).toThrow(/wants symlink already exists/);
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      serviceActive: true,
    })).toThrow(/already active/);
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      unitLoaded: true,
    })).toThrow(/already loaded/);
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      defaultServiceStateExists: true,
    })).toThrow(/default service-state/);
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      isolatedServiceStateExists: true,
    })).toThrow(/isolated service-state/);
    expect(() => requireAbsentSystemdProbeSurface(absentSurface())).not.toThrow();
  });

  test("strict systemctl observation fails closed before mutation", () => {
    let mutated = false;
    const mutate = () => { mutated = true; };
    expect(() => {
      interpretSystemdShow({ status: 1, stdout: "LoadState=not-found\nActiveState=inactive\n" });
      mutate();
    }).toThrow(/cannot query systemd manager state/);
    expect(mutated).toBe(false);
    expect(() => {
      interpretSystemdShow({ status: 0, stdout: "LoadState=\nActiveState=inactive\n" });
      mutate();
    }).toThrow(/systemd manager state is missing/);
    expect(mutated).toBe(false);
    expect(() => {
      interpretSystemdShow({ status: 0, stdout: "LoadState=mystery\nActiveState=inactive\n" });
      mutate();
    }).toThrow(/LoadState is unknown/);
    expect(mutated).toBe(false);
    expect(() => {
      interpretSystemdShow({ status: 0, stdout: "LoadState=loaded\nActiveState=weird\n" });
      mutate();
    }).toThrow(/ActiveState is unknown/);
    expect(mutated).toBe(false);
    const absent = managerFlagsFromStates(interpretSystemdShow({
      status: 0,
      stdout: "LoadState=not-found\nActiveState=inactive\n",
    }));
    expect(absent).toEqual({ unitLoaded: false, serviceActive: false });
    const failed = managerFlagsFromStates(interpretSystemdShow({
      status: 0,
      stdout: "LoadState=loaded\nActiveState=failed\n",
    }));
    expect(failed).toEqual({ unitLoaded: true, serviceActive: true });
    const activating = managerFlagsFromStates(interpretSystemdShow({
      status: 0,
      stdout: "LoadState=loaded\nActiveState=activating\n",
    }));
    expect(activating).toEqual({ unitLoaded: true, serviceActive: true });
    const deactivating = managerFlagsFromStates(interpretSystemdShow({
      status: 0,
      stdout: "LoadState=loaded\nActiveState=deactivating\n",
    }));
    expect(deactivating).toEqual({ unitLoaded: true, serviceActive: true });
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      ...failed,
    })).toThrow();
  });

  test("conservative cleanup marks manager state present on query failure", () => {
    expect(systemdManagerFlagsForCleanup(null)).toEqual({ unitLoaded: true, serviceActive: true });
    expect(systemdManagerFlagsForCleanup({ status: 1, stdout: "" })).toEqual({
      unitLoaded: true,
      serviceActive: true,
    });
    expect(systemdManagerFlagsForCleanup({
      status: 0,
      stdout: "LoadState=not-found\nActiveState=inactive\n",
    })).toEqual({ unitLoaded: false, serviceActive: false });
    let stopped = false;
    cleanupCreatedSystemdArtifacts({
      baseline: absentSurface(),
      current: {
        ...absentSurface(),
        ...systemdManagerFlagsForCleanup(null),
      },
      stopAndDisable: () => { stopped = true; },
      removeUnit: () => {},
      removeWants: () => {},
      removeDefaultState: () => {},
      removeIsolatedState: () => {},
      daemonReload: () => {},
    });
    expect(stopped).toBe(true);
  });

  test("partial unit and state created then throw is cleaned from baseline", () => {
    const root = tempDir();
    const unit = join(root, "opencodex-proxy.service");
    const wantsDir = join(root, "default.target.wants");
    mkdirSync(wantsDir, { recursive: true });
    const wants = join(wantsDir, "opencodex-proxy.service");
    const defaultState = join(root, "default-service-state.json");
    const isolatedState = join(root, "isolated-service-state.json");
    const baseline = absentSurface();
    expect(() => {
      try {
        writeFileSync(unit, "[Service]\nExecStart=/bin/true\n");
        writeFileSync(wants, "[Service]\nExecStart=/bin/true\n");
        writeFileSync(defaultState, "{}\n");
        writeFileSync(isolatedState, "{}\n");
        throw new Error("service-install failed");
      } finally {
        cleanupCreatedSystemdArtifacts({
          baseline,
          current: {
            unitExists: entryExists(unit),
            wantsExists: entryExists(wants),
            serviceActive: true,
            unitLoaded: true,
            defaultServiceStateExists: entryExists(defaultState),
            isolatedServiceStateExists: entryExists(isolatedState),
          },
          stopAndDisable: () => {},
          removeUnit: () => unlinkIfExists(unit),
          removeWants: () => unlinkIfExists(wants),
          removeDefaultState: () => unlinkIfExists(defaultState),
          removeIsolatedState: () => unlinkIfExists(isolatedState),
          daemonReload: () => {},
        });
      }
    }).toThrow(/service-install failed/);
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(wants)).toBe(false);
    expect(existsSync(defaultState)).toBe(false);
    expect(existsSync(isolatedState)).toBe(false);
  });

  posixTest("preflight rejects a pre-existing broken wants symlink", () => {
    const root = tempDir();
    const unit = join(root, "opencodex-proxy.service");
    const wantsDir = join(root, "default.target.wants");
    mkdirSync(wantsDir, { recursive: true });
    const wants = join(wantsDir, "opencodex-proxy.service");
    symlinkSync(unit, wants);
    expect(entryExists(wants)).toBe(true);
    expect(existsSync(wants)).toBe(false);
    expect(() => requireAbsentSystemdProbeSurface({
      ...absentSurface(),
      wantsExists: entryExists(wants),
    })).toThrow(/wants symlink already exists/);
    unlinkIfExists(wants);
    expect(entryExists(wants)).toBe(false);
  });

  posixTest("broken wants symlink remains visible and is removed after unit deletion", () => {
    const root = tempDir();
    const unit = join(root, "opencodex-proxy.service");
    const wantsDir = join(root, "default.target.wants");
    mkdirSync(wantsDir, { recursive: true });
    const wants = join(wantsDir, "opencodex-proxy.service");
    writeFileSync(unit, "[Service]\nExecStart=/bin/true\n");
    symlinkSync(unit, wants);
    unlinkSync(unit);
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(wants)).toBe(false);
    expect(entryExists(wants)).toBe(true);
    const removed: string[] = [];
    cleanupCreatedSystemdArtifacts({
      baseline: absentSurface(),
      current: {
        unitExists: entryExists(unit),
        wantsExists: entryExists(wants),
        serviceActive: false,
        unitLoaded: false,
        defaultServiceStateExists: false,
        isolatedServiceStateExists: false,
      },
      stopAndDisable: () => {
        throw new Error("disable failed");
      },
      removeUnit: () => {
        removed.push("unit");
        unlinkIfExists(unit);
      },
      removeWants: () => {
        removed.push("wants");
        unlinkIfExists(wants);
      },
      removeDefaultState: () => {},
      removeIsolatedState: () => {},
      daemonReload: () => { removed.push("reload"); },
    });
    expect(removed).toEqual(["wants", "reload"]);
    expect(entryExists(wants)).toBe(false);
    expect(entryExists(unit)).toBe(false);
  });

  posixTest("cleanup unlinks the wants symlink before the unit file", () => {
    const root = tempDir();
    const unit = join(root, "opencodex-proxy.service");
    const wantsDir = join(root, "default.target.wants");
    mkdirSync(wantsDir, { recursive: true });
    const wants = join(wantsDir, "opencodex-proxy.service");
    writeFileSync(unit, "[Service]\nExecStart=/bin/true\n");
    symlinkSync(unit, wants);
    const order: string[] = [];
    cleanupCreatedSystemdArtifacts({
      baseline: absentSurface(),
      current: {
        unitExists: entryExists(unit),
        wantsExists: entryExists(wants),
        serviceActive: true,
        unitLoaded: true,
        defaultServiceStateExists: false,
        isolatedServiceStateExists: false,
      },
      stopAndDisable: () => { order.push("disable"); },
      removeUnit: () => {
        order.push("unit");
        unlinkIfExists(unit);
      },
      removeWants: () => {
        order.push("wants");
        unlinkIfExists(wants);
      },
      removeDefaultState: () => {},
      removeIsolatedState: () => {},
      daemonReload: () => { order.push("reload"); },
    });
    expect(order).toEqual(["disable", "wants", "unit", "reload"]);
    expect(entryExists(wants)).toBe(false);
    expect(entryExists(unit)).toBe(false);
  });

  test("failed-candidate injection is manifest-valid ready-failed, not chmod", () => {
    const source = readFileSync(join(import.meta.dir, "../scripts/probe-linux-deb-systemd.ts"), "utf8");
    expect(source).toContain("writeFailedReadyCli");
    expect(source).toContain("assertDestructiveSystemdProbeAllowed");
    expect(source).toContain("requireAbsentSystemdProbeSurface");
    expect(source).toContain("cleanupCreatedSystemdArtifacts");
    expect(source).toContain("snapshotSystemdSurfaceStrict");
    expect(source).toContain("snapshotSystemdSurfaceForCleanup");
    expect(source).toContain("entryExists");
    expect(source).toContain("unlinkIfExists");
    expect(source).toContain("systemdSurfacesEqual");
    expect(source).toContain("stubReadyzHit");
    expect(source).toContain("terminateOwnedProbeChildren");
    expect(source).toContain("proxy_not_ready");
    expect(source).not.toContain("restore_failed");
    expect(source).not.toMatch(/chmodSync\([^)]*0o644/);
    expect(source).not.toContain("0o644");
  });

  posixTest("runtime-layout deb has no maintainer scripts or GUI binary", () => {
    const root = tempDir();
    const target = "x86_64-unknown-linux-gnu";
    const bunName = `ocx-runtime-${target}`;
    writeRegular(join(root, "package.json"), `${JSON.stringify({ name: "ocx-runtime", version: "2.36.0" })}\n`);
    writeRegular(join(root, bunName), "#!/bin/sh\necho ocx\n", true);
    writeRegular(join(root, "src/cli/index.ts"), "export {}\n");
    writeRegular(join(root, "desktop/runtime/bootstrap.ts"), "export {}\n");
    writeRegular(join(root, "desktop/runtime/install.ts"), "export {}\n");
    writeRegular(join(root, "gui/dist/index.html"), "<html></html>\n");
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.36.0", target),
      version: "2.36.0",
      target,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: bunName, executable: true },
        { path: "src/cli/index.ts", executable: false },
        { path: "desktop/runtime/bootstrap.ts", executable: false },
        { path: "desktop/runtime/install.ts", executable: false },
        { path: "gui/dist/index.html", executable: false },
      ],
      enforceExecutableBit: true,
    });
    if (!created.ok) throw new Error(created.message);
    const written = writeRuntimeManifestFile(root, created.manifest);
    if (!written.ok) throw new Error(written.message);
    const deb = join(tempDir(), "open-codex.deb");
    const packed = packLinuxRuntimeDeb({ runtimeRoot: root, outputDeb: deb });
    expect(packed.package).toBe(LINUX_DEB_PACKAGE);
    expect(packed.sha256).toMatch(/^[a-f0-9]{64}$/);
    const extract = tempDir();
    const extracted = Bun.spawnSync(["dpkg-deb", "-R", packed.deb, extract], { stdout: "pipe", stderr: "pipe" });
    expect(extracted.exitCode).toBe(0);
    expect(existsSync(join(extract, LINUX_DEB_SIDECAR_REL))).toBe(true);
    expect(existsSync(join(extract, LINUX_DEB_APP_REL))).toBe(false);
    expect(existsSync(join(extract, "DEBIAN", "postinst"))).toBe(false);
    expect(existsSync(join(extract, "DEBIAN", "preinst"))).toBe(false);
    expect(existsSync(join(extract, "DEBIAN", "prerm"))).toBe(false);
    expect(existsSync(join(extract, "DEBIAN", "postrm"))).toBe(false);
    expect(readFileSync(join(extract, "DEBIAN", "control"), "utf8")).toContain("Package: open-codex");
  });
});
