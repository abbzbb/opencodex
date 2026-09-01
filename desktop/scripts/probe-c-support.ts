#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPathInsideRoot, pathsEqualCanonical, readDesktopDirectOwnerRecord } from "../../src/config/desktop-owner";
import { readPid, readRuntimePort } from "../../src/config/process-state";
import {
  createRuntimeManifestFromFiles,
  readRuntimeManifestFile,
  runtimeManifestId,
  walkRegularFiles,
  writeRuntimeManifestFile,
  type TargetTriple,
} from "../runtime/manifest";
import { ERROR_CODES } from "../runtime/protocol";

export const LINUX_X64_TARGET = "x86_64-unknown-linux-gnu" as const;
export const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
export const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
export const STUB_PID_FILE = "probe-stub-pid";
export const STUB_CONSUME_FILE = "probe-stub-consumed";
export const STUB_READYZ_FILE = "probe-stub-readyz-hit";
export const STUB_CLEANUP_FILE = "probe-stub-cleanup";
export const DESTRUCTIVE_SYSTEMD_PROBE_ENV = "OCX_DESTRUCTIVE_SYSTEMD_PROBE";
export const OCX_CONFIG_CANARY_REL = "user-config-canary";
export const CODEX_JOURNAL_CANARY_REL = "probe-canary.jsonl";
export const FAILURE_FIXTURE = "cooperative-ready-failed" as const;

export type JsonRecord = Record<string, unknown>;

export type ChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class ProbeFailure extends Error {}

export function fail(message: string): never {
  throw new ProbeFailure(message);
}

const FIXED_ERROR_MESSAGE_CATEGORIES: Record<string, string> = {
  "owned live graceful stop failed": "owned-live-graceful-stop",
  "owned live proxy disappeared before stop": "owned-live-disappeared",
  "owned live proxy identity changed before stop": "owned-live-identity-changed",
  "owned live proxy bind is not loopback": "owned-live-bind",
  "owned live proxy owner changed before stop": "owned-live-owner-changed",
  "owned live stop seam is unavailable": "owned-live-stop-seam",
  "owned live identity is unavailable": "owned-live-identity",
  "rollback refused to stop a successor proxy": "rollback-successor",
  "rollback could not prove absence": "absence-unproven",
  "candidate readiness failed after publish": "candidate-readiness-after-publish",
  "candidate readiness failed": "candidate-readiness",
  "proxy readiness failed": "proxy-readiness",
  "proxy is not ready": "proxy-not-ready",
  "proxy bind is not loopback": "proxy-bind",
  "owned service stop failed": "owned-service-stop",
  "successor proxy after publish": "successor-after-publish",
  "activation journal missing during candidate pid update": "journal-missing",
  "activation journal could not be updated": "journal-update",
  "activation journal could not be cleared": "journal-clear",
  "activation journal is unreadable": "journal-unreadable",
  "restore failed": "restore-failed",
  "stop failed": "stop-failed",
};

export function boundedErrorCode(code: unknown): string {
  return typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)
    ? code
    : "unknown";
}

export function sanitizedErrorMessageCategory(message: unknown): string {
  if (typeof message !== "string") return "none";
  const normalized = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().toLowerCase();
  if (normalized.length === 0) return "none";
  if (!/^[\x20-\x7e]+$/.test(normalized)) return "other";
  return FIXED_ERROR_MESSAGE_CATEGORIES[normalized] ?? "other";
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireProxyNotReadyAfterFailedStart(error: unknown): void {
  const record = isRecord(error) ? error : null;
  const code = boundedErrorCode(record?.code);
  if (code === "proxy_not_ready") return;
  fail(
    `failed candidate did not fail after start: ${code}/${sanitizedErrorMessageCategory(record?.message)}`,
  );
}

export function linuxProcEnvironValue(raw: string | Uint8Array, key: string): string | null {
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8").decode(raw);
  const prefix = `${key}=`;
  for (const entry of text.split("\0")) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return null;
}

export function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}

export function jsonLooksPathFree(value: unknown): boolean {
  const text = JSON.stringify(value);
  if (text.includes("/home/") || text.includes("/Users/") || text.includes("\\\\Users\\\\")) return false;
  if (text.includes("OPENCODEX_HOME") || text.includes("Bearer ") || text.includes("sk-")) return false;
  return true;
}

export async function readBoundedStream(
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
      if (total > MAX_CHILD_OUTPUT_BYTES) {
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

export async function runChild(
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
    await child.exited.catch(() => 0);
    throw error;
  }
}

export function parseOneJsonLine(result: ChildResult, label: string): unknown {
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    fail(`${label} exited with status ${String(result.exitCode)}`);
  }
  if (!result.stdout.endsWith("\n") || result.stdout.indexOf("\n") !== result.stdout.length - 1) {
    fail(`${label} did not emit one JSON line`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(`${label} emitted invalid JSON`);
  }
}

export function runtimeBinaryName(target: TargetTriple): string {
  return target.includes("windows") ? `ocx-runtime-${target}.exe` : `ocx-runtime-${target}`;
}

const REPO_ROOT = resolve(import.meta.dir, "../..");

export function overlayCurrentDesktopRuntime(destRoot: string): void {
  copyTree(join(REPO_ROOT, "desktop/runtime"), join(destRoot, "desktop/runtime"));
  copyTree(join(REPO_ROOT, "src"), join(destRoot, "src"));
}

export function copyTree(sourceRoot: string, destRoot: string): void {
  mkdirSync(destRoot, { recursive: true });
  const copied = spawnSync("cp", ["-a", `${resolve(sourceRoot)}/.`, destRoot], {
    stdio: "ignore",
  });
  if (copied.status !== 0) fail("runtime tree copy failed");
  const keep = join(destRoot, ".keep");
  if (existsSync(keep)) {
    try { rmSync(keep); } catch { fail("runtime tree cleanup failed"); }
  }
}

export function rewritePackageVersion(root: string, version: string): void {
  if (!VERSION_RE.test(version)) fail("runtime version is invalid");
  const path = join(root, "package.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
  parsed.version = version;
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

export function writeFailedReadyCli(root: string, version: string): void {
  writeFileSync(join(root, "src/cli/index.ts"), `const portFlag = process.argv.indexOf("--port");
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 0;
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
const started = Date.now();
const home = process.env.OPENCODEX_HOME;
const writeMarker = async (name: string, body: string) => {
  if (typeof home === "string" && home.length > 0) {
    await Bun.write(home + "/" + name, body);
  }
};
await writeMarker(${JSON.stringify(STUB_PID_FILE)}, String(process.pid));
const { writeFileSync } = await import("node:fs");
const { writePid, writeRuntimePort, removePid, removeRuntimePort, readPid, readRuntimePort } = await import("../config/process-state.ts");
const {
  consumeLaunchDescriptorAndPublish,
  DESKTOP_LAUNCH_DESCRIPTOR_ENV,
  readDesktopDirectOwnerRecord,
  removeDesktopDirectOwnerRecord,
} = await import("../config/desktop-owner.ts");
let publishedOwnerId = null;
let cleaned = false;
const cleanupOwnRecords = () => {
  if (cleaned) return;
  cleaned = true;
  let cleanupSucceeded = true;
  const ownerId = publishedOwnerId;
  if (typeof ownerId === "string" && ownerId.length > 0) {
    try {
      if (removeDesktopDirectOwnerRecord(process.pid, ownerId) === false) cleanupSucceeded = false;
    } catch { cleanupSucceeded = false; }
  }
  try { removeRuntimePort(process.pid); } catch { cleanupSucceeded = false; }
  try { removePid(process.pid); } catch { cleanupSucceeded = false; }
  try {
    const owner = readDesktopDirectOwnerRecord();
    if (owner && owner.pid === process.pid && typeof ownerId === "string" && ownerId.length > 0 && owner.ownerId === ownerId) {
      cleanupSucceeded = false;
    }
    if (readRuntimePort(process.pid) !== null) cleanupSucceeded = false;
    if (readPid() === process.pid) cleanupSucceeded = false;
  } catch { cleanupSucceeded = false; }
  if (typeof home === "string" && home.length > 0) {
    try {
      writeFileSync(home + "/" + ${JSON.stringify(STUB_CLEANUP_FILE)}, cleanupSucceeded ? "ok" : "failed");
    } catch { cleanupSucceeded = false; }
  }
};
process.on("SIGTERM", () => { cleanupOwnRecords(); process.exit(0); });
process.on("SIGINT", () => { cleanupOwnRecords(); process.exit(0); });
writePid(process.pid);
writeRuntimePort({ pid: process.pid, port, hostname: "127.0.0.1" });
let consumeState = "absent";
try {
  const descriptorPath = process.env[DESKTOP_LAUNCH_DESCRIPTOR_ENV];
  if (typeof descriptorPath === "string" && descriptorPath.length > 0) {
    delete process.env[DESKTOP_LAUNCH_DESCRIPTOR_ENV];
    const published = consumeLaunchDescriptorAndPublish({
      descriptorPath,
      pid: process.pid,
      port,
      hostname: "127.0.0.1",
      expectedBunPath: process.execPath,
      expectedCliPath: process.argv[1],
      runtimeVersion: ${JSON.stringify(version)},
    });
    if (published && typeof published.ownerId === "string" && published.ownerId.length > 0) {
      publishedOwnerId = published.ownerId;
      const owner = readDesktopDirectOwnerRecord();
      if (owner && owner.pid === process.pid && typeof owner.ownerId === "string") {
        publishedOwnerId = owner.ownerId;
      }
      consumeState = "ok";
    } else {
      consumeState = "null";
    }
  }
} catch {
  consumeState = "throw";
}
await writeMarker(${JSON.stringify(STUB_CONSUME_FILE)}, consumeState);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const url = new URL(req.url);
    const pid = process.pid;
    if (typeof home === "string" && home.length > 0) {
      void Bun.write(home + "/probe-stub-last-request", req.method + " " + url.pathname);
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      if (typeof home === "string" && home.length > 0) {
        void Bun.write(home + "/probe-stub-stop-hit", "1");
      }
      cleanupOwnRecords();
      setTimeout(() => process.exit(0), 200);
      return Response.json({ success: true, message: "Proxy stopping, native Codex restored." });
    }
    if (url.pathname === "/healthz") {
      return Response.json({
        service: "opencodex",
        status: "ok",
        version: ${JSON.stringify(version)},
        uptime: (Date.now() - started) / 1000,
        pid,
        port,
      });
    }
    if (url.pathname === "/readyz") {
      if (typeof home === "string" && home.length > 0) {
        void Bun.write(home + "/${STUB_READYZ_FILE}", "1");
      }
      return Response.json({
        service: "opencodex",
        status: "failed",
        version: ${JSON.stringify(version)},
        uptime: (Date.now() - started) / 1000,
        pid,
        port,
      }, { status: 503 });
    }
    return new Response("not found", { status: 404 });
  },
});
await new Promise(() => {});
`);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseProcArgv(pid: number): string[] {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    if (raw.byteLength === 0) return [];
    const parts = raw.toString("utf8").split("\0");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  } catch {
    return [];
  }
}

export function argvMatchesRuntime(argv: readonly string[], bunPath: string, cliPath: string): boolean {
  if (argv.length < 2) return false;
  return pathsEqualCanonical(argv[0]!, bunPath) && pathsEqualCanonical(argv[1]!, cliPath);
}

export function cmdlineMatchesRuntime(pid: number, bunPath: string, cliPath: string): boolean {
  return argvMatchesRuntime(parseProcArgv(pid), bunPath, cliPath);
}

export function posixShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function runtimeExecToken(bunPath: string, cliPath: string): string {
  return `exec ${posixShellSingleQuote(bunPath)} ${posixShellSingleQuote(cliPath)} `;
}

export function execStartBindsRuntime(execStart: string, bunPath: string, cliPath: string): boolean {
  return execStart.includes(runtimeExecToken(bunPath, cliPath));
}

export function distinctSuccessorVersions(sourceVersion: string): { newVersion: string; failVersion: string } {
  if (!VERSION_RE.test(sourceVersion)) fail("runtime version is invalid");
  const taken = new Set<string>([sourceVersion]);
  const newVersion = allocateDistinctVersion(sourceVersion, "new", taken);
  taken.add(newVersion);
  const failVersion = allocateDistinctVersion(sourceVersion, "fail", taken);
  return { newVersion, failVersion };
}

function allocateDistinctVersion(sourceVersion: string, label: string, taken: Set<string>): string {
  let index = 1;
  while (index < 10_000) {
    const suffix = index === 1 ? `+${label}` : `+${label}${index}`;
    const candidate = `${sourceVersion}${suffix}`;
    if (candidate.length <= 64 && VERSION_RE.test(candidate) && !taken.has(candidate)) return candidate;
    index += 1;
  }
  fail("could not allocate a distinct runtime version");
}

export function readStubPid(opencodexHome: string): number | null {
  try {
    const raw = readFileSync(join(opencodexHome, STUB_PID_FILE), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function readStubConsume(opencodexHome: string): string | null {
  try {
    const raw = readFileSync(join(opencodexHome, STUB_CONSUME_FILE), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function stubReadyzHit(opencodexHome: string): boolean {
  try {
    return readFileSync(join(opencodexHome, STUB_READYZ_FILE), "utf8").trim() === "1";
  } catch {
    return false;
  }
}

export function readStubCleanup(opencodexHome: string): "ok" | "failed" | null {
  try {
    const raw = readFileSync(join(opencodexHome, STUB_CLEANUP_FILE), "utf8").trim();
    if (raw === "ok" || raw === "failed") return raw;
    return null;
  } catch {
    return null;
  }
}

export function requireStubCleanupOk(opencodexHome: string): void {
  const state = readStubCleanup(opencodexHome);
  if (state === "ok") return;
  fail(state === "failed"
    ? "failed candidate cleanup marker is failed"
    : "failed candidate cleanup marker is missing");
}

export type StubCleanupObservation = {
  ownerRemoveReturnedFalse: boolean;
  owner: { pid: number; ownerId: string } | null;
  runtimePortForPid: { pid: number } | null;
  pidRead: number | null;
  selfPid: number;
  publishedOwnerId: string | null;
};

export function stubCleanupRecordsStillOwned(input: {
  owner: { pid: number; ownerId: string } | null;
  runtimePortForPid: { pid: number } | null;
  pidRead: number | null;
  selfPid: number;
  publishedOwnerId: string | null;
}): boolean {
  if (
    input.owner
    && input.owner.pid === input.selfPid
    && typeof input.publishedOwnerId === "string"
    && input.publishedOwnerId.length > 0
    && input.owner.ownerId === input.publishedOwnerId
  ) return true;
  if (input.runtimePortForPid !== null) return true;
  if (input.pidRead === input.selfPid) return true;
  return false;
}

export function stubCleanupMarkerBody(input: StubCleanupObservation): "ok" | "failed" {
  if (input.ownerRemoveReturnedFalse) return "failed";
  if (stubCleanupRecordsStillOwned(input)) return "failed";
  return "ok";
}

export function clearFailedCandidateMarkers(opencodexHome: string): void {
  for (const name of [STUB_PID_FILE, STUB_CONSUME_FILE, STUB_READYZ_FILE, STUB_CLEANUP_FILE]) {
    try { rmSync(join(opencodexHome, name)); } catch { /* absent */ }
  }
}

export type ProbeCanaries = {
  opencodex: Buffer;
  codexJournal: Buffer;
};

export function seedProbeCanaries(opencodexHome: string, codexHome: string): ProbeCanaries {
  const opencodex = Buffer.from("probe-desktop-home-canary-v1\n");
  const codexJournal = Buffer.from(`${JSON.stringify({
    type: "session_meta",
    id: "probe-canary",
    schema: "codex-session-journal-v1",
  })}\n`);
  writeFileSync(join(opencodexHome, OCX_CONFIG_CANARY_REL), opencodex);
  writeFileSync(join(codexHome, CODEX_JOURNAL_CANARY_REL), codexJournal);
  return { opencodex, codexJournal };
}

export function verifyProbeCanaries(
  opencodexHome: string,
  codexHome: string,
  expected: ProbeCanaries,
): void {
  let opencodex: Buffer;
  let codexJournal: Buffer;
  try {
    opencodex = readFileSync(join(opencodexHome, OCX_CONFIG_CANARY_REL));
    codexJournal = readFileSync(join(codexHome, CODEX_JOURNAL_CANARY_REL));
  } catch {
    fail("home canary is missing");
  }
  if (Buffer.compare(opencodex, expected.opencodex) !== 0) fail("desktop home canary bytes changed");
  if (Buffer.compare(codexJournal, expected.codexJournal) !== 0) fail("codex journal canary bytes changed");
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  fail(`${label} timed out`);
}

function processLooksOwned(pid: number, stableRoot: string): boolean {
  if (!isProcessAlive(pid)) return false;
  const argv = parseProcArgv(pid);
  if (argv.length < 2) return false;
  const bun = argv[0]!;
  const cli = argv[1]!;
  return isPathInsideRoot(stableRoot, bun)
    && isPathInsideRoot(stableRoot, cli)
    && bun.includes("ocx-runtime-")
    && cli.endsWith("/src/cli/index.ts");
}

function collectOwnedPidsFromProc(stableRoot: string): number[] {
  const pids: number[] = [];
  if (process.platform !== "linux" || !existsSync("/proc")) return pids;
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const name of entries) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (processLooksOwned(pid, stableRoot)) pids.push(pid);
  }
  return pids;
}

export async function terminateOwnedProbeChildren(input: {
  stableRoot: string;
  installId: string | null;
  trackedPids: Iterable<number>;
  opencodexHome?: string;
}): Promise<void> {
  const owned = new Set<number>();
  const owner = readDesktopDirectOwnerRecord();
  if (owner
    && input.installId
    && owner.installId === input.installId
    && isPathInsideRoot(input.stableRoot, owner.bunPath)
    && isPathInsideRoot(input.stableRoot, owner.cliPath)
    && isProcessAlive(owner.pid)) {
    owned.add(owner.pid);
  }
  const runtime = readRuntimePort();
  if (runtime?.pid && processLooksOwned(runtime.pid, input.stableRoot)) owned.add(runtime.pid);
  const pidRecord = readPid();
  if (pidRecord && processLooksOwned(pidRecord, input.stableRoot)) owned.add(pidRecord);
  if (input.opencodexHome) {
    const stub = readStubPid(input.opencodexHome);
    if (stub !== null && processLooksOwned(stub, input.stableRoot)) owned.add(stub);
  }
  for (const pid of input.trackedPids) {
    if (processLooksOwned(pid, input.stableRoot)) owned.add(pid);
  }
  for (const pid of collectOwnedPidsFromProc(input.stableRoot)) owned.add(pid);
  for (const pid of owned) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await Bun.sleep(200);
  for (const pid of owned) {
    if (!isProcessAlive(pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export function assertDestructiveSystemdProbeAllowed(): void {
  if (process.env.GITHUB_ACTIONS !== "true") fail("systemd probe is CI-only");
  if (process.env[DESTRUCTIVE_SYSTEMD_PROBE_ENV] !== "1") {
    fail("systemd probe requires OCX_DESTRUCTIVE_SYSTEMD_PROBE");
  }
}

export type SystemdProbeSurface = {
  unitExists: boolean;
  wantsExists: boolean;
  serviceActive: boolean;
  unitLoaded: boolean;
  defaultServiceStateExists: boolean;
  isolatedServiceStateExists: boolean;
};

export const KNOWN_SYSTEMD_LOAD_STATES = [
  "loaded",
  "not-found",
  "stub",
  "merged",
  "masked",
  "error",
  "bad-setting",
] as const;

export const KNOWN_SYSTEMD_ACTIVE_STATES = [
  "active",
  "reloading",
  "inactive",
  "failed",
  "activating",
  "deactivating",
  "maintenance",
] as const;

export type SystemctlShowResult = {
  status: number;
  stdout: string;
};

function systemdShowProperty(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function interpretSystemdShow(result: SystemctlShowResult): { loadState: string; activeState: string } {
  if (result.status !== 0) fail("cannot query systemd manager state");
  const loadState = systemdShowProperty(result.stdout, "LoadState");
  const activeState = systemdShowProperty(result.stdout, "ActiveState");
  if (loadState === null || activeState === null) fail("systemd manager state is missing");
  if (!(KNOWN_SYSTEMD_LOAD_STATES as readonly string[]).includes(loadState)) fail("systemd LoadState is unknown");
  if (!(KNOWN_SYSTEMD_ACTIVE_STATES as readonly string[]).includes(activeState)) fail("systemd ActiveState is unknown");
  return { loadState, activeState };
}

export function managerFlagsFromStates(states: { loadState: string; activeState: string }): {
  unitLoaded: boolean;
  serviceActive: boolean;
} {
  return {
    unitLoaded: states.loadState !== "not-found",
    serviceActive: states.activeState !== "inactive",
  };
}

export function systemdManagerFlagsForCleanup(result: SystemctlShowResult | null): {
  unitLoaded: boolean;
  serviceActive: boolean;
} {
  if (result === null) return { unitLoaded: true, serviceActive: true };
  try {
    return managerFlagsFromStates(interpretSystemdShow(result));
  } catch {
    return { unitLoaded: true, serviceActive: true };
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export function systemdSurfacesEqual(left: SystemdProbeSurface, right: SystemdProbeSurface): boolean {
  return left.unitExists === right.unitExists
    && left.wantsExists === right.wantsExists
    && left.serviceActive === right.serviceActive
    && left.unitLoaded === right.unitLoaded
    && left.defaultServiceStateExists === right.defaultServiceStateExists
    && left.isolatedServiceStateExists === right.isolatedServiceStateExists;
}

export function requireAbsentSystemdProbeSurface(input: SystemdProbeSurface): void {
  if (input.unitExists) fail("production systemd unit already exists");
  if (input.wantsExists) fail("production systemd wants symlink already exists");
  if (input.serviceActive) fail("production systemd service is already active");
  if (input.unitLoaded) fail("production systemd unit is already loaded");
  if (input.defaultServiceStateExists) fail("default service-state already exists");
  if (input.isolatedServiceStateExists) fail("isolated service-state already exists");
}

export function cleanupCreatedSystemdArtifacts(input: {
  baseline: SystemdProbeSurface;
  current: SystemdProbeSurface;
  stopAndDisable: () => void;
  removeUnit: () => void;
  removeWants: () => void;
  removeDefaultState: () => void;
  removeIsolatedState: () => void;
  daemonReload: () => void;
}): void {
  const createdUnit = !input.baseline.unitExists && input.current.unitExists;
  const createdWants = !input.baseline.wantsExists && input.current.wantsExists;
  const createdActive = !input.baseline.serviceActive && input.current.serviceActive;
  const createdLoaded = !input.baseline.unitLoaded && input.current.unitLoaded;
  const createdDefault = !input.baseline.defaultServiceStateExists && input.current.defaultServiceStateExists;
  const createdIsolated = !input.baseline.isolatedServiceStateExists && input.current.isolatedServiceStateExists;
  if (createdUnit || createdActive || createdLoaded) input.stopAndDisable();
  if (createdWants) input.removeWants();
  if (createdUnit) input.removeUnit();
  if (createdDefault) input.removeDefaultState();
  if (createdIsolated) input.removeIsolatedState();
  if (createdUnit || createdWants || createdLoaded) input.daemonReload();
}


export function resignRuntimeTree(root: string, version: string, target: TargetTriple): void {
  const walked = walkRegularFiles(root);
  if (!walked.ok) fail("runtime walk failed");
  const files = walked.files
    .filter(file => file.path !== "runtime-manifest.json")
    .map(file => ({
      path: file.path,
      executable: (file.stat.mode & 0o111) !== 0,
    }));
  const created = createRuntimeManifestFromFiles({
    id: runtimeManifestId(version, target),
    version,
    target,
    root,
    files,
    enforceExecutableBit: process.platform !== "win32",
  });
  if (!created.ok) fail("runtime manifest rebuild failed");
  const written = writeRuntimeManifestFile(root, created.manifest);
  if (!written.ok) fail("runtime manifest write failed");
  const loaded = readRuntimeManifestFile(join(root, "runtime-manifest.json"), { expectedTarget: target });
  if (!loaded.ok || loaded.manifest.version !== version) fail("runtime manifest reload failed");
}

export type IsolatedHomes = {
  home: string;
  stableRoot: string;
  env: Record<string, string>;
};

export function createIsolatedHomes(prefix: string, port: number): IsolatedHomes {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const xdgData = join(home, "xdg-data");
  const xdgConfig = join(home, "xdg-config");
  const xdgCache = join(home, "xdg-cache");
  const xdgState = join(home, "xdg-state");
  const xdgRuntime = join(home, "xdg-runtime");
  const ocxHome = join(home, "opencodex");
  const codexHome = join(home, "codex");
  const tmp = join(home, "tmp");
  for (const dir of [xdgData, xdgConfig, xdgCache, xdgState, xdgRuntime, ocxHome, codexHome, tmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(ocxHome, "config.json"), `${JSON.stringify({ port, hostname: "127.0.0.1", providers: {} })}\n`);
  return {
    home,
    stableRoot: join(xdgData, "com.opencodex.app", "runtime"),
    env: {
      HOME: home,
      XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      XDG_RUNTIME_DIR: xdgRuntime,
      OPENCODEX_HOME: ocxHome,
      CODEX_HOME: codexHome,
      TMPDIR: tmp,
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      NO_COLOR: "1",
    },
  };
}

export function removeIsolatedHomes(home: string): void {
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
}

export async function invokeBridge(
  bunPath: string,
  generationRoot: string,
  env: Record<string, string>,
  request: JsonRecord,
  timeout: number,
): Promise<JsonRecord> {
  const result = await runChild(
    [bunPath, "desktop/runtime/bootstrap.ts"],
    {
      cwd: generationRoot,
      env,
      stdin: `${JSON.stringify(request)}\n`,
      timeout,
    },
  );
  const value = parseOneJsonLine(result, String(request.operation));
  if (!isRecord(value)) fail("bridge envelope is not an object");
  return value;
}

export async function invokeInstall(
  bunPath: string,
  sourceRoot: string,
  env: Record<string, string>,
  stableRoot: string,
  target: TargetTriple,
  timeout: number,
): Promise<JsonRecord> {
  const result = await runChild(
    [bunPath, "desktop/runtime/install.ts"],
    {
      cwd: sourceRoot,
      env,
      stdin: `${JSON.stringify({ schemaVersion: 1, target, stableRoot })}\n`,
      timeout,
    },
  );
  const value = parseOneJsonLine(result, "install");
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) fail("runtime install failed");
  return value.result;
}
