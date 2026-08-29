/**
 * Production v1 Desktop bridge operations: bootstrap, status, and stop.
 *
 * Reuses findLiveProxy, probeReadiness, diagnoseService, runStopTransaction, and
 * the detached CLI `start` child path. Must not import `src/cli/index.ts`, hold
 * the start lock, parse CLI text, or write desktop-direct owner/runtime records.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
import { ProxyOwnershipRefusedError, stopProxy } from "../../src/lib/process-control";
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
  isServiceOwnershipError,
  stopServiceForTransaction,
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
  ServiceState,
  StatusResult,
} from "./protocol";

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
  startDirect?: (input: { descriptorPath: string | null; port?: number; cwd: string }) => Promise<void>;
  startService?: () => Promise<void>;
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
  code: "ownership_conflict" | "service_not_startable" | "proxy_not_ready" | "runtime_integrity_failed" | "unsupported_operation" | "stop_failed",
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

function allowedMutationsFor(owner: Owner): Operation[] {
  return owner === "unknown/conflict" ? [] : ["stop"];
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
  startDirect: (input: { descriptorPath: string | null; port?: number; cwd: string }) => Promise<void>;
  startService: () => Promise<void>;
  runStopTransaction: () => Promise<StopTransactionResult>;
  isAlive: (pid: number) => boolean;
  hasForbiddenEnvFile: (cwd: string) => boolean;
};

function resolveDeps(deps: BridgeHandlerDeps): RequiredHandlerDeps {
  const cwd = deps.cwd ?? process.cwd();
  const identity = deps.identity === undefined ? resolveDesktopRuntimeIdentity(cwd) : deps.identity;
  return {
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
    startDirect: deps.startDirect ?? (input => {
      if (!identity) throw new Error("desktop runtime identity is unavailable");
      return productionStartDirect({ ...input, identity });
    }),
    startService: deps.startService ?? (() => {
      if (!identity) throw new Error("desktop runtime identity is unavailable");
      return productionStartService(identity, cwd);
    }),
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
}): StatusResult {
  return {
    status: input.status,
    origin: input.origin,
    pid: input.pid,
    version: input.version,
    owner: input.owner,
    service: input.service,
    allowedMutations: allowedMutationsFor(input.owner),
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
    allowedMutations: allowedMutationsFor(input.owner),
  };
  return { ok: true, result };
}

async function handleStatus(deps: RequiredHandlerDeps, signal: AbortSignal): Promise<HandlerOutcome> {
  const current = await currentStatus(deps, signal);
  return { ok: true, result: current.status };
}

async function handleBootstrap(deps: RequiredHandlerDeps, signal: AbortSignal): Promise<HandlerOutcome> {
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
