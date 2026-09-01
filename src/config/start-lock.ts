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
import { join } from "node:path";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { getConfigDir, hardenConfigDir } from "./paths";

const START_LOCK_DIR_NAME = "ocx.start.lock";
const START_LOCK_OWNER_MAX_BYTES = 4096;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Hard-pinned `--port` reclaim in `chooseListenPort`. A start that holds the
 * transaction lock can spend this long waiting for a ghost LISTEN row before
 * bind, so waiters must outlast it.
 */
export const PINNED_PORT_RECLAIM_TIMEOUT_MS = 60_000;
/** Hard-pin prefer-retry after reclaim, before refusing the pinned port. */
export const PINNED_PORT_PREFER_RETRY_MS = 5_000;
/** EADDRINUSE retry while holding the lock for an explicit `--port`. */
export const PINNED_PORT_BIND_RETRY_MS = 3_000;
/**
 * Owner rediscovery, bind, and PID/runtime publication after the listen port is
 * free. Kept separate from reclaim so the wait budget cannot shrink below the
 * 60s reclaim by accident.
 */
export const START_LOCK_PUBLISH_SLACK_MS = 15_000;
/**
 * A contender can observe the canonical directory between mkdir and the
 * complete owner record. Never reclaim that incomplete publication
 * immediately; a crashed publisher is recoverable only after this grace.
 */
export const START_LOCK_INCOMPLETE_GRACE_MS = 30_000;

/**
 * Default waiter budget for `acquireStartLock` / `withStartLock`.
 *
 * A holder doing `ocx start --port` can occupy the lock for pinned-port reclaim
 * plus prefer-retry, one bind retry, and publication. Waiters that expire
 * earlier would time out while a legitimate start is still reclaiming.
 */
export const START_LOCK_WAIT_TIMEOUT_MS =
  PINNED_PORT_RECLAIM_TIMEOUT_MS
  + PINNED_PORT_PREFER_RETRY_MS
  + PINNED_PORT_BIND_RETRY_MS
  + START_LOCK_PUBLISH_SLACK_MS;
export const START_LOCK_POLL_INTERVAL_MS = 50;

export type StartLockRecord = {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
};

export type StartLockHandle = {
  readonly token: string;
  readonly pid: number;
  readonly lockPath: string;
  readonly ownerPath: string;
  release(): void;
};

export type StartLockOptions = {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  pid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  randomToken?: () => string;
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

type StartLockSnapshot = {
  record: StartLockRecord;
  ownerPath: string;
  lockIdentity: Pick<Stats, "dev" | "ino">;
  ownerIdentity: FileIdentity;
};

type IncompleteStartLockSnapshot = {
  lockIdentity: FileIdentity;
  owner: { name: string; path: string; identity: FileIdentity } | null;
  newestMtimeMs: number;
};

export class StartLockTimeoutError extends Error {
  readonly code = "START_LOCK_TIMEOUT" as const;

  constructor(waitTimeoutMs: number, options?: ErrorOptions) {
    super(`Timed out after ${waitTimeoutMs}ms waiting for the OpenCodex start lock`, options);
    this.name = "StartLockTimeoutError";
  }
}

export function getStartLockPath(): string {
  return join(getConfigDir(), START_LOCK_DIR_NAME);
}

export function releaseStartLock(handle: StartLockHandle): void {
  handle.release();
}

/**
 * Acquire the start lock, run `work`, and release on every completion path
 * including throw. Callers must not `process.exit` inside `work`: Node/Bun
 * terminate without unwinding, so `finally` would not run and the lock would
 * stay until stale-PID reclaim.
 */
export async function withStartLock<T>(
  work: (handle: StartLockHandle) => Promise<T>,
  options?: StartLockOptions,
): Promise<T> {
  const handle = await acquireStartLock(options);
  try {
    return await work(handle);
  } finally {
    handle.release();
  }
}

export async function acquireStartLock(options: StartLockOptions = {}): Promise<StartLockHandle> {
  const waitTimeoutMs = options.waitTimeoutMs ?? START_LOCK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? START_LOCK_POLL_INTERVAL_MS;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new RangeError("start lock waitTimeoutMs must be a non-negative number");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("start lock pollIntervalMs must be a non-negative number");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError("start lock pid must be a positive safe integer");
  }

  ensureStartLockHome();
  const lockPath = getStartLockPath();
  const started = now();

  for (;;) {
    const handle = tryClaimStartLock(lockPath, {
      pid,
      now,
      randomToken: options.randomToken,
      beforeReleaseUnlink: options.beforeReleaseUnlink,
    });
    if (handle) return handle;
    if (reclaimStaleStartLock(lockPath, isAlive, options.beforeStaleReclaim)) continue;
    if (reclaimIncompleteStartLock(lockPath, now(), options.beforeIncompleteReclaim)) continue;
    const elapsed = now() - started;
    if (elapsed >= waitTimeoutMs) throw new StartLockTimeoutError(waitTimeoutMs);
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

function sameStartLock(left: StartLockSnapshot, right: StartLockSnapshot): boolean {
  return left.record.token === right.record.token
    && left.record.pid === right.record.pid
    && left.record.createdAt === right.record.createdAt
    && sameFileIdentity(left.lockIdentity, right.lockIdentity)
    && sameOwnerIdentity(left.ownerIdentity, right.ownerIdentity);
}

function sameIncompleteStartLock(
  left: IncompleteStartLockSnapshot,
  right: IncompleteStartLockSnapshot,
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
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= START_LOCK_OWNER_MAX_BYTES;
}

function parseOwnerRecord(raw: string): StartLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<StartLockRecord>;
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

function readStartLockSnapshot(lockPath: string): StartLockSnapshot | null {
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

function readIncompleteStartLockSnapshot(lockPath: string): IncompleteStartLockSnapshot | null {
  // A complete record, including a dead owner, belongs to the normal stale-PID
  // protocol. The incomplete path is deliberately narrower.
  if (readStartLockSnapshot(lockPath)) return null;

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
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > START_LOCK_OWNER_MAX_BYTES) {
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

function ensureStartLockHome(): void {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else hardenConfigDir();
}

function makeToken(pid: number, now: () => number, randomToken?: () => string): string {
  const token = randomToken?.() ?? `${pid}-${now()}-${randomUUID()}`;
  if (!TOKEN_PATTERN.test(token)) {
    throw new RangeError("start lock token must be a 1..128 character [A-Za-z0-9._-] value");
  }
  return token;
}

function tryClaimStartLock(
  lockPath: string,
  options: {
    pid: number;
    now: () => number;
    randomToken?: () => string;
    beforeReleaseUnlink?: () => void;
  },
): StartLockHandle | null {
  const record: StartLockRecord = {
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
    const owned = readStartLockSnapshot(lockPath);
    if (!owned || owned.record.token !== record.token || !sameOwnerIdentity(identity, owned.ownerIdentity)) {
      throw new Error("start lock changed during owner publication");
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
          const current = readStartLockSnapshot(lockPath);
          if (!identity || !current || current.record.token !== record.token
            || !sameOwnerIdentity(identity, current.ownerIdentity)) {
            return;
          }
          options.beforeReleaseUnlink?.();
          const confirmed = readStartLockSnapshot(lockPath);
          if (!confirmed || !sameStartLock(current, confirmed) || confirmed.record.token !== record.token) {
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
  record: StartLockRecord,
  identity: FileIdentity | null,
  createdDirectory: boolean,
  fd: number | null,
): void {
  if (fd !== null) {
    try { closeSync(fd); } catch { /* best-effort close before ownership cleanup */ }
  }
  try {
    const current = readStartLockSnapshot(lockPath);
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

function reclaimIncompleteStartLock(
  lockPath: string,
  nowMs: number,
  beforeIncompleteReclaim?: () => void,
): boolean {
  const observed = readIncompleteStartLockSnapshot(lockPath);
  if (!observed || nowMs - observed.newestMtimeMs < START_LOCK_INCOMPLETE_GRACE_MS) return false;
  const current = readIncompleteStartLockSnapshot(lockPath);
  if (!current || !sameIncompleteStartLock(observed, current)) return false;
  beforeIncompleteReclaim?.();
  try {
    const confirmed = readIncompleteStartLockSnapshot(lockPath);
    if (!confirmed || !sameIncompleteStartLock(current, confirmed)) return false;
    if (confirmed.owner) unlinkSync(confirmed.owner.path);
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function reclaimStaleStartLock(
  lockPath: string,
  isAlive: (pid: number) => boolean,
  beforeStaleReclaim?: () => void,
): boolean {
  const observed = readStartLockSnapshot(lockPath);
  if (!observed) return false;
  if (isAlive(observed.record.pid)) return false;
  const current = readStartLockSnapshot(lockPath);
  if (!current || !sameStartLock(observed, current)) return false;
  beforeStaleReclaim?.();
  try {
    const confirmed = readStartLockSnapshot(lockPath);
    if (!confirmed || !sameStartLock(current, confirmed)) return false;
    unlinkSync(observed.ownerPath);
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
