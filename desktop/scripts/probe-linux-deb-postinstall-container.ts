#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TARGET = "x86_64-unknown-linux-gnu";
const STATUS_REQUEST_ID = "01K3M8Q4H6V2W9Y5T7N1R0C8DJ";
const STOP_REQUEST_ID = "01K3M8Q4H6V2W9Y5T7N1R0C8DK";
const MAX_OUTPUT_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 30_000;
const APP_EXIT_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

type ChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

class ProbeFailure extends Error {}

function fail(message: string): never {
  throw new ProbeFailure(message);
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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing ${name}`);
  return value;
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  fail(`${label} timed out`);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  onOverflow: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_OUTPUT_BYTES) {
        onOverflow();
        await reader.cancel();
        fail("child output exceeded limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function runChild(
  command: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string; timeout: number },
): Promise<ChildResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout,
    killSignal: "SIGKILL",
  });
  const kill = () => child.kill("SIGKILL");
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, kill),
      readBoundedStream(child.stderr, kill),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdout),
      stderr: new TextDecoder("utf-8", { fatal: true }).decode(stderr),
    };
  } catch (error) {
    kill();
    await child.exited;
    throw error;
  }
}

function parseOneJsonLine(result: ChildResult, label: string): unknown {
  if (result.exitCode !== 0) fail(`${label} exited nonzero`);
  if (!result.stdout.endsWith("\n") || result.stdout.indexOf("\n") !== result.stdout.length - 1) {
    fail(`${label} did not emit one JSON line`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(`${label} emitted invalid JSON`);
  }
}

function childEnv(): Record<string, string> {
  return {
    HOME: requireEnv("HOME"),
    XDG_DATA_HOME: requireEnv("XDG_DATA_HOME"),
    XDG_CONFIG_HOME: requireEnv("XDG_CONFIG_HOME"),
    XDG_CACHE_HOME: requireEnv("XDG_CACHE_HOME"),
    XDG_STATE_HOME: requireEnv("XDG_STATE_HOME"),
    XDG_RUNTIME_DIR: requireEnv("XDG_RUNTIME_DIR"),
    OPENCODEX_HOME: requireEnv("OPENCODEX_HOME"),
    CODEX_HOME: requireEnv("CODEX_HOME"),
    TMPDIR: requireEnv("TMPDIR"),
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
}

export const FORBIDDEN_HOST_COMMANDS = ["node", "bun", "npm", "ocx", "opencodex", "codex"] as const;

function assertNoHostRuntime(): void {
  if (process.getuid?.() !== 10001) fail("post-install runtime must use the probe uid");
  const status = readFileSync("/proc/self/status", "utf8");
  const effective = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(status)?.[1];
  if (!effective || !/^0+$/.test(effective)) fail("post-install runtime retained Linux capabilities");
  for (const name of FORBIDDEN_HOST_COMMANDS) {
    if (Bun.which(name) !== null) fail(`unexpected global runtime: ${name}`);
  }
}

export function validatePublishedCurrentPointer(
  pointer: unknown,
  manifest: { id: string; version: string; target: string },
  packageVersion: string,
): void {
  if (!isRecord(pointer)) fail("current pointer is missing");
  if (pointer.previous !== null) fail("clean install unexpectedly has a previous runtime");
  if (!isRecord(pointer.current)) fail("current pointer selected the wrong generation");
  if (pointer.current.id !== manifest.id
    || pointer.current.version !== manifest.version
    || pointer.current.version !== packageVersion
    || pointer.current.target !== manifest.target
    || pointer.current.relPath !== `versions/${packageVersion}`) {
    fail("current pointer disagrees with the stable manifest");
  }
}

function moduleUrl(stableCwd: string, relPath: string): string {
  return pathToFileURL(join(stableCwd, ...relPath.split("/"))).href;
}

function findProcessByExecutable(executable: string): number | null {
  const matches: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0")[0];
      if (command === executable) matches.push(Number(name));
    } catch {
      // Process exited while /proc was being read.
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group may already have exited.
  }
}

async function invokeBridge(
  stableCwd: string,
  runtimePath: string,
  request: JsonRecord,
  timeout: number,
): Promise<JsonRecord> {
  const result = await runChild(
    [runtimePath, "desktop/runtime/bootstrap.ts"],
    {
      cwd: stableCwd,
      env: childEnv(),
      stdin: `${JSON.stringify(request)}\n`,
      timeout,
    },
  );
  const value = parseOneJsonLine(result, String(request.operation));
  if (!isRecord(value)) fail("bridge envelope is not an object");
  return value;
}

async function main(): Promise<void> {
  assertNoHostRuntime();
  const version = requireEnv("OCX_PROBE_PACKAGE_VERSION");
  const resultPath = requireEnv("OCX_PROBE_RESULT_PATH");
  const stableRoot = join(requireEnv("XDG_DATA_HOME"), "com.opencodex.app", "runtime");
  const stableCwd = join(stableRoot, "versions", version);
  const runtimePath = join(stableCwd, `ocx-runtime-${TARGET}`);
  const app = Bun.spawn(
    [
      "/usr/bin/dbus-run-session",
      "--",
      "/usr/bin/xvfb-run",
      "-a",
      "-s",
      "-screen 0 1280x800x24",
      "/usr/bin/opencodex-desktop",
    ],
    {
      cwd: requireEnv("HOME"),
      env: childEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    },
  );
  const appKill = () => killGroup(app.pid, "SIGKILL");
  const appStdout = readBoundedStream(app.stdout, appKill);
  const appStderr = readBoundedStream(app.stderr, appKill);
  let proxyPid: number | null = null;
  let structuredStopComplete = false;

  try {
    await waitUntil(() => existsSync(join(stableCwd, "runtime-manifest.json")), START_TIMEOUT_MS, "stable runtime publication");

    const staging = await import(moduleUrl(stableCwd, "desktop/runtime/staging.ts"));
    const manifestModule = await import(moduleUrl(stableCwd, "desktop/runtime/manifest.ts"));
    const protocol = await import(moduleUrl(stableCwd, "desktop/runtime/protocol.ts"));
    const processState = await import(moduleUrl(stableCwd, "src/config/process-state.ts"));
    const desktopOwner = await import(moduleUrl(stableCwd, "src/config/desktop-owner.ts"));
    const liveness = await import(moduleUrl(stableCwd, "src/server/proxy-liveness.ts"));
    const handlers = await import(moduleUrl(stableCwd, "desktop/runtime/handlers.ts"));

    let currentPointer: unknown = null;
    await waitUntil(() => {
      const observed = staging.readCurrentPointer(stableRoot);
      if (!observed.ok) fail("current pointer is invalid");
      if (observed.pointer === null) return false;
      currentPointer = observed.pointer;
      return true;
    }, STOP_TIMEOUT_MS, "current pointer publication");
    const packagedManifest = manifestModule.readRuntimeManifestFile(
      "/usr/lib/OpenCodex/resources/runtime/runtime-manifest.json",
      { expectedTarget: TARGET },
    );
    const stableManifest = manifestModule.readRuntimeManifestFile(
      join(stableCwd, "runtime-manifest.json"),
      { expectedTarget: TARGET },
    );
    if (!packagedManifest.ok || !stableManifest.ok) fail("runtime manifest is invalid");
    if (manifestModule.serializeRuntimeManifest(packagedManifest.manifest)
      !== manifestModule.serializeRuntimeManifest(stableManifest.manifest)) {
      fail("stable manifest differs from installed resources");
    }
    validatePublishedCurrentPointer(currentPointer, stableManifest.manifest, version);
    const verified = manifestModule.verifyRuntimeTree(stableCwd, stableManifest.manifest, {
      expectedTarget: TARGET,
      enforceExecutableBit: true,
      allowManifestFile: true,
    });
    if (!verified.ok) fail("stable runtime integrity check failed");

    const statusRequest = {
      schemaVersion: 1,
      requestId: STATUS_REQUEST_ID,
      operation: "status",
      payload: {},
    };
    let statusEnvelope: JsonRecord | null = null;
    await waitUntil(async () => {
      const value = await invokeBridge(stableCwd, runtimePath, statusRequest, STOP_TIMEOUT_MS);
      const parsed = protocol.validateEnvelope(value);
      if (!parsed.ok || !parsed.value.ok || parsed.value.operation !== "status") return false;
      const result = parsed.value.result;
      if (result.status === "failed") {
        if (result.owner === "unknown/conflict") fail("desktop bootstrap has conflicting ownership");
        if (result.origin === null) fail("desktop bootstrap produced a non-loopback origin");
        fail("desktop bootstrap failed readiness");
      }
      if (result.status !== "ready") return false;
      statusEnvelope = value;
      return true;
    }, START_TIMEOUT_MS, "desktop readiness");
    if (!statusEnvelope) fail("ready status envelope missing");

    const status = (statusEnvelope as JsonRecord).result;
    if (!isRecord(status)) fail("status result is invalid");
    if (status.owner !== "desktop-direct") fail("status owner is not desktop-direct");
    if (status.version !== version) fail("status version mismatch");
    if (!isRecord(status.service)
      || status.service.installed !== false
      || status.service.startable !== false
      || status.service.stateCode !== "absent") {
      fail("clean install service state is not absent");
    }
    if (!Array.isArray(status.allowedMutations)
      || status.allowedMutations[0] !== "stop"
      || (status.allowedMutations.length === 1 ? false : status.allowedMutations.length !== 2 || status.allowedMutations[1] !== "service-install")) {
      fail("desktop-direct mutation set is invalid");
    }
    if (typeof status.pid !== "number" || !Number.isSafeInteger(status.pid) || status.pid <= 0) {
      fail("status pid is invalid");
    }
    proxyPid = status.pid;
    const origin = new URL(String(status.origin));

    const live = await liveness.findLiveProxy();
    const ready = await liveness.probeReadiness(live?.port ?? 0, {
      hostname: live?.hostname,
      expectedPid: proxyPid,
    });
    const pidFile = processState.readPid();
    const runtime = processState.readRuntimePort(proxyPid);
    const owner = desktopOwner.readDesktopDirectOwnerRecord();
    const identity = handlers.resolveDesktopRuntimeIdentity(stableCwd);
    if (!live || live.pid !== proxyPid || live.source !== "runtime" || live.version !== version) {
      fail("findLiveProxy disagrees with bridge status");
    }
    if (origin.protocol !== "http:" || Number(origin.port) !== live.port || origin.pathname !== "/") {
      fail("bridge origin disagrees with the live proxy");
    }
    if (!ready || !ready.ready || ready.status !== "ready" || ready.pid !== proxyPid || ready.port !== live.port) {
      fail("readyz disagrees with live proxy identity");
    }
    if (pidFile !== proxyPid || !runtime || runtime.pid !== proxyPid || runtime.port !== live.port) {
      fail("pid/runtime-port records disagree");
    }
    if (!owner || !identity
      || owner.pid !== proxyPid
      || owner.ownerId !== runtime.ownerId
      || owner.installId !== identity.installId
      || owner.runtimeManifestId !== stableManifest.manifest.id
      || owner.runtimeManifestId !== identity.runtimeManifestId
      || owner.runtimeVersion !== version
      || owner.bunPath !== runtimePath
      || owner.cliPath !== join(stableCwd, "src/cli/index.ts")) {
      fail("desktop owner record disagrees with stable runtime");
    }
    const appPid = findProcessByExecutable("/usr/bin/opencodex-desktop");
    if (appPid === null || !isAlive(appPid)) fail("installed Tauri application is not running");

    const healthResponseExact = await fetch(`http://127.0.0.1:${live.port}/healthz`);
    const health = await healthResponseExact.json();
    if (healthResponseExact.status !== 200
      || !isRecord(health)
      || health.service !== "opencodex"
      || health.status !== "ok"
      || health.version !== version
      || health.pid !== proxyPid
      || health.port !== live.port) {
      fail("healthz identity disagrees");
    }

    const stopRequest = {
      schemaVersion: 1,
      requestId: STOP_REQUEST_ID,
      operation: "stop",
      payload: { reason: "app-exit" },
    };
    const stopValue = await invokeBridge(stableCwd, runtimePath, stopRequest, STOP_TIMEOUT_MS);
    const stopEnvelope = protocol.validateEnvelope(stopValue);
    if (!stopEnvelope.ok || !stopEnvelope.value.ok || stopEnvelope.value.operation !== "stop") {
      fail("structured stop did not succeed");
    }
    const stop = stopEnvelope.value.result;
    if (!exactKeys(stop, [
      "ok",
      "code",
      "serviceStopped",
      "proxyStopped",
      "proxyAbsent",
      "restoreStatus",
      "grokStatus",
    ])
      || stop.ok !== true
      || stop.code !== "stopped"
      || stop.serviceStopped !== false
      || stop.proxyStopped !== true
      || stop.proxyAbsent !== true
      || !["restored", "not-needed"].includes(String(stop.restoreStatus))
      || !["restored", "not-needed"].includes(String(stop.grokStatus))) {
      fail("structured stop result is invalid");
    }

    await waitUntil(async () => {
      const after = await liveness.findLiveProxy();
      return after === null && proxyPid !== null && !isAlive(proxyPid);
    }, STOP_TIMEOUT_MS, "proxy absence");
    if (processState.readPid() !== null
      || processState.readRuntimePort() !== null
      || desktopOwner.readDesktopDirectOwnerRecord() !== null) {
      fail("runtime ownership records survived stop");
    }
    const stoppedValue = await invokeBridge(stableCwd, runtimePath, statusRequest, STOP_TIMEOUT_MS);
    const stoppedEnvelope = protocol.validateEnvelope(stoppedValue);
    if (!stoppedEnvelope.ok || !stoppedEnvelope.value.ok || stoppedEnvelope.value.operation !== "status") {
      fail("post-stop status did not succeed");
    }
    const stopped = stoppedEnvelope.value.result;
    if (stopped.status !== "stopped"
      || stopped.pid !== null
      || stopped.origin !== null
      || !isRecord(stopped.service)
      || stopped.service.installed !== false) {
      fail("post-stop status did not prove absence");
    }
    try {
      await fetch(`http://127.0.0.1:${live.port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      fail("proxy listener survived structured stop");
    } catch (error) {
      if (error instanceof Error && error.message === "proxy listener survived structured stop") throw error;
    }
    structuredStopComplete = true;
    writeFileSync(resultPath, '{"ok":true}\n', { mode: 0o600 });
  } finally {
    if (!structuredStopComplete && existsSync(runtimePath)) {
      try {
        await invokeBridge(stableCwd, runtimePath, {
          schemaVersion: 1,
          requestId: STOP_REQUEST_ID,
          operation: "stop",
          payload: { reason: "app-exit" },
        }, STOP_TIMEOUT_MS);
      } catch {
        // Failure cleanup cannot manufacture success.
      }
    }
    killGroup(app.pid, "SIGTERM");
    await Promise.race([app.exited, sleep(APP_EXIT_TIMEOUT_MS)]);
    killGroup(app.pid, "SIGKILL");
    await app.exited;
    await Promise.allSettled([appStdout, appStderr]);
    await waitUntil(
      () => findProcessByExecutable("/usr/bin/opencodex-desktop") === null,
      APP_EXIT_TIMEOUT_MS,
      "desktop process cleanup",
    );
    rmSync(join(requireEnv("TMPDIR"), ".X11-unix"), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch(error => {
    const message = error instanceof ProbeFailure ? error.message : "unexpected probe error";
    console.error(`post-install-harness: ${message}`);
    process.exit(1);
  });
}
