import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runStopTransaction as runCoreStopTransaction } from "../../src/cli/stop-transaction";
import type { DesktopRuntimeIdentity } from "../../src/config/desktop-owner";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import type { ServiceDiagnostic } from "../../src/service";
import { resolveDesktopRuntimeIdentity } from "../runtime/handlers";
import {
  createRuntimeManifestFromFiles,
  readRuntimeManifestFile,
  runtimeManifestId,
  verifyRuntimeTree,
  writeRuntimeManifestFile,
  type TargetTriple,
} from "../runtime/manifest";
import { DeadlineExceededError } from "../runtime/deadline";
import {
  ACTIVATION_JOURNAL_NAME,
  intendedPublishedPointer,
  observeActivationJournal,
  writeActivationJournal,
  type ActivationJournalRecord,
} from "../runtime/activation-journal";
import {
  classifyOwnerForActivation,
  retainReferencedRuntimeGenerations,
  runDesktopServiceMutation,
  stableStoreRootFromIdentity,
  type DesktopServiceMutationDeps,
} from "../runtime/service-activation";
import {
  publishCurrent,
  readCurrentPointer,
  stageRuntime,
  STABLE_VERSIONS_DIR,
} from "../runtime/staging";

const POSIX = process.platform !== "win32";

let home = "";
let previousHome: string | undefined;
const tempDirs: string[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-service-activation-home-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  home = "";
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function hostTarget(): TargetTriple {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  if (process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  return "x86_64-unknown-linux-gnu";
}

function writeFile(root: string, rel: string, content: string, executable = false): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (POSIX) chmodSync(abs, executable ? 0o755 : 0o644);
}

function writePayload(version: string): { root: string; id: string } {
  const target = hostTarget();
  const root = tempDir(`ocx-runtime-src-${version}-`);
  const bunName = `ocx-runtime-${target}${target.includes("windows") ? ".exe" : ""}`;
  writeFile(root, "package.json", `${JSON.stringify({ name: "ocx-runtime", version }, null, 2)}\n`);
  writeFile(root, bunName, "#!/bin/sh\necho ocx\n", true);
  writeFile(root, "src/cli/index.ts", `export const version = "${version}";\n`);
  const created = createRuntimeManifestFromFiles({
    id: runtimeManifestId(version, target),
    version,
    target,
    root,
    files: [
      { path: "package.json", executable: false },
      { path: bunName, executable: POSIX },
      { path: "src/cli/index.ts", executable: false },
    ],
    enforceExecutableBit: POSIX,
  });
  if (!created.ok) throw new Error(created.message);
  const written = writeRuntimeManifestFile(root, created.manifest);
  if (!written.ok) throw new Error(written.message);
  return { root, id: created.manifest.id };
}

function liveFor(identity: DesktopRuntimeIdentity, pid: number): LiveProxy {
  return {
    pid,
    port: 10100,
    hostname: "127.0.0.1",
    source: "runtime",
    version: identity.runtimeVersion,
  };
}

async function setupStore(): Promise<{
  stableRoot: string;
  old: DesktopRuntimeIdentity;
  next: DesktopRuntimeIdentity;
  oldId: string;
  nextId: string;
}> {
  const stableRoot = tempDir("ocx-stable-");
  const target = hostTarget();
  const oldSource = writePayload("2.35.0");
  const nextSource = writePayload("2.36.0");
  const stagedOld = stageRuntime({ sourceRoot: oldSource.root, stableRoot, expectedTarget: target });
  if (!stagedOld.ok) throw new Error(stagedOld.message);
  const published = publishCurrent({
    stableRoot,
    staged: stagedOld.staged,
    expectedCurrent: null,
    expectedTarget: target,
    isVersionReferenced: () => true,
  });
  if (!published.ok) throw new Error(published.message);
  const stagedNext = stageRuntime({ sourceRoot: nextSource.root, stableRoot, expectedTarget: target });
  if (!stagedNext.ok) throw new Error(stagedNext.message);
  const old = resolveDesktopRuntimeIdentity(stagedOld.absPath);
  const next = resolveDesktopRuntimeIdentity(stagedNext.absPath);
  if (!old || !next) throw new Error("failed to resolve staged identities");
  return { stableRoot, old, next, oldId: oldSource.id, nextId: nextSource.id };
}

function fakeDeps(input: {
  old: DesktopRuntimeIdentity;
  next: DesktopRuntimeIdentity;
  owner: DesktopServiceMutationDeps["owner"];
  live: LiveProxy | null;
  serviceInstalled?: boolean;
  failRepair?: boolean;
  failStart?: boolean;
  failReady?: boolean;
  installMutatesThenThrows?: boolean;
  uninstallReturnsFalse?: boolean;
  managerStarted?: boolean;
  failRollbackRepair?: boolean;
  failRollbackStop?: boolean;
  failRollbackStopProxyAbsent?: boolean;
  failRollbackStopOwnership?: boolean;
  stopLeavesCandidatePidAlive?: boolean;
  throwAfterReady?: boolean;
  uninstallLeavesService?: boolean;
  raceServicePaths?: boolean;
  raceServicePathsAfterPublish?: boolean;
  raceDiagnoseConflict?: boolean;
  raceDiagnoseAfterPublish?: boolean;
  failReadyPending?: boolean;
  failOwnedServiceStop?: boolean;
  ownedServiceCanRespawn?: boolean;
  rollbackStopWindow?: "stable-absent" | "respawn";
  beforeRollbackStop?: () => void | Promise<void>;
  beforeJournalPidUpdate?: () => void | Promise<void>;
  identity?: DesktopRuntimeIdentity;
  mutatePointer?: (stableRoot: string) => void;
  installed?: { bunPath?: string; cliPath?: string };
  liveBox?: { current: LiveProxy | null };
  alivePids?: Set<number>;
  holdRepair?: () => Promise<void>;
  onRepairEntered?: () => void;
}): {
  deps: DesktopServiceMutationDeps;
  abort: () => void;
  calls: {
    install: number;
    repair: string[];
    repairBackend: Array<string | null>;
    start: string[];
    stop: number;
    stopPid: number[];
    stopService: number;
    uninstall: number;
    direct: string[];
  };
  installed: { bunPath?: string; cliPath?: string };
} {
  const calls = {
    install: 0,
    repair: [] as string[],
    repairBackend: [] as Array<string | null>,
    start: [] as string[],
    stop: 0,
    stopPid: [] as number[],
    stopService: 0,
    uninstall: 0,
    direct: [] as string[],
  };
  const serviceInstalled = input.serviceInstalled ?? input.owner === "desktop-service";
  const installed: { bunPath?: string; cliPath?: string } = input.installed ?? (serviceInstalled
    ? { bunPath: input.old.bunPath, cliPath: input.old.cliPath }
    : {});
  const liveBox = input.liveBox ?? { current: input.live };
  const alivePids = input.alivePids ?? new Set<number>();
  if (liveBox.current?.pid) alivePids.add(liveBox.current.pid);
  const controller = new AbortController();
  let waitReadySleeps = 0;
  let diagnoseOverride: Partial<ServiceDiagnostic> = {};
  const deps: DesktopServiceMutationDeps = {
    signal: controller.signal,
    identity: input.identity ?? input.old,
    owner: input.owner,
    live: liveBox.current,
    service: {
      installed: Boolean(installed.bunPath),
      startable: Boolean(installed.bunPath),
      stateCode: installed.bunPath ? "startable" : "absent",
    },
    expectedTarget: hostTarget(),
    platform: process.platform,
    sleep: async () => {
      waitReadySleeps += 1;
      if (waitReadySleeps > 40) throw new DeadlineExceededError();
    },
    diagnoseService: () => ({
      supported: true,
      installed: Boolean(installed.bunPath),
      enabled: Boolean(installed.bunPath),
      running: liveBox.current !== null,
      viable: Boolean(installed.bunPath),
      startable: Boolean(installed.bunPath),
      stale: false,
      conflict: false,
      backend: installed.bunPath ? "scheduler" : null,
      summary: installed.bunPath ? "installed" : "not installed",
      ...diagnoseOverride,
    }),
    inspectServiceInstall: () => ({ conflict: false, bunPath: installed.bunPath, cliPath: installed.cliPath }),
    findLiveProxy: async () => liveBox.current,
    probeReadiness: async (_port, opts) => {
      const live = liveBox.current;
      if (input.failReady && live && live.version !== input.old.runtimeVersion && live.pid != null) {
        return { ready: false, status: "failed" as const, pid: live.pid, port: live.port };
      }
      if (input.failReadyPending && live && live.version !== input.old.runtimeVersion && live.pid != null) {
        return { ready: false, status: "pending" as const, pid: live.pid, port: live.port };
      }
      if (!live || !opts.expectedPid || live.pid !== opts.expectedPid) return null;
      return { ready: true, status: "ready" as const, pid: live.pid, port: live.port };
    },
    runStopTransaction: async () => {
      calls.stop += 1;
      if (input.failRollbackStop && calls.stop > 1) {
        return {
          ok: false,
          code: "stop_failed",
          retryable: false,
          message: "rollback stop failed",
          serviceStopped: false,
          proxyStopped: false,
          proxyAbsent: false,
          restoreStatus: "failed",
          grokStatus: "not-needed",
          events: [],
        };
      }
      if (input.failRollbackStopOwnership && calls.stop > 1) {
        return {
          ok: false,
          code: "ownership_conflict",
          retryable: false,
          message: "rollback ownership conflict",
          serviceStopped: false,
          proxyStopped: false,
          proxyAbsent: false,
          restoreStatus: "failed",
          grokStatus: "not-needed",
          events: [],
        };
      }
      if (input.rollbackStopWindow && calls.stop > 1) {
        let clock = 0;
        let probes = 0;
        return runCoreStopTransaction({
          stopServiceIfInstalled: () => ({ state: "stopped", canRespawn: true }),
          isServiceOwnershipError: () => false,
          readPid: () => null,
          stopProxy: async () => {},
          removePid: () => {},
          removeRuntimePort: () => {},
          readPidFileValue: () => null,
          readRuntimePortPid: () => null,
          findLiveProxy: async () => {
            probes += 1;
            if (input.rollbackStopWindow === "respawn" && probes >= 2) {
              const revived = liveFor(input.next, 9002);
              liveBox.current = revived;
              if (revived.pid) alivePids.add(revived.pid);
              return revived;
            }
            return liveBox.current;
          },
          removePidIfValueIs: () => {},
          removeRuntimePortIfPidIs: () => {},
          revertSystemEnv: () => {},
          restoreNativeCodexAsync: async () => ({ success: true, message: "ok" }),
          stripGrokConfig: () => ({ ok: true, changed: false, message: "ok" }),
          isProxyOwnershipRefused: () => false,
          sleep: async ms => {
            clock += ms;
          },
          now: () => clock,
          absenceProbeDelayMs: 1_000,
        });
      }
      const stoppedPid = liveBox.current?.pid;
      liveBox.current = null;
      if (stoppedPid && !(input.stopLeavesCandidatePidAlive && calls.stop > 1)) {
        alivePids.delete(stoppedPid);
      }
      if (input.failRollbackStopProxyAbsent && calls.stop > 1) {
        return {
          ok: false,
          code: "restore_failed",
          retryable: false,
          message: "native restore failed",
          serviceStopped: true,
          proxyStopped: true,
          proxyAbsent: true,
          restoreStatus: "failed",
          grokStatus: "not-needed",
          events: [],
        };
      }
      return {
        ok: true,
        code: "stopped",
        serviceStopped: true,
        proxyStopped: true,
        proxyAbsent: true,
        restoreStatus: "not-needed",
        grokStatus: "not-needed",
        events: [],
      };
    },
    isAlive: pid => pid === process.pid || alivePids.has(pid),
    classifyOwner: (observed, identity) => {
      if (installed.bunPath && identity && installed.bunPath === identity.bunPath) {
        return classifyOwnerForActivation({
          identity,
          live: observed,
          service: { installed: true, startable: true, conflict: false },
          serviceInstall: { conflict: false, bunPath: installed.bunPath, cliPath: installed.cliPath },
          commandLine: `${identity.bunPath} ${identity.cliPath} start`,
          isAlive: () => true,
        });
      }
      if (input.owner === "desktop-direct" && !installed.bunPath) {
        if (!observed) return "desktop-direct";
        return identity && observed.version === identity.runtimeVersion
          ? "desktop-direct"
          : "unknown/conflict";
      }
      return classifyOwnerForActivation({
        identity,
        live: observed,
        service: {
          installed: Boolean(installed.bunPath),
          startable: Boolean(installed.bunPath),
          conflict: false,
        },
        serviceInstall: { conflict: false, bunPath: installed.bunPath, cliPath: installed.cliPath },
        commandLine: identity ? `${identity.bunPath} ${identity.cliPath} start` : null,
        isAlive: () => true,
      });
    },
    installService: async identity => {
      calls.install += 1;
      installed.bunPath = identity.bunPath;
      installed.cliPath = identity.cliPath;
      if (input.installMutatesThenThrows) throw new Error("state write failed");
      if (input.managerStarted) {
        const nextLive = liveFor(identity, identity.runtimeVersion === input.next.runtimeVersion ? 9002 : 9001);
        liveBox.current = nextLive;
        if (nextLive.pid) alivePids.add(nextLive.pid);
        return { managerStarted: true };
      }
    },
    repairService: async (identity, opts) => {
      calls.repair.push(identity.runtimeVersion);
      calls.repairBackend.push(opts?.backend ?? null);
      if (input.onRepairEntered && identity.runtimeVersion === input.next.runtimeVersion) {
        input.onRepairEntered();
      }
      if (input.holdRepair && identity.runtimeVersion === input.next.runtimeVersion) {
        await input.holdRepair();
      }
      if (input.failRepair && identity.runtimeVersion === input.next.runtimeVersion) {
        throw new Error("candidate repair exploded");
      }
      if (input.failRollbackRepair && identity.runtimeVersion === input.old.runtimeVersion) {
        throw new Error("rollback repair exploded");
      }
      installed.bunPath = identity.bunPath;
      installed.cliPath = identity.cliPath;
      if (input.managerStarted) {
        const nextLive = liveFor(identity, identity.runtimeVersion === input.next.runtimeVersion ? 9002 : 9001);
        liveBox.current = nextLive;
        if (nextLive.pid) alivePids.add(nextLive.pid);
        return { managerStarted: true };
      }
    },
    startService: async identity => {
      calls.start.push(identity.runtimeVersion);
      if (input.failStart) {
        throw new Error("candidate start exploded");
      }
      const nextLive = liveFor(identity, identity.runtimeVersion === input.next.runtimeVersion ? 9002 : 9001);
      liveBox.current = nextLive;
      if (nextLive.pid) alivePids.add(nextLive.pid);
    },
    startDirect: async identity => {
      calls.direct.push(identity.runtimeVersion);
      const nextLive = liveFor(identity, identity.runtimeVersion === input.next.runtimeVersion ? 9002 : 9001);
      liveBox.current = nextLive;
      if (nextLive.pid) alivePids.add(nextLive.pid);
    },
    uninstallService: async () => {
      calls.uninstall += 1;
      if (input.uninstallLeavesService) return false;
      delete installed.bunPath;
      delete installed.cliPath;
      if (input.uninstallReturnsFalse) return false;
      return true;
    },
    stopOwnedLive: async request => {
      calls.stopPid.push(request.live.pid ?? 0);
    },
    stopOwnedService: async () => {
      calls.stopService += 1;
      if (input.failOwnedServiceStop) {
        return { state: "failed" as const, message: "/secret/user/unit.service failed" };
      }
      if (input.ownedServiceCanRespawn) {
        return { state: "stopped" as const, canRespawn: true };
      }
      return { state: "stopped" as const };
    },
    beforeRollbackStop: input.beforeRollbackStop,
    beforeJournalPidUpdate: input.beforeJournalPidUpdate,
    activationLock: {
      waitTimeoutMs: 2_000,
      pollIntervalMs: 1,
      sleep: async () => {
        await Promise.resolve();
      },
    },
    resolveIdentity: resolveDesktopRuntimeIdentity,
    afterCandidateReady: async () => {
      if (input.raceServicePaths) installed.bunPath = join(input.old.stableRuntimeRoot, "other-bun");
      if (input.raceDiagnoseConflict) {
        diagnoseOverride = { conflict: true, startable: false, installed: true };
      }
      if (input.throwAfterReady) throw new Error("post-ready hook failed");
      if (input.mutatePointer) input.mutatePointer(stableStoreRootFromIdentity(input.old)!);
    },
    publishPointer: input.raceServicePathsAfterPublish || input.raceDiagnoseAfterPublish
      ? (publishInput) => {
          const published = publishCurrent(publishInput);
          if (published.ok && input.raceServicePathsAfterPublish) {
            installed.bunPath = join(input.old.stableRuntimeRoot, "other-bun");
          }
          if (published.ok && input.raceDiagnoseAfterPublish) {
            diagnoseOverride = { conflict: true, startable: false, installed: true };
          }
          return published;
        }
      : undefined,
  };
  return { deps, abort: () => controller.abort(), calls, installed };
}

describe("desktop service runtime activation", () => {
  test("installs a verified candidate, publishes current, and retains the previous generation", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({ changed: true, proxyStatus: "ready" });
    expect(calls.stop).toBe(1);
    expect(calls.repair).toEqual(["2.36.0"]);
    expect(calls.start).toEqual(["2.36.0"]);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.nextId);
    expect(pointer.ok && pointer.pointer?.previous?.id).toBe(store.oldId);
    expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.35.0"))).toBe(true);
    expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.36.0"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(store.next.bunPath);
  });

  test("rolls back to the previous absolute paths when candidate readiness fails", async () => {
    const store = await setupStore();
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      failReady: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    expect(calls.repair).toEqual(["2.36.0", "2.35.0"]);
    expect(calls.start).toContain("2.35.0");
    expect(installed.bunPath).toBe(store.old.bunPath);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("maps candidate repair failure after a successful rollback", async () => {
    const store = await setupStore();
    const { deps, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      failRepair: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("service_not_startable");
    expect(result.error.retryable).toBe(true);
    expect(installed.bunPath).toBe(store.old.bunPath);
  });

  test("keeps referenced generations when rollback repair also fails", async () => {
    const store = await setupStore();
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      failRepair: true,
      failRollbackRepair: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(result.error.retryable).toBe(false);
    expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.35.0"))).toBe(true);
    expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.36.0"))).toBe(true);
  });

  test("CAS conflict stops only this candidate and does not restore the old service", async () => {
    const store = await setupStore();
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      mutatePointer: stableRoot => {
        writeFileSync(join(stableRoot, "current.json"), `${JSON.stringify({
          schemaVersion: 1,
          current: {
            id: "other",
            version: "0.0.1",
            target: hostTarget(),
            relPath: "versions/0.0.1",
          },
          previous: null,
        })}\n`);
      },
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("runtime_integrity_failed");
    expect(result.error.message).toContain("pointer");
    expect(calls.repair).toEqual(["2.36.0"]);
    expect(calls.start).toEqual(["2.36.0"]);
    expect(calls.repair).not.toContain("2.35.0");
    expect(calls.start).not.toContain("2.35.0");
    expect(installed.bunPath).toBe(store.next.bunPath);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe("other");
    expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.35.0"))).toBe(true);
    expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.36.0"))).toBe(true);
  });

  test("refuses existing-external owners with a foreign service", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "existing-external",
      live: liveFor(store.old, 11),
      serviceInstalled: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.stop).toBe(0);
  });

  test("refuses unknown/conflict owners", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "unknown/conflict",
      live: liveFor(store.old, 11),
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.install).toBe(0);
  });

  test("rejects a tampered or escaped runtime manifest id", async () => {
    const store = await setupStore();
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const missing = await runDesktopServiceMutation("repair", { runtimeManifestId: "missing-runtime" }, deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("runtime_integrity_failed");

    writeFileSync(join(store.next.cliPath), "tampered\n");
    const tampered = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.error.code).toBe("runtime_integrity_failed");
  });

  test("rejects a symlinked version directory", async () => {
    const store = await setupStore();
    if (!POSIX) return;
    const versions = join(store.stableRoot, STABLE_VERSIONS_DIR);
    rmSync(join(versions, "2.36.0"), { recursive: true, force: true });
    symlinkSync(join(versions, "2.35.0"), join(versions, "2.36.0"));
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("runtime_integrity_failed");
  });

  test("direct-mode activation restarts the previous generation after candidate failure", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      failReady: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, {
      ...deps,
      mode: "direct",
      owner: "desktop-direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    expect(calls.direct).toContain("2.36.0");
    expect(calls.direct).toContain("2.35.0");
    expect(calls.uninstall).toBe(0);
    expect(calls.install).toBe(0);
    expect(calls.repair).toEqual([]);
  });

  test("install-from-direct rollback uninstalls the candidate and restarts the old direct runtime", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      failReady: true,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    expect(calls.install).toBe(1);
    expect(calls.uninstall).toBe(1);
    expect(calls.direct).toEqual(["2.35.0"]);
    expect(calls.repair).not.toContain("2.35.0");
  });

  test("install-from-stopped rollback uninstalls the candidate and leaves the proxy stopped", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: null,
      failReady: true,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(calls.uninstall).toBe(1);
    expect(calls.direct).toEqual([]);
    expect(calls.start).toEqual(["2.36.0"]);
  });

  test("structured stop failure during rollback is restore_failed", async () => {
    const store = await setupStore();
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      failReady: true,
      failRollbackStop: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(result.error.retryable).toBe(false);
  });

  test("post-ready hook failure rolls back", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      throwAfterReady: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("runtime_integrity_failed");
    expect(calls.repair).toContain("2.35.0");
  });

  test("uninstall residual service is not success", async () => {
    const store = await setupStore();
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      uninstallLeavesService: true,
    });
    const result = await runDesktopServiceMutation("uninstall", {}, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("stop_failed");
  });

  test("pointer/identity mismatch is integrity failure before publish", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      identity: store.next,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("runtime_integrity_failed");
    expect(calls.stop).toBe(0);
  });

  test("service-path race after ready rolls back", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      raceServicePaths: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.repair).toContain("2.35.0");
  });

  test("canonical stable root is the identity parent, not HOME or XDG", async () => {
    const decoyHome = tempDir("ocx-decoy-home-");
    const decoyXdg = tempDir("ocx-decoy-xdg-");
    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.HOME = decoyHome;
    process.env.XDG_DATA_HOME = decoyXdg;
    try {
      const store = await setupStore();
      expect(store.stableRoot.startsWith(decoyHome)).toBe(false);
      expect(store.stableRoot.startsWith(decoyXdg)).toBe(false);
      const { deps } = fakeDeps({
        old: store.old,
        next: store.next,
        owner: "desktop-service",
        live: liveFor(store.old, 9001),
      });
      const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
      expect(result.ok).toBe(true);
      const pointer = readCurrentPointer(store.stableRoot);
      expect(pointer.ok && pointer.pointer?.current.id).toBe(store.nextId);
      expect(existsSync(join(decoyHome, "current.json"))).toBe(false);
      expect(existsSync(join(decoyXdg, "current.json"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
    }
  });

  test("post-publish path race restores current.json to the snapshot pointer", async () => {
    const store = await setupStore();
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      raceServicePathsAfterPublish: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.repair).toEqual(["2.36.0", "2.35.0"]);
    expect(calls.repairBackend[1]).toBe("scheduler");
    expect(installed.bunPath).toBe(store.old.bunPath);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
    expect(pointer.ok && pointer.pointer?.previous).toBeNull();
  });

  test("post-publish rollback does not overwrite a concurrently changed current", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    deps.publishPointer = (publishInput) => {
      const published = publishCurrent(publishInput);
      if (published.ok) {
        writeFileSync(join(store.stableRoot, "current.json"), `${JSON.stringify({
          schemaVersion: 1,
          current: {
            id: "other",
            version: "0.0.1",
            target: hostTarget(),
            relPath: "versions/0.0.1",
          },
          previous: published.pointer.current,
        })}\n`);
      }
      return published;
    };
    const originalInspect = deps.inspectServiceInstall;
    let published = false;
    const originalPublish = deps.publishPointer;
    deps.publishPointer = (input) => {
      const result = originalPublish(input);
      published = result.ok;
      return result;
    };
    deps.inspectServiceInstall = () => {
      const snapshot = originalInspect();
      if (published) return { ...snapshot, bunPath: join(store.old.stableRuntimeRoot, "other-bun") };
      return snapshot;
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.repair).toEqual(["2.36.0"]);
    expect(calls.repair).not.toContain("2.35.0");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe("other");
  });

  test("direct-mode rollback never uninstalls a service this transaction did not touch", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      failReady: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, {
      ...deps,
      mode: "direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(calls.uninstall).toBe(0);
    expect(calls.direct).toEqual(["2.36.0", "2.35.0"]);
  });

  test("pointer target mismatch is integrity failure before mutation", async () => {
    const store = await setupStore();
    const pointer = readCurrentPointer(store.stableRoot);
    if (!pointer.ok || !pointer.pointer) throw new Error("missing pointer");
    const wrongTarget = hostTarget() === "x86_64-unknown-linux-gnu"
      ? "aarch64-apple-darwin"
      : "x86_64-unknown-linux-gnu";
    writeFileSync(join(store.stableRoot, "current.json"), `${JSON.stringify({
      schemaVersion: 1,
      current: { ...pointer.pointer.current, target: wrongTarget },
      previous: pointer.pointer.previous,
    })}\n`);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("runtime_integrity_failed");
    expect(calls.stop).toBe(0);
    expect(calls.repair).toEqual([]);
  });

  test("service path comparison matches canonical aliases of the exact candidate files", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const originalInspect = deps.inspectServiceInstall;
    deps.inspectServiceInstall = () => {
      const snapshot = originalInspect();
      if (!snapshot.bunPath || !snapshot.cliPath) return snapshot;
      return {
        conflict: false,
        bunPath: join(snapshot.bunPath, "."),
        cliPath: join(snapshot.cliPath, "."),
      };
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(true);
    expect(calls.repair).toEqual(["2.36.0"]);
    const published = readCurrentPointer(store.stableRoot);
    expect(published.ok && published.pointer?.current.id).toBe(store.nextId);
  });

  test("two overlapping candidates serialize: one winner, loser never rolls the winner back", async () => {
    const store = await setupStore();
    const extraSource = writePayload("2.37.0");
    const stagedExtra = stageRuntime({
      sourceRoot: extraSource.root,
      stableRoot: store.stableRoot,
      expectedTarget: hostTarget(),
    });
    if (!stagedExtra.ok) throw new Error(stagedExtra.message);
    const extra = resolveDesktopRuntimeIdentity(stagedExtra.absPath);
    if (!extra) throw new Error("failed to resolve extra identity");

    const installed = { bunPath: store.old.bunPath, cliPath: store.old.cliPath };
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>(resolve => {
      releaseHold = resolve;
    });
    let holding = false;

    const winner = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      installed,
      holdRepair: async () => {
        holding = true;
        await hold;
      },
    });
    const loser = fakeDeps({
      old: store.old,
      next: extra,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      installed,
    });

    const winnerPromise = runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, winner.deps);
    try {
      for (let i = 0; i < 10_000 && !holding; i++) await Promise.resolve();
      if (!holding) throw new Error("winner never entered repair");
      const loserPromise = runDesktopServiceMutation("repair", { runtimeManifestId: extraSource.id }, loser.deps);
      for (let i = 0; i < 1_000 && loser.calls.repair.length === 0; i++) await Promise.resolve();
      expect(loser.calls.repair).toEqual([]);
      expect(loser.calls.install).toBe(0);
      releaseHold();
      const [winnerResult, loserResult] = await Promise.all([winnerPromise, loserPromise]);
      expect(winnerResult.ok).toBe(true);
      expect(loserResult.ok).toBe(false);
      if (loserResult.ok) return;
      expect(loserResult.error.code).toBe("runtime_integrity_failed");
      expect(loser.calls.repair).toEqual([]);
      expect(loser.calls.start).toEqual([]);
      expect(loser.calls.uninstall).toBe(0);
      expect(winner.calls.repair).toEqual(["2.36.0"]);
      expect(installed.bunPath).toBe(store.next.bunPath);
      const pointer = readCurrentPointer(store.stableRoot);
      expect(pointer.ok && pointer.pointer?.current.id).toBe(store.nextId);
      expect(pointer.ok && pointer.pointer?.current.id).not.toBe(extraSource.id);
      expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.35.0"))).toBe(true);
      expect(existsSync(join(store.stableRoot, STABLE_VERSIONS_DIR, "2.36.0"))).toBe(true);
    } finally {
      releaseHold();
      winner.abort();
      loser.abort();
    }
  });

  test("stale start blocked on the lock must not start the old runtime", async () => {
    const store = await setupStore();
    const installed = { bunPath: store.old.bunPath, cliPath: store.old.cliPath };
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const alivePids = new Set<number>([9001]);
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>(resolve => {
      releaseHold = resolve;
    });
    let holding = false;
    const winner = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      installed,
      liveBox,
      alivePids,
      holdRepair: async () => {
        holding = true;
        await hold;
      },
    });
    const waiter = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: null,
      installed,
      liveBox,
      alivePids,
    });
    const winnerPromise = runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, winner.deps);
    try {
      for (let i = 0; i < 10_000 && !holding; i++) await Promise.resolve();
      if (!holding) throw new Error("winner never entered repair");
      const waiterPromise = runDesktopServiceMutation("start", {}, waiter.deps);
      releaseHold();
      const [winnerResult, waiterResult] = await Promise.all([winnerPromise, waiterPromise]);
      expect(winnerResult.ok).toBe(true);
      expect(waiterResult.ok).toBe(false);
      if (waiterResult.ok) return;
      expect(waiterResult.error.code).toBe("runtime_integrity_failed");
      expect(waiter.calls.start).toEqual([]);
      expect(winner.calls.start).toEqual(["2.36.0"]);
    } finally {
      releaseHold();
      winner.abort();
      waiter.abort();
    }
  });

  test("stale uninstall blocked on the lock must not remove the winner service", async () => {
    const store = await setupStore();
    const installed = { bunPath: store.old.bunPath, cliPath: store.old.cliPath };
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const alivePids = new Set<number>([9001]);
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>(resolve => {
      releaseHold = resolve;
    });
    let holding = false;
    const winner = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      installed,
      liveBox,
      alivePids,
      holdRepair: async () => {
        holding = true;
        await hold;
      },
    });
    const waiter = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      installed,
      liveBox,
      alivePids,
    });
    const winnerPromise = runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, winner.deps);
    try {
      for (let i = 0; i < 10_000 && !holding; i++) await Promise.resolve();
      if (!holding) throw new Error("winner never entered repair");
      const waiterPromise = runDesktopServiceMutation("uninstall", {}, waiter.deps);
      releaseHold();
      const [winnerResult, waiterResult] = await Promise.all([winnerPromise, waiterPromise]);
      expect(winnerResult.ok).toBe(true);
      expect(waiterResult.ok).toBe(false);
      if (waiterResult.ok) return;
      expect(waiterResult.error.code).toBe("runtime_integrity_failed");
      expect(waiter.calls.uninstall).toBe(0);
      expect(installed.bunPath).toBe(store.next.bunPath);
    } finally {
      releaseHold();
      winner.abort();
      waiter.abort();
    }
  });

  test("install from stale absent state reclassifies after the lock", async () => {
    const store = await setupStore();
    const installed: { bunPath?: string; cliPath?: string } = {};
    const liveBox = { current: null as LiveProxy | null };
    const alivePids = new Set<number>();
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>(resolve => {
      releaseHold = resolve;
    });
    let holding = false;
    const winner = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: null,
      serviceInstalled: false,
      installed,
      liveBox,
      alivePids,
    });
    winner.deps.installService = async identity => {
      holding = true;
      await hold;
      installed.bunPath = identity.bunPath;
      installed.cliPath = identity.cliPath;
      winner.calls.install += 1;
    };
    const waiter = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: null,
      serviceInstalled: false,
      installed,
      liveBox,
      alivePids,
    });
    const winnerPromise = runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, winner.deps);
    try {
      for (let i = 0; i < 10_000 && !holding; i++) await Promise.resolve();
      if (!holding) throw new Error("winner never entered install");
      const waiterPromise = runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, waiter.deps);
      releaseHold();
      const [winnerResult, waiterResult] = await Promise.all([winnerPromise, waiterPromise]);
      expect(winnerResult.ok).toBe(true);
      expect(waiterResult.ok).toBe(false);
      if (waiterResult.ok) return;
      expect(waiterResult.error.code).toBe("runtime_integrity_failed");
      expect(waiter.calls.install).toBe(0);
      expect(winner.calls.install).toBe(1);
    } finally {
      releaseHold();
      winner.abort();
      waiter.abort();
    }
  });

  test("rollback requires the candidate PID dead even when the listener is gone", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      throwAfterReady: true,
      stopLeavesCandidatePidAlive: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.repair).toEqual(["2.36.0"]);
    expect(calls.repair).not.toContain("2.35.0");
    expect(calls.start).toEqual(["2.36.0"]);
  });

  test("post-ready diagnose conflict rolls back instead of succeeding", async () => {
    const store = await setupStore();
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      raceDiagnoseConflict: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.repair).toContain("2.35.0");
    expect(installed.bunPath).toBe(store.old.bunPath);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("post-publish diagnose conflict rolls back the published pointer", async () => {
    const store = await setupStore();
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      raceDiagnoseAfterPublish: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.repair).toEqual(["2.36.0", "2.35.0"]);
    expect(installed.bunPath).toBe(store.old.bunPath);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("rollback continues when stop reports restore_failed with proxyAbsent", async () => {
    const store = await setupStore();
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      failReady: true,
      failRollbackStopProxyAbsent: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    expect(calls.repair).toEqual(["2.36.0", "2.35.0"]);
    expect(calls.start).toContain("2.35.0");
    expect(installed.bunPath).toBe(store.old.bunPath);
  });

  test("rollback stop ownership_conflict remains non-recoverable", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      failReady: true,
      failRollbackStopOwnership: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.repair).toEqual(["2.36.0"]);
    expect(calls.repair).not.toContain("2.35.0");
  });

  test("tampered current generation fails integrity before stop or service mutation", async () => {
    const store = await setupStore();
    writeFileSync(store.old.cliPath, "tampered\n");
    for (const kind of ["start", "uninstall", "repair"] as const) {
      const { deps, calls } = fakeDeps({
        old: store.old,
        next: store.next,
        owner: "desktop-service",
        live: liveFor(store.old, 9001),
      });
      const result = await runDesktopServiceMutation(
        kind,
        kind === "repair" ? { runtimeManifestId: store.nextId } : {},
        deps,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("runtime_integrity_failed");
      expect(calls.stop).toBe(0);
      expect(calls.install).toBe(0);
      expect(calls.repair).toEqual([]);
      expect(calls.start).toEqual([]);
      expect(calls.uninstall).toBe(0);
      expect(calls.direct).toEqual([]);
    }
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("runtime_integrity_failed");
    expect(calls.stop).toBe(0);
    expect(calls.install).toBe(0);
    expect(calls.repair).toEqual([]);
    expect(calls.start).toEqual([]);
    expect(calls.uninstall).toBe(0);
    expect(calls.direct).toEqual([]);
  });

  test("service-repair from desktop-direct does not stop or mutate the service", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.stop).toBe(0);
    expect(calls.install).toBe(0);
    expect(calls.repair).toEqual([]);
    expect(calls.start).toEqual([]);
    expect(calls.uninstall).toBe(0);
    expect(calls.direct).toEqual([]);
  });

  test("service-install from desktop-service does not stop or mutate the service", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.stop).toBe(0);
    expect(calls.install).toBe(0);
    expect(calls.repair).toEqual([]);
    expect(calls.start).toEqual([]);
    expect(calls.uninstall).toBe(0);
    expect(calls.direct).toEqual([]);
  });

  test("windows-native install is refused on non-win32 before any mutation", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
    });
    const result = await runDesktopServiceMutation(
      "install",
      { runtimeManifestId: store.nextId, backend: "windows-native" },
      { ...deps, platform: "linux" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("service_not_startable");
    expect(result.error.retryable).toBe(false);
    expect(calls.stop).toBe(0);
    expect(calls.install).toBe(0);
    expect(calls.repair).toEqual([]);
    expect(calls.start).toEqual([]);
    expect(calls.uninstall).toBe(0);
    expect(calls.direct).toEqual([]);
  });

  test("reference guard retains service and owner generations", () => {
    const storePath = "/opt/opencodex/versions/2.35.0";
    const guard = retainReferencedRuntimeGenerations({
      serviceInstall: {
        conflict: false,
        bunPath: join(storePath, "ocx-runtime"),
        cliPath: join(storePath, "src/cli/index.ts"),
      },
    });
    expect(guard("versions/2.35.0", storePath)).toBe(true);
    expect(guard("versions/2.36.0", "/opt/opencodex/versions/2.36.0")).toBe(false);
  });

  test("reference guard retains snapshot previous by relPath", () => {
    const guard = retainReferencedRuntimeGenerations({
      pointer: {
        schemaVersion: 1,
        current: {
          id: "b",
          version: "2.36.0",
          target: hostTarget(),
          relPath: "versions/2.36.0",
        },
        previous: {
          id: "a",
          version: "2.35.0",
          target: hostTarget(),
          relPath: "versions/2.35.0",
        },
      },
      candidate: {
        id: "c",
        version: "2.37.0",
        target: hostTarget(),
        relPath: "versions/2.37.0",
      },
    });
    expect(guard("versions/2.35.0", "/opt/opencodex/versions/2.35.0")).toBe(true);
    expect(guard("versions/2.36.0", "/opt/opencodex/versions/2.36.0")).toBe(true);
    expect(guard("versions/2.37.0", "/opt/opencodex/versions/2.37.0")).toBe(true);
    expect(guard("versions/2.38.0", "/opt/opencodex/versions/2.38.0")).toBe(false);
  });
});

describe("desktop service activation fifth-review regressions", () => {
  async function setupThreeGenerations(): Promise<{
    stableRoot: string;
    a: DesktopRuntimeIdentity;
    b: DesktopRuntimeIdentity;
    c: DesktopRuntimeIdentity;
    aId: string;
    bId: string;
    cId: string;
  }> {
    const store = await setupStore();
    const pointer = readCurrentPointer(store.stableRoot);
    if (!pointer.ok || !pointer.pointer) throw new Error("missing pointer");
    const publishedB = publishCurrent({
      stableRoot: store.stableRoot,
      staged: {
        id: store.nextId,
        version: store.next.runtimeVersion,
        target: hostTarget(),
        relPath: `${STABLE_VERSIONS_DIR}/${store.next.runtimeVersion}`,
      },
      expectedCurrent: pointer.pointer.current,
      expectedTarget: hostTarget(),
      isVersionReferenced: () => true,
    });
    if (!publishedB.ok) throw new Error(publishedB.message);
    const extraSource = writePayload("2.37.0");
    const stagedC = stageRuntime({
      sourceRoot: extraSource.root,
      stableRoot: store.stableRoot,
      expectedTarget: hostTarget(),
    });
    if (!stagedC.ok) throw new Error(stagedC.message);
    const extra = resolveDesktopRuntimeIdentity(stagedC.absPath);
    if (!extra) throw new Error("failed to resolve third generation");
    return {
      stableRoot: store.stableRoot,
      a: store.old,
      b: store.next,
      c: extra,
      aId: store.oldId,
      bId: store.nextId,
      cId: extraSource.id,
    };
  }

  function journalRecord(input: {
    stableRoot: string;
    old: DesktopRuntimeIdentity;
    next: DesktopRuntimeIdentity;
    oldId: string;
    nextId: string;
    kind?: ActivationJournalRecord["kind"];
    mode?: ActivationJournalRecord["mode"];
    owner?: ActivationJournalRecord["snapshot"]["owner"];
    hadLiveProxy?: boolean;
    touchedService?: boolean;
    published?: boolean;
    candidatePid?: number | null;
    bunPath?: string | null;
    cliPath?: string | null;
    publishedPointer?: ActivationJournalRecord["publishedPointer"];
  }): ActivationJournalRecord {
    const current = {
      id: input.oldId,
      version: input.old.runtimeVersion,
      target: hostTarget(),
      relPath: `${STABLE_VERSIONS_DIR}/${input.old.runtimeVersion}`,
    };
    const candidate = {
      id: input.nextId,
      version: input.next.runtimeVersion,
      target: hostTarget(),
      relPath: `${STABLE_VERSIONS_DIR}/${input.next.runtimeVersion}`,
    };
    const snapshotPointer = { schemaVersion: 1 as const, current, previous: null };
    return {
      schemaVersion: 1,
      transactionId: "tx-recover-1",
      token: "lock-token-1",
      intent: "activate",
      kind: input.kind ?? "install",
      mode: input.mode ?? "service",
      stableRoot: input.stableRoot,
      expectedTarget: hostTarget(),
      snapshot: {
        pointer: snapshotPointer,
        owner: input.owner ?? "desktop-direct",
        hadLiveProxy: input.hadLiveProxy ?? true,
        serviceInstalled: input.owner === "desktop-service",
        backend: input.owner === "desktop-service" ? "scheduler" : null,
        bunPath: input.bunPath !== undefined
          ? input.bunPath
          : (input.owner === "desktop-service" ? input.old.bunPath : null),
        cliPath: input.cliPath !== undefined
          ? input.cliPath
          : (input.owner === "desktop-service" ? input.old.cliPath : null),
        previousPid: input.hadLiveProxy === false ? null : 9001,
        previousBunPath: input.old.bunPath,
        previousCliPath: input.old.cliPath,
      },
      candidate,
      publishedPointer: input.publishedPointer !== undefined
        ? input.publishedPointer
        : intendedPublishedPointer(snapshotPointer, candidate),
      touchedService: input.touchedService ?? true,
      candidatePid: input.candidatePid !== undefined ? input.candidatePid : (input.published ? 9002 : null),
    };
  }

  test("install that mutates then throws rolls back; residual service does not restart direct", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
      installMutatesThenThrows: true,
      uninstallLeavesService: true,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.install).toBe(1);
    expect(calls.uninstall).toBe(1);
    expect(calls.direct).toEqual([]);
    expect(calls.start.filter(v => v === "2.35.0")).toEqual([]);
  });

  test("rollback uninstall false with absent service is acceptable", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
      failReady: true,
      uninstallReturnsFalse: true,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    expect(calls.uninstall).toBe(1);
    expect(calls.direct).toEqual(["2.35.0"]);
  });

  test("uninstall false with stale install paths is restore_failed and does not start direct", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
      failReady: true,
      uninstallReturnsFalse: true,
    });
    const originalDiagnose = deps.diagnoseService;
    deps.uninstallService = async () => {
      calls.uninstall += 1;
      return false;
    };
    deps.diagnoseService = () => ({
      ...originalDiagnose(),
      installed: false,
      startable: false,
      enabled: false,
      conflict: false,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.direct).toEqual([]);
    expect(calls.uninstall).toBe(1);
  });

  test("rollback uninstall false with residual service is restore_failed and does not start direct", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
      failReady: true,
      uninstallLeavesService: true,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.direct).toEqual([]);
  });

  test("post-publish failure of C over B/A restores exact B/A and keeps A verified", async () => {
    const gens = await setupThreeGenerations();
    const { deps, calls } = fakeDeps({
      old: gens.b,
      next: gens.c,
      owner: "desktop-service",
      live: liveFor(gens.b, 9001),
      raceServicePathsAfterPublish: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: gens.cId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ownership_conflict");
    expect(calls.repair).toEqual(["2.37.0", "2.36.0"]);
    const pointer = readCurrentPointer(gens.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(gens.bId);
    expect(pointer.ok && pointer.pointer?.previous?.id).toBe(gens.aId);
    expect(existsSync(join(gens.stableRoot, STABLE_VERSIONS_DIR, "2.35.0"))).toBe(true);
    const aRoot = join(gens.stableRoot, STABLE_VERSIONS_DIR, "2.35.0");
    const loaded = readRuntimeManifestFile(join(aRoot, "runtime-manifest.json"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const verified = verifyRuntimeTree(aRoot, loaded.manifest, { expectedTarget: hostTarget() });
    expect(verified.ok).toBe(true);
  });

  test("skips startService when install already started the manager", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveFor(store.old, 9001),
      serviceInstalled: false,
      managerStarted: true,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(true);
    expect(calls.install).toBe(1);
    expect(calls.start).toEqual([]);
  });

  test("failed start of a previously stopped service remains stopped", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: null,
      failStart: true,
    });
    const result = await runDesktopServiceMutation("start", {}, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("service_not_startable");
    expect(calls.repair).toEqual([]);
    expect(calls.start).toEqual(["2.35.0"]);
    expect(calls.direct).toEqual([]);
  });

  test("repair rollback of a previously stopped service restores defs but ends stopped", async () => {
    const store = await setupStore();
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: null,
      failReady: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(calls.repair).toEqual(["2.36.0", "2.35.0"]);
    expect(calls.start).toEqual(["2.36.0"]);
    expect(calls.start).not.toContain("2.35.0");
  });

  test("mode=direct refuses desktop-service and start/uninstall with no side effects", async () => {
    const store = await setupStore();
    for (const kind of ["install", "repair", "start", "uninstall"] as const) {
      const { deps, calls } = fakeDeps({
        old: store.old,
        next: store.next,
        owner: "desktop-service",
        live: liveFor(store.old, 9001),
      });
      const result = await runDesktopServiceMutation(
        kind,
        kind === "install" || kind === "repair" ? { runtimeManifestId: store.nextId } : {},
        { ...deps, mode: "direct" },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("ownership_conflict");
      expect(calls.stop).toBe(0);
      expect(calls.install).toBe(0);
      expect(calls.repair).toEqual([]);
      expect(calls.start).toEqual([]);
      expect(calls.uninstall).toBe(0);
      expect(calls.direct).toEqual([]);
    }
  });

  test("direct-mode startDirect uses candidate bun and cli without spawning", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: liveBox.current,
      liveBox,
      serviceInstalled: false,
    });
    const seen: string[] = [];
    deps.startDirect = async identity => {
      seen.push(identity.bunPath, identity.cliPath);
      calls.direct.push(identity.runtimeVersion);
      liveBox.current = liveFor(identity, 9002);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, {
      ...deps,
      mode: "direct",
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe(store.next.bunPath);
    expect(seen[1]).toBe(store.next.cliPath);
    expect(calls.install).toBe(0);
    expect(calls.repair).toEqual([]);
  });

  test("recovery after partial install mutation restores snapshot and clears journal", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "install",
      owner: "desktop-direct",
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: null,
      serviceInstalled: false,
      installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toContain("retry status");
    expect(calls.uninstall).toBe(1);
    expect(installed.bunPath).toBeUndefined();
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("recovery of candidate-ready before publish rolls back snapshot pointer", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "repair",
      owner: "desktop-service",
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const liveBox = { current: liveFor(store.next, 9002) as LiveProxy | null };
    const { deps, calls, installed } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(true);
    expect(calls.repair).toContain("2.35.0");
    expect(installed.bunPath).toBe(store.old.bunPath);
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("recovery after publish before journal delete finalizes when candidate is healthy", async () => {
    const store = await setupStore();
    const pointer = readCurrentPointer(store.stableRoot);
    if (!pointer.ok || !pointer.pointer) throw new Error("missing pointer");
    const published = publishCurrent({
      stableRoot: store.stableRoot,
      staged: {
        id: store.nextId,
        version: store.next.runtimeVersion,
        target: hostTarget(),
        relPath: `${STABLE_VERSIONS_DIR}/${store.next.runtimeVersion}`,
      },
      expectedCurrent: pointer.pointer.current,
      expectedTarget: hostTarget(),
      isVersionReferenced: () => true,
    });
    if (!published.ok) throw new Error(published.message);
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "repair",
      owner: "desktop-service",
      published: true,
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const liveBox = { current: liveFor(store.next, 9002) as LiveProxy | null };
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(true);
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
    const after = readCurrentPointer(store.stableRoot);
    expect(after.ok && after.pointer?.current.id).toBe(store.nextId);
  });

  test("recovery failure on successor pointer retains the journal", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    writeFileSync(join(store.stableRoot, "current.json"), `${JSON.stringify({
      schemaVersion: 1,
      current: {
        id: "other",
        version: "0.0.1",
        target: hostTarget(),
        relPath: "versions/0.0.1",
      },
      previous: null,
    })}\n`);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(result.error.retryable).toBe(false);
    expect(calls.repair).toEqual([]);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
    expect(existsSync(join(store.stableRoot, ACTIVATION_JOURNAL_NAME))).toBe(true);
  });

  test("recycled journal pid without a runtime record is not signaled", async () => {
    const store = await setupStore();
    const recycled = 4242;
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "install",
      owner: "desktop-direct",
      candidatePid: recycled,
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: null,
      serviceInstalled: false,
      installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
      alivePids: new Set([recycled]),
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(result.error.retryable).toBe(false);
    expect(calls.stopPid).toEqual([]);
    expect(calls.stop).toBe(0);
    expect(calls.stopService).toBe(0);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
  });

  test("no-live foreign service is not stopped", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "repair",
      mode: "direct",
      owner: "desktop-direct",
      touchedService: false,
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: null,
      serviceInstalled: false,
      installed: { bunPath: "/opt/foreign/bun", cliPath: "/opt/foreign/cli.ts" },
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, {
      ...deps,
      mode: "direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.stopService).toBe(0);
    expect(calls.stop).toBe(0);
    expect(calls.stopPid).toEqual([]);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
  });

  test("post-image pending readiness does not finalize the journal", async () => {
    const store = await setupStore();
    const pointer = readCurrentPointer(store.stableRoot);
    if (!pointer.ok || !pointer.pointer) throw new Error("missing pointer");
    const published = publishCurrent({
      stableRoot: store.stableRoot,
      staged: {
        id: store.nextId,
        version: store.next.runtimeVersion,
        target: hostTarget(),
        relPath: `${STABLE_VERSIONS_DIR}/${store.next.runtimeVersion}`,
      },
      expectedCurrent: pointer.pointer.current,
      expectedTarget: hostTarget(),
      isVersionReferenced: () => true,
    });
    if (!published.ok) throw new Error(published.message);
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "repair",
      owner: "desktop-service",
      published: true,
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const liveBox = { current: liveFor(store.next, 9002) as LiveProxy | null };
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
      failReadyPending: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(true);
    const after = readCurrentPointer(store.stableRoot);
    expect(after.ok && after.pointer?.current.id).toBe(store.oldId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
  });

  test("post-image failed readiness rolls back instead of finalizing", async () => {
    const store = await setupStore();
    const pointer = readCurrentPointer(store.stableRoot);
    if (!pointer.ok || !pointer.pointer) throw new Error("missing pointer");
    const published = publishCurrent({
      stableRoot: store.stableRoot,
      staged: {
        id: store.nextId,
        version: store.next.runtimeVersion,
        target: hostTarget(),
        relPath: `${STABLE_VERSIONS_DIR}/${store.next.runtimeVersion}`,
      },
      expectedCurrent: pointer.pointer.current,
      expectedTarget: hostTarget(),
      isVersionReferenced: () => true,
    });
    if (!published.ok) throw new Error(published.message);
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "repair",
      owner: "desktop-service",
      published: true,
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const liveBox = { current: liveFor(store.next, 9002) as LiveProxy | null };
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
      failReady: true,
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(true);
    const after = readCurrentPointer(store.stableRoot);
    expect(after.ok && after.pointer?.current.id).toBe(store.oldId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
  });

  test("checksummed forged post-image journal is restore_failed and is kept", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "repair",
      owner: "desktop-service",
      publishedPointer: {
        schemaVersion: 1,
        current: {
          id: store.nextId,
          version: store.next.runtimeVersion,
          target: hostTarget(),
          relPath: `${STABLE_VERSIONS_DIR}/${store.next.runtimeVersion}`,
        },
        previous: null,
      },
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.stop).toBe(0);
    expect(calls.stopPid).toEqual([]);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
  });

  test("checksummed forged service path journal is restore_failed and is kept", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "repair",
      owner: "desktop-service",
      bunPath: store.next.bunPath,
      cliPath: store.next.cliPath,
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.stop).toBe(0);
    expect(calls.repair).toEqual([]);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
  });

  test("successor appearing between rollback observation and stop is not stopped", async () => {
    const store = await setupStore();
    const successor: LiveProxy = {
      pid: 7777,
      port: 10100,
      hostname: "127.0.0.1",
      source: "runtime",
      version: "9.9.9",
    };
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      failReady: true,
      beforeRollbackStop: () => {
        liveBox.current = successor;
      },
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.stop).toBe(1);
    expect(liveBox.current?.pid).toBe(7777);
  });

  test("journal pid update CAS failure rolls back and fails closed", async () => {
    const store = await setupStore();
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveFor(store.old, 9001),
      beforeJournalPidUpdate: () => {
        writeFileSync(join(store.stableRoot, ACTIVATION_JOURNAL_NAME), "tampered-journal\n");
      },
    });
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("candidate pid recycled onto a foreign same-pid live is not stopped", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      throwAfterReady: true,
      beforeRollbackStop: () => {
        liveBox.current = {
          pid: 9002,
          port: 10100,
          hostname: "127.0.0.1",
          source: "runtime",
          version: store.next.runtimeVersion,
        };
      },
    });
    const originalClassify = deps.classifyOwner;
    deps.classifyOwner = (live, identity) => {
      if (live?.pid === 9002) return "existing-external";
      return originalClassify(live, identity);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(calls.stopPid).toEqual([]);
    expect(liveBox.current?.pid).toBe(9002);
  });

  test("afterPointerPublished absent live rolls back the published pointer", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const alivePids = new Set<number>([9001]);
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      alivePids,
    });
    deps.afterPointerPublished = async () => {
      liveBox.current = null;
      alivePids.delete(9002);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
  });

  test("afterPointerPublished absent live with alive unproven candidate pid fails closed", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
    });
    deps.afterPointerPublished = async () => {
      liveBox.current = null;
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(result.error.retryable).toBe(false);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.nextId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
    expect(calls.stopPid).toEqual([]);
    expect(calls.stopService).toBe(0);
    expect(calls.repair).toEqual(["2.36.0"]);
    expect(calls.start).toEqual(["2.36.0"]);
    expect(calls.direct).toEqual([]);
  });

  test("canRespawn stop with first-absent then window respawn fails closed", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const alivePids = new Set<number>([9001]);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      alivePids,
      ownedServiceCanRespawn: true,
      rollbackStopWindow: "respawn",
    });
    deps.afterPointerPublished = async () => {
      liveBox.current = null;
      alivePids.delete(9002);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(result.error.retryable).toBe(false);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.nextId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
    expect(calls.stop).toBe(2);
    expect(calls.stopService).toBe(1);
    expect(calls.repair).toEqual(["2.36.0"]);
    expect(calls.start).toEqual(["2.36.0"]);
    expect(calls.direct).toEqual([]);
  });

  test("canRespawn stop with stable absence completes rollback", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const alivePids = new Set<number>([9001]);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
      alivePids,
      ownedServiceCanRespawn: true,
      rollbackStopWindow: "stable-absent",
    });
    deps.afterPointerPublished = async () => {
      liveBox.current = null;
      alivePids.delete(9002);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
    expect(calls.stop).toBe(2);
    expect(calls.stopService).toBe(1);
    expect(calls.repair).toEqual(["2.36.0", "2.35.0"]);
    expect(calls.start).toContain("2.35.0");
  });

  test("afterPointerPublished pending readiness rolls back", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
    });
    const originalProbe = deps.probeReadiness;
    let published = false;
    deps.afterPointerPublished = async () => {
      published = true;
    };
    deps.probeReadiness = async (port, opts) => {
      if (published && opts.expectedPid === 9002) {
        return { ready: false, status: "pending" as const, pid: 9002, port: 10100 };
      }
      return originalProbe(port, opts);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("afterPointerPublished failed readiness rolls back", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
    });
    const originalProbe = deps.probeReadiness;
    let published = false;
    deps.afterPointerPublished = async () => {
      published = true;
    };
    deps.probeReadiness = async (port, opts) => {
      if (published && opts.expectedPid === 9002) {
        return { ready: false, status: "failed" as const, pid: 9002, port: 10100 };
      }
      return originalProbe(port, opts);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("proxy_not_ready");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("afterPointerPublished foreign live retains journal and does not rewind", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
    });
    deps.afterPointerPublished = async () => {
      liveBox.current = {
        pid: 7777,
        port: 10100,
        hostname: "127.0.0.1",
        source: "runtime",
        version: "9.9.9",
      };
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.nextId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
  });

  test("afterPointerPublished healthy replacement pid finalizes", async () => {
    const store = await setupStore();
    const liveBox = { current: liveFor(store.old, 9001) as LiveProxy | null };
    const { deps } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-service",
      live: liveBox.current,
      liveBox,
    });
    deps.afterPointerPublished = async () => {
      liveBox.current = liveFor(store.next, 9003);
    };
    const result = await runDesktopServiceMutation("repair", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(true);
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.nextId);
    expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
  });

  test("failed owned service stop aborts restore and keeps the journal", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "install",
      owner: "desktop-direct",
    });
    expect(writeActivationJournal(store.stableRoot, record).ok).toBe(true);
    const { deps, calls } = fakeDeps({
      old: store.old,
      next: store.next,
      owner: "desktop-direct",
      live: null,
      serviceInstalled: false,
      installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
      failOwnedServiceStop: true,
    });
    const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("restore_failed");
    expect(JSON.stringify(result)).not.toContain("/secret/user");
    expect(calls.direct).toEqual([]);
    expect(calls.repair).toEqual([]);
    expect(observeActivationJournal(store.stableRoot).state).toBe("valid");
    const pointer = readCurrentPointer(store.stableRoot);
    expect(pointer.ok && pointer.pointer?.current.id).toBe(store.oldId);
  });

  test("killed OS-process writer is recovered by the next owner", async () => {
    const store = await setupStore();
    const record = journalRecord({
      stableRoot: store.stableRoot,
      old: store.old,
      next: store.next,
      oldId: store.oldId,
      nextId: store.nextId,
      kind: "install",
      owner: "desktop-direct",
    });
    const journalModule = join(import.meta.dir, "../runtime/activation-journal.ts");
    const lockModule = join(import.meta.dir, "../runtime/activation-lock.ts");
    const child = Bun.spawn([process.execPath, "-e", `
      import { writeActivationJournal } from ${JSON.stringify(journalModule)};
      import { acquireActivationLock } from ${JSON.stringify(lockModule)};
      const handle = await acquireActivationLock(${JSON.stringify(store.stableRoot)}, { waitTimeoutMs: 5_000, pollIntervalMs: 20 });
      const written = writeActivationJournal(${JSON.stringify(store.stableRoot)}, ${JSON.stringify(record)});
      if (!written.ok) {
        process.stdout.write("write-failed\\n");
        process.exit(1);
      }
      process.stdout.write("ready\\n");
      await new Promise(() => {});
    `], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    try {
      const stream = child.stdout;
      if (stream == null || typeof stream === "number") throw new Error("child stdout unavailable");
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !buf.includes("ready")) {
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value?: undefined }>(resolve => setTimeout(() => resolve({ done: true }), 200)),
        ]);
        if (result.value) buf += decoder.decode(result.value, { stream: true });
        if (result.done && !result.value) break;
      }
      expect(buf).toContain("ready");
      child.kill("SIGKILL");
      await child.exited;
      const { deps, calls, installed } = fakeDeps({
        old: store.old,
        next: store.next,
        owner: "desktop-direct",
        live: null,
        serviceInstalled: false,
        installed: { bunPath: store.next.bunPath, cliPath: store.next.cliPath },
      });
      const result = await runDesktopServiceMutation("install", { runtimeManifestId: store.nextId }, deps);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.retryable).toBe(true);
      expect(calls.uninstall).toBe(1);
      expect(installed.bunPath).toBeUndefined();
      expect(observeActivationJournal(store.stableRoot).state).toBe("absent");
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await child.exited.catch(() => 1);
    }
  }, 15_000);
});
