import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_FILE_NAME = "runtime-manifest.json";
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_MANIFEST_FILES = 100_000;
export const MAX_RELATIVE_PATH_LENGTH = 240;
export const MAX_VERSION_LENGTH = 64;
export const MAX_MANIFEST_ID_LENGTH = 128;

export const TARGET_TRIPLES = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;

export type TargetTriple = (typeof TARGET_TRIPLES)[number];

export const RUNTIME_STORE_ERROR_CODES = [
  "invalid_manifest",
  "invalid_pointer",
  "ambiguous_manifest_id",
  "target_mismatch",
  "path_escape",
  "symlink_forbidden",
  "unexpected_file",
  "missing_file",
  "hash_mismatch",
  "executable_bit_mismatch",
  "forbidden_file",
  "cas_mismatch",
  "lock_held",
  "rollback_unavailable",
  "version_in_use",
  "io_error",
] as const;

export type RuntimeStoreErrorCode = (typeof RUNTIME_STORE_ERROR_CODES)[number];

export type RuntimeStoreErr = {
  ok: false;
  code: RuntimeStoreErrorCode;
  message: string;
};

export type RuntimeStoreOk<T> = { ok: true } & T;
export type RuntimeStoreResult<T> = RuntimeStoreOk<T> | RuntimeStoreErr;
export type RuntimeUnit = { unit: true };

export function okUnit(): RuntimeStoreOk<RuntimeUnit> {
  return { ok: true, unit: true };
}

export type ManifestFileEntry = {
  path: string;
  sha256: string;
  executable: boolean;
};

export type RuntimeManifest = {
  schemaVersion: 1;
  id: string;
  version: string;
  target: TargetTriple;
  files: ManifestFileEntry[];
};

export type VerifyRuntimeTreeOptions = {
  expectedTarget?: TargetTriple;
  enforceExecutableBit?: boolean;
  allowManifestFile?: boolean;
};

export type CreateRuntimeManifestInput = {
  id: string;
  version: string;
  target: TargetTriple;
  root: string;
  files: Array<{ path: string; executable: boolean }>;
  enforceExecutableBit?: boolean;
};

const MANIFEST_KEYS = ["schemaVersion", "id", "version", "target", "files"] as const;
const FILE_ENTRY_KEYS = ["path", "sha256", "executable"] as const;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const MANIFEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const FORBIDDEN_BASENAME_RE = /^\.env(?:\..*)?$/;
const FORBIDDEN_SEGMENTS = new Set([".git"]);
const FORBIDDEN_BASENAMES = new Set(["current.json", "current.lock", MANIFEST_FILE_NAME]);
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export function failStore(code: RuntimeStoreErrorCode, message: string): RuntimeStoreErr {
  return { ok: false, code, message };
}

export function okStore<T>(value: T): RuntimeStoreOk<T> {
  return { ok: true, ...value };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

export function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: RuntimeStoreErrorCode,
): RuntimeStoreErr | null {
  const keys = ownKeys(value);
  if (keys.length !== expected.length) {
    const extra = keys.filter((key) => !expected.includes(key));
    if (extra.length > 0) {
      return failStore(code, `unknown field: ${extra[0]}`);
    }
    const missing = expected.filter((key) => !keys.includes(key));
    return failStore(code, `missing field: ${missing[0]}`);
  }
  for (const key of keys) {
    if (!expected.includes(key)) {
      return failStore(code, `unknown field: ${key}`);
    }
  }
  for (const key of expected) {
    if (!keys.includes(key)) {
      return failStore(code, `missing field: ${key}`);
    }
  }
  return null;
}

function copyObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    out[key] = value[key];
  }
  return out;
}

export function asObject(
  value: unknown,
  label: string,
  code: RuntimeStoreErrorCode = "invalid_manifest",
): RuntimeStoreResult<{ value: Record<string, unknown> }> {
  if (!isPlainObject(value)) {
    return failStore(code, `${label} must be an object`);
  }
  const copied = copyObject(value);
  if (!copied) {
    return failStore(code, `${label} contains a forbidden field`);
  }
  return okStore({ value: copied });
}

export function isTargetTriple(value: unknown): value is TargetTriple {
  return typeof value === "string" && (TARGET_TRIPLES as readonly string[]).includes(value);
}

export function isRuntimeVersion(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value === "." || value === "..") {
    return false;
  }
  if (value.length < 1 || value.length > MAX_VERSION_LENGTH) {
    return false;
  }
  if (value.includes("/") || value.includes("\\") || value.includes(":")) {
    return false;
  }
  return VERSION_RE.test(value);
}

export function isManifestId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length < 1 || value.length > MAX_MANIFEST_ID_LENGTH) {
    return false;
  }
  if (value.includes("..") || value.includes("/") || value.includes("\\") || value.includes(":")) {
    return false;
  }
  return MANIFEST_ID_RE.test(value);
}

export function runtimeManifestId(version: string, target: TargetTriple): string {
  return `ocx-runtime-${version}-${target}`;
}

export function versionRelPath(version: string): string {
  return `versions/${version}`;
}

export function isForbiddenBasename(name: string): boolean {
  return FORBIDDEN_BASENAME_RE.test(name) || FORBIDDEN_BASENAMES.has(name);
}

export function posixSegments(posixRel: string): string[] {
  return posixRel.split("/");
}

export function validateRelativeRuntimePath(value: unknown): RuntimeStoreResult<{ path: string }> {
  if (typeof value !== "string") {
    return failStore("path_escape", "path must be a relative POSIX string");
  }
  if (value.length < 1 || value.length > MAX_RELATIVE_PATH_LENGTH) {
    return failStore("path_escape", "path length is invalid");
  }
  if (isAbsolute(value) || value.startsWith("/") || value.startsWith("\\")) {
    return failStore("path_escape", "path must be relative");
  }
  if (value.includes("\0") || value.includes("\\") || value.includes(":") || value.includes("//")) {
    return failStore("path_escape", "path contains an illegal character");
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return failStore("path_escape", "path contains an illegal character");
  }
  const segments = posixSegments(value);
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return failStore("path_escape", "path must not contain empty, '.', or '..' segments");
    }
    if (FORBIDDEN_SEGMENTS.has(segment) || isForbiddenBasename(segment)) {
      return failStore("forbidden_file", `forbidden path: ${value}`);
    }
  }
  return okStore({ path: value });
}

export function defaultEnforceExecutableBit(): boolean {
  return process.platform !== "win32";
}

export function fileIsExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

export function canonicalFileMode(executable: boolean): number {
  return executable ? 0o755 : 0o644;
}

export function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  if (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  ) {
    return bytes.subarray(3);
  }
  return bytes;
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function fileErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

function openReadNoFollow(path: string): number {
  if (process.platform === "win32") {
    return openSync(path, "r");
  }
  return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
}

export function sha256File(path: string): RuntimeStoreResult<{ sha256: string }> {
  try {
    const hash = createHash("sha256");
    const fd = openReadNoFollow(path);
    try {
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) {
          break;
        }
        hash.update(buf.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    return okStore({ sha256: hash.digest("hex") });
  } catch (error) {
    return ioError(error);
  }
}

export function ioError(error: unknown): RuntimeStoreErr {
  const code = fileErrorCode(error);
  if (code === "ENOENT") {
    return failStore("missing_file", "required runtime file is missing");
  }
  if (code === "ELOOP") {
    return failStore("symlink_forbidden", "symlink is not allowed");
  }
  return failStore("io_error", code ? `filesystem error: ${code}` : "filesystem error");
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (process.platform === "win32") {
    const a = rootPath.toLowerCase();
    const b = candidatePath.toLowerCase();
    return b === a || b.startsWith(a.endsWith("\\") ? a : `${a}\\`);
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

export function realpathRoot(root: string): RuntimeStoreResult<{ root: string }> {
  try {
    const real = realpathSync(root);
    const st = lstatSync(real);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return failStore("io_error", "runtime root must be a directory");
    }
    return okStore({ root: real });
  } catch (error) {
    return ioError(error);
  }
}

export type ContainedLookup = {
  absPath: string;
  stat: Stats;
};

export function containedLookup(root: string, posixRel: string): RuntimeStoreResult<ContainedLookup> {
  const pathCheck = validateRelativeRuntimePath(posixRel);
  if (!pathCheck.ok) {
    return pathCheck;
  }
  let current = resolve(root);
  if (!isInsideRoot(root, current)) {
    return failStore("path_escape", "path escapes runtime root");
  }
  for (const segment of posixSegments(pathCheck.path)) {
    const next = join(current, segment);
    if (!isInsideRoot(root, next)) {
      return failStore("path_escape", "path escapes runtime root");
    }
    let st: Stats;
    try {
      st = lstatSync(next);
    } catch (error) {
      return ioError(error);
    }
    if (st.isSymbolicLink()) {
      return failStore("symlink_forbidden", `symlink is not allowed: ${posixRel}`);
    }
    current = next;
  }
  try {
    return okStore({ absPath: current, stat: lstatSync(current) });
  } catch (error) {
    return ioError(error);
  }
}

export function sortManifestFiles(files: ManifestFileEntry[]): ManifestFileEntry[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function canonicalizeRuntimeManifest(manifest: RuntimeManifest): RuntimeManifest {
  return {
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    target: manifest.target,
    files: sortManifestFiles(manifest.files).map((file) => ({
      path: file.path,
      sha256: file.sha256,
      executable: file.executable,
    })),
  };
}

export function serializeRuntimeManifest(manifest: RuntimeManifest): string {
  return `${JSON.stringify(canonicalizeRuntimeManifest(manifest))}\n`;
}

function parseFileEntry(value: unknown, index: number): RuntimeStoreResult<{ entry: ManifestFileEntry }> {
  const obj = asObject(value, `files[${index}]`);
  if (!obj.ok) {
    return obj;
  }
  const record = obj.value;
  const keys = exactObjectKeys(record, FILE_ENTRY_KEYS, "invalid_manifest");
  if (keys) {
    return keys;
  }
  const pathCheck = validateRelativeRuntimePath(record.path);
  if (!pathCheck.ok) {
    return pathCheck;
  }
  const sha256 = record.sha256;
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    return failStore("invalid_manifest", `files[${index}].sha256 must be a lowercase SHA-256 hex digest`);
  }
  if (typeof record.executable !== "boolean") {
    return failStore("invalid_manifest", `files[${index}].executable must be a boolean`);
  }
  return okStore({
    entry: {
      path: pathCheck.path,
      sha256,
      executable: record.executable,
    },
  });
}

export function parseRuntimeManifest(
  value: unknown,
  options: { expectedTarget?: TargetTriple } = {},
): RuntimeStoreResult<{ manifest: RuntimeManifest }> {
  const obj = asObject(value, "manifest");
  if (!obj.ok) {
    return obj;
  }
  const record = obj.value;
  const keys = exactObjectKeys(record, MANIFEST_KEYS, "invalid_manifest");
  if (keys) {
    return keys;
  }
  if (!Object.is(record.schemaVersion, 1) || !Number.isInteger(record.schemaVersion)) {
    return failStore("invalid_manifest", "unsupported schemaVersion");
  }
  if (!isManifestId(record.id)) {
    return failStore("invalid_manifest", "invalid id");
  }
  if (!isRuntimeVersion(record.version)) {
    return failStore("invalid_manifest", "invalid version");
  }
  if (!isTargetTriple(record.target)) {
    return failStore("invalid_manifest", "invalid target triple");
  }
  if (options.expectedTarget && record.target !== options.expectedTarget) {
    return failStore("target_mismatch", "manifest target does not match the expected triple");
  }
  if (!Array.isArray(record.files)) {
    return failStore("invalid_manifest", "files must be an array");
  }
  if (record.files.length < 1) {
    return failStore("invalid_manifest", "files must not be empty");
  }
  if (record.files.length > MAX_MANIFEST_FILES) {
    return failStore("invalid_manifest", "files exceeds the closed maximum");
  }
  const files: ManifestFileEntry[] = [];
  const seen = new Set<string>();
  const seenFolded = new Set<string>();
  for (let index = 0; index < record.files.length; index += 1) {
    const parsed = parseFileEntry(record.files[index], index);
    if (!parsed.ok) {
      return parsed;
    }
    if (seen.has(parsed.entry.path)) {
      return failStore("invalid_manifest", `duplicate path: ${parsed.entry.path}`);
    }
    const folded = parsed.entry.path.toLowerCase();
    if (seenFolded.has(folded)) {
      return failStore("invalid_manifest", `duplicate path: ${parsed.entry.path}`);
    }
    seen.add(parsed.entry.path);
    seenFolded.add(folded);
    files.push(parsed.entry);
  }
  return okStore({
    manifest: canonicalizeRuntimeManifest({
      schemaVersion: 1,
      id: record.id,
      version: record.version,
      target: record.target,
      files,
    }),
  });
}

export function parseRuntimeManifestJson(
  bytes: Uint8Array,
  options: { expectedTarget?: TargetTriple } = {},
): RuntimeStoreResult<{ manifest: RuntimeManifest }> {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    return failStore("invalid_manifest", "manifest exceeds the closed maximum size");
  }
  const payload = stripUtf8Bom(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return failStore("invalid_manifest", "manifest is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failStore("invalid_manifest", "manifest is not valid JSON");
  }
  return parseRuntimeManifest(value, options);
}

export function readRuntimeManifestFile(
  path: string,
  options: { expectedTarget?: TargetTriple } = {},
): RuntimeStoreResult<{ manifest: RuntimeManifest }> {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      return failStore("symlink_forbidden", "manifest must not be a symlink");
    }
    if (!st.isFile()) {
      return failStore("invalid_manifest", "manifest must be a regular file");
    }
    if (st.size > MAX_MANIFEST_BYTES) {
      return failStore("invalid_manifest", "manifest exceeds the closed maximum size");
    }
    return parseRuntimeManifestJson(readFileSync(path), options);
  } catch (error) {
    return ioError(error);
  }
}

export function writeRuntimeManifestFile(dir: string, manifest: RuntimeManifest): RuntimeStoreResult<{ path: string }> {
  const canonical = canonicalizeRuntimeManifest(manifest);
  const path = join(dir, MANIFEST_FILE_NAME);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      return failStore("symlink_forbidden", "manifest must not be a symlink");
    }
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") {
      return ioError(error);
    }
  }
  try {
    writeFileSync(path, serializeRuntimeManifest(canonical), { encoding: "utf8", flag: "w" });
    return okStore({ path });
  } catch (error) {
    return ioError(error);
  }
}

export type WalkedFile = {
  path: string;
  absPath: string;
  stat: Stats;
};

export function walkRegularFiles(root: string): RuntimeStoreResult<{ files: WalkedFile[] }> {
  const resolved = realpathRoot(root);
  if (!resolved.ok) {
    return resolved;
  }
  const files: WalkedFile[] = [];
  const stack: Array<{ abs: string; rel: string }> = [{ abs: resolved.root, rel: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    let entries: string[];
    try {
      entries = readdirSync(current.abs);
    } catch (error) {
      return ioError(error);
    }
    for (const name of entries) {
      if (name === "." || name === "..") {
        continue;
      }
      const absPath = join(current.abs, name);
      if (!isInsideRoot(resolved.root, absPath)) {
        return failStore("path_escape", "path escapes runtime root");
      }
      let st: Stats;
      try {
        st = lstatSync(absPath);
      } catch (error) {
        return ioError(error);
      }
      const rel = current.rel === "" ? name : `${current.rel}/${name}`;
      if (rel !== MANIFEST_FILE_NAME) {
        const pathCheck = validateRelativeRuntimePath(rel);
        if (!pathCheck.ok) {
          return pathCheck;
        }
      }
      if (st.isSymbolicLink()) {
        return failStore("symlink_forbidden", `symlink is not allowed: ${rel}`);
      }
      if (st.isDirectory()) {
        stack.push({ abs: absPath, rel });
        continue;
      }
      if (!st.isFile()) {
        return failStore("unexpected_file", `unexpected file type: ${rel}`);
      }
      if (isForbiddenBasename(name) && name !== MANIFEST_FILE_NAME) {
        return failStore("forbidden_file", `forbidden path: ${rel}`);
      }
      files.push({ path: rel.replaceAll("\\", "/"), absPath, stat: st });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return okStore({ files });
}

function packageNameFromNodeModulesPath(posixRel: string): string | undefined {
  if (!posixRel.startsWith("node_modules/")) {
    return undefined;
  }
  const rest = posixRel.slice("node_modules/".length);
  if (rest.length === 0) {
    return undefined;
  }
  const parts = rest.split("/");
  if (parts[0]?.startsWith("@")) {
    if (parts.length < 2) {
      return undefined;
    }
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function readJsonObject(bytes: Uint8Array, label: string): RuntimeStoreResult<{ value: Record<string, unknown> }> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stripUtf8Bom(bytes));
  } catch {
    return failStore("invalid_manifest", `${label} is not valid UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failStore("invalid_manifest", `${label} is not valid JSON`);
  }
  return asObject(value, label);
}

function developmentPackageNames(packageJson: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const dev = packageJson.devDependencies;
  if (!isPlainObject(dev)) {
    return names;
  }
  const prod = isPlainObject(packageJson.dependencies) ? packageJson.dependencies : undefined;
  for (const name of Object.keys(dev)) {
    if (prod && Object.prototype.hasOwnProperty.call(prod, name)) {
      continue;
    }
    names.add(name);
  }
  return names;
}

function rejectDevelopmentDependency(
  posixRel: string,
  devPackages: Set<string>,
): RuntimeStoreErr | null {
  const pkg = packageNameFromNodeModulesPath(posixRel);
  if (pkg && devPackages.has(pkg)) {
    return failStore("forbidden_file", `development dependency is not allowed: ${posixRel}`);
  }
  return null;
}

function collectDevPackagesFromTree(
  root: string,
  files: ManifestFileEntry[],
): RuntimeStoreResult<{ names: Set<string> }> {
  const pkgEntry = files.find((file) => file.path === "package.json");
  if (!pkgEntry) {
    return okStore({ names: new Set<string>() });
  }
  const lookup = containedLookup(root, "package.json");
  if (!lookup.ok) {
    return lookup;
  }
  if (!lookup.stat.isFile()) {
    return failStore("unexpected_file", "package.json must be a regular file");
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(lookup.absPath);
  } catch (error) {
    return ioError(error);
  }
  const hashed = sha256Bytes(bytes);
  if (hashed !== pkgEntry.sha256) {
    return failStore("hash_mismatch", "hash mismatch: package.json");
  }
  const parsed = readJsonObject(bytes, "package.json");
  if (!parsed.ok) {
    return parsed;
  }
  return okStore({ names: developmentPackageNames(parsed.value) });
}

export function verifyRuntimeTree(
  root: string,
  manifest: RuntimeManifest,
  options: VerifyRuntimeTreeOptions = {},
): RuntimeStoreResult<{ root: string }> {
  if (options.expectedTarget && manifest.target !== options.expectedTarget) {
    return failStore("target_mismatch", "manifest target does not match the expected triple");
  }
  const resolved = realpathRoot(root);
  if (!resolved.ok) {
    return resolved;
  }
  const enforceExecutableBit = options.enforceExecutableBit ?? defaultEnforceExecutableBit();
  const allowManifestFile = options.allowManifestFile ?? true;
  const walked = walkRegularFiles(resolved.root);
  if (!walked.ok) {
    return walked;
  }
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const devPackages = collectDevPackagesFromTree(resolved.root, manifest.files);
  if (!devPackages.ok) {
    return devPackages;
  }

  for (const file of walked.files) {
    if (file.path === MANIFEST_FILE_NAME) {
      if (!allowManifestFile) {
        return failStore("unexpected_file", `unexpected file: ${file.path}`);
      }
      continue;
    }
    const forbidden = isForbiddenBasename(file.path.split("/").pop() ?? file.path);
    if (forbidden) {
      return failStore("forbidden_file", `forbidden path: ${file.path}`);
    }
    const dev = rejectDevelopmentDependency(file.path, devPackages.names);
    if (dev) {
      return dev;
    }
    const entry = listed.get(file.path);
    if (!entry) {
      return failStore("unexpected_file", `unexpected file: ${file.path}`);
    }
    seen.add(file.path);
    if (file.stat.isSymbolicLink()) {
      return failStore("symlink_forbidden", `symlink is not allowed: ${file.path}`);
    }
    const digest = sha256File(file.absPath);
    if (!digest.ok) {
      return digest;
    }
    if (digest.sha256 !== entry.sha256) {
      return failStore("hash_mismatch", `hash mismatch: ${file.path}`);
    }
    if (enforceExecutableBit && fileIsExecutable(file.stat.mode) !== entry.executable) {
      return failStore("executable_bit_mismatch", `executable bit mismatch: ${file.path}`);
    }
  }

  for (const entry of manifest.files) {
    const dev = rejectDevelopmentDependency(entry.path, devPackages.names);
    if (dev) {
      return dev;
    }
    if (!seen.has(entry.path)) {
      const lookup = containedLookup(resolved.root, entry.path);
      if (!lookup.ok && lookup.code === "symlink_forbidden") {
        return lookup;
      }
      return failStore("missing_file", `missing file: ${entry.path}`);
    }
  }
  return okStore({ root: resolved.root });
}

export function createRuntimeManifestFromFiles(
  input: CreateRuntimeManifestInput,
): RuntimeStoreResult<{ manifest: RuntimeManifest }> {
  if (!isManifestId(input.id)) {
    return failStore("invalid_manifest", "invalid id");
  }
  if (!isRuntimeVersion(input.version)) {
    return failStore("invalid_manifest", "invalid version");
  }
  if (!isTargetTriple(input.target)) {
    return failStore("invalid_manifest", "invalid target triple");
  }
  const resolved = realpathRoot(input.root);
  if (!resolved.ok) {
    return resolved;
  }
  const enforceExecutableBit = input.enforceExecutableBit ?? defaultEnforceExecutableBit();
  const files: ManifestFileEntry[] = [];
  for (const file of input.files) {
    const pathCheck = validateRelativeRuntimePath(file.path);
    if (!pathCheck.ok) {
      return pathCheck;
    }
    const lookup = containedLookup(resolved.root, pathCheck.path);
    if (!lookup.ok) {
      return lookup;
    }
    if (lookup.stat.isSymbolicLink()) {
      return failStore("symlink_forbidden", `symlink is not allowed: ${pathCheck.path}`);
    }
    if (!lookup.stat.isFile()) {
      return failStore("unexpected_file", `not a regular file: ${pathCheck.path}`);
    }
    if (enforceExecutableBit && fileIsExecutable(lookup.stat.mode) !== file.executable) {
      return failStore("executable_bit_mismatch", `executable bit mismatch: ${pathCheck.path}`);
    }
    const digest = sha256File(lookup.absPath);
    if (!digest.ok) {
      return digest;
    }
    files.push({
      path: pathCheck.path,
      sha256: digest.sha256,
      executable: file.executable,
    });
  }
  const parsed = parseRuntimeManifest({
    schemaVersion: 1,
    id: input.id,
    version: input.version,
    target: input.target,
    files,
  });
  if (!parsed.ok) {
    return parsed;
  }
  const verified = verifyRuntimeTree(resolved.root, parsed.manifest, {
    expectedTarget: input.target,
    enforceExecutableBit,
    allowManifestFile: true,
  });
  if (!verified.ok) {
    return verified;
  }
  return parsed;
}

export function mkdirContained(root: string, posixRel: string): RuntimeStoreResult<{ absPath: string }> {
  const pathCheck = validateRelativeRuntimePath(posixRel);
  if (!pathCheck.ok) {
    return pathCheck;
  }
  let current = resolve(root);
  for (const segment of posixSegments(pathCheck.path)) {
    const next = join(current, segment);
    if (!isInsideRoot(root, next)) {
      return failStore("path_escape", "path escapes runtime root");
    }
    try {
      const st = lstatSync(next);
      if (st.isSymbolicLink()) {
        return failStore("symlink_forbidden", `symlink is not allowed: ${posixRel}`);
      }
      if (!st.isDirectory()) {
        return failStore("unexpected_file", `not a directory: ${posixRel}`);
      }
    } catch (error) {
      if (fileErrorCode(error) !== "ENOENT") {
        return ioError(error);
      }
      try {
        mkdirSync(next);
      } catch (mkdirError) {
        if (fileErrorCode(mkdirError) !== "EEXIST") {
          return ioError(mkdirError);
        }
      }
      try {
        const created = lstatSync(next);
        if (created.isSymbolicLink()) {
          return failStore("symlink_forbidden", `symlink is not allowed: ${posixRel}`);
        }
        if (!created.isDirectory()) {
          return failStore("unexpected_file", `not a directory: ${posixRel}`);
        }
      } catch (createdError) {
        return ioError(createdError);
      }
    }
    current = next;
  }
  return okStore({ absPath: current });
}

export function parentPosixPath(posixRel: string): string | undefined {
  const idx = posixRel.lastIndexOf("/");
  if (idx <= 0) {
    return undefined;
  }
  return posixRel.slice(0, idx);
}

export function ensureParentDir(root: string, posixRel: string): RuntimeStoreResult<{ absPath: string }> {
  const parent = parentPosixPath(posixRel);
  if (!parent) {
    return okStore({ absPath: resolve(root) });
  }
  return mkdirContained(root, parent);
}

export function fileExistsLstat(path: string): RuntimeStoreResult<{ exists: boolean; stat?: Stats }> {
  try {
    return okStore({ exists: true, stat: lstatSync(path) });
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") {
      return okStore({ exists: false });
    }
    return ioError(error);
  }
}
