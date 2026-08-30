/**
 * Cross-process Desktop activation lock.
 *
 * Held across the full async service/direct transaction (snapshot → stop →
 * install/repair/start/uninstall → ready → publish/rollback). A module-local
 * Promise mutex cannot serialize two bridge processes, so this is a directory
 * lock with an owner-token record, live-PID check, and compare-before-reclaim.
 *
 * The lock lives at `<stableRoot>/activation.lock`, never under homedir or
 * OPENCODEX_HOME. It is distinct from `current.lock` (sync store ops) and the
 * start lock (OPENCODEX_HOME; the Desktop bridge must not hold that).
 *
 * WATCH: this lock duplicates the cross-process owner-token/PID/compare-before-reclaim
 * pattern of the start lock. Keep them distinct; do not merge activation.lock into
 * the start lock in this change. The Desktop bridge must not hold the start lock.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertNotRealHomeUnderTest } from "../../src/lib/test-home-guard";
import { DeadlineExceededError } from "./deadline";

export const ACTIVATION_LOCK_DIR_NAME = "activation.lock";
export const ACTIVATION_LOCK_WAIT_TIMEOUT_MS = 120_000;
export const ACTIVATION_LOCK_POLL_INTERVAL_MS = 50;
export const ACTIVATION_LOCK_INCOMPLETE_GRACE_MS = 5_000;
const ACTIVATION_LOCK_OWNER_MAX_BYTES = 4096;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export type ActivationLockRecord = {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
};

export type ActivationLockHandle = {
  readonly token: string;
  readonly pid: number;
  readonly lockPath: string;
  readonly ownerPath: string;
  release(): void;
};

export type ActivationLockOptions = {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  pid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  randomToken?: () => string;
  signal?: AbortSignal;
  beforeStaleReclaim?: () => void;
  beforeIncompleteReclaim?: () => void;
  beforeReleaseUnlink?: () => void;
};

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type ActivationLockSnapshot = {
  record: ActivationLockRecord;
  ownerPath: string;
  lockIdentity: Pick<Stats, "dev" | "ino">;
  ownerIdentity: FileIdentity;
};

type IncompleteActivationLockSnapshot = {
  lockIdentity: FileIdentity;
  owner: { name: string; path: string; identity: FileIdentity } | null;
  newestMtimeMs: number;
};

export class ActivationLockTimeoutError extends Error {
  readonly code = "ACTIVATION_LOCK_TIMEOUT" as const;

  constructor(waitTimeoutMs: number, options?: ErrorOptions) {
    super(`Timed out after ${waitTimeoutMs}ms waiting for the Desktop activation lock`, options);
    this.name = "ActivationLockTimeoutError";
  }
}

export function activationLockPath(stableRoot: string): string {
  if (typeof stableRoot !== "string" || stableRoot.length === 0 || !isAbsolute(stableRoot)) {
    throw new RangeError("activation lock stableRoot must be an absolute path");
  }
  return join(resolve(stableRoot), ACTIVATION_LOCK_DIR_NAME);
}

export type ActivationLockObservation =
  | { state: "absent" }
  | { state: "live"; pid: number; token: string }
  | { state: "stale"; pid: number; token: string }
  | { state: "incomplete" };

/**
 * Non-mutating lock observation. Status uses this instead of waiting. A live
 * holder means activation is in flight; stale/incomplete means bootstrap may
 * reclaim under acquireActivationLock. Never waits on the start lock.
 */
export function observeActivationLock(
  stableRoot: string,
  options?: { isAlive?: (pid: number) => boolean },
): ActivationLockObservation {
  if (typeof stableRoot !== "string" || stableRoot.length === 0 || !isAbsolute(stableRoot)) {
    return { state: "absent" };
  }
  const lockPath = join(resolve(stableRoot), ACTIVATION_LOCK_DIR_NAME);
  let lockStat: Stats;
  try {
    lockStat = lstatSync(lockPath);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return { state: "absent" };
    return { state: "incomplete" };
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) return { state: "incomplete" };
  const complete = readActivationLockSnapshot(lockPath);
  if (complete) {
    const isAlive = options?.isAlive ?? defaultIsAlive;
    if (isAlive(complete.record.pid)) {
      return { state: "live", pid: complete.record.pid, token: complete.record.token };
    }
    return { state: "stale", pid: complete.record.pid, token: complete.record.token };
  }
  if (readIncompleteActivationLockSnapshot(lockPath)) return { state: "incomplete" };
  return { state: "absent" };
}

export async function withActivationLock<T>(
  stableRoot: string,
  work: (handle: ActivationLockHandle) => Promise<T>,
  options?: ActivationLockOptions,
): Promise<T> {
  const handle = await acquireActivationLock(stableRoot, options);
  try {
    return await work(handle);
  } finally {
    handle.release();
  }
}

export async function acquireActivationLock(
  stableRoot: string,
  options: ActivationLockOptions = {},
): Promise<ActivationLockHandle> {
  const waitTimeoutMs = options.waitTimeoutMs ?? ACTIVATION_LOCK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ACTIVATION_LOCK_POLL_INTERVAL_MS;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new RangeError("activation lock waitTimeoutMs must be a non-negative number");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("activation lock pollIntervalMs must be a non-negative number");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("activation lock pid must be a positive safe integer");
  }

  const lockPath = activationLockPath(stableRoot);
  assertNotRealHomeUnderTest(lockPath);
  ensureStableRootExists(stableRoot);
  const started = now();

  for (;;) {
    if (options.signal?.aborted) throw new DeadlineExceededError();
    const handle = tryClaimActivationLock(lockPath, {
      pid,
      now,
      randomToken: options.randomToken,
      beforeReleaseUnlink: options.beforeReleaseUnlink,
    });
    if (handle) return handle;
    if (reclaimStaleActivationLock(lockPath, isAlive, options.beforeStaleReclaim)) continue;
    if (reclaimIncompleteActivationLock(lockPath, now(), options.beforeIncompleteReclaim)) continue;
    const elapsed = now() - started;
    if (elapsed >= waitTimeoutMs) throw new ActivationLockTimeoutError(waitTimeoutMs);
    await sleep(Math.min(waitTimeoutMs - elapsed, pollIntervalMs));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileErrorCode(error) !== "ESRCH";
  }
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameFileIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOwnerIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sameActivationLock(left: ActivationLockSnapshot, right: ActivationLockSnapshot): boolean {
  return left.record.token === right.record.token
    && left.record.pid === right.record.pid
    && left.record.createdAt === right.record.createdAt
    && sameFileIdentity(left.lockIdentity, right.lockIdentity)
    && sameOwnerIdentity(left.ownerIdentity, right.ownerIdentity);
}

function sameIncompleteActivationLock(
  left: IncompleteActivationLockSnapshot,
  right: IncompleteActivationLockSnapshot,
): boolean {
  if (!sameOwnerIdentity(left.lockIdentity, right.lockIdentity)) return false;
  if (left.owner === null || right.owner === null) return left.owner === right.owner;
  return left.owner.name === right.owner.name
    && sameOwnerIdentity(left.owner.identity, right.owner.identity);
}

function fileIdentityFromStats(stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function isSafeLockDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function isSafeOwnerFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= ACTIVATION_LOCK_OWNER_MAX_BYTES;
}

function parseOwnerRecord(raw: string): ActivationLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ActivationLockRecord>;
    if (value.version !== 1
      || typeof value.token !== "string"
      || !TOKEN_PATTERN.test(value.token)
      || typeof value.pid !== "number"
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || typeof value.createdAt !== "number"
      || !Number.isFinite(value.createdAt)) {
      return null;
    }
    return { version: 1, token: value.token, pid: value.pid, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function readActivationLockSnapshot(lockPath: string): ActivationLockSnapshot | null {
  let lockIdentity: Stats;
  let entries: string[];
  try {
    lockIdentity = lstatSync(lockPath);
    if (!isSafeLockDirectory(lockIdentity)) return null;
    entries = readdirSync(lockPath);
  } catch {
    return null;
  }
  if (entries.length !== 1 || !entries[0]!.endsWith(".json")) return null;
  const ownerPath = join(lockPath, entries[0]!);
  let before: Stats;
  let bytes: string;
  try {
    before = lstatSync(ownerPath);
    if (!isSafeOwnerFile(before)) return null;
    bytes = readFileSync(ownerPath, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(bytes, "utf8") !== before.size) return null;
  const record = parseOwnerRecord(bytes);
  if (!record || entries[0] !== `${record.token}.json`) return null;
  try {
    const afterOwner = lstatSync(ownerPath);
    const afterLock = lstatSync(lockPath);
    if (!isSafeOwnerFile(afterOwner) || !sameOwnerIdentity(fileIdentityFromStats(before), fileIdentityFromStats(afterOwner))) {
      return null;
    }
    if (!isSafeLockDirectory(afterLock) || !sameFileIdentity(lockIdentity, afterLock)) return null;
    return {
      record,
      ownerPath,
      lockIdentity: { dev: lockIdentity.dev, ino: lockIdentity.ino },
      ownerIdentity: fileIdentityFromStats(afterOwner),
    };
  } catch {
    return null;
  }
}

function readIncompleteActivationLockSnapshot(lockPath: string): IncompleteActivationLockSnapshot | null {
  if (readActivationLockSnapshot(lockPath)) return null;

  let lockStat: Stats;
  let entries: string[];
  try {
    lockStat = lstatSync(lockPath);
    if (!isSafeLockDirectory(lockStat)) return null;
    entries = readdirSync(lockPath);
  } catch {
    return null;
  }
  if (entries.length > 1) return null;
  const lockIdentity = fileIdentityFromStats(lockStat);
  if (entries.length === 0) {
    return { lockIdentity, owner: null, newestMtimeMs: lockStat.mtimeMs };
  }

  const name = entries[0]!;
  if (!name.endsWith(".json") || !TOKEN_PATTERN.test(name.slice(0, -5))) return null;
  const path = join(lockPath, name);
  try {
    const ownerStat = lstatSync(path);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > ACTIVATION_LOCK_OWNER_MAX_BYTES) {
      return null;
    }
    return {
      lockIdentity,
      owner: { name, path, identity: fileIdentityFromStats(ownerStat) },
      newestMtimeMs: Math.max(lockStat.mtimeMs, ownerStat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function ensureStableRootExists(stableRoot: string): void {
  const resolved = resolve(stableRoot);
  assertNotRealHomeUnderTest(resolved);
  let stat: Stats;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new RangeError("activation lock stableRoot must exist as a directory");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RangeError("activation lock stableRoot must exist as a directory");
  }
}

function makeToken(pid: number, now: () => number, randomToken?: () => string): string {
  const token = randomToken?.() ?? `${pid}-${now()}-${randomUUID()}`;
  if (!TOKEN_PATTERN.test(token)) {
    throw new RangeError("activation lock token must be a 1..128 character [A-Za-z0-9._-] value");
  }
  return token;
}

function tryClaimActivationLock(
  lockPath: string,
  options: {
    pid: number;
    now: () => number;
    randomToken?: () => string;
    beforeReleaseUnlink?: () => void;
  },
): ActivationLockHandle | null {
  const record: ActivationLockRecord = {
    version: 1,
    token: makeToken(options.pid, options.now, options.randomToken),
    pid: options.pid,
    createdAt: options.now(),
  };
  const ownerPath = join(lockPath, `${record.token}.json`);
  let fd: number | null = null;
  let identity: FileIdentity | null = null;
  let createdDirectory = false;

  try {
    mkdirSync(lockPath, { mode: 0o700 });
    createdDirectory = true;
    try { chmodSync(lockPath, 0o700); } catch { /* best-effort owner-only mode */ }
    fd = openSync(ownerPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    identity = fileIdentityFromStats(fstatSync(fd));
    const owned = readActivationLockSnapshot(lockPath);
    if (!owned || owned.record.token !== record.token || !sameOwnerIdentity(identity, owned.ownerIdentity)) {
      throw new Error("activation lock changed during owner publication");
    }
    let released = false;
    const claimedFd = fd;
    fd = null;
    return {
      token: record.token,
      pid: record.pid,
      lockPath,
      ownerPath,
      release(): void {
        if (released) return;
        released = true;
        try { closeSync(claimedFd); } catch { /* stale recovery handles an uncertain lock */ }
        try {
          const current = readActivationLockSnapshot(lockPath);
          if (!identity || !current || current.record.token !== record.token
            || !sameOwnerIdentity(identity, current.ownerIdentity)) {
            return;
          }
          options.beforeReleaseUnlink?.();
          const confirmed = readActivationLockSnapshot(lockPath);
          if (!confirmed || !sameActivationLock(current, confirmed) || confirmed.record.token !== record.token) {
            return;
          }
          unlinkSync(ownerPath);
          rmdirSync(lockPath);
        } catch { /* stale recovery handles release failures */ }
      },
    };
  } catch (error) {
    discardClaim(lockPath, ownerPath, record, identity, createdDirectory, fd);
    if (fileErrorCode(error) !== "EEXIST") throw error;
    return null;
  }
}

function discardClaim(
  lockPath: string,
  ownerPath: string,
  record: ActivationLockRecord,
  identity: FileIdentity | null,
  createdDirectory: boolean,
  fd: number | null,
): void {
  if (fd !== null) {
    try { closeSync(fd); } catch { /* best-effort close before ownership cleanup */ }
  }
  try {
    const current = readActivationLockSnapshot(lockPath);
    if (identity && current && current.record.token === record.token
      && sameOwnerIdentity(identity, current.ownerIdentity)) {
      unlinkSync(ownerPath);
      rmdirSync(lockPath);
      return;
    }
  } catch { /* fall through to token-qualified cleanup of a dir we created */ }
  if (!createdDirectory) return;
  try { unlinkSync(ownerPath); } catch { /* token-named path only */ }
  try { rmdirSync(lockPath); } catch { /* another owner exists or cleanup is uncertain */ }
}

function reclaimIncompleteActivationLock(
  lockPath: string,
  nowMs: number,
  beforeIncompleteReclaim?: () => void,
): boolean {
  const observed = readIncompleteActivationLockSnapshot(lockPath);
  if (!observed || nowMs - observed.newestMtimeMs < ACTIVATION_LOCK_INCOMPLETE_GRACE_MS) return false;
  const current = readIncompleteActivationLockSnapshot(lockPath);
  if (!current || !sameIncompleteActivationLock(observed, current)) return false;
  beforeIncompleteReclaim?.();
  try {
    const confirmed = readIncompleteActivationLockSnapshot(lockPath);
    if (!confirmed || !sameIncompleteActivationLock(current, confirmed)) return false;
    if (confirmed.owner) unlinkSync(confirmed.owner.path);
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function reclaimStaleActivationLock(
  lockPath: string,
  isAlive: (pid: number) => boolean,
  beforeStaleReclaim?: () => void,
): boolean {
  const observed = readActivationLockSnapshot(lockPath);
  if (!observed) return false;
  if (isAlive(observed.record.pid)) return false;
  const current = readActivationLockSnapshot(lockPath);
  if (!current || !sameActivationLock(observed, current)) return false;
  beforeStaleReclaim?.();
  try {
    const confirmed = readActivationLockSnapshot(lockPath);
    if (!confirmed || !sameActivationLock(current, confirmed)) return false;
    unlinkSync(observed.ownerPath);
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
