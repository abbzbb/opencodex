/**
 * Owner-only Desktop activation journal.
 *
 * THE JOURNAL IS PREPARED INTENT, NOT A COMMIT. Commit is compare-before-delete
 * after `current.json` is the intended post-image and candidate health is
 * re-proven. A journal on disk means the transaction never committed.
 *
 * Recovery uses `current.json` as the durable oracle. It never trusts a phase
 * flag. Pointer equal to the snapshot pre-image → roll back. Pointer equal to
 * the exact intended post-image → re-prove candidate health and either finalize
 * (delete journal) or roll back. Any other pointer, checksum failure, or
 * malformed envelope → keep the journal and fail closed.
 *
 * Writes are owner-only (0600), exact-key, checksummed, and durable:
 * temp wx + file fsync + compare-before rename + POSIX directory fsync.
 * This module must not reuse the activation-lock owner publisher (no fsync,
 * extra keys accepted).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertNotRealHomeUnderTest } from "../../src/lib/test-home-guard";
import {
  asObject,
  exactObjectKeys,
  failStore,
  fileErrorCode,
  fileExistsLstat,
  ioError,
  isInsideRoot,
  isPlainObject,
  isTargetTriple,
  okStore,
  okUnit,
  stripUtf8Bom,
  type RuntimeStoreResult,
  type RuntimeUnit,
  type TargetTriple,
} from "./manifest";
import {
  currentPointersEqual,
  parseCurrentPointer,
  parseVersionPointer,
  type CurrentPointer,
  type VersionPointer,
} from "./staging";
import type { Owner } from "./protocol";

export type ActivationJournalKind = "install" | "start" | "repair" | "uninstall";
export type ActivationJournalMode = "service" | "direct";

export const ACTIVATION_JOURNAL_NAME = "activation.journal";
export const ACTIVATION_JOURNAL_ENVELOPE_TAG = "ocx-activation-journal-v1";
export const ACTIVATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const ACTIVATION_JOURNAL_MAX_BYTES = 64 * 1024;
const FILE_MODE = 0o600;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const JOURNAL_KEYS = [
  "schemaVersion",
  "transactionId",
  "token",
  "intent",
  "kind",
  "mode",
  "stableRoot",
  "expectedTarget",
  "snapshot",
  "candidate",
  "publishedPointer",
  "touchedService",
  "candidatePid",
] as const;

const SNAPSHOT_KEYS = [
  "pointer",
  "owner",
  "hadLiveProxy",
  "serviceInstalled",
  "backend",
  "bunPath",
  "cliPath",
  "previousPid",
  "previousBunPath",
  "previousCliPath",
] as const;

const KINDS = ["install", "start", "repair", "uninstall"] as const;
const MODES = ["service", "direct"] as const;
const OWNERS = ["existing-external", "desktop-direct", "desktop-service", "unknown/conflict"] as const;
const BACKENDS = ["scheduler", "native", "launchd", "systemd"] as const;

export type ActivationJournalBackend = "scheduler" | "native" | "launchd" | "systemd" | null;

export type ActivationJournalSnapshot = {
  pointer: CurrentPointer;
  owner: Owner;
  hadLiveProxy: boolean;
  serviceInstalled: boolean;
  backend: ActivationJournalBackend;
  bunPath: string | null;
  cliPath: string | null;
  previousPid: number | null;
  previousBunPath: string | null;
  previousCliPath: string | null;
};

export type ActivationJournalRecord = {
  schemaVersion: 1;
  transactionId: string;
  token: string;
  intent: "activate";
  kind: ActivationJournalKind;
  mode: ActivationJournalMode;
  stableRoot: string;
  expectedTarget: TargetTriple;
  snapshot: ActivationJournalSnapshot;
  candidate: VersionPointer;
  publishedPointer: CurrentPointer | null;
  touchedService: boolean;
  candidatePid: number | null;
};

export type ActivationJournalObservation =
  | { state: "absent" }
  | { state: "valid"; record: ActivationJournalRecord; identity: JournalFileIdentity }
  | { state: "unreadable" };

export type JournalFileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type ExpectedJournal = {
  transactionId: string;
  identity?: JournalFileIdentity;
};

function fileIdentityFromStats(stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">): JournalFileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFileIdentity(left: JournalFileIdentity, right: JournalFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

export function intendedPublishedPointer(
  snapshot: CurrentPointer,
  candidate: VersionPointer,
): CurrentPointer | null {
  if (snapshot.current.id === candidate.id || snapshot.current.version === candidate.version) {
    return null;
  }
  return {
    schemaVersion: 1,
    current: candidate,
    previous: snapshot.current,
  };
}

export function activationJournalPath(stableRoot: string): string {
  if (typeof stableRoot !== "string" || stableRoot.length === 0 || !isAbsolute(stableRoot)) {
    throw new RangeError("activation journal stableRoot must be an absolute path");
  }
  const resolved = resolve(stableRoot);
  const path = join(resolved, ACTIVATION_JOURNAL_NAME);
  if (basename(path) !== ACTIVATION_JOURNAL_NAME || !isInsideRoot(resolved, path)) {
    throw new RangeError("activation journal path escaped the stable root");
  }
  return path;
}

function serializeVersionPointer(pointer: VersionPointer): Record<string, string> {
  return {
    id: pointer.id,
    version: pointer.version,
    target: pointer.target,
    relPath: pointer.relPath,
  };
}

function serializeCurrentPointerValue(pointer: CurrentPointer): Record<string, unknown> {
  return {
    schemaVersion: 1,
    current: serializeVersionPointer(pointer.current),
    previous: pointer.previous ? serializeVersionPointer(pointer.previous) : null,
  };
}

export function serializeActivationJournalRecord(record: ActivationJournalRecord): string {
  return JSON.stringify({
    schemaVersion: 1,
    transactionId: record.transactionId,
    token: record.token,
    intent: "activate",
    kind: record.kind,
    mode: record.mode,
    stableRoot: record.stableRoot,
    expectedTarget: record.expectedTarget,
    snapshot: {
      pointer: serializeCurrentPointerValue(record.snapshot.pointer),
      owner: record.snapshot.owner,
      hadLiveProxy: record.snapshot.hadLiveProxy,
      serviceInstalled: record.snapshot.serviceInstalled,
      backend: record.snapshot.backend,
      bunPath: record.snapshot.bunPath,
      cliPath: record.snapshot.cliPath,
      previousPid: record.snapshot.previousPid,
      previousBunPath: record.snapshot.previousBunPath,
      previousCliPath: record.snapshot.previousCliPath,
    },
    candidate: serializeVersionPointer(record.candidate),
    publishedPointer: record.publishedPointer
      ? serializeCurrentPointerValue(record.publishedPointer)
      : null,
    touchedService: record.touchedService,
    candidatePid: record.candidatePid,
  });
}

export function encodeActivationJournal(record: ActivationJournalRecord): string {
  const body = serializeActivationJournalRecord(record);
  const sum = createHash("sha256").update(body).digest("hex");
  return `${ACTIVATION_JOURNAL_ENVELOPE_TAG} ${sum}\n${body}\n`;
}

function isKind(value: unknown): value is ActivationJournalKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function isMode(value: unknown): value is ActivationJournalMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function isOwner(value: unknown): value is Owner {
  return typeof value === "string" && (OWNERS as readonly string[]).includes(value);
}

function isBackend(value: unknown): value is ActivationJournalBackend {
  return value === null || (typeof value === "string" && (BACKENDS as readonly string[]).includes(value));
}

function isOptionalAbsolutePath(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string"
    && value.length > 0
    && isAbsolute(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isOptionalPid(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseActivationJournalRecord(
  value: unknown,
): RuntimeStoreResult<{ record: ActivationJournalRecord }> {
  const obj = asObject(value, "activation.journal", "invalid_pointer");
  if (!obj.ok) return obj;
  const keys = exactObjectKeys(obj.value, JOURNAL_KEYS, "invalid_pointer");
  if (keys) return keys;
  if (!Object.is(obj.value.schemaVersion, ACTIVATION_JOURNAL_SCHEMA_VERSION) || !Number.isInteger(obj.value.schemaVersion)) {
    return failStore("invalid_pointer", "unsupported journal schemaVersion");
  }
  if (typeof obj.value.transactionId !== "string" || !TOKEN_PATTERN.test(obj.value.transactionId)) {
    return failStore("invalid_pointer", "journal transactionId is invalid");
  }
  if (typeof obj.value.token !== "string" || !TOKEN_PATTERN.test(obj.value.token)) {
    return failStore("invalid_pointer", "journal token is invalid");
  }
  if (obj.value.intent !== "activate") {
    return failStore("invalid_pointer", "journal intent is invalid");
  }
  if (!isKind(obj.value.kind) || !isMode(obj.value.mode)) {
    return failStore("invalid_pointer", "journal kind or mode is invalid");
  }
  if (typeof obj.value.stableRoot !== "string"
    || !isAbsolute(obj.value.stableRoot)
    || /[\u0000-\u001f\u007f]/.test(obj.value.stableRoot)) {
    return failStore("path_escape", "journal stableRoot is invalid");
  }
  if (!isTargetTriple(obj.value.expectedTarget)) {
    return failStore("invalid_pointer", "journal expectedTarget is invalid");
  }
  if (typeof obj.value.touchedService !== "boolean") {
    return failStore("invalid_pointer", "journal touchedService is invalid");
  }
  if (!isOptionalPid(obj.value.candidatePid)) {
    return failStore("invalid_pointer", "journal candidatePid is invalid");
  }
  const snapshotObj = asObject(obj.value.snapshot, "activation.journal snapshot", "invalid_pointer");
  if (!snapshotObj.ok) return snapshotObj;
  const snapshotKeys = exactObjectKeys(snapshotObj.value, SNAPSHOT_KEYS, "invalid_pointer");
  if (snapshotKeys) return snapshotKeys;
  const pointer = parseCurrentPointer(snapshotObj.value.pointer);
  if (!pointer.ok) return pointer;
  if (!isOwner(snapshotObj.value.owner)) {
    return failStore("invalid_pointer", "journal snapshot owner is invalid");
  }
  if (typeof snapshotObj.value.hadLiveProxy !== "boolean"
    || typeof snapshotObj.value.serviceInstalled !== "boolean") {
    return failStore("invalid_pointer", "journal snapshot running bits are invalid");
  }
  if (!isBackend(snapshotObj.value.backend)) {
    return failStore("invalid_pointer", "journal snapshot backend is invalid");
  }
  if (!isOptionalAbsolutePath(snapshotObj.value.bunPath)
    || !isOptionalAbsolutePath(snapshotObj.value.cliPath)
    || !isOptionalAbsolutePath(snapshotObj.value.previousBunPath)
    || !isOptionalAbsolutePath(snapshotObj.value.previousCliPath)
    || !isOptionalPid(snapshotObj.value.previousPid)) {
    return failStore("invalid_pointer", "journal snapshot paths are invalid");
  }
  const candidate = parseVersionPointer(obj.value.candidate, "candidate");
  if (!candidate.ok) return candidate;
  let publishedPointer: CurrentPointer | null = null;
  if (obj.value.publishedPointer !== null) {
    const parsed = parseCurrentPointer(obj.value.publishedPointer);
    if (!parsed.ok) return parsed;
    publishedPointer = parsed.pointer;
  }
  const record: ActivationJournalRecord = {
    schemaVersion: 1,
    transactionId: obj.value.transactionId,
    token: obj.value.token,
    intent: "activate",
    kind: obj.value.kind,
    mode: obj.value.mode,
    stableRoot: resolve(obj.value.stableRoot),
    expectedTarget: obj.value.expectedTarget,
    snapshot: {
      pointer: pointer.pointer,
      owner: snapshotObj.value.owner,
      hadLiveProxy: snapshotObj.value.hadLiveProxy,
      serviceInstalled: snapshotObj.value.serviceInstalled,
      backend: snapshotObj.value.backend,
      bunPath: snapshotObj.value.bunPath,
      cliPath: snapshotObj.value.cliPath,
      previousPid: snapshotObj.value.previousPid,
      previousBunPath: snapshotObj.value.previousBunPath,
      previousCliPath: snapshotObj.value.previousCliPath,
    },
    candidate: candidate.pointer,
    publishedPointer,
    touchedService: obj.value.touchedService,
    candidatePid: obj.value.candidatePid,
  };
  return okStore({ record });
}

export function decodeActivationJournal(
  raw: string,
): RuntimeStoreResult<{ record: ActivationJournalRecord }> {
  const newline = raw.indexOf("\n");
  if (newline <= 0) {
    return failStore("invalid_pointer", "journal envelope is truncated");
  }
  const header = raw.slice(0, newline);
  const body = raw.slice(newline + 1).replace(/\n$/, "");
  const space = header.indexOf(" ");
  if (space <= 0) {
    return failStore("invalid_pointer", "journal envelope header is invalid");
  }
  const tag = header.slice(0, space);
  const sum = header.slice(space + 1);
  if (tag !== ACTIVATION_JOURNAL_ENVELOPE_TAG || !SHA256_RE.test(sum)) {
    return failStore("invalid_pointer", "journal envelope tag is invalid");
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== sum) {
    return failStore("invalid_pointer", "journal checksum mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failStore("invalid_pointer", "journal body is not JSON");
  }
  if (!isPlainObject(parsed)) {
    return failStore("invalid_pointer", "journal body is not an object");
  }
  return parseActivationJournalRecord(parsed);
}

export type ActivationJournalIo = {
  fsyncDirectory?: (filePath: string) => RuntimeStoreResult<RuntimeUnit>;
};

function fsyncDir(path: string): RuntimeStoreResult<RuntimeUnit> {
  if (process.platform === "win32") return okUnit();
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
    return okUnit();
  } catch (error) {
    return ioError(error);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function unlinkIfRegularFile(path: string): RuntimeStoreResult<RuntimeUnit> {
  const exists = fileExistsLstat(path);
  if (!exists.ok) return exists;
  if (!exists.exists) return okUnit();
  if (!exists.stat) return failStore("io_error", "path is unreadable");
  if (exists.stat.isSymbolicLink()) {
    return failStore("symlink_forbidden", "refusing to unlink a symlink");
  }
  if (exists.stat.isDirectory()) {
    return failStore("unexpected_file", "refusing to delete a directory at a journal path");
  }
  try {
    unlinkSync(path);
    return okUnit();
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return okUnit();
    return ioError(error);
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

function writeJournalAtomic(
  dest: string,
  record: ActivationJournalRecord,
  io?: ActivationJournalIo,
): RuntimeStoreResult<RuntimeUnit> {
  const encoded = encodeActivationJournal(record);
  if (Buffer.byteLength(encoded, "utf8") > ACTIVATION_JOURNAL_MAX_BYTES) {
    return failStore("invalid_pointer", "journal exceeds the maximum size");
  }
  const tmp = join(dirname(dest), `${ACTIVATION_JOURNAL_NAME}.${randomBytes(8).toString("hex")}.tmp`);
  if (!isInsideRoot(dirname(dest), tmp)) {
    return failStore("path_escape", "journal temp path escaped the stable root");
  }
  try {
    writeFileSync(tmp, encoded, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    try { chmodSync(tmp, FILE_MODE); } catch { /* best-effort owner-only mode */ }
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
    return failStore("symlink_forbidden", "activation.journal must not be a symlink");
  }
  if (destExists.exists && destExists.stat && !destExists.stat.isFile()) {
    unlinkIfRegularFile(tmp);
    return failStore("invalid_pointer", "activation.journal must be a regular file");
  }
  const renamed = renameReplacingFile(tmp, dest);
  if (!renamed.ok) {
    unlinkIfRegularFile(tmp);
    return renamed;
  }
  try { chmodSync(dest, FILE_MODE); } catch { /* best-effort owner-only mode */ }
  if (process.platform !== "win32") {
    try {
      const mode = lstatSync(dest).mode & 0o777;
      if (mode !== FILE_MODE) {
        return failStore("io_error", "activation.journal must be owner-only");
      }
    } catch (error) {
      return ioError(error);
    }
  }
  const synced = (io?.fsyncDirectory ?? fsyncDir)(dest);
  if (!synced.ok) return synced;
  return okUnit();
}

function readJournalSnapshot(path: string): ActivationJournalObservation {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return { state: "absent" };
    return { state: "unreadable" };
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0 || before.size > ACTIVATION_JOURNAL_MAX_BYTES) {
    return { state: "unreadable" };
  }
  if (process.platform !== "win32" && (before.mode & 0o777) !== FILE_MODE) {
    return { state: "unreadable" };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { state: "unreadable" };
  }
  if (bytes.byteLength !== before.size) return { state: "unreadable" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stripUtf8Bom(bytes));
  } catch {
    return { state: "unreadable" };
  }
  const decoded = decodeActivationJournal(text);
  if (!decoded.ok) return { state: "unreadable" };
  try {
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isFile()
      || !sameFileIdentity(fileIdentityFromStats(before), fileIdentityFromStats(after))) {
      return { state: "unreadable" };
    }
    return {
      state: "valid",
      record: decoded.record,
      identity: fileIdentityFromStats(after),
    };
  } catch {
    return { state: "unreadable" };
  }
}

export function observeActivationJournal(stableRoot: string): ActivationJournalObservation {
  try {
    const path = activationJournalPath(stableRoot);
    assertNotRealHomeUnderTest(path);
    return readJournalSnapshot(path);
  } catch {
    return { state: "unreadable" };
  }
}

export function writeActivationJournal(
  stableRoot: string,
  record: ActivationJournalRecord,
  io?: ActivationJournalIo,
): RuntimeStoreResult<RuntimeUnit> {
  let dest: string;
  try {
    dest = activationJournalPath(stableRoot);
  } catch {
    return failStore("path_escape", "activation journal path is invalid");
  }
  assertNotRealHomeUnderTest(dest);
  if (resolve(record.stableRoot) !== resolve(stableRoot)) {
    return failStore("path_escape", "journal stableRoot must equal the lock root");
  }
  const existing = readJournalSnapshot(dest);
  if (existing.state === "valid" || existing.state === "unreadable") {
    return failStore("cas_mismatch", "activation journal already exists");
  }
  return writeJournalAtomic(dest, record, io);
}

export function replaceActivationJournal(
  stableRoot: string,
  expected: ExpectedJournal,
  next: ActivationJournalRecord,
  io?: ActivationJournalIo,
): RuntimeStoreResult<RuntimeUnit> {
  let dest: string;
  try {
    dest = activationJournalPath(stableRoot);
  } catch {
    return failStore("path_escape", "activation journal path is invalid");
  }
  assertNotRealHomeUnderTest(dest);
  if (next.transactionId !== expected.transactionId) {
    return failStore("cas_mismatch", "journal transactionId does not match");
  }
  if (resolve(next.stableRoot) !== resolve(stableRoot)) {
    return failStore("path_escape", "journal stableRoot must equal the lock root");
  }
  const existing = readJournalSnapshot(dest);
  if (existing.state !== "valid") {
    return failStore("cas_mismatch", "activation journal is not the expected record");
  }
  if (existing.record.transactionId !== expected.transactionId) {
    return failStore("cas_mismatch", "activation journal transactionId mismatch");
  }
  if (expected.identity && !sameFileIdentity(existing.identity, expected.identity)) {
    return failStore("cas_mismatch", "activation journal changed during compare");
  }
  const confirmed = readJournalSnapshot(dest);
  if (confirmed.state !== "valid"
    || confirmed.record.transactionId !== expected.transactionId
    || !sameFileIdentity(existing.identity, confirmed.identity)) {
    return failStore("cas_mismatch", "activation journal changed during compare");
  }
  return writeJournalAtomic(dest, next, io);
}

export function removeActivationJournal(
  stableRoot: string,
  expected: ExpectedJournal,
  io?: ActivationJournalIo,
): RuntimeStoreResult<RuntimeUnit> {
  let dest: string;
  try {
    dest = activationJournalPath(stableRoot);
  } catch {
    return failStore("path_escape", "activation journal path is invalid");
  }
  assertNotRealHomeUnderTest(dest);
  const existing = readJournalSnapshot(dest);
  if (existing.state === "absent") return okUnit();
  if (existing.state !== "valid") {
    return failStore("cas_mismatch", "activation journal is unreadable; refusing delete");
  }
  if (existing.record.transactionId !== expected.transactionId) {
    return failStore("cas_mismatch", "activation journal transactionId mismatch");
  }
  if (expected.identity && !sameFileIdentity(existing.identity, expected.identity)) {
    return failStore("cas_mismatch", "activation journal changed during compare");
  }
  const confirmed = readJournalSnapshot(dest);
  if (confirmed.state !== "valid"
    || confirmed.record.transactionId !== expected.transactionId
    || !sameFileIdentity(existing.identity, confirmed.identity)) {
    return failStore("cas_mismatch", "activation journal changed during compare");
  }
  try {
    unlinkSync(dest);
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") return ioError(error);
  }
  const synced = (io?.fsyncDirectory ?? fsyncDir)(dest);
  if (!synced.ok) return synced;
  const after = readJournalSnapshot(dest);
  if (after.state !== "absent") {
    return failStore("cas_mismatch", "activation journal remained after delete");
  }
  return okUnit();
}

export function journalPointersEqual(
  left: CurrentPointer | null,
  right: CurrentPointer | null,
): boolean {
  return currentPointersEqual(left, right);
}
