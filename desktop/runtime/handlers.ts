/**
 * Production v1 Desktop bridge operations: bootstrap, status, and stop.
 *
 * Reuses findLiveProxy, probeReadiness, diagnoseService, runStopTransaction, and
 * the detached CLI `start` child path. Must not import `src/cli/index.ts`, hold
 * the start lock, parse CLI text, or write desktop-direct owner/runtime records.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { restoreNativeCodexAsync } from "../../src/codex/inject";
import { loadConfig } from "../../src/config";
import {
  classifyDesktopOwner,
  createDesktopLaunchDescriptor,
  DESKTOP_LAUNCH_DESCRIPTOR_ENV,
  readDesktopDirectOwnerRecord,
  reclaimStaleDesktopDirectRecords,
  reclaimStaleDesktopLaunchDescriptors,
  type DesktopOwnerKind,
  type DesktopRuntimeIdentity,
} from "../../src/config/desktop-owner";
import {
  readPid,
  readPidFileValue,
  readRuntimePort,
  removePid,
  removePidIfValueIs,
  removeRuntimePort,
  removeRuntimePortIfPidIs,
} from "../../src/config/process-state";
import { runStopTransaction, type StopTransactionResult } from "../../src/cli/stop-transaction";
import { stripGrokConfig } from "../../src/grok/inject";
import { withProcessRuntimeProvenance } from "../../src/lib/bun-runtime";
import { ProxyOwnershipRefusedError, stopProxy, stopProxyGracefully } from "../../src/lib/process-control";
import { redactSecretString, redactUserPath } from "../../src/lib/redact";
import { selfLaunchArgv } from "../../src/lib/self-launch-argv";
import { isLoopbackHostname } from "../../src/server/auth-cors";
import {
  findLiveProxy,
  probeReadiness,
  type LiveProxy,
} from "../../src/server/proxy-liveness";
import { revertSystemEnv } from "../../src/server/system-env";
import {
  diagnoseService,
  inspectServiceStateEvidence,
  installManagedServiceWithRuntime,
  isServiceOwnershipError,
  repairService,
  stopServiceForTransaction,
  uninstallServiceIfInstalled,
  type ManagedServiceStopOutcome,
  type ServiceDiagnostic,
} from "../../src/service";
import { DeadlineExceededError } from "./deadline";
import {
  MANIFEST_FILE_NAME,
  containedLookup,
  readRuntimeManifestFile,
  verifyRuntimeTree,
  type TargetTriple,
} from "./manifest";
import { isLoopbackOrigin, normalizeLoopbackOrigin } from "./origin";
import type {
  BootstrapResult,
  BridgeRequest,
  HandlerOutcome,
  Operation,
  Owner,
  ProxyStatus,
  ServiceInstallBackend,
  ServiceInstallPayload,
  ServiceRepairPayload,
  ServiceState,
  StatusResult,
} from "./protocol";
import {
  activationIsPending,
  recoverDesktopActivationIfNeeded,
  runDesktopServiceMutation,
  stableStoreRootFromIdentity,
  type DesktopServiceMutationDeps,
  type OwnedLiveStopRequest,
  type ServiceManagerEffect,
} from "./service-activation";

const CLI_ENTRY_REL = "src/cli/index.ts";
const STABLE_VERSIONS_DIR = "versions";
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const READY_POLL_MS = 150;
const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;

export type ReadinessProbeFn = (
  port: number,
  opts: { hostname?: string; expectedPid?: number },
) => Promise<{ ready: boolean; status: "ready" | "pending" | "failed"; pid: number; port: number } | null>;

export type BridgeHandlerDeps = {
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  findLiveProxy?: () => Promise<LiveProxy | null>;
  probeReadiness?: ReadinessProbeFn;
  diagnoseService?: () => ServiceDiagnostic;
  inspectServiceInstall?: () => { conflict: boolean; bunPath?: string; cliPath?: string };
  readCommandLine?: (pid: number) => string | undefined;
  identity?: DesktopRuntimeIdentity | null;
  cwd?: string;
  getBindHostname?: () => string | undefined;
  getPreferredPort?: () => number | undefined;
  startDirect?: (input: {
    descriptorPath: string | null;
    port?: number;
    cwd: string;
    identity: DesktopRuntimeIdentity;
  }) => Promise<void>;
  startService?: () => Promise<void>;
  startServiceIdentity?: (identity: DesktopRuntimeIdentity) => Promise<void>;
  installServiceRuntime?: (
    identity: DesktopRuntimeIdentity,
    backend: ServiceInstallBackend,
  ) => Promise<void | ServiceManagerEffect>;
  repairServiceRuntime?: (
    identity: DesktopRuntimeIdentity,
    opts?: { backend?: ServiceDiagnostic["backend"] },
  ) => Promise<void | ServiceManagerEffect>;
  uninstallServiceRuntime?: () => boolean | Promise<boolean>;
  afterCandidateReady?: () => void | Promise<void>;
  stopOwnedServiceRuntime?: () => ManagedServiceStopOutcome | Promise<ManagedServiceStopOutcome>;
  stopOwnedLiveRuntime?: (request: OwnedLiveStopRequest) => Promise<void> | void;
  runStopTransaction?: () => Promise<StopTransactionResult>;
  isAlive?: (pid: number) => boolean;
  hasForbiddenEnvFile?: (cwd: string) => boolean;
};

function safeMessage(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const printable = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  const secretRedacted = redactSecretString(printable).replace(/\bBearer\s+\[REDACTED\]/gi, "[REDACTED]");
  const redacted = redactUserPath(secretRedacted).trim();
  const pathBearing = /[A-Za-z]:[\\/]/.test(redacted)
    || /\\\\/.test(redacted)
    || /~[\w.-]*\//.test(redacted)
    || /[%$][A-Za-z_]/.test(redacted)
    || /\/[\w.\-~%]+\//.test(redacted);
  const chosen = pathBearing ? fallback : (redacted || fallback);
  const ascii = ASCII_PRINTABLE_RE.test(chosen) ? chosen : fallback;
  return ascii.slice(0, 4096);
}

function errorOutcome(
  code: "ownership_conflict" | "service_not_startable" | "proxy_not_ready" | "runtime_integrity_failed" | "unsupported_operation" | "stop_failed" | "restore_failed",
  message: string,
  retryable: boolean,
): HandlerOutcome {
  return {
    ok: false,
    error: {
      code,
      message: safeMessage(message, code.replaceAll("_", " ")),
      retryable,
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DeadlineExceededError();
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DeadlineExceededError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultReadCommandLine(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

function cwdHasForbiddenEnvFile(cwd: string): boolean {
  try {
    return readdirSync(cwd).some(name => name === ".env" || name.startsWith(".env."));
  } catch {
    return true;
  }
}

function readServiceInstallPaths(): { conflict: boolean; bunPath?: string; cliPath?: string } {
  const evidence = inspectServiceStateEvidence();
  const valid = evidence.filter(item => item.kind === "valid");
  const blocked = evidence.some(item => item.kind === "invalid" || item.kind === "unreadable");
  if (blocked && valid.length > 0) return { conflict: true };
  if (valid.length === 0) return { conflict: false };
  const first = valid[0]!.state;
  for (const item of valid.slice(1)) {
    if (item.state.bunPath !== first.bunPath || item.state.cliPath !== first.cliPath) {
      return { conflict: true };
    }
  }
  return {
    conflict: false,
    ...(first.bunPath ? { bunPath: first.bunPath } : {}),
    ...(first.cliPath ? { cliPath: first.cliPath } : {}),
  };
}

function mapServiceState(service: ServiceDiagnostic, extraConflict: boolean): ServiceState {
  if (service.conflict || extraConflict) {
    return { installed: true, startable: false, stateCode: "conflict" };
  }
  if (!service.installed) {
    return { installed: false, startable: false, stateCode: "absent" };
  }
  if (service.startable) {
    return { installed: true, startable: true, stateCode: "startable" };
  }
  return { installed: true, startable: false, stateCode: "not-startable" };
}

export function allowedMutationsFor(
  owner: Owner,
  service: ServiceState = { installed: false, startable: false, stateCode: "absent" },
  identity: DesktopRuntimeIdentity | null = null,
  livePid: number | null = null,
): Operation[] {
  if (owner === "unknown/conflict") return [];
  if (!identity) return ["stop"];
  if (owner === "desktop-service") {
    return ["stop", "service-start", "service-repair", "service-uninstall"];
  }
  if (owner === "desktop-direct") return ["stop", "service-install"];
  if (owner === "existing-external" && !service.installed && livePid === null) {
    return ["stop", "service-install"];
  }
  return ["stop"];
}

function isAttachableBind(hostname: string | undefined): boolean {
  const trimmed = (hostname ?? "127.0.0.1").trim();
  if (trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") return false;
  return isLoopbackHostname(trimmed);
}

function originForLive(live: LiveProxy): string | null {
  const host = live.hostname?.trim() || "127.0.0.1";
  const candidate = host.includes(":") && !host.startsWith("[")
    ? `http://[${host}]:${live.port}`
    : `http://${host}:${live.port}`;
  const origin = normalizeLoopbackOrigin(candidate);
  return origin && isLoopbackOrigin(origin) ? origin : null;
}

function usableVersion(value: string | undefined): string | null {
  if (typeof value !== "string" || !VERSION_RE.test(value)) return null;
  return value;
}

function asOwner(value: DesktopOwnerKind): Owner {
  return value;
}

function currentTargetTriple(): TargetTriple | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

function runtimeBunRelPath(target: TargetTriple): string {
  return `ocx-runtime-${target}${target.includes("windows") ? ".exe" : ""}`;
}

export function resolveDesktopRuntimeIdentity(cwd = process.cwd()): DesktopRuntimeIdentity | null {
  const target = currentTargetTriple();
  if (!target) return null;
  const loaded = readRuntimeManifestFile(join(cwd, MANIFEST_FILE_NAME), { expectedTarget: target });
  if (!loaded.ok) return null;
  const verified = verifyRuntimeTree(cwd, loaded.manifest, {
    expectedTarget: target,
    allowManifestFile: true,
  });
  if (!verified.ok) return null;
  if (basename(verified.root) !== loaded.manifest.version) return null;
  const versionsRoot = dirname(verified.root);
  if (basename(versionsRoot) !== STABLE_VERSIONS_DIR) return null;

  const bunRelPath = runtimeBunRelPath(target);
  const bunEntry = loaded.manifest.files.find(entry => entry.path === bunRelPath);
  const cliEntry = loaded.manifest.files.find(entry => entry.path === CLI_ENTRY_REL);
  if (!bunEntry || !cliEntry || (!target.includes("windows") && !bunEntry.executable)) return null;
  const bun = containedLookup(verified.root, bunRelPath);
  const cli = containedLookup(verified.root, CLI_ENTRY_REL);
  if (!bun.ok || !cli.ok || !bun.stat.isFile() || !cli.stat.isFile()) return null;

  const stableStoreRoot = dirname(versionsRoot);
  const installId = createHash("sha256")
    .update(`opencodex-desktop-install\0${stableStoreRoot}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return {
    installId,
    runtimeManifestId: loaded.manifest.id,
    runtimeVersion: loaded.manifest.version,
    bunPath: bun.absPath,
    cliPath: cli.absPath,
    stableRuntimeRoot: verified.root,
  };
}

export function cliChildStartArgv(port: number | undefined, cliPath: string): string[] {
  const args = ["start"];
  if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
    args.push("--port", String(port));
  }
  return selfLaunchArgv(args, { isStandaloneExecutable: false, sourceEntrypoint: cliPath });
}

function detachedChildEnv(descriptorPath: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OCX_SERVICE;
  if (descriptorPath) env[DESKTOP_LAUNCH_DESCRIPTOR_ENV] = descriptorPath;
  else delete env[DESKTOP_LAUNCH_DESCRIPTOR_ENV];
  return withProcessRuntimeProvenance(env);
}

function spawnCliChild(input: {
  program: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.program, input.argv, {
      cwd: input.cwd,
      env: input.env,
      detached: input.detached,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    if (input.detached) {
      child.unref();
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

async function productionStartDirect(input: {
  descriptorPath: string | null;
  port?: number;
  cwd: string;
  identity: DesktopRuntimeIdentity;
}): Promise<void> {
  await spawnCliChild({
    program: input.identity.bunPath,
    argv: cliChildStartArgv(input.port, input.identity.cliPath),
    cwd: input.cwd,
    env: detachedChildEnv(input.descriptorPath),
    detached: true,
  });
}

async function productionStartService(identity: DesktopRuntimeIdentity, cwd: string): Promise<void> {
  await spawnCliChild({
    program: identity.bunPath,
    argv: selfLaunchArgv(["service", "start"], {
      isStandaloneExecutable: false,
      sourceEntrypoint: identity.cliPath,
    }),
    cwd,
    env: detachedChildEnv(null),
    detached: false,
  });
}

function serviceBackendFor(backend: ServiceInstallBackend): "scheduler" | "native" {
  return backend === "windows-native" ? "native" : "scheduler";
}

async function productionInstallService(
  identity: DesktopRuntimeIdentity,
  backend: ServiceInstallBackend,
): Promise<ServiceManagerEffect> {
  await installManagedServiceWithRuntime(
    { bunPath: identity.bunPath, cliPath: identity.cliPath },
    { backend: serviceBackendFor(backend) },
  );
  return { managerStarted: true };
}

async function productionRepairService(
  identity: DesktopRuntimeIdentity,
  opts?: { backend?: ServiceDiagnostic["backend"] },
): Promise<ServiceManagerEffect> {
  const backend = opts?.backend === "native" || opts?.backend === "scheduler" ? opts.backend : undefined;
  await repairService({
    runtime: { bunPath: identity.bunPath, cliPath: identity.cliPath },
    ...(backend ? { backend } : {}),
  });
  return { managerStarted: true };
}

function productionStopOwnedService(): ManagedServiceStopOutcome {
  return stopServiceForTransaction();
}

async function productionStopOwnedLive(
  io: {
    findLiveProxy: () => Promise<LiveProxy | null>;
    classifyOwner: (live: LiveProxy | null, identity: DesktopRuntimeIdentity | null) => Owner;
  },
  request: OwnedLiveStopRequest,
): Promise<void> {
  const current = await io.findLiveProxy();
  if (!current?.pid || current.pid !== request.live.pid) {
    throw new Error("owned live proxy disappeared before stop");
  }
  if (current.version !== request.identity.runtimeVersion) {
    throw new Error("owned live proxy identity changed before stop");
  }
  if (!isAttachableBind(current.hostname)) {
    throw new Error("owned live proxy bind is not loopback");
  }
  const owner = io.classifyOwner(current, request.identity);
  if (owner !== request.expectedOwner) {
    throw new Error("owned live proxy owner changed before stop");
  }
  const graceful = await stopProxyGracefully(current.pid);
  if (graceful === "refused" || graceful === false) {
    throw new Error("owned live graceful stop failed");
  }
}

async function productionStop(): Promise<StopTransactionResult> {
  return runStopTransaction({
    stopServiceIfInstalled: stopServiceForTransaction,
    isServiceOwnershipError,
    readPid,
    stopProxy,
    removePid,
    removeRuntimePort,
    readPidFileValue,
    readRuntimePortPid: () => readRuntimePort()?.pid ?? null,
    findLiveProxy,
    removePidIfValueIs,
    removeRuntimePortIfPidIs,
    revertSystemEnv,
    restoreNativeCodexAsync,
    stripGrokConfig,
    isProxyOwnershipRefused: err => err instanceof ProxyOwnershipRefusedError,
  });
}

function bindHostnameFromLive(live: LiveProxy | null, fallback: string | undefined): string | undefined {
  return live?.hostname ?? fallback;
}

function snapshotOwner(deps: RequiredHandlerDeps, live: LiveProxy | null): Owner {
  reclaimStaleDesktopDirectRecords({ isAlive: deps.isAlive });
  reclaimStaleDesktopLaunchDescriptors();
  const service = deps.diagnoseService();
  const install = deps.inspectServiceInstall();
  const classification = classifyDesktopOwner({
    identity: deps.identity,
    livePid: live?.pid ?? null,
    livePort: live?.port ?? null,
    commandLine: live?.pid ? deps.readCommandLine(live.pid) ?? null : null,
    service: {
      installed: service.installed,
      startable: service.startable,
      conflict: service.conflict || install.conflict,
    },
    serviceInstall: install,
    isAlive: deps.isAlive,
  });
  return asOwner(classification.owner);
}

type RequiredHandlerDeps = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  findLiveProxy: () => Promise<LiveProxy | null>;
  probeReadiness: ReadinessProbeFn;
  diagnoseService: () => ServiceDiagnostic;
  inspectServiceInstall: () => { conflict: boolean; bunPath?: string; cliPath?: string };
  readCommandLine: (pid: number) => string | undefined;
  identity: DesktopRuntimeIdentity | null;
  cwd: string;
  getBindHostname: () => string | undefined;
  getPreferredPort: () => number | undefined;
  startDirect: (input: {
    descriptorPath: string | null;
    port?: number;
    cwd: string;
    identity: DesktopRuntimeIdentity;
  }) => Promise<void>;
  startService: () => Promise<void>;
  startServiceIdentity: (identity: DesktopRuntimeIdentity) => Promise<void>;
  installServiceRuntime: (
    identity: DesktopRuntimeIdentity,
    backend: ServiceInstallBackend,
  ) => Promise<void | ServiceManagerEffect>;
  repairServiceRuntime: (
    identity: DesktopRuntimeIdentity,
    opts?: { backend?: ServiceDiagnostic["backend"] },
  ) => Promise<void | ServiceManagerEffect>;
  uninstallServiceRuntime: () => boolean | Promise<boolean>;
  afterCandidateReady?: () => void | Promise<void>;
  stopOwnedServiceRuntime: () => ManagedServiceStopOutcome | Promise<ManagedServiceStopOutcome>;
  stopOwnedLiveRuntime: (request: OwnedLiveStopRequest) => Promise<void> | void;
  runStopTransaction: () => Promise<StopTransactionResult>;
  isAlive: (pid: number) => boolean;
  hasForbiddenEnvFile: (cwd: string) => boolean;
};

function resolveDeps(deps: BridgeHandlerDeps): RequiredHandlerDeps {
  const cwd = deps.cwd ?? process.cwd();
  const identity = deps.identity === undefined ? resolveDesktopRuntimeIdentity(cwd) : deps.identity;
  const resolved: RequiredHandlerDeps = {
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? defaultSleep,
    findLiveProxy: deps.findLiveProxy ?? (() => findLiveProxy()),
    probeReadiness: deps.probeReadiness ?? ((port, opts) => probeReadiness(port, opts)),
    diagnoseService: deps.diagnoseService ?? diagnoseService,
    inspectServiceInstall: deps.inspectServiceInstall ?? readServiceInstallPaths,
    readCommandLine: deps.readCommandLine ?? defaultReadCommandLine,
    identity,
    cwd,
    getBindHostname: deps.getBindHostname ?? (() => loadConfig().hostname),
    getPreferredPort: deps.getPreferredPort ?? (() => loadConfig().port),
    startDirect: deps.startDirect ?? (input => productionStartDirect({ ...input, identity: input.identity })),
    startService: deps.startService ?? (() => {
      if (!identity) throw new Error("desktop runtime identity is unavailable");
      return productionStartService(identity, cwd);
    }),
    startServiceIdentity: deps.startServiceIdentity ?? (target => productionStartService(target, cwd)),
    installServiceRuntime: deps.installServiceRuntime ?? ((target, backend) => productionInstallService(target, backend)),
    repairServiceRuntime: deps.repairServiceRuntime ?? ((target, opts) => productionRepairService(target, opts)),
    uninstallServiceRuntime: deps.uninstallServiceRuntime ?? (() => uninstallServiceIfInstalled()),
    ...(deps.afterCandidateReady ? { afterCandidateReady: deps.afterCandidateReady } : {}),
    stopOwnedServiceRuntime: deps.stopOwnedServiceRuntime ?? productionStopOwnedService,
    stopOwnedLiveRuntime: deps.stopOwnedLiveRuntime ?? (request => productionStopOwnedLive({
      findLiveProxy: () => resolved.findLiveProxy(),
      classifyOwner: (live, target) => snapshotOwner({ ...resolved, identity: target }, live),
    }, request)),
    runStopTransaction: deps.runStopTransaction ?? productionStop,
    isAlive: deps.isAlive ?? (pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }),
    hasForbiddenEnvFile: deps.hasForbiddenEnvFile ?? cwdHasForbiddenEnvFile,
  };
  return resolved;
}

async function probeLive(
  deps: RequiredHandlerDeps,
  live: LiveProxy,
): Promise<{ status: ProxyStatus; origin: string | null; version: string | null }> {
  const bindHost = bindHostnameFromLive(live, deps.getBindHostname());
  if (!isAttachableBind(bindHost)) {
    return { status: "failed", origin: null, version: usableVersion(live.version) };
  }
  const origin = originForLive({ ...live, hostname: bindHost ?? live.hostname });
  if (!origin) return { status: "failed", origin: null, version: usableVersion(live.version) };
  if (!live.pid) return { status: "pending", origin, version: usableVersion(live.version) };
  const ready = await deps.probeReadiness(live.port, { hostname: live.hostname, expectedPid: live.pid });
  const version = usableVersion(live.version);
  if (!ready) return { status: "pending", origin, version };
  if (ready.status === "ready" && version === null) return { status: "pending", origin, version };
  return { status: ready.status, origin, version };
}

function statusResult(input: {
  status: ProxyStatus;
  origin: string | null;
  pid: number | null;
  version: string | null;
  owner: Owner;
  service: ServiceState;
  identity: DesktopRuntimeIdentity | null;
}): StatusResult {
  return {
    status: input.status,
    origin: input.origin,
    pid: input.pid,
    version: input.version,
    owner: input.owner,
    service: input.service,
    allowedMutations: allowedMutationsFor(input.owner, input.service, input.identity, input.pid),
  };
}

async function currentStatus(deps: RequiredHandlerDeps, signal: AbortSignal): Promise<{
  live: LiveProxy | null;
  owner: Owner;
  service: ServiceState;
  status: StatusResult;
}> {
  throwIfAborted(signal);
  const diagnosed = deps.diagnoseService();
  const install = deps.inspectServiceInstall();
  const service = mapServiceState(diagnosed, install.conflict);
  const live = await deps.findLiveProxy();
  throwIfAborted(signal);
  const owner = snapshotOwner(deps, live);
  if (!live) {
    return {
      live: null,
      owner,
      service,
      status: statusResult({
        status: "stopped",
        origin: null,
        pid: null,
        version: null,
        owner,
        service,
        identity: deps.identity,
      }),
    };
  }
  const probed = await probeLive(deps, live);
  throwIfAborted(signal);
  const status = owner === "unknown/conflict" && probed.status === "ready" ? "failed" : probed.status;
  return {
    live,
    owner,
    service,
    status: statusResult({
      status,
      origin: probed.origin,
      pid: live.pid,
      version: probed.version,
      owner,
      service,
      identity: deps.identity,
    }),
  };
}

async function waitForReady(
  deps: RequiredHandlerDeps,
  signal: AbortSignal,
): Promise<
  | { ok: true; live: LiveProxy; origin: string; version: string }
  | { ok: false; outcome: HandlerOutcome }
> {
  for (;;) {
    throwIfAborted(signal);
    const live = await deps.findLiveProxy();
    throwIfAborted(signal);
    if (live) {
      const bindHost = bindHostnameFromLive(live, deps.getBindHostname());
      if (!isAttachableBind(bindHost)) {
        return { ok: false, outcome: errorOutcome("proxy_not_ready", "proxy bind is not loopback", false) };
      }
      const origin = originForLive({ ...live, hostname: bindHost ?? live.hostname });
      if (!origin) {
        return { ok: false, outcome: errorOutcome("proxy_not_ready", "proxy bind is not loopback", false) };
      }
      if (live.pid) {
        const ready = await deps.probeReadiness(live.port, { hostname: live.hostname, expectedPid: live.pid });
        throwIfAborted(signal);
        if (ready?.status === "failed") {
          return { ok: false, outcome: errorOutcome("proxy_not_ready", "proxy readiness failed", true) };
        }
        const version = usableVersion(live.version);
        if (ready?.ready && version) {
          return { ok: true, live, origin, version };
        }
      }
    }
    await deps.sleep(READY_POLL_MS, signal);
  }
}

function bootstrapResult(input: {
  origin: string;
  pid: number;
  version: string;
  owner: Owner;
  service: ServiceState;
  identity: DesktopRuntimeIdentity | null;
}): HandlerOutcome {
  if (input.owner === "unknown/conflict") {
    return errorOutcome("ownership_conflict", "ownership evidence is conflicting", false);
  }
  const result: BootstrapResult = {
    status: "ready",
    origin: input.origin,
    pid: input.pid,
    version: input.version,
    owner: input.owner,
    service: input.service,
    allowedMutations: allowedMutationsFor(input.owner, input.service, input.identity, input.pid),
  };
  return { ok: true, result };
}

function stableRootIfPresent(deps: RequiredHandlerDeps): string | null {
  if (!deps.identity) return null;
  const root = stableStoreRootFromIdentity(deps.identity);
  if (!root || !existsSync(root)) return null;
  return root;
}

async function observeOrRecoverActivation(
  deps: RequiredHandlerDeps,
  signal: AbortSignal,
  mode: "status" | "bootstrap",
): Promise<HandlerOutcome | null> {
  const stableRoot = stableRootIfPresent(deps);
  if (!stableRoot) return null;
  const pending = activationIsPending(stableRoot, deps.isAlive);
  if (!pending.pending) return null;
  if (mode === "status") {
    const current = await currentStatus(deps, signal);
    return {
      ok: true,
      result: {
        ...current.status,
        status: "pending",
        allowedMutations: [],
      },
    };
  }
  if (!pending.recoverable) {
    return errorOutcome("service_not_startable", "activation is in progress", true);
  }
  const current = await currentStatus(deps, signal);
  return recoverDesktopActivationIfNeeded(serviceMutationDeps(deps, current, signal), stableRoot);
}

async function handleStatus(deps: RequiredHandlerDeps, signal: AbortSignal): Promise<HandlerOutcome> {
  const pending = await observeOrRecoverActivation(deps, signal, "status");
  if (pending) return pending;
  const current = await currentStatus(deps, signal);
  return { ok: true, result: current.status };
}

async function handleBootstrap(deps: RequiredHandlerDeps, signal: AbortSignal): Promise<HandlerOutcome> {
  const recovered = await observeOrRecoverActivation(deps, signal, "bootstrap");
  if (recovered) return recovered;
  const current = await currentStatus(deps, signal);
  if (current.owner === "unknown/conflict") {
    return errorOutcome("ownership_conflict", "ownership evidence is conflicting", false);
  }
  if (current.live) {
    if (current.status.status === "failed" && current.status.origin === null) {
      return errorOutcome("proxy_not_ready", "proxy bind is not loopback", false);
    }
    const waited = await waitForReady(deps, signal);
    if (!waited.ok) return waited.outcome;
    if (!waited.live.pid) return errorOutcome("proxy_not_ready", "proxy is not ready", true);
    const owner = snapshotOwner(deps, waited.live);
    return bootstrapResult({
      origin: waited.origin,
      pid: waited.live.pid,
      version: waited.version,
      owner,
      service: current.service,
      identity: deps.identity,
    });
  }

  const recorded = readDesktopDirectOwnerRecord();
  if (recorded && deps.isAlive(recorded.pid)) {
    const waited = await waitForReady(deps, signal);
    if (!waited.ok) return waited.outcome;
    if (!waited.live.pid) return errorOutcome("proxy_not_ready", "proxy is not ready", true);
    const owner = snapshotOwner(deps, waited.live);
    return bootstrapResult({
      origin: waited.origin,
      pid: waited.live.pid,
      version: waited.version,
      owner,
      service: current.service,
      identity: deps.identity,
    });
  }

  if (current.service.stateCode === "conflict") {
    return errorOutcome("ownership_conflict", "ownership evidence is conflicting", false);
  }
  if (current.service.installed && !current.service.startable) {
    return errorOutcome("service_not_startable", "installed service is not startable", false);
  }
  if (!deps.identity) {
    return errorOutcome("runtime_integrity_failed", "desktop runtime identity is unavailable", false);
  }

  if (current.service.startable) {
    await deps.startService();
  } else {
    if (deps.hasForbiddenEnvFile(deps.cwd)) {
      return errorOutcome("runtime_integrity_failed", "desktop runtime tree contains a forbidden env file", false);
    }
    reclaimStaleDesktopLaunchDescriptors();
    const descriptorPath = createDesktopLaunchDescriptor(deps.identity).path;
    await deps.startDirect({
      descriptorPath,
      port: deps.getPreferredPort(),
      cwd: deps.cwd,
      identity: deps.identity,
    });
  }

  const waited = await waitForReady(deps, signal);
  if (!waited.ok) return waited.outcome;
  if (!waited.live.pid) return errorOutcome("proxy_not_ready", "proxy is not ready", true);
  const owner = snapshotOwner(deps, waited.live);
  const service = mapServiceState(deps.diagnoseService(), deps.inspectServiceInstall().conflict);
  return bootstrapResult({
    origin: waited.origin,
    pid: waited.live.pid,
    version: waited.version,
    owner,
    service,
    identity: deps.identity,
  });
}

async function handleStop(deps: RequiredHandlerDeps, signal: AbortSignal): Promise<HandlerOutcome> {
  const current = await currentStatus(deps, signal);
  if (current.owner === "unknown/conflict") {
    return errorOutcome("ownership_conflict", "ownership evidence is conflicting", false);
  }
  const result = await deps.runStopTransaction();
  throwIfAborted(signal);
  return { ok: true, result };
}

function serviceMutationDeps(
  deps: RequiredHandlerDeps,
  current: Awaited<ReturnType<typeof currentStatus>>,
  signal: AbortSignal,
): DesktopServiceMutationDeps {
  return {
    signal,
    identity: deps.identity,
    owner: current.owner,
    live: current.live,
    service: current.service,
    expectedTarget: currentTargetTriple(),
    platform: process.platform,
    sleep: deps.sleep,
    diagnoseService: deps.diagnoseService,
    inspectServiceInstall: deps.inspectServiceInstall,
    findLiveProxy: deps.findLiveProxy,
    probeReadiness: deps.probeReadiness,
    runStopTransaction: deps.runStopTransaction,
    stopOwnedLive: request => deps.stopOwnedLiveRuntime(request),
    stopOwnedService: () => deps.stopOwnedServiceRuntime(),
    isAlive: deps.isAlive,
    classifyOwner: (live, identity) => snapshotOwner({ ...deps, identity }, live),
    installService: deps.installServiceRuntime,
    repairService: deps.repairServiceRuntime,
    startService: deps.startServiceIdentity,
    startDirect: target => deps.startDirect({
      descriptorPath: createDesktopLaunchDescriptor(target).path,
      port: deps.getPreferredPort(),
      cwd: target.stableRuntimeRoot,
      identity: target,
    }),
    uninstallService: deps.uninstallServiceRuntime,
    resolveIdentity: resolveDesktopRuntimeIdentity,
    ...(deps.afterCandidateReady ? { afterCandidateReady: deps.afterCandidateReady } : {}),
  };
}

async function handleServiceMutation(
  deps: RequiredHandlerDeps,
  request: BridgeRequest,
  signal: AbortSignal,
): Promise<HandlerOutcome> {
  const current = await currentStatus(deps, signal);
  const mutationDeps = serviceMutationDeps(deps, current, signal);
  if (request.operation === "service-install") {
    const payload = request.payload as ServiceInstallPayload;
    return runDesktopServiceMutation("install", {
      runtimeManifestId: payload.runtimeManifestId,
      backend: payload.backend,
    }, { ...mutationDeps, backend: payload.backend });
  }
  if (request.operation === "service-repair") {
    const payload = request.payload as ServiceRepairPayload;
    return runDesktopServiceMutation("repair", { runtimeManifestId: payload.runtimeManifestId }, mutationDeps);
  }
  if (request.operation === "service-start") {
    return runDesktopServiceMutation("start", {}, mutationDeps);
  }
  return runDesktopServiceMutation("uninstall", {}, mutationDeps);
}

export function createBridgeHandler(deps: BridgeHandlerDeps = {}) {
  const resolved = resolveDeps(deps);
  return async (
    request: BridgeRequest,
    context: { signal: AbortSignal; deadlineMs: number },
  ): Promise<HandlerOutcome> => {
    const signal = context.signal;
    throwIfAborted(signal);
    switch (request.operation) {
      case "status":
        return handleStatus(resolved, signal);
      case "bootstrap":
        return handleBootstrap(resolved, signal);
      case "stop":
        return handleStop(resolved, signal);
      case "service-install":
      case "service-start":
      case "service-repair":
      case "service-uninstall":
        return handleServiceMutation(resolved, request, signal);
      case "legacy-tray-uninstall":
        return errorOutcome(
          "unsupported_operation",
          `unsupported_operation: ${request.operation} is not wired`,
          false,
        );
      default:
        return errorOutcome("unsupported_operation", "unsupported_operation: unknown operation", false);
    }
  };
}
