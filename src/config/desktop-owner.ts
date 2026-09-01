/**
 * Desktop-direct launch descriptor and two-record ownership seam.
 *
 * The proxy child is the only writer of `runtime-port.json` owner id and
 * `desktop-direct-owner.json`. Bridge/Rust callers may create a one-shot launch
 * descriptor, classify evidence, and compare-before-clean dead complete records.
 * They must not create, overwrite, or "repair" the two ownership records.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { atomicWriteFile } from "./atomic-write";
import { getConfigDir, hardenConfigDir } from "./paths";
import { getRuntimePortPath, readRuntimePort } from "./process-state";

export const DESKTOP_OWNER_SCHEMA_VERSION = 1 as const;
export const DESKTOP_DIRECT_OWNER_FILE = "desktop-direct-owner.json";
export const DESKTOP_LAUNCH_DIR_NAME = "desktop-launch";
export const DESKTOP_LAUNCH_DESCRIPTOR_ENV = "OCX_DESKTOP_LAUNCH_DESCRIPTOR";
export const DESKTOP_OWNER_MAX_BYTES = 16 * 1024;
export const DESKTOP_LAUNCH_MAX_AGE_MS = 120_000;
export const DESKTOP_OWNER_STALE_GRACE_MS = 30_000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const HEX_32_RE = /^[a-f0-9]{32}$/;
const HEX_64_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

const OWNER_RECORD_KEYS = [
  "schemaVersion",
  "ownerId",
  "installId",
  "runtimeManifestId",
  "runtimeVersion",
  "bunPath",
  "cliPath",
  "pid",
  "nonceDigest",
  "createdAt",
] as const;

const DESCRIPTOR_KEYS = [
  "schemaVersion",
  "installId",
  "runtimeManifestId",
  "bunPath",
  "cliPath",
  "nonce",
  "createdAt",
] as const;

export type DesktopOwnerKind =
  | "existing-external"
  | "desktop-direct"
  | "desktop-service"
  | "unknown/conflict";

export type DesktopRuntimeIdentity = {
  installId: string;
  runtimeManifestId: string;
  runtimeVersion: string;
  bunPath: string;
  cliPath: string;
  stableRuntimeRoot: string;
};

export type DesktopLaunchDescriptor = {
  schemaVersion: 1;
  installId: string;
  runtimeManifestId: string;
  bunPath: string;
  cliPath: string;
  nonce: string;
  createdAt: number;
};

export type DesktopDirectOwnerRecord = {
  schemaVersion: 1;
  ownerId: string;
  installId: string;
  runtimeManifestId: string;
  runtimeVersion: string;
  bunPath: string;
  cliPath: string;
  pid: number;
  nonceDigest: string;
  createdAt: number;
};

export type DesktopServiceInstallPaths = {
  bunPath?: string;
  cliPath?: string;
};

export type DesktopOwnerEvidence = {
  identity: DesktopRuntimeIdentity | null;
  livePid: number | null;
  livePort: number | null;
  commandLine?: string | null;
  service: { installed: boolean; startable: boolean; conflict: boolean };
  serviceInstall?: DesktopServiceInstallPaths | null;
  now?: number;
  isAlive?: (pid: number) => boolean;
};

export type DesktopOwnerClassification = {
  owner: DesktopOwnerKind;
  complete: boolean;
};

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

function ensureHome(): string {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else hardenConfigDir();
  return dir;
}

export function getDesktopDirectOwnerPath(): string {
  return join(getConfigDir(), DESKTOP_DIRECT_OWNER_FILE);
}

export function getDesktopLaunchDir(): string {
  return join(getConfigDir(), DESKTOP_LAUNCH_DIR_NAME);
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileErrorCode(error) !== "ESRCH";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = ownKeys(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    if (!expected.includes(key)) return false;
  }
  for (const key of expected) {
    if (!keys.includes(key)) return false;
  }
  return true;
}

function fileIdentityFromStats(stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function isSafeRegularFile(stat: Stats, maxBytes: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes;
}

function unixOwnerOnlyFile(stat: Stats): boolean {
  if (process.platform === "win32") return true;
  return (stat.mode & 0o077) === 0;
}

function unixOwnerOnlyDir(stat: Stats): boolean {
  if (process.platform === "win32") return true;
  return (stat.mode & 0o077) === 0;
}

function isSafeAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("..")) return false;
  if (!isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/);
  return !segments.includes("..");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_RE.test(value);
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
}

function normalizePath(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathsEqualCanonical(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

export function isPathInsideRoot(root: string, target: string): boolean {
  if (!isSafeAbsolutePath(root) || !isSafeAbsolutePath(target)) return false;
  const rel = relative(normalizePath(root), normalizePath(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function digestLaunchNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function parseOwnerRecord(value: unknown): DesktopDirectOwnerRecord | null {
  if (!isPlainObject(value) || !exactKeys(value, OWNER_RECORD_KEYS)) return null;
  if (!Object.is(value.schemaVersion, 1) || !Number.isInteger(value.schemaVersion)) return null;
  if (!HEX_32_RE.test(String(value.ownerId ?? ""))) return null;
  if (!isId(value.installId) || !isId(value.runtimeManifestId) || !isVersion(value.runtimeVersion)) return null;
  if (!isSafeAbsolutePath(value.bunPath) || !isSafeAbsolutePath(value.cliPath)) return null;
  if (!isPid(value.pid) || !HEX_64_RE.test(String(value.nonceDigest ?? ""))) return null;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt <= 0) return null;
  return {
    schemaVersion: 1,
    ownerId: value.ownerId as string,
    installId: value.installId,
    runtimeManifestId: value.runtimeManifestId,
    runtimeVersion: value.runtimeVersion,
    bunPath: value.bunPath,
    cliPath: value.cliPath,
    pid: value.pid,
    nonceDigest: value.nonceDigest as string,
    createdAt: value.createdAt,
  };
}

function parseLaunchDescriptor(value: unknown): DesktopLaunchDescriptor | null {
  if (!isPlainObject(value) || !exactKeys(value, DESCRIPTOR_KEYS)) return null;
  if (!Object.is(value.schemaVersion, 1) || !Number.isInteger(value.schemaVersion)) return null;
  if (!isId(value.installId) || !isId(value.runtimeManifestId)) return null;
  if (!isSafeAbsolutePath(value.bunPath) || !isSafeAbsolutePath(value.cliPath)) return null;
  if (typeof value.nonce !== "string" || !HEX_64_RE.test(value.nonce)) return null;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt <= 0) return null;
  return {
    schemaVersion: 1,
    installId: value.installId,
    runtimeManifestId: value.runtimeManifestId,
    bunPath: value.bunPath,
    cliPath: value.cliPath,
    nonce: value.nonce,
    createdAt: value.createdAt,
  };
}

function readJsonFile(path: string, maxBytes: number): { identity: FileIdentity; value: unknown } | null {
  let before: Stats;
  let raw: string;
  try {
    before = lstatSync(path);
    if (!isSafeRegularFile(before, maxBytes) || !unixOwnerOnlyFile(before)) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") !== before.size) return null;
  try {
    const after = lstatSync(path);
    if (!isSafeRegularFile(after, maxBytes) || !sameFileIdentity(fileIdentityFromStats(before), fileIdentityFromStats(after))) {
      return null;
    }
    return { identity: fileIdentityFromStats(after), value: JSON.parse(raw) as unknown };
  } catch {
    return null;
  }
}

function readJsonFileNoFollow(path: string, maxBytes: number): { identity: FileIdentity; value: unknown } | null {
  let before: Stats;
  let fd: number | null = null;
  let raw: string;
  try {
    before = lstatSync(path);
    if (!isSafeRegularFile(before, maxBytes) || !unixOwnerOnlyFile(before)) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!isSafeRegularFile(opened, maxBytes) || !unixOwnerOnlyFile(opened)) return null;
    if (!sameFileIdentity(fileIdentityFromStats(before), fileIdentityFromStats(opened))) return null;
    raw = readFileSync(fd, "utf8");
    const afterRead = fstatSync(fd);
    if (!sameFileIdentity(fileIdentityFromStats(opened), fileIdentityFromStats(afterRead))) return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* descriptor validation already failed closed */ }
    }
  }
  if (Buffer.byteLength(raw, "utf8") !== before.size) return null;
  try {
    const named = lstatSync(path);
    if (!isSafeRegularFile(named, maxBytes)) return null;
    if (!sameFileIdentity(fileIdentityFromStats(before), fileIdentityFromStats(named))) return null;
    return { identity: fileIdentityFromStats(named), value: JSON.parse(raw) as unknown };
  } catch {
    return null;
  }
}

export function readDesktopDirectOwnerRecord(): DesktopDirectOwnerRecord | null {
  const parsed = readJsonFile(getDesktopDirectOwnerPath(), DESKTOP_OWNER_MAX_BYTES);
  if (!parsed) return null;
  return parseOwnerRecord(parsed.value);
}

export function removeDesktopDirectOwnerRecord(
  expectedPid: number,
  expectedOwnerId?: string,
): boolean {
  if (!isPid(expectedPid)) return false;
  const path = getDesktopDirectOwnerPath();
  const observed = readJsonFile(path, DESKTOP_OWNER_MAX_BYTES);
  if (!observed) return false;
  const owner = parseOwnerRecord(observed.value);
  if (!owner || owner.pid !== expectedPid) return false;
  if (expectedOwnerId !== undefined && owner.ownerId !== expectedOwnerId) return false;
  const confirmed = readJsonFile(path, DESKTOP_OWNER_MAX_BYTES);
  if (!confirmed || !sameFileIdentity(observed.identity, confirmed.identity)) return false;
  const confirmedOwner = parseOwnerRecord(confirmed.value);
  if (!confirmedOwner || confirmedOwner.pid !== expectedPid) return false;
  if (expectedOwnerId !== undefined && confirmedOwner.ownerId !== expectedOwnerId) return false;
  return unlinkIfUnchanged(path, confirmed.identity);
}

export function readRuntimePortOwnerId(expectedPid?: number): string | null {
  const parsed = readJsonFile(getRuntimePortPath(), DESKTOP_OWNER_MAX_BYTES);
  if (!parsed || !isPlainObject(parsed.value)) return null;
  if (!isPid(parsed.value.pid) || !Number.isInteger(parsed.value.port)) return null;
  if (expectedPid !== undefined && parsed.value.pid !== expectedPid) return null;
  if (parsed.value.ownerId === undefined) return null;
  return HEX_32_RE.test(String(parsed.value.ownerId)) ? String(parsed.value.ownerId) : null;
}

export function desktopDirectRecordsComplete(expectedPid?: number): boolean {
  const owner = readDesktopDirectOwnerRecord();
  if (!owner) return false;
  if (expectedPid !== undefined && owner.pid !== expectedPid) return false;
  const runtime = readRuntimePort(owner.pid);
  const ownerId = readRuntimePortOwnerId(owner.pid);
  return runtime !== null && ownerId === owner.ownerId && runtime.pid === owner.pid;
}

function commandLineNamesExpectedBinaries(commandLine: string, identity: DesktopRuntimeIdentity): boolean {
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  const bun = normalizePath(identity.bunPath).replace(/\\/g, "/");
  const cli = normalizePath(identity.cliPath).replace(/\\/g, "/");
  return normalized.includes(bun.toLowerCase()) && normalized.includes(cli.toLowerCase());
}

function servicePathsInsideRuntime(
  identity: DesktopRuntimeIdentity,
  install: DesktopServiceInstallPaths | null | undefined,
): boolean {
  if (!install?.bunPath || !install.cliPath) return false;
  return normalizePath(install.bunPath) === normalizePath(identity.bunPath)
    && normalizePath(install.cliPath) === normalizePath(identity.cliPath)
    && isPathInsideRoot(identity.stableRuntimeRoot, install.bunPath)
    && isPathInsideRoot(identity.stableRuntimeRoot, install.cliPath);
}

function ownerRecordMatchesIdentity(
  owner: DesktopDirectOwnerRecord,
  identity: DesktopRuntimeIdentity,
): boolean {
  return owner.installId === identity.installId
    && owner.runtimeManifestId === identity.runtimeManifestId
    && owner.runtimeVersion === identity.runtimeVersion
    && normalizePath(owner.bunPath) === normalizePath(identity.bunPath)
    && normalizePath(owner.cliPath) === normalizePath(identity.cliPath)
    && isPathInsideRoot(identity.stableRuntimeRoot, owner.bunPath)
    && isPathInsideRoot(identity.stableRuntimeRoot, owner.cliPath);
}

type RecordPresence =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "complete"; owner: DesktopDirectOwnerRecord; runtimePid: number; runtimePort: number; ownerId: string };

function inspectOwnershipRecords(expectedPid?: number): RecordPresence {
  const ownerPath = getDesktopDirectOwnerPath();
  const runtimePath = getRuntimePortPath();
  const ownerExists = existsSync(ownerPath);
  const runtime = readRuntimePort(expectedPid);
  const runtimeOwnerId = readRuntimePortOwnerId(expectedPid);
  const owner = readDesktopDirectOwnerRecord();

  if (!ownerExists && runtimeOwnerId === null) return { kind: "absent" };
  if (!owner || !runtime || runtimeOwnerId === null) return { kind: "invalid" };
  if (owner.pid !== runtime.pid || owner.ownerId !== runtimeOwnerId) return { kind: "invalid" };
  if (expectedPid !== undefined && owner.pid !== expectedPid) return { kind: "invalid" };
  return {
    kind: "complete",
    owner,
    runtimePid: runtime.pid,
    runtimePort: runtime.port,
    ownerId: owner.ownerId,
  };
}

function unlinkIfUnchanged(path: string, identity: FileIdentity): boolean {
  try {
    const current = lstatSync(path);
    if (!sameFileIdentity(identity, fileIdentityFromStats(current))) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a complete, identity-stable owner/runtime pair only when the recorded PID is
 * dead and both files still match the snapshot. Partial records are left untouched.
 */
export function reclaimStaleDesktopDirectRecords(options: {
  isAlive?: (pid: number) => boolean;
  now?: number;
} = {}): boolean {
  const ownerPath = getDesktopDirectOwnerPath();
  const runtimePath = getRuntimePortPath();
  const ownerRead = readJsonFile(ownerPath, DESKTOP_OWNER_MAX_BYTES);
  const runtimeRead = readJsonFile(runtimePath, DESKTOP_OWNER_MAX_BYTES);
  if (!ownerRead || !runtimeRead) return false;
  const owner = parseOwnerRecord(ownerRead.value);
  if (!owner) return false;
  if (!isPlainObject(runtimeRead.value) || runtimeRead.value.ownerId !== owner.ownerId) return false;
  if (!isPid(runtimeRead.value.pid) || runtimeRead.value.pid !== owner.pid) return false;
  const isAlive = options.isAlive ?? defaultIsAlive;
  if (isAlive(owner.pid)) return false;
  const now = options.now ?? Date.now();
  if (now - owner.createdAt < DESKTOP_OWNER_STALE_GRACE_MS) return false;
  const ownerAgain = readJsonFile(ownerPath, DESKTOP_OWNER_MAX_BYTES);
  const runtimeAgain = readJsonFile(runtimePath, DESKTOP_OWNER_MAX_BYTES);
  if (!ownerAgain || !runtimeAgain) return false;
  if (!sameFileIdentity(ownerRead.identity, ownerAgain.identity)) return false;
  if (!sameFileIdentity(runtimeRead.identity, runtimeAgain.identity)) return false;
  const confirmed = parseOwnerRecord(ownerAgain.value);
  if (!confirmed || confirmed.ownerId !== owner.ownerId || confirmed.pid !== owner.pid) return false;
  unlinkIfUnchanged(ownerPath, ownerAgain.identity);
  unlinkIfUnchanged(runtimePath, runtimeAgain.identity);
  return !existsSync(ownerPath) && readRuntimePortOwnerId(owner.pid) === null;
}

export function classifyDesktopOwner(evidence: DesktopOwnerEvidence): DesktopOwnerClassification {
  reclaimStaleDesktopDirectRecords({
    isAlive: evidence.isAlive,
    now: evidence.now,
  });

  if (evidence.service.conflict) {
    return { owner: "unknown/conflict", complete: false };
  }

  const records = inspectOwnershipRecords(evidence.livePid ?? undefined);
  if (records.kind === "invalid") {
    return { owner: "unknown/conflict", complete: false };
  }

  if (records.kind === "complete") {
    if (!evidence.identity) return { owner: "unknown/conflict", complete: true };
    if (!ownerRecordMatchesIdentity(records.owner, evidence.identity)) {
      return { owner: "unknown/conflict", complete: true };
    }
    if (evidence.livePid !== null && evidence.livePid !== records.owner.pid) {
      return { owner: "unknown/conflict", complete: true };
    }
    if (evidence.livePort !== null && evidence.livePort !== records.runtimePort) {
      return { owner: "unknown/conflict", complete: true };
    }
    if (evidence.commandLine) {
      if (!commandLineNamesExpectedBinaries(evidence.commandLine, evidence.identity)) {
        return { owner: "unknown/conflict", complete: true };
      }
    } else if (evidence.livePid !== null) {
      return { owner: "unknown/conflict", complete: true };
    }
    if (evidence.service.installed) {
      return { owner: "unknown/conflict", complete: true };
    }
    return { owner: "desktop-direct", complete: true };
  }

  if (evidence.service.installed && evidence.identity && servicePathsInsideRuntime(evidence.identity, evidence.serviceInstall)) {
    return { owner: "desktop-service", complete: true };
  }

  return { owner: "existing-external", complete: records.kind === "absent" };
}

export function createDesktopLaunchDescriptor(
  identity: DesktopRuntimeIdentity,
  options: { now?: number; nonce?: string; token?: string } = {},
): { path: string } {
  if (!isId(identity.installId) || !isId(identity.runtimeManifestId) || !isVersion(identity.runtimeVersion)) {
    throw new RangeError("desktop launch identity is invalid");
  }
  if (!isSafeAbsolutePath(identity.bunPath) || !isSafeAbsolutePath(identity.cliPath) || !isSafeAbsolutePath(identity.stableRuntimeRoot)) {
    throw new RangeError("desktop launch paths must be absolute");
  }
  const home = ensureHome();
  const dir = join(home, DESKTOP_LAUNCH_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("desktop launch directory is unsafe");
    }
  }
  try { chmodSync(dir, 0o700); } catch { /* best-effort owner-only mode */ }
  const dirStat = lstatSync(dir);
  if (!unixOwnerOnlyDir(dirStat)) {
    throw new Error("desktop launch directory must be owner-only");
  }

  const nonce = options.nonce ?? randomBytes(32).toString("hex");
  if (!HEX_64_RE.test(nonce)) throw new RangeError("desktop launch nonce must be 32 bytes hex");
  const token = options.token ?? randomUUID().replace(/-/g, "");
  if (!TOKEN_RE.test(token)) throw new RangeError("desktop launch token is invalid");
  const path = join(dir, `${token}.json`);
  const resolved = resolve(path);
  if (!isPathInsideRoot(dir, resolved)) throw new Error("desktop launch descriptor escaped its directory");
  const record: DesktopLaunchDescriptor = {
    schemaVersion: 1,
    installId: identity.installId,
    runtimeManifestId: identity.runtimeManifestId,
    bunPath: identity.bunPath,
    cliPath: identity.cliPath,
    nonce,
    createdAt: options.now ?? Date.now(),
  };
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    try { closeSync(fd); } catch { /* exclusive create already happened */ }
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
  return { path };
}

function resolvedDescriptorPath(path: string): string | null {
  if (!isSafeAbsolutePath(path)) return null;
  const dir = getDesktopLaunchDir();
  const lexicalDir = resolve(dir);
  const lexical = resolve(path);
  const name = basename(lexical);
  if (!name.endsWith(".json") || !TOKEN_RE.test(name.slice(0, -5))) return null;
  if (dirname(lexical) !== lexicalDir || !isPathInsideRoot(lexicalDir, lexical)) return null;
  try {
    const stat = lstatSync(lexical);
    if (!isSafeRegularFile(stat, DESKTOP_OWNER_MAX_BYTES) || !unixOwnerOnlyFile(stat)) return null;
    const realDir = realpathSync(lexicalDir);
    const realFile = realpathSync(lexical);
    if (dirname(realFile) !== realDir || basename(realFile) !== name) return null;
  } catch {
    return null;
  }
  return lexical;
}

export function consumeDesktopLaunchDescriptor(
  path: string,
  options: {
    now?: number;
    identity?: DesktopRuntimeIdentity | null;
    expectedBunPath?: string;
    expectedCliPath?: string;
  } = {},
): DesktopLaunchDescriptor | null {
  const resolved = resolvedDescriptorPath(path);
  if (!resolved) return null;
  const read = readJsonFileNoFollow(resolved, DESKTOP_OWNER_MAX_BYTES);
  if (!read) return null;
  const descriptor = parseLaunchDescriptor(read.value);
  if (!descriptor) return null;
  const now = options.now ?? Date.now();
  if (now - descriptor.createdAt > DESKTOP_LAUNCH_MAX_AGE_MS || now < descriptor.createdAt) return null;
  if (options.identity) {
    if (descriptor.installId !== options.identity.installId) return null;
    if (descriptor.runtimeManifestId !== options.identity.runtimeManifestId) return null;
    if (normalizePath(descriptor.bunPath) !== normalizePath(options.identity.bunPath)) return null;
    if (normalizePath(descriptor.cliPath) !== normalizePath(options.identity.cliPath)) return null;
  }
  if (options.expectedBunPath && normalizePath(descriptor.bunPath) !== normalizePath(options.expectedBunPath)) {
    return null;
  }
  if (options.expectedCliPath && normalizePath(descriptor.cliPath) !== normalizePath(options.expectedCliPath)) {
    return null;
  }
  if (!unlinkIfUnchanged(resolved, read.identity)) return null;
  return descriptor;
}

export function reclaimStaleDesktopLaunchDescriptors(options: { now?: number } = {}): number {
  const dir = getDesktopLaunchDir();
  let entries: string[];
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 0;
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const now = options.now ?? Date.now();
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".json") || !TOKEN_RE.test(name.slice(0, -5))) continue;
    const path = join(dir, name);
    const read = readJsonFile(path, DESKTOP_OWNER_MAX_BYTES);
    if (!read) continue;
    const descriptor = parseLaunchDescriptor(read.value);
    if (!descriptor) continue;
    if (now - descriptor.createdAt <= DESKTOP_LAUNCH_MAX_AGE_MS) continue;
    const again = readJsonFile(path, DESKTOP_OWNER_MAX_BYTES);
    if (!again || !sameFileIdentity(read.identity, again.identity)) continue;
    if (unlinkIfUnchanged(path, again.identity)) removed += 1;
  }
  return removed;
}

export function publishDesktopDirectOwnerRecord(record: DesktopDirectOwnerRecord): void {
  const parsed = parseOwnerRecord(record);
  if (!parsed) throw new RangeError("desktop-direct owner record is invalid");
  ensureHome();
  atomicWriteFile(getDesktopDirectOwnerPath(), `${JSON.stringify(parsed)}\n`);
}

export function writeRuntimePortOwnerId(
  ownerId: string,
  expectedPid: number,
): boolean {
  if (!HEX_32_RE.test(ownerId) || !isPid(expectedPid)) return false;
  const parsed = readJsonFile(getRuntimePortPath(), DESKTOP_OWNER_MAX_BYTES);
  const runtime = readRuntimePort(expectedPid);
  if (!parsed || !isPlainObject(parsed.value) || !runtime) return false;
  if (parsed.value.pid !== expectedPid) return false;
  if (parsed.value.ownerId !== undefined && parsed.value.ownerId !== ownerId) return false;
  const next = {
    pid: runtime.pid,
    port: runtime.port,
    ...(runtime.hostname ? { hostname: runtime.hostname } : {}),
    ...(runtime.attestationSecret ? { attestationSecret: runtime.attestationSecret } : {}),
    ownerId,
  };
  atomicWriteFile(getRuntimePortPath(), `${JSON.stringify(next, null, 2)}\n`);
  return readRuntimePortOwnerId(expectedPid) === ownerId;
}

export function publishDesktopDirectRecords(input: {
  owner: DesktopDirectOwnerRecord;
  runtime: { pid: number; port: number; hostname?: string; attestationSecret?: string };
}): void {
  if (input.owner.pid !== input.runtime.pid) {
    throw new RangeError("desktop-direct owner pid must match runtime pid");
  }
  publishDesktopDirectOwnerRecord(input.owner);
  const current = readJsonFile(getRuntimePortPath(), DESKTOP_OWNER_MAX_BYTES);
  if (current && isPlainObject(current.value) && isPid(current.value.pid) && current.value.pid === input.runtime.pid) {
    if (!writeRuntimePortOwnerId(input.owner.ownerId, input.runtime.pid)) {
      removeDesktopDirectOwnerRecord(input.owner.pid, input.owner.ownerId);
      throw new Error("desktop-direct runtime owner publication failed");
    }
    if (!desktopDirectRecordsComplete(input.owner.pid)) {
      removeDesktopDirectOwnerRecord(input.owner.pid, input.owner.ownerId);
      throw new Error("desktop-direct ownership records are incomplete");
    }
    return;
  }
  ensureHome();
  atomicWriteFile(getRuntimePortPath(), `${JSON.stringify({
    pid: input.runtime.pid,
    port: input.runtime.port,
    ...(input.runtime.hostname ? { hostname: input.runtime.hostname } : {}),
    ...(input.runtime.attestationSecret ? { attestationSecret: input.runtime.attestationSecret } : {}),
    ownerId: input.owner.ownerId,
  }, null, 2)}\n`);
  if (!desktopDirectRecordsComplete(input.owner.pid)) {
    removeDesktopDirectOwnerRecord(input.owner.pid, input.owner.ownerId);
    throw new Error("desktop-direct ownership records are incomplete");
  }
}

/**
 * Child-side publication: consume the one-shot descriptor, then write both records.
 * Returns null when the descriptor is missing, stale, or mismatched.
 */
export function consumeLaunchDescriptorAndPublish(input: {
  descriptorPath: string;
  pid: number;
  port: number;
  hostname?: string;
  attestationSecret?: string;
  identity?: DesktopRuntimeIdentity | null;
  expectedBunPath?: string;
  expectedCliPath?: string;
  runtimeVersion?: string;
  now?: number;
}): { ownerId: string } | null {
  const descriptor = consumeDesktopLaunchDescriptor(input.descriptorPath, {
    now: input.now,
    identity: input.identity,
    expectedBunPath: input.expectedBunPath,
    expectedCliPath: input.expectedCliPath,
  });
  if (!descriptor) return null;
  const identity = input.identity;
  const runtimeVersion = identity?.runtimeVersion ?? input.runtimeVersion;
  if (!runtimeVersion || !isVersion(runtimeVersion)) return null;
  const ownerId = randomBytes(16).toString("hex");
  const owner: DesktopDirectOwnerRecord = {
    schemaVersion: 1,
    ownerId,
    installId: descriptor.installId,
    runtimeManifestId: descriptor.runtimeManifestId,
    runtimeVersion,
    bunPath: descriptor.bunPath,
    cliPath: descriptor.cliPath,
    pid: input.pid,
    nonceDigest: digestLaunchNonce(descriptor.nonce),
    createdAt: input.now ?? Date.now(),
  };
  publishDesktopDirectRecords({
    owner,
    runtime: {
      pid: input.pid,
      port: input.port,
      hostname: input.hostname,
      attestationSecret: input.attestationSecret,
    },
  });
  return { ownerId };
}
