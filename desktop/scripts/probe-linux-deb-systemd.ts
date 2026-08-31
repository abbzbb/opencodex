#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findLiveProxy, probeReadiness } from "../../src/server/proxy-liveness";
import { ACTIVATION_JOURNAL_NAME } from "../runtime/activation-journal";
import { LINUX_DEB_PACKAGE, LINUX_DEB_RUNTIME_REL, LINUX_DEB_SIDECAR_REL } from "./probe-linux-deb";
import { readRuntimeManifestFile, verifyRuntimeTree } from "../runtime/manifest";
import { STABLE_VERSIONS_DIR, readCurrentPointer } from "../runtime/staging";
import { validateEnvelope } from "../runtime/protocol";
import {
  LINUX_X64_TARGET,
  FAILURE_FIXTURE,
  assertDestructiveSystemdProbeAllowed,
  cleanupCreatedSystemdArtifacts,
  clearFailedCandidateMarkers,
  entryExists,
  cmdlineMatchesRuntime,
  copyTree,
  createIsolatedHomes,
  distinctSuccessorVersions,
  exactKeys,
  execStartBindsRuntime,
  fail,
  interpretSystemdShow,
  managerFlagsFromStates,
  invokeBridge,
  invokeInstall,
  isProcessAlive,
  isRecord,
  jsonLooksPathFree,
  overlayCurrentDesktopRuntime,
  readStubPid,
  removeIsolatedHomes,
  requireAbsentSystemdProbeSurface,
  requireProxyNotReadyAfterFailedStart,
  requireStubCleanupOk,
  resignRuntimeTree,
  rewritePackageVersion,
  runtimeBinaryName,
  seedProbeCanaries,
  stubReadyzHit,
  systemdManagerFlagsForCleanup,
  systemdSurfacesEqual,
  terminateOwnedProbeChildren,
  unlinkIfExists,
  verifyProbeCanaries,
  waitUntil,
  writeFailedReadyCli,
  type JsonRecord,
  type SystemdProbeSurface,
} from "./probe-c-support";

const INSTALLED_SIDECAR = `/${LINUX_DEB_SIDECAR_REL}`;
const INSTALLED_RUNTIME = `/${LINUX_DEB_RUNTIME_REL}`;
const UNIT_NAME = "opencodex-proxy.service";
const INSTALL_TIMEOUT_MS = 180_000;
const BRIDGE_TIMEOUT_MS = 120_000;
const FAIL_TIMEOUT_MS = 150_000;
const PORT = 18_241;

export const SYSTEMD_SUMMARY_KEYS = [
  "schemaVersion",
  "target",
  "package",
  "unitAbsoluteStablePaths",
  "ocxServiceIdentity",
  "readiness",
  "crashRestartNewPid",
  "repairCommitted",
  "repairRollback",
  "stopUninstallCleanup",
  "userConfigPreserved",
  "globalJsRuntimeUsed",
  "tauriGuiPackage",
  "webviewEvidence",
  "injectedDependencySeams",
  "failureFixture",
] as const;

export type SystemdProbeSummary = {
  schemaVersion: 1;
  target: typeof LINUX_X64_TARGET;
  package: typeof LINUX_DEB_PACKAGE;
  unitAbsoluteStablePaths: true;
  ocxServiceIdentity: true;
  readiness: "ready";
  crashRestartNewPid: true;
  repairCommitted: true;
  repairRollback: true;
  stopUninstallCleanup: true;
  userConfigPreserved: true;
  globalJsRuntimeUsed: false;
  tauriGuiPackage: false;
  webviewEvidence: false;
  injectedDependencySeams: false;
  failureFixture: typeof FAILURE_FIXTURE;
};

function which(name: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const value = result.stdout.trim();
  return result.status === 0 && value.length > 0 ? value : null;
}

function unitPath(): string {
  return join(homedir(), ".config/systemd/user", UNIT_NAME);
}

function wantsPath(): string {
  return join(homedir(), ".config/systemd/user/default.target.wants", UNIT_NAME);
}

function defaultServiceStatePath(): string {
  return join(homedir(), ".opencodex", "service-state.json");
}

function systemctl(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    env: process.env,
  });
  return { status: result.status ?? 1, stdout: result.stdout };
}

function unitText(): string {
  if (!existsSync(unitPath())) fail("systemd user unit is missing");
  return readFileSync(unitPath(), "utf8");
}

function loadedExecStart(): string {
  return systemctl(["show", "opencodex-proxy", "--property", "ExecStart", "--value"]).stdout;
}

function showManager(): { status: number; stdout: string } {
  return systemctl(["show", "opencodex-proxy", "--property", "LoadState", "--property", "ActiveState"]);
}

function observeManagerStrict(): { loadState: string; activeState: string } {
  return interpretSystemdShow(showManager());
}

function serviceIsRunning(): boolean {
  return observeManagerStrict().activeState === "active";
}

function mainPid(): number {
  const shown = systemctl(["show", "opencodex-proxy", "--property", "MainPID", "--value"]);
  const pid = Number.parseInt(shown.stdout.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("systemd MainPID is missing");
  return pid;
}

function generationRoot(stableRoot: string, version: string): string {
  return join(stableRoot, STABLE_VERSIONS_DIR, version);
}

function pointerPair(stableRoot: string): { current: string; previous: string | null; currentVersion: string } {
  const pointer = readCurrentPointer(stableRoot);
  if (!pointer.ok || !pointer.pointer) fail("current pointer is missing");
  return {
    current: pointer.pointer.current.id,
    previous: pointer.pointer.previous?.id ?? null,
    currentVersion: pointer.pointer.current.version,
  };
}

function requirePointerPair(
  stableRoot: string,
  expectedCurrentId: string,
  expectedPreviousId: string | null,
  expectedVersion: string,
): void {
  const pair = pointerPair(stableRoot);
  if (pair.current !== expectedCurrentId || pair.previous !== expectedPreviousId || pair.currentVersion !== expectedVersion) {
    fail("current/previous pointer pair mismatch");
  }
}

function requireLoadedStablePaths(bunPath: string, cliPath: string): void {
  const unit = unitText();
  if (!unit.includes("Environment=OCX_SERVICE=1") && !/\bOCX_SERVICE=1\b/.test(unit)) {
    fail("unit is missing OCX_SERVICE identity");
  }
  if (!execStartBindsRuntime(unit, bunPath, cliPath)) fail("unit ExecStart is not bound to the expected runtime");
  if (!execStartBindsRuntime(loadedExecStart(), bunPath, cliPath)) {
    fail("loaded ExecStart is not bound to the expected runtime");
  }
}

function fileSystemdSurface(isolatedServiceStatePath: string): Pick<
  SystemdProbeSurface,
  "unitExists" | "wantsExists" | "defaultServiceStateExists" | "isolatedServiceStateExists"
> {
  return {
    unitExists: entryExists(unitPath()),
    wantsExists: entryExists(wantsPath()),
    defaultServiceStateExists: entryExists(defaultServiceStatePath()),
    isolatedServiceStateExists: entryExists(isolatedServiceStatePath),
  };
}

function snapshotSystemdSurfaceStrict(isolatedServiceStatePath: string): SystemdProbeSurface {
  const manager = managerFlagsFromStates(observeManagerStrict());
  return {
    ...fileSystemdSurface(isolatedServiceStatePath),
    serviceActive: manager.serviceActive,
    unitLoaded: manager.unitLoaded,
  };
}

function snapshotSystemdSurfaceForCleanup(isolatedServiceStatePath: string): SystemdProbeSurface {
  const files = fileSystemdSurface(isolatedServiceStatePath);
  let shown: { status: number; stdout: string } | null = null;
  try {
    shown = showManager();
  } catch {
    shown = null;
  }
  const manager = systemdManagerFlagsForCleanup(shown);
  return {
    ...files,
    serviceActive: manager.serviceActive,
    unitLoaded: manager.unitLoaded,
  };
}

function verifyStagedGeneration(root: string, version: string): void {
  const loaded = readRuntimeManifestFile(join(root, "runtime-manifest.json"), {
    expectedTarget: LINUX_X64_TARGET,
  });
  if (!loaded.ok || loaded.manifest.version !== version) fail("staged generation manifest is missing");
  const verified = verifyRuntimeTree(root, loaded.manifest, {
    expectedTarget: LINUX_X64_TARGET,
    enforceExecutableBit: true,
    allowManifestFile: true,
  });
  if (!verified.ok) fail("staged generation failed verification");
}

function materializeCandidate(
  sourceRoot: string,
  destRoot: string,
  version: string,
  failedReady: boolean,
): void {
  copyTree(sourceRoot, destRoot);
  overlayCurrentDesktopRuntime(destRoot);
  rewritePackageVersion(destRoot, version);
  if (failedReady) writeFailedReadyCli(destRoot, version);
  resignRuntimeTree(destRoot, version, LINUX_X64_TARGET);
}

function journalExists(stableRoot: string): boolean {
  return existsSync(join(stableRoot, ACTIVATION_JOURNAL_NAME));
}

export function validateSystemdProbeSummary(value: unknown): SystemdProbeSummary {
  if (!isRecord(value) || !exactKeys(value, SYSTEMD_SUMMARY_KEYS)) fail("systemd summary fields are invalid");
  if (value.schemaVersion !== 1
    || value.target !== LINUX_X64_TARGET
    || value.package !== LINUX_DEB_PACKAGE
    || value.unitAbsoluteStablePaths !== true
    || value.ocxServiceIdentity !== true
    || value.readiness !== "ready"
    || value.crashRestartNewPid !== true
    || value.repairCommitted !== true
    || value.repairRollback !== true
    || value.stopUninstallCleanup !== true
    || value.userConfigPreserved !== true
    || value.globalJsRuntimeUsed !== false
    || value.tauriGuiPackage !== false
    || value.webviewEvidence !== false
    || value.injectedDependencySeams !== false
    || value.failureFixture !== FAILURE_FIXTURE) {
    fail("systemd summary values are invalid");
  }
  if (!jsonLooksPathFree(value)) fail("systemd summary is not path-free");
  return value as SystemdProbeSummary;
}

async function requireServiceReady(
  bunPath: string,
  generationRootPath: string,
  env: Record<string, string>,
  requestId: string,
  expected: {
    pid: number;
    version: string;
    bunPath: string;
    cliPath: string;
    currentId: string;
    previousId: string | null;
    stableRoot: string;
  },
): Promise<void> {
  const status = await invokeBridge(bunPath, generationRootPath, env, {
    schemaVersion: 1,
    requestId,
    operation: "status",
    payload: {},
  }, BRIDGE_TIMEOUT_MS);
  const parsed = validateEnvelope(status);
  if (!parsed.ok || !parsed.value.ok) fail("service status failed");
  const result = parsed.value.result as JsonRecord;
  if (result.owner !== "desktop-service" || result.status !== "ready") fail("service is not ready");
  if (result.version !== expected.version) fail("service version mismatch");
  if (result.pid !== expected.pid) fail("status pid does not match MainPID");
  requirePointerPair(expected.stableRoot, expected.currentId, expected.previousId, expected.version);
  requireLoadedStablePaths(expected.bunPath, expected.cliPath);
  if (!cmdlineMatchesRuntime(expected.pid, expected.bunPath, expected.cliPath)) {
    fail("MainPID cmdline does not use the expected stable paths");
  }
  const live = await findLiveProxy();
  if (!live || live.pid !== expected.pid || live.version !== expected.version) fail("live proxy identity mismatch");
  const ready = await probeReadiness(live.port, { hostname: live.hostname, expectedPid: expected.pid });
  if (!ready || ready.status !== "ready" || ready.pid !== expected.pid) fail("strict readyz failed");
  if (journalExists(expected.stableRoot)) fail("activation journal remained");
}

export async function runLinuxDebSystemdProbe(): Promise<SystemdProbeSummary> {
  assertDestructiveSystemdProbeAllowed();
  if (process.platform !== "linux") fail("systemd probe requires linux");
  if (!existsSync(INSTALLED_SIDECAR) || !existsSync(INSTALLED_RUNTIME)) fail("package-owned runtime is not installed");
  if (which("bun") || which("node") || which("npm") || which("ocx") || which("opencodex")) {
    fail("global JS runtime is on PATH");
  }
  const target = LINUX_X64_TARGET;
  const sourceManifest = readRuntimeManifestFile(join(INSTALLED_RUNTIME, "runtime-manifest.json"), {
    expectedTarget: target,
  });
  if (!sourceManifest.ok) fail("installed runtime manifest is missing");
  const oldVersion = sourceManifest.manifest.version;
  const { newVersion, failVersion } = distinctSuccessorVersions(oldVersion);
  const homes = createIsolatedHomes("ocx-deb-systemd-", PORT);
  const env: Record<string, string> = {
    ...homes.env,
    HOME: homedir(),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? homes.env.XDG_RUNTIME_DIR,
  };
  const isolatedStatePath = join(env.OPENCODEX_HOME, "service-state.json");
  const baseline = snapshotSystemdSurfaceStrict(isolatedStatePath);
  requireAbsentSystemdProbeSurface(baseline);
  const canaries = seedProbeCanaries(env.OPENCODEX_HOME, env.CODEX_HOME);
  const previousHome = process.env.OPENCODEX_HOME;
  const previousCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = env.OPENCODEX_HOME;
  process.env.CODEX_HOME = env.CODEX_HOME;
  const bunName = runtimeBinaryName(target);
  const trackedPids = new Set<number>();
  try {
    const oldSource = join(homes.home, "src-old");
    copyTree(INSTALLED_RUNTIME, oldSource);
    overlayCurrentDesktopRuntime(oldSource);
    resignRuntimeTree(oldSource, oldVersion, target);
    await invokeInstall(join(oldSource, bunName), oldSource, env, homes.stableRoot, target, INSTALL_TIMEOUT_MS);
    const oldRoot = generationRoot(homes.stableRoot, oldVersion);
    const oldBun = join(oldRoot, bunName);
    const oldCli = join(oldRoot, "src/cli/index.ts");
    verifyStagedGeneration(oldRoot, oldVersion);
    const oldManifest = readRuntimeManifestFile(join(oldRoot, "runtime-manifest.json"), { expectedTarget: target });
    if (!oldManifest.ok) fail("staged old generation manifest missing");

    const bootstrap = await invokeBridge(oldBun, oldRoot, env, {
      schemaVersion: 1,
      requestId: "01K3P2BBBBBBBBBBBBBBB00001",
      operation: "bootstrap",
      payload: {},
    }, BRIDGE_TIMEOUT_MS);
    const bootParsed = validateEnvelope(bootstrap);
    if (!bootParsed.ok || !bootParsed.value.ok) fail("desktop-direct bootstrap failed");

    const installed = await invokeBridge(oldBun, oldRoot, env, {
      schemaVersion: 1,
      requestId: "01K3P2BBBBBBBBBBBBBBB00002",
      operation: "service-install",
      payload: { backend: "platform-default", runtimeManifestId: oldManifest.manifest.id },
    }, BRIDGE_TIMEOUT_MS);
    const installParsed = validateEnvelope(installed);
    if (!installParsed.ok || !installParsed.value.ok) fail("service-install failed");

    await waitUntil(() => serviceIsRunning(), 20_000, "service active");
    const oldPid = mainPid();
    trackedPids.add(oldPid);
    requirePointerPair(homes.stableRoot, oldManifest.manifest.id, null, oldVersion);
    await requireServiceReady(oldBun, oldRoot, env, "01K3P2BBBBBBBBBBBBBBB00003", {
      pid: oldPid,
      version: oldVersion,
      bunPath: oldBun,
      cliPath: oldCli,
      currentId: oldManifest.manifest.id,
      previousId: null,
      stableRoot: homes.stableRoot,
    });

    spawnSync("kill", ["-9", String(oldPid)], { stdio: "ignore" });
    await waitUntil(() => {
      try {
        const next = mainPid();
        return next !== oldPid && serviceIsRunning();
      } catch {
        return false;
      }
    }, 30_000, "crash restart");
    const crashPid = mainPid();
    if (crashPid === oldPid) fail("crash restart reused the previous MainPID");
    trackedPids.add(crashPid);
    await waitUntil(async () => {
      const live = await findLiveProxy();
      if (!live || live.pid !== crashPid || live.version !== oldVersion) return false;
      const ready = await probeReadiness(live.port, { hostname: live.hostname, expectedPid: crashPid });
      return Boolean(ready && ready.status === "ready");
    }, 20_000, "crash restart ready");
    await requireServiceReady(oldBun, oldRoot, env, "01K3P2BBBBBBBBBBBBBBB00008", {
      pid: crashPid,
      version: oldVersion,
      bunPath: oldBun,
      cliPath: oldCli,
      currentId: oldManifest.manifest.id,
      previousId: null,
      stableRoot: homes.stableRoot,
    });
    verifyProbeCanaries(env.OPENCODEX_HOME, env.CODEX_HOME, canaries);

    const newSource = join(homes.home, "src-new");
    materializeCandidate(INSTALLED_RUNTIME, newSource, newVersion, false);
    await invokeInstall(join(newSource, bunName), newSource, env, homes.stableRoot, target, INSTALL_TIMEOUT_MS);
    const newManifest = readRuntimeManifestFile(join(newSource, "runtime-manifest.json"), { expectedTarget: target });
    if (!newManifest.ok) fail("repair candidate manifest missing");
    const newRoot = generationRoot(homes.stableRoot, newVersion);
    const newBun = join(newRoot, bunName);
    const newCli = join(newRoot, "src/cli/index.ts");
    verifyStagedGeneration(newRoot, newVersion);
    const repaired = await invokeBridge(oldBun, oldRoot, env, {
      schemaVersion: 1,
      requestId: "01K3P2BBBBBBBBBBBBBBB00004",
      operation: "service-repair",
      payload: { runtimeManifestId: newManifest.manifest.id },
    }, BRIDGE_TIMEOUT_MS);
    const repairParsed = validateEnvelope(repaired);
    if (!repairParsed.ok || !repairParsed.value.ok) fail("service-repair failed");
    await waitUntil(() => {
      try {
        const next = mainPid();
        return next !== crashPid && next !== oldPid && serviceIsRunning();
      } catch {
        return false;
      }
    }, 20_000, "repair restart");
    const repairedPid = mainPid();
    if (repairedPid === crashPid || repairedPid === oldPid) fail("repair reused a prior MainPID");
    trackedPids.add(repairedPid);
    if (isProcessAlive(crashPid)) fail("pre-repair MainPID remained alive");
    await requireServiceReady(newBun, newRoot, env, "01K3P2BBBBBBBBBBBBBBB00009", {
      pid: repairedPid,
      version: newVersion,
      bunPath: newBun,
      cliPath: newCli,
      currentId: newManifest.manifest.id,
      previousId: oldManifest.manifest.id,
      stableRoot: homes.stableRoot,
    });
    verifyProbeCanaries(env.OPENCODEX_HOME, env.CODEX_HOME, canaries);

    const failSource = join(homes.home, "src-fail");
    materializeCandidate(INSTALLED_RUNTIME, failSource, failVersion, true);
    await invokeInstall(join(failSource, bunName), failSource, env, homes.stableRoot, target, INSTALL_TIMEOUT_MS);
    const failManifest = readRuntimeManifestFile(join(failSource, "runtime-manifest.json"), { expectedTarget: target });
    if (!failManifest.ok) fail("rollback candidate manifest missing");
    const failRoot = generationRoot(homes.stableRoot, failVersion);
    const failBun = join(failRoot, bunName);
    const failCli = join(failRoot, "src/cli/index.ts");
    verifyStagedGeneration(failRoot, failVersion);
    clearFailedCandidateMarkers(env.OPENCODEX_HOME);

    const preFailurePid = repairedPid;
    const failPromise = invokeBridge(newBun, newRoot, env, {
      schemaVersion: 1,
      requestId: "01K3P2BBBBBBBBBBBBBBB00005",
      operation: "service-repair",
      payload: { runtimeManifestId: failManifest.manifest.id },
    }, FAIL_TIMEOUT_MS);
    let failedCandidatePid: number | null = null;
    await waitUntil(() => {
      const pid = readStubPid(env.OPENCODEX_HOME);
      if (pid === null || !isProcessAlive(pid)) return false;
      if (!cmdlineMatchesRuntime(pid, failBun, failCli)) return false;
      if (!stubReadyzHit(env.OPENCODEX_HOME)) return false;
      failedCandidatePid = pid;
      return true;
    }, 30_000, "failed candidate start");
    if (failedCandidatePid === null) fail("production operation did not start the candidate");
    trackedPids.add(failedCandidatePid);
    const failed = await failPromise;
    const failedParsed = validateEnvelope(failed);
    if (!failedParsed.ok || failedParsed.value.ok) fail("failed repair unexpectedly succeeded");
    requireProxyNotReadyAfterFailedStart(failedParsed.value.error);
    requireStubCleanupOk(env.OPENCODEX_HOME);
    if (!stubReadyzHit(env.OPENCODEX_HOME)) fail("failed candidate never served failed readyz");
    if (isProcessAlive(failedCandidatePid)) fail("failed candidate remained alive");
    if (isProcessAlive(preFailurePid)) fail("pre-failure pid remained alive");
    await waitUntil(() => {
      try {
        const next = mainPid();
        return next !== preFailurePid && next !== failedCandidatePid && serviceIsRunning();
      } catch {
        return false;
      }
    }, 30_000, "repair rollback");
    const restoredPid = mainPid();
    if (restoredPid === preFailurePid || restoredPid === failedCandidatePid) fail("rollback reused a prior pid");
    trackedPids.add(restoredPid);
    await requireServiceReady(newBun, newRoot, env, "01K3P2BBBBBBBBBBBBBBB00010", {
      pid: restoredPid,
      version: newVersion,
      bunPath: newBun,
      cliPath: newCli,
      currentId: newManifest.manifest.id,
      previousId: oldManifest.manifest.id,
      stableRoot: homes.stableRoot,
    });
    if (isProcessAlive(failedCandidatePid)) fail("failed candidate process is still present");
    if (journalExists(homes.stableRoot)) fail("activation journal remained after rollback");
    verifyProbeCanaries(env.OPENCODEX_HOME, env.CODEX_HOME, canaries);

    await invokeBridge(newBun, newRoot, env, {
      schemaVersion: 1,
      requestId: "01K3P2BBBBBBBBBBBBBBB00006",
      operation: "stop",
      payload: { reason: "app-exit" },
    }, BRIDGE_TIMEOUT_MS);
    await invokeBridge(newBun, newRoot, env, {
      schemaVersion: 1,
      requestId: "01K3P2BBBBBBBBBBBBBBB00007",
      operation: "service-uninstall",
      payload: {},
    }, BRIDGE_TIMEOUT_MS);
    await waitUntil(
      () => systemdSurfacesEqual(snapshotSystemdSurfaceStrict(isolatedStatePath), baseline),
      10_000,
      "uninstall cleanup",
    );
    if (!systemdSurfacesEqual(snapshotSystemdSurfaceStrict(isolatedStatePath), baseline)) {
      fail("uninstall did not restore the preflight surface");
    }
    verifyProbeCanaries(env.OPENCODEX_HOME, env.CODEX_HOME, canaries);

    return validateSystemdProbeSummary({
      schemaVersion: 1,
      target,
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
      failureFixture: FAILURE_FIXTURE,
    });
  } finally {
    try {
      cleanupCreatedSystemdArtifacts({
        baseline,
        current: snapshotSystemdSurfaceForCleanup(isolatedStatePath),
        stopAndDisable: () => {
          spawnSync("systemctl", ["--user", "stop", "opencodex-proxy"], { stdio: "ignore" });
          spawnSync("systemctl", ["--user", "disable", "opencodex-proxy"], { stdio: "ignore" });
        },
        removeUnit: () => unlinkIfExists(unitPath()),
        removeWants: () => unlinkIfExists(wantsPath()),
        removeDefaultState: () => unlinkIfExists(defaultServiceStatePath()),
        removeIsolatedState: () => unlinkIfExists(isolatedStatePath),
        daemonReload: () => {
          spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        },
      });
    } finally {
      await terminateOwnedProbeChildren({
        stableRoot: homes.stableRoot,
        installId: null,
        trackedPids,
        opencodexHome: env.OPENCODEX_HOME,
      });
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodex;
      removeIsolatedHomes(homes.home);
    }
  }
}

if (import.meta.main) {
  runLinuxDebSystemdProbe()
    .then(summary => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : "systemd probe failed"}\n`);
      process.exit(1);
    });
}
