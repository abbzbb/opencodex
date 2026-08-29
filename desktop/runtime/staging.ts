import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  MANIFEST_FILE_NAME,
  asObject,
  canonicalFileMode,
  containedLookup,
  defaultEnforceExecutableBit,
  ensureParentDir,
  exactObjectKeys,
  failStore,
  fileErrorCode,
  fileExistsLstat,
  ioError,
  isInsideRoot,
  isManifestId,
  isRuntimeVersion,
  isTargetTriple,
  mkdirContained,
  okStore,
  okUnit,
  parseRuntimeManifest,
  posixSegments,
  readRuntimeManifestFile,
  realpathRoot,
  stripUtf8Bom,
  validateRelativeRuntimePath,
  verifyRuntimeTree,
  versionRelPath,
  writeRuntimeManifestFile,
  type RuntimeManifest,
  type RuntimeStoreResult,
  type RuntimeUnit,
  type TargetTriple,
} from "./manifest";

export const CURRENT_POINTER_NAME = "current.json";
export const CURRENT_LOCK_NAME = "current.lock";
export const STABLE_VERSIONS_DIR = "versions";
export const STABLE_STAGING_DIR = "staging";
export const POINTER_SCHEMA_VERSION = 1 as const;
export const STORE_LOCK_SCHEMA_VERSION = 1 as const;
export const STORE_LOCK_INCOMPLETE_GRACE_MS = 5_000;
const STORE_LOCK_TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_STORE_LOCK_BYTES = 4096;

export type VersionPointer = {
  id: string;
  version: string;
  target: TargetTriple;
  relPath: string;
};

export type CurrentPointer = {
  schemaVersion: 1;
  current: VersionPointer;
  previous: VersionPointer | null;
};

export type StagingHooks = {
  afterCopyFile?: (relPath: string) => void;
  beforeRenameStage?: (tempDir: string) => void;
  beforePublish?: () => void;
  beforeCurrentRename?: () => void;
  failCopyOf?: string;
  failCurrentRename?: boolean;
  isAlive?: (pid: number) => boolean;
  pid?: number;
  now?: () => number;
  beforeStaleReclaim?: () => void;
  beforeReleaseUnlink?: () => void;
};

export type StoreLockRecord = {
  schemaVersion: 1;
  token: string;
  pid: number;
  createdAt: number;
};

export type VersionReferenceGuard = (relPath: string, absPath: string) => boolean;

export type StageRuntimeInput = {
  sourceRoot: string;
  stableRoot: string;
  expectedTarget: TargetTriple;
  manifest?: unknown;
  enforceExecutableBit?: boolean;
  hooks?: StagingHooks;
  isVersionReferenced?: VersionReferenceGuard;
};

export type StageRuntimeSuccess = {
  staged: VersionPointer;
  absPath: string;
  reused: boolean;
  manifest: RuntimeManifest;
};

export type PublishCurrentInput = {
  stableRoot: string;
  staged: VersionPointer;
  expectedCurrent: VersionPointer | null;
  expectedTarget: TargetTriple;
  enforceExecutableBit?: boolean;
  isVersionReferenced?: VersionReferenceGuard;
  hooks?: StagingHooks;
};

export type PublishCurrentSuccess = {
  pointer: CurrentPointer;
  pruned: string[];
  retained: string[];
};

export type RollbackCurrentInput = {
  stableRoot: string;
  expectedCurrent: VersionPointer;
  expectedTarget: TargetTriple;
  enforceExecutableBit?: boolean;
  isVersionReferenced?: VersionReferenceGuard;
  hooks?: StagingHooks;
};

export type ActivateRuntimeInput = StageRuntimeInput & {
  expectedCurrent: VersionPointer | null;
  isVersionReferenced?: VersionReferenceGuard;
};

export type ActivateRuntimeSuccess = StageRuntimeSuccess & PublishCurrentSuccess;

export type ResolveRuntimeInput = {
  stableRoot: string;
  manifestId: string;
  expectedTarget?: TargetTriple;
  enforceExecutableBit?: boolean;
};

const POINTER_KEYS = ["schemaVersion", "current", "previous"] as const;
const VERSION_POINTER_KEYS = ["id", "version", "target", "relPath"] as const;

function pointersEqual(left: VersionPointer | null, right: VersionPointer | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.target === right.target &&
    left.relPath === right.relPath
  );
}

export function versionPointerFromManifest(manifest: RuntimeManifest): VersionPointer {
  return {
    id: manifest.id,
    version: manifest.version,
    target: manifest.target,
    relPath: versionRelPath(manifest.version),
  };
}

export function parseVersionPointer(
  value: unknown,
  label: string,
): RuntimeStoreResult<{ pointer: VersionPointer }> {
  const obj = asObject(value, label, "invalid_pointer");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactObjectKeys(obj.value, VERSION_POINTER_KEYS, "invalid_pointer");
  if (keys) {
    return keys;
  }
  if (!isManifestId(obj.value.id)) {
    return failStore("invalid_pointer", `${label}.id is invalid`);
  }
  if (!isRuntimeVersion(obj.value.version)) {
    return failStore("invalid_pointer", `${label}.version is invalid`);
  }
  if (!isTargetTriple(obj.value.target)) {
    return failStore("invalid_pointer", `${label}.target is invalid`);
  }
  const rel = validateRelativeRuntimePath(obj.value.relPath);
  if (!rel.ok) {
    return failStore("invalid_pointer", `${label}.relPath is invalid`);
  }
  if (rel.path !== versionRelPath(obj.value.version)) {
    return failStore("invalid_pointer", `${label}.relPath must be versions/<version>`);
  }
  return okStore({
    pointer: {
      id: obj.value.id,
      version: obj.value.version,
      target: obj.value.target,
      relPath: rel.path,
    },
  });
}

export function parseCurrentPointer(value: unknown): RuntimeStoreResult<{ pointer: CurrentPointer }> {
  const obj = asObject(value, "current.json", "invalid_pointer");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactObjectKeys(obj.value, POINTER_KEYS, "invalid_pointer");
  if (keys) {
    return keys;
  }
  if (!Object.is(obj.value.schemaVersion, 1) || !Number.isInteger(obj.value.schemaVersion)) {
    return failStore("invalid_pointer", "unsupported schemaVersion");
  }
  const current = parseVersionPointer(obj.value.current, "current");
  if (!current.ok) {
    return current;
  }
  let previous: VersionPointer | null = null;
  if (obj.value.previous !== null) {
    const parsed = parseVersionPointer(obj.value.previous, "previous");
    if (!parsed.ok) {
      return parsed;
    }
    previous = parsed.pointer;
    if (previous.version === current.pointer.version) {
      return failStore("invalid_pointer", "previous.version must differ from current.version");
    }
  }
  return okStore({
    pointer: {
      schemaVersion: 1,
      current: current.pointer,
      previous,
    },
  });
}

export function serializeCurrentPointer(pointer: CurrentPointer): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    current: {
      id: pointer.current.id,
      version: pointer.current.version,
      target: pointer.current.target,
      relPath: pointer.current.relPath,
    },
    previous: pointer.previous
      ? {
          id: pointer.previous.id,
          version: pointer.previous.version,
          target: pointer.previous.target,
          relPath: pointer.previous.relPath,
        }
      : null,
  })}\n`;
}

function currentPointerPath(stableRoot: string): string {
  return join(stableRoot, CURRENT_POINTER_NAME);
}

function lockFilePath(stableRoot: string): string {
  return join(stableRoot, CURRENT_LOCK_NAME);
}

function versionAbsPath(stableRoot: string, version: string): string {
  return join(stableRoot, STABLE_VERSIONS_DIR, version);
}

export function readCurrentPointer(stableRoot: string): RuntimeStoreResult<{ pointer: CurrentPointer | null }> {
  const path = currentPointerPath(stableRoot);
  const exists = fileExistsLstat(path);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists) {
    return okStore({ pointer: null });
  }
  if (!exists.stat) {
    return failStore("invalid_pointer", "current.json is unreadable");
  }
  if (exists.stat.isSymbolicLink()) {
    return failStore("symlink_forbidden", "current.json must not be a symlink");
  }
  if (!exists.stat.isFile()) {
    return failStore("invalid_pointer", "current.json must be a regular file");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(stripUtf8Bom(readFileSync(path)));
    return parseCurrentPointer(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return failStore("invalid_pointer", "current.json is not valid JSON");
    }
    return ioError(error);
  }
}

function ensureStableRoot(stableRoot: string): RuntimeStoreResult<{ root: string }> {
  if (typeof stableRoot !== "string" || stableRoot.length === 0) {
    return failStore("path_escape", "stable root is required");
  }
  const resolved = resolve(stableRoot);
  try {
    mkdirSync(resolved, { recursive: true });
  } catch (error) {
    return ioError(error);
  }
  const exists = fileExistsLstat(resolved);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists || !exists.stat) {
    return failStore("io_error", "stable root is missing");
  }
  if (exists.stat.isSymbolicLink()) {
    return failStore("symlink_forbidden", "stable root must not be a symlink");
  }
  if (!exists.stat.isDirectory()) {
    return failStore("io_error", "stable root must be a directory");
  }
  return okStore({ root: resolved });
}

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type HeldStoreLock = {
  fd: number;
  token: string;
  pid: number;
  identity: FileIdentity;
};

function fileIdentityFromStats(stat: { dev: number; ino: number; size: number; mtimeMs: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileErrorCode(error) !== "ESRCH";
  }
}

export function serializeStoreLockRecord(record: StoreLockRecord): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    token: record.token,
    pid: record.pid,
    createdAt: record.createdAt,
  })}\n`;
}

export function parseStoreLockRecord(value: unknown): StoreLockRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !Object.is(record.schemaVersion, 1) ||
    typeof record.token !== "string" ||
    !STORE_LOCK_TOKEN_RE.test(record.token) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    token: record.token,
    pid: record.pid,
    createdAt: record.createdAt,
  };
}

function unlinkLockIfIdentity(path: string, identity: FileIdentity | undefined): void {
  if (!identity) {
    return;
  }
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || st.isDirectory() || !st.isFile()) {
      return;
    }
    if (!sameFileIdentity(identity, fileIdentityFromStats(st))) {
      return;
    }
    unlinkSync(path);
  } catch {
    /* successor-safe: leave an unmatched path alone */
  }
}

function readLockRecordIfIdentity(path: string, identity: FileIdentity): StoreLockRecord | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || st.isDirectory() || !st.isFile()) {
      return null;
    }
    if (!sameFileIdentity(identity, fileIdentityFromStats(st))) {
      return null;
    }
    if (st.size <= 0 || st.size > MAX_STORE_LOCK_BYTES) {
      return null;
    }
    const parsed = parseStoreLockRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isFile() || !sameFileIdentity(identity, fileIdentityFromStats(after))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function inspectLockFile(path: string): RuntimeStoreResult<{
  exists: boolean;
  identity?: FileIdentity;
  record?: StoreLockRecord | null;
}> {
  const exists = fileExistsLstat(path);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists || !exists.stat) {
    return okStore({ exists: false });
  }
  if (exists.stat.isSymbolicLink()) {
    return failStore("symlink_forbidden", "current.lock must not be a symlink");
  }
  if (exists.stat.isDirectory()) {
    return failStore("unexpected_file", "current.lock must be a regular file");
  }
  if (!exists.stat.isFile()) {
    return failStore("unexpected_file", "current.lock must be a regular file");
  }
  if (exists.stat.size > MAX_STORE_LOCK_BYTES) {
    return failStore("unexpected_file", "current.lock exceeds the closed maximum size");
  }
  const identity = fileIdentityFromStats(exists.stat);
  let record: StoreLockRecord | null = null;
  if (exists.stat.size > 0) {
    try {
      record = parseStoreLockRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      record = null;
    }
    const after = fileExistsLstat(path);
    if (!after.ok) {
      return after;
    }
    if (!after.exists || !after.stat || after.stat.isSymbolicLink() || !after.stat.isFile()) {
      return failStore("lock_held", "runtime store is locked");
    }
    if (!sameFileIdentity(identity, fileIdentityFromStats(after.stat))) {
      return failStore("lock_held", "runtime store is locked");
    }
  }
  return okStore({ exists: true, identity, record });
}

function exclusiveCreateLock(
  path: string,
  pid: number,
  now: () => number,
): RuntimeStoreResult<HeldStoreLock> {
  const token = `${pid}-${now()}-${randomBytes(8).toString("hex")}`;
  if (!STORE_LOCK_TOKEN_RE.test(token)) {
    return failStore("io_error", "store lock token is invalid");
  }
  const record: StoreLockRecord = {
    schemaVersion: STORE_LOCK_SCHEMA_VERSION,
    token,
    pid,
    createdAt: now(),
  };
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (fileErrorCode(error) === "EEXIST") {
      return failStore("lock_held", "runtime store is locked");
    }
    return ioError(error);
  }
  try {
    writeFileSync(fd, serializeStoreLockRecord(record), "utf8");
    fsyncSync(fd);
    const identity = fileIdentityFromStats(fstatSync(fd));
    return okStore({ fd, token, pid, identity });
  } catch (error) {
    let identity: FileIdentity | undefined;
    try {
      identity = fileIdentityFromStats(fstatSync(fd));
    } catch {
      /* fd may already be unusable */
    }
    try {
      closeSync(fd);
    } catch {
      /* still compare-before-unlink */
    }
    unlinkLockIfIdentity(path, identity);
    return ioError(error);
  }
}

function reclaimStoreLock(
  path: string,
  isAlive: (pid: number) => boolean,
  now: () => number,
  hooks?: StagingHooks,
): RuntimeStoreResult<{ reclaimed: boolean }> {
  const inspected = inspectLockFile(path);
  if (!inspected.ok) {
    return inspected;
  }
  if (!inspected.exists || !inspected.identity) {
    return okStore({ reclaimed: false });
  }
  const record = inspected.record ?? null;
  if (record && isAlive(record.pid)) {
    return okStore({ reclaimed: false });
  }
  if (!record && now() - inspected.identity.mtimeMs < STORE_LOCK_INCOMPLETE_GRACE_MS) {
    return okStore({ reclaimed: false });
  }
  const observed = inspected.identity;
  hooks?.beforeStaleReclaim?.();
  const confirmed = inspectLockFile(path);
  if (!confirmed.ok) {
    return confirmed;
  }
  if (!confirmed.exists || !confirmed.identity || !sameFileIdentity(observed, confirmed.identity)) {
    return okStore({ reclaimed: false });
  }
  const confirmedRecord = confirmed.record ?? null;
  if (confirmedRecord && isAlive(confirmedRecord.pid)) {
    return okStore({ reclaimed: false });
  }
  if (!confirmedRecord && now() - confirmed.identity.mtimeMs < STORE_LOCK_INCOMPLETE_GRACE_MS) {
    return okStore({ reclaimed: false });
  }
  unlinkLockIfIdentity(path, confirmed.identity);
  return okStore({ reclaimed: true });
}

function claimStoreLock(path: string, hooks?: StagingHooks): RuntimeStoreResult<HeldStoreLock> {
  const isAlive = hooks?.isAlive ?? defaultIsAlive;
  const pid = hooks?.pid ?? process.pid;
  const now = hooks?.now ?? Date.now;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return failStore("io_error", "store lock pid must be a positive safe integer");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = inspectLockFile(path);
    if (!existing.ok) {
      return existing;
    }
    const created = exclusiveCreateLock(path, pid, now);
    if (created.ok) {
      return created;
    }
    if (created.code !== "lock_held") {
      return created;
    }
    const reclaimed = reclaimStoreLock(path, isAlive, now, hooks);
    if (!reclaimed.ok) {
      return reclaimed;
    }
    if (!reclaimed.reclaimed) {
      return failStore("lock_held", "runtime store is locked");
    }
  }
  return failStore("lock_held", "runtime store is locked");
}

function releaseStoreLock(path: string, held: HeldStoreLock, hooks?: StagingHooks): void {
  try {
    closeSync(held.fd);
  } catch {
    /* compare-before-unlink still applies */
  }
  const observed = readLockRecordIfIdentity(path, held.identity);
  if (!observed || observed.token !== held.token) {
    return;
  }
  hooks?.beforeReleaseUnlink?.();
  const confirmed = readLockRecordIfIdentity(path, held.identity);
  if (!confirmed || confirmed.token !== held.token) {
    return;
  }
  unlinkLockIfIdentity(path, held.identity);
}

function withStoreLock<T>(
  stableRoot: string,
  hooks: StagingHooks | undefined,
  fn: () => RuntimeStoreResult<T>,
): RuntimeStoreResult<T> {
  const prepared = ensureStableRoot(stableRoot);
  if (!prepared.ok) {
    return prepared;
  }
  const path = lockFilePath(prepared.root);
  const held = claimStoreLock(path, hooks);
  if (!held.ok) {
    return held;
  }
  try {
    return fn();
  } catch (error) {
    return ioError(error);
  } finally {
    releaseStoreLock(path, held, hooks);
  }
}

function applyExecutableBit(
  path: string,
  executable: boolean,
  enforce: boolean,
): RuntimeStoreResult<RuntimeUnit> {
  if (!enforce) {
    return okUnit();
  }
  try {
    chmodSync(path, canonicalFileMode(executable));
    return okUnit();
  } catch (error) {
    return ioError(error);
  }
}

function loadSourceManifest(
  sourceRoot: string,
  expectedTarget: TargetTriple,
  manifestValue: unknown | undefined,
): RuntimeStoreResult<{ manifest: RuntimeManifest }> {
  if (manifestValue !== undefined) {
    return parseRuntimeManifest(manifestValue, { expectedTarget });
  }
  return readRuntimeManifestFile(join(sourceRoot, MANIFEST_FILE_NAME), { expectedTarget });
}

function liveRelPaths(pointer: CurrentPointer | null): Set<string> {
  const keep = new Set<string>();
  if (!pointer) {
    return keep;
  }
  keep.add(pointer.current.relPath);
  if (pointer.previous) {
    keep.add(pointer.previous.relPath);
  }
  return keep;
}

function readStagedManifest(
  absPath: string,
  expectedTarget: TargetTriple,
): RuntimeStoreResult<{ manifest: RuntimeManifest }> {
  const exists = fileExistsLstat(absPath);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists || !exists.stat) {
    return failStore("missing_file", "staged version is missing");
  }
  if (exists.stat.isSymbolicLink()) {
    return failStore("symlink_forbidden", "version directory must not be a symlink");
  }
  if (!exists.stat.isDirectory()) {
    return failStore("unexpected_file", "version path must be a directory");
  }
  return readRuntimeManifestFile(join(absPath, MANIFEST_FILE_NAME), { expectedTarget });
}

function verifyStagedVersion(
  absPath: string,
  expected: VersionPointer,
  expectedTarget: TargetTriple,
  enforceExecutableBit: boolean,
): RuntimeStoreResult<{ manifest: RuntimeManifest }> {
  const loaded = readStagedManifest(absPath, expectedTarget);
  if (!loaded.ok) {
    return loaded;
  }
  const pointer = versionPointerFromManifest(loaded.manifest);
  if (!pointersEqual(pointer, expected)) {
    return failStore("invalid_pointer", "staged tree does not match the requested pointer");
  }
  const verified = verifyRuntimeTree(absPath, loaded.manifest, {
    expectedTarget,
    enforceExecutableBit,
    allowManifestFile: true,
  });
  if (!verified.ok) {
    return verified;
  }
  return okStore({ manifest: loaded.manifest });
}

function unlinkIfRegularFile(path: string): RuntimeStoreResult<RuntimeUnit> {
  const exists = fileExistsLstat(path);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists) {
    return okUnit();
  }
  if (!exists.stat) {
    return failStore("io_error", "path is unreadable");
  }
  if (exists.stat.isDirectory()) {
    return failStore("unexpected_file", "refusing to recursively delete a directory at a file path");
  }
  try {
    unlinkSync(path);
    return okUnit();
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") {
      return okUnit();
    }
    return ioError(error);
  }
}

function removeTree(path: string): RuntimeStoreResult<RuntimeUnit> {
  const exists = fileExistsLstat(path);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists) {
    return okUnit();
  }
  if (!exists.stat) {
    return failStore("io_error", "path is unreadable");
  }
  if (exists.stat.isSymbolicLink() || exists.stat.isFile()) {
    try {
      unlinkSync(path);
      return okUnit();
    } catch (error) {
      if (fileErrorCode(error) === "ENOENT") {
        return okUnit();
      }
      return ioError(error);
    }
  }
  if (!exists.stat.isDirectory()) {
    return failStore("unexpected_file", "refusing to delete unexpected file type");
  }
  try {
    rmSync(path, { recursive: true, force: true });
    return okUnit();
  } catch (error) {
    return ioError(error);
  }
}

function ensureStableChildDir(root: string, name: string): RuntimeStoreResult<{ absPath: string }> {
  const created = mkdirContained(root, name);
  if (!created.ok) {
    return created;
  }
  const exists = fileExistsLstat(created.absPath);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists || !exists.stat) {
    return failStore("io_error", `${name} directory is missing`);
  }
  if (exists.stat.isSymbolicLink()) {
    return failStore("symlink_forbidden", `${name} directory must not be a symlink`);
  }
  if (!exists.stat.isDirectory()) {
    return failStore("unexpected_file", `${name} must be a directory`);
  }
  if (!isInsideRoot(root, created.absPath)) {
    return failStore("path_escape", `${name} escapes the stable root`);
  }
  return okStore({ absPath: created.absPath });
}

function assertStableChildDir(root: string, name: string): RuntimeStoreResult<{ absPath: string }> {
  const absPath = join(root, name);
  if (!isInsideRoot(root, absPath)) {
    return failStore("path_escape", `${name} escapes the stable root`);
  }
  const exists = fileExistsLstat(absPath);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists || !exists.stat) {
    return failStore("missing_file", `${name} directory is missing`);
  }
  if (exists.stat.isSymbolicLink()) {
    return failStore("symlink_forbidden", `${name} directory must not be a symlink`);
  }
  if (!exists.stat.isDirectory()) {
    return failStore("unexpected_file", `${name} must be a directory`);
  }
  return okStore({ absPath });
}

function walkDestFileSlot(
  destRoot: string,
  posixRel: string,
): RuntimeStoreResult<{ absPath: string }> {
  let current = resolve(destRoot);
  const segments = posixSegments(posixRel);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      return failStore("path_escape", "path must not contain empty, '.', or '..' segments");
    }
    const next = join(current, segment);
    if (!isInsideRoot(destRoot, next)) {
      return failStore("path_escape", "path escapes runtime root");
    }
    const exists = fileExistsLstat(next);
    if (!exists.ok) {
      return exists;
    }
    const isLast = index === segments.length - 1;
    if (isLast) {
      if (exists.exists) {
        return failStore("unexpected_file", `destination already exists: ${posixRel}`);
      }
      return okStore({ absPath: next });
    }
    if (!exists.exists || !exists.stat) {
      return failStore("missing_file", `destination directory is missing: ${posixRel}`);
    }
    if (exists.stat.isSymbolicLink()) {
      return failStore("symlink_forbidden", `symlink is not allowed: ${posixRel}`);
    }
    if (!exists.stat.isDirectory()) {
      return failStore("unexpected_file", `not a directory: ${posixRel}`);
    }
    current = next;
  }
  return failStore("path_escape", "destination path is invalid");
}

function copyAllowlist(input: {
  sourceRoot: string;
  destRoot: string;
  manifest: RuntimeManifest;
  enforceExecutableBit: boolean;
  hooks?: StagingHooks;
}): RuntimeStoreResult<RuntimeUnit> {
  for (const entry of input.manifest.files) {
    if (input.hooks?.failCopyOf === entry.path) {
      return failStore("io_error", `copy failed: ${entry.path}`);
    }
    const source = containedLookup(input.sourceRoot, entry.path);
    if (!source.ok) {
      return source;
    }
    if (source.stat.isSymbolicLink()) {
      return failStore("symlink_forbidden", `symlink is not allowed: ${entry.path}`);
    }
    if (!source.stat.isFile()) {
      return failStore("unexpected_file", `not a regular file: ${entry.path}`);
    }
    const parent = ensureParentDir(input.destRoot, entry.path);
    if (!parent.ok) {
      return parent;
    }
    const dest = walkDestFileSlot(input.destRoot, entry.path);
    if (!dest.ok) {
      return dest;
    }
    try {
      copyFileSync(source.absPath, dest.absPath);
    } catch (error) {
      return ioError(error);
    }
    const destStat = fileExistsLstat(dest.absPath);
    if (!destStat.ok) {
      return destStat;
    }
    if (!destStat.exists || !destStat.stat) {
      return failStore("missing_file", `copy failed: ${entry.path}`);
    }
    if (destStat.stat.isSymbolicLink()) {
      return failStore("symlink_forbidden", `symlink is not allowed: ${entry.path}`);
    }
    if (!destStat.stat.isFile()) {
      return failStore("unexpected_file", `not a regular file: ${entry.path}`);
    }
    const mode = applyExecutableBit(dest.absPath, entry.executable, input.enforceExecutableBit);
    if (!mode.ok) {
      return mode;
    }
    if (input.hooks?.afterCopyFile) {
      input.hooks.afterCopyFile(entry.path);
    }
  }
  const written = writeRuntimeManifestFile(input.destRoot, input.manifest);
  if (!written.ok) {
    return written;
  }
  return okUnit();
}

function stageRuntimeLocked(input: StageRuntimeInput): RuntimeStoreResult<StageRuntimeSuccess> {
  const stable = ensureStableRoot(input.stableRoot);
  if (!stable.ok) {
    return stable;
  }
  const source = realpathRoot(input.sourceRoot);
  if (!source.ok) {
    return source;
  }
  const sourceRoot = source.root;
  const enforceExecutableBit = input.enforceExecutableBit ?? defaultEnforceExecutableBit();
  const loaded = loadSourceManifest(sourceRoot, input.expectedTarget, input.manifest);
  if (!loaded.ok) {
    return loaded;
  }
  const manifest = loaded.manifest;
  const sourceVerified = verifyRuntimeTree(sourceRoot, manifest, {
    expectedTarget: input.expectedTarget,
    enforceExecutableBit,
    allowManifestFile: true,
  });
  if (!sourceVerified.ok) {
    return sourceVerified;
  }

  const stagingDir = ensureStableChildDir(stable.root, STABLE_STAGING_DIR);
  if (!stagingDir.ok) {
    return stagingDir;
  }
  const versionsDir = ensureStableChildDir(stable.root, STABLE_VERSIONS_DIR);
  if (!versionsDir.ok) {
    return versionsDir;
  }

  const staged = versionPointerFromManifest(manifest);
  const finalAbs = versionAbsPath(stable.root, staged.version);
  const pointer = readCurrentPointer(stable.root);
  if (!pointer.ok) {
    return pointer;
  }
  const live = liveRelPaths(pointer.pointer);
  const existing = fileExistsLstat(finalAbs);
  if (!existing.ok) {
    return existing;
  }
  if (existing.exists) {
    if (existing.stat?.isSymbolicLink()) {
      return failStore("symlink_forbidden", "version directory must not be a symlink");
    }
    const reused = verifyStagedVersion(finalAbs, staged, input.expectedTarget, enforceExecutableBit);
    if (reused.ok) {
      return okStore({
        staged,
        absPath: finalAbs,
        reused: true,
        manifest: reused.manifest,
      });
    }
    if (live.has(staged.relPath)) {
      return failStore("version_in_use", "cannot replace a live current or rollback generation");
    }
    if (input.isVersionReferenced?.(staged.relPath, finalAbs)) {
      return failStore("version_in_use", "cannot replace a referenced runtime generation");
    }
    const removed = removeTree(finalAbs);
    if (!removed.ok) {
      return removed;
    }
  }

  const tempRel = `${STABLE_STAGING_DIR}/${staged.version}-${randomBytes(8).toString("hex")}`;
  const tempDir = mkdirContained(stable.root, tempRel);
  if (!tempDir.ok) {
    return tempDir;
  }
  const tempAbs = tempDir.absPath;
  let renamed = false;
  try {
    const copied = copyAllowlist({
      sourceRoot,
      destRoot: tempAbs,
      manifest,
      enforceExecutableBit,
      hooks: input.hooks,
    });
    if (!copied.ok) {
      return copied;
    }
    const destVerified = verifyRuntimeTree(tempAbs, manifest, {
      expectedTarget: input.expectedTarget,
      enforceExecutableBit,
      allowManifestFile: true,
    });
    if (!destVerified.ok) {
      return destVerified;
    }
    input.hooks?.beforeRenameStage?.(tempAbs);
    const stagingOk = assertStableChildDir(stable.root, STABLE_STAGING_DIR);
    if (!stagingOk.ok) {
      return stagingOk;
    }
    const versionsOk = assertStableChildDir(stable.root, STABLE_VERSIONS_DIR);
    if (!versionsOk.ok) {
      return versionsOk;
    }
    const tempStat = fileExistsLstat(tempAbs);
    if (!tempStat.ok) {
      return tempStat;
    }
    if (!tempStat.exists || !tempStat.stat || tempStat.stat.isSymbolicLink() || !tempStat.stat.isDirectory()) {
      return failStore("symlink_forbidden", "staging directory must not be a symlink");
    }
    const destExists = fileExistsLstat(finalAbs);
    if (!destExists.ok) {
      return destExists;
    }
    if (destExists.exists) {
      if (destExists.stat?.isSymbolicLink()) {
        return failStore("symlink_forbidden", "version directory must not be a symlink");
      }
      return failStore("unexpected_file", "version destination already exists");
    }
    renameSync(tempAbs, finalAbs);
    const publishedDir = fileExistsLstat(finalAbs);
    if (!publishedDir.ok) {
      return publishedDir;
    }
    if (!publishedDir.exists || publishedDir.stat?.isSymbolicLink() || !publishedDir.stat?.isDirectory()) {
      return failStore("symlink_forbidden", "version directory must not be a symlink");
    }
    if (!isInsideRoot(stable.root, finalAbs)) {
      return failStore("path_escape", "version directory escapes the stable root");
    }
    renamed = true;
    return okStore({
      staged,
      absPath: finalAbs,
      reused: false,
      manifest,
    });
  } catch (error) {
    return ioError(error);
  } finally {
    if (!renamed) {
      removeTree(tempAbs);
    }
  }
}

function renameReplacingFile(tmpPath: string, destPath: string): RuntimeStoreResult<RuntimeUnit> {
  const retries = process.platform === "win32" ? 2 : 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmpPath, destPath);
      return okUnit();
    } catch (error) {
      const code = fileErrorCode(error);
      const transient =
        process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      if (!transient || attempt >= retries) {
        return ioError(error);
      }
      Bun.sleepSync(25 * (attempt + 1));
    }
  }
}

function writeCurrentPointerAtomic(
  stableRoot: string,
  pointer: CurrentPointer,
  hooks?: StagingHooks,
): RuntimeStoreResult<RuntimeUnit> {
  const dest = currentPointerPath(stableRoot);
  const tmp = join(stableRoot, `${CURRENT_POINTER_NAME}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, serializeCurrentPointer(pointer), { encoding: "utf8", flag: "wx" });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    unlinkIfRegularFile(tmp);
    return ioError(error);
  }
  const destExists = fileExistsLstat(dest);
  if (!destExists.ok) {
    unlinkIfRegularFile(tmp);
    return destExists;
  }
  if (destExists.exists && destExists.stat?.isSymbolicLink()) {
    unlinkIfRegularFile(tmp);
    return failStore("symlink_forbidden", "current.json must not be a symlink");
  }
  if (destExists.exists && destExists.stat && !destExists.stat.isFile()) {
    unlinkIfRegularFile(tmp);
    return failStore("invalid_pointer", "current.json must be a regular file");
  }
  // A valid current.json is never unlinked before the replacement is published.
  hooks?.beforeCurrentRename?.();
  if (hooks?.failCurrentRename) {
    unlinkIfRegularFile(tmp);
    return failStore("io_error", "current.json replace failed");
  }
  const renamed = renameReplacingFile(tmp, dest);
  if (!renamed.ok) {
    unlinkIfRegularFile(tmp);
    return renamed;
  }
  return okUnit();
}

type PruneCandidate = { relPath: string; absPath: string };

function planPruneGenerations(input: {
  stableRoot: string;
  pointer: CurrentPointer;
  isVersionReferenced?: VersionReferenceGuard;
}): RuntimeStoreResult<{ prune: PruneCandidate[]; retained: string[] }> {
  const versionsRoot = join(input.stableRoot, STABLE_VERSIONS_DIR);
  const exists = fileExistsLstat(versionsRoot);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists) {
    return okStore({ prune: [], retained: [] });
  }
  if (exists.stat?.isSymbolicLink()) {
    return failStore("symlink_forbidden", "versions directory must not be a symlink");
  }
  if (!exists.stat?.isDirectory()) {
    return failStore("unexpected_file", "versions must be a directory");
  }
  let names: string[];
  try {
    names = readdirSync(versionsRoot);
  } catch (error) {
    return ioError(error);
  }
  const keep = liveRelPaths(input.pointer);
  const prune: PruneCandidate[] = [];
  const retained: string[] = [];
  for (const name of names) {
    const relPath = `${STABLE_VERSIONS_DIR}/${name}`;
    const absPath = join(versionsRoot, name);
    if (keep.has(relPath)) {
      continue;
    }
    const child = fileExistsLstat(absPath);
    if (!child.ok) {
      return child;
    }
    if (child.stat?.isSymbolicLink()) {
      return failStore("symlink_forbidden", `version directory must not be a symlink: ${relPath}`);
    }
    if (input.isVersionReferenced?.(relPath, absPath)) {
      retained.push(relPath);
      continue;
    }
    prune.push({ relPath, absPath });
  }
  return okStore({ prune, retained });
}

function executePrunePlan(plan: {
  prune: PruneCandidate[];
  retained: string[];
}): RuntimeStoreResult<{ pruned: string[]; retained: string[] }> {
  const pruned: string[] = [];
  const retained = [...plan.retained];
  for (const candidate of plan.prune) {
    const child = fileExistsLstat(candidate.absPath);
    if (!child.ok || !child.exists) {
      if (child.ok) {
        continue;
      }
      retained.push(candidate.relPath);
      continue;
    }
    if (child.stat?.isSymbolicLink()) {
      retained.push(candidate.relPath);
      continue;
    }
    const removed = removeTree(candidate.absPath);
    if (!removed.ok) {
      retained.push(candidate.relPath);
      continue;
    }
    pruned.push(candidate.relPath);
  }
  return okStore({ pruned, retained });
}

function pruneUnreferencedGenerations(input: {
  stableRoot: string;
  pointer: CurrentPointer;
  isVersionReferenced?: VersionReferenceGuard;
}): RuntimeStoreResult<{ pruned: string[]; retained: string[] }> {
  const plan = planPruneGenerations(input);
  if (!plan.ok) {
    return plan;
  }
  return executePrunePlan(plan);
}

function publishCurrentLocked(input: PublishCurrentInput): RuntimeStoreResult<PublishCurrentSuccess> {
  const stable = ensureStableRoot(input.stableRoot);
  if (!stable.ok) {
    return stable;
  }
  const enforceExecutableBit = input.enforceExecutableBit ?? defaultEnforceExecutableBit();
  const observed = readCurrentPointer(stable.root);
  if (!observed.ok) {
    return observed;
  }
  if (!pointersEqual(observed.pointer?.current ?? null, input.expectedCurrent)) {
    return failStore("cas_mismatch", "current.json does not match the expected pointer");
  }
  input.hooks?.beforePublish?.();
  const absPath = versionAbsPath(stable.root, input.staged.version);
  const verified = verifyStagedVersion(absPath, input.staged, input.expectedTarget, enforceExecutableBit);
  if (!verified.ok) {
    return verified;
  }
  const incoming = versionPointerFromManifest(verified.manifest);
  if (observed.pointer && pointersEqual(observed.pointer.current, incoming)) {
    const pruned = pruneUnreferencedGenerations({
      stableRoot: stable.root,
      pointer: observed.pointer,
      isVersionReferenced: input.isVersionReferenced,
    });
    if (!pruned.ok) {
      return pruned;
    }
    return okStore({ pointer: observed.pointer, pruned: pruned.pruned, retained: pruned.retained });
  }
  const next: CurrentPointer = {
    schemaVersion: 1,
    current: incoming,
    previous: observed.pointer ? observed.pointer.current : null,
  };
  const plan = planPruneGenerations({
    stableRoot: stable.root,
    pointer: next,
    isVersionReferenced: input.isVersionReferenced,
  });
  if (!plan.ok) {
    return plan;
  }
  const written = writeCurrentPointerAtomic(stable.root, next, input.hooks);
  if (!written.ok) {
    return written;
  }
  const pruned = executePrunePlan(plan);
  if (!pruned.ok) {
    return okStore({
      pointer: next,
      pruned: [],
      retained: [...plan.retained, ...plan.prune.map((item) => item.relPath)],
    });
  }
  return okStore({ pointer: next, pruned: pruned.pruned, retained: pruned.retained });
}

function rollbackCurrentLocked(input: RollbackCurrentInput): RuntimeStoreResult<PublishCurrentSuccess> {
  const stable = ensureStableRoot(input.stableRoot);
  if (!stable.ok) {
    return stable;
  }
  const enforceExecutableBit = input.enforceExecutableBit ?? defaultEnforceExecutableBit();
  const observed = readCurrentPointer(stable.root);
  if (!observed.ok) {
    return observed;
  }
  if (!observed.pointer) {
    return failStore("rollback_unavailable", "no current runtime is published");
  }
  if (!pointersEqual(observed.pointer.current, input.expectedCurrent)) {
    return failStore("cas_mismatch", "current.json does not match the expected pointer");
  }
  if (!observed.pointer.previous) {
    return failStore("rollback_unavailable", "no rollback generation is available");
  }
  const previousAbs = versionAbsPath(stable.root, observed.pointer.previous.version);
  const verified = verifyStagedVersion(
    previousAbs,
    observed.pointer.previous,
    input.expectedTarget,
    enforceExecutableBit,
  );
  if (!verified.ok) {
    return verified;
  }
  const next: CurrentPointer = {
    schemaVersion: 1,
    current: versionPointerFromManifest(verified.manifest),
    previous: observed.pointer.current,
  };
  const plan = planPruneGenerations({
    stableRoot: stable.root,
    pointer: next,
    isVersionReferenced: input.isVersionReferenced,
  });
  if (!plan.ok) {
    return plan;
  }
  const written = writeCurrentPointerAtomic(stable.root, next, input.hooks);
  if (!written.ok) {
    return written;
  }
  const pruned = executePrunePlan(plan);
  if (!pruned.ok) {
    return okStore({
      pointer: next,
      pruned: [],
      retained: [...plan.retained, ...plan.prune.map((item) => item.relPath)],
    });
  }
  return okStore({ pointer: next, pruned: pruned.pruned, retained: pruned.retained });
}

export function stageRuntime(input: StageRuntimeInput): RuntimeStoreResult<StageRuntimeSuccess> {
  return withStoreLock(input.stableRoot, input.hooks, () => stageRuntimeLocked(input));
}

export function publishCurrent(input: PublishCurrentInput): RuntimeStoreResult<PublishCurrentSuccess> {
  return withStoreLock(input.stableRoot, input.hooks, () => publishCurrentLocked(input));
}

export function rollbackCurrent(input: RollbackCurrentInput): RuntimeStoreResult<PublishCurrentSuccess> {
  return withStoreLock(input.stableRoot, input.hooks, () => rollbackCurrentLocked(input));
}

export function activateRuntime(input: ActivateRuntimeInput): RuntimeStoreResult<ActivateRuntimeSuccess> {
  return withStoreLock(input.stableRoot, input.hooks, () => {
    const staged = stageRuntimeLocked(input);
    if (!staged.ok) {
      return staged;
    }
    const published = publishCurrentLocked({
      stableRoot: input.stableRoot,
      staged: staged.staged,
      expectedCurrent: input.expectedCurrent,
      expectedTarget: input.expectedTarget,
      enforceExecutableBit: input.enforceExecutableBit,
      isVersionReferenced: input.isVersionReferenced,
      hooks: input.hooks,
    });
    if (!published.ok) {
      return published;
    }
    return okStore({
      staged: staged.staged,
      absPath: staged.absPath,
      reused: staged.reused,
      manifest: staged.manifest,
      pointer: published.pointer,
      pruned: published.pruned,
      retained: published.retained,
    });
  });
}

export function resolveRuntimeByManifestId(
  input: ResolveRuntimeInput,
): RuntimeStoreResult<{ pointer: VersionPointer; absPath: string; manifest: RuntimeManifest }> {
  const stable = ensureStableRoot(input.stableRoot);
  if (!stable.ok) {
    return stable;
  }
  if (!isManifestId(input.manifestId)) {
    return failStore("invalid_manifest", "invalid id");
  }
  const versionsRoot = join(stable.root, STABLE_VERSIONS_DIR);
  const exists = fileExistsLstat(versionsRoot);
  if (!exists.ok) {
    return exists;
  }
  if (!exists.exists) {
    return failStore("missing_file", "no staged runtime matches the manifest id");
  }
  if (exists.stat?.isSymbolicLink()) {
    return failStore("symlink_forbidden", "versions directory must not be a symlink");
  }
  let names: string[];
  try {
    names = readdirSync(versionsRoot);
  } catch (error) {
    return ioError(error);
  }
  const matches: Array<{ pointer: VersionPointer; absPath: string; manifest: RuntimeManifest }> = [];
  const enforceExecutableBit = input.enforceExecutableBit ?? defaultEnforceExecutableBit();
  for (const name of names) {
    const absPath = join(versionsRoot, name);
    const child = fileExistsLstat(absPath);
    if (!child.ok) {
      return child;
    }
    if (child.stat?.isSymbolicLink()) {
      return failStore("symlink_forbidden", `version directory must not be a symlink: ${name}`);
    }
    if (!child.stat?.isDirectory()) {
      continue;
    }
    const loaded = readRuntimeManifestFile(join(absPath, MANIFEST_FILE_NAME), {
      expectedTarget: input.expectedTarget,
    });
    if (!loaded.ok) {
      if (loaded.code === "missing_file") {
        continue;
      }
      return loaded;
    }
    if (loaded.manifest.id !== input.manifestId) {
      continue;
    }
    const verified = verifyRuntimeTree(absPath, loaded.manifest, {
      expectedTarget: input.expectedTarget,
      enforceExecutableBit,
      allowManifestFile: true,
    });
    if (!verified.ok) {
      return verified;
    }
    matches.push({
      pointer: versionPointerFromManifest(loaded.manifest),
      absPath,
      manifest: loaded.manifest,
    });
  }
  if (matches.length === 0) {
    return failStore("missing_file", "no staged runtime matches the manifest id");
  }
  if (matches.length > 1) {
    return failStore("ambiguous_manifest_id", "multiple staged trees share this id");
  }
  const match = matches[0];
  if (!match) {
    return failStore("missing_file", "no staged runtime matches the manifest id");
  }
  return okStore(match);
}

export function verifyPublishedCurrent(
  stableRoot: string,
  options: { expectedTarget?: TargetTriple; enforceExecutableBit?: boolean } = {},
): RuntimeStoreResult<{ pointer: CurrentPointer; absPath: string; manifest: RuntimeManifest }> {
  const observed = readCurrentPointer(stableRoot);
  if (!observed.ok) {
    return observed;
  }
  if (!observed.pointer) {
    return failStore("invalid_pointer", "no current runtime is published");
  }
  const absPath = versionAbsPath(resolve(stableRoot), observed.pointer.current.version);
  const verified = verifyStagedVersion(
    absPath,
    observed.pointer.current,
    options.expectedTarget ?? observed.pointer.current.target,
    options.enforceExecutableBit ?? defaultEnforceExecutableBit(),
  );
  if (!verified.ok) {
    return verified;
  }
  return okStore({ pointer: observed.pointer, absPath, manifest: verified.manifest });
}
