#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MANIFEST_FILE_NAME,
  readRuntimeManifestFile,
  serializeRuntimeManifest,
  verifyRuntimeTree,
  type RuntimeManifest,
  type TargetTriple,
} from "../runtime/manifest";
import {
  validateEnvelope,
  type BridgeEnvelope,
  type StatusResult,
} from "../runtime/protocol";
import {
  parseVersionPointer,
  readCurrentPointer,
  versionPointerFromManifest,
  type VersionPointer,
} from "../runtime/staging";
import {
  keyringNativeFileForTarget,
  keyringPackageForTarget,
  runtimeBinaryName,
  validateNativeBinaryForTarget,
} from "./build-runtime";

export const LINUX_DEB_TARGET = "x86_64-unknown-linux-gnu" as const;
export const LINUX_DEB_ARCH = "amd64" as const;
export const LINUX_DEB_PACKAGE = "open-codex" as const;
export const LINUX_DEB_APP_REL = "usr/bin/opencodex-desktop" as const;
export const LINUX_DEB_SIDECAR_REL = "usr/bin/ocx-runtime" as const;
export const LINUX_DEB_RUNTIME_REL = "usr/lib/OpenCodex/resources/runtime" as const;

const DPKG_DEB = "/usr/bin/dpkg-deb";
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const EXTRACT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;
const BRIDGE_TIMEOUT_MS = 30_000;
const NATIVE_SMOKE_TIMEOUT_MS = 30_000;
export const LINUX_DEB_STATUS_REQUEST_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUIRED_RUNTIME_ENTRIES = [
  "package.json",
  "src/cli/index.ts",
  "desktop/runtime/bootstrap.ts",
  "desktop/runtime/install.ts",
  "gui/dist/index.html",
] as const;

type JsonRecord = Record<string, unknown>;

export type LinuxDebLayout = {
  extractRoot: string;
  appPath: string;
  sidecarPath: string;
  runtimeRoot: string;
};

export type ValidatedLinuxDebLayout = LinuxDebLayout & {
  manifest: RuntimeManifest;
  sidecarSha256: string;
  runtimeSha256: string;
  payloadBytes: number;
};

export type ProbeArgs = {
  deb: string;
  sha256: string;
};

type ChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type InstallSuccess = {
  current: VersionPointer;
  previous: VersionPointer | null;
  staged: VersionPointer;
  reused: boolean;
  published: boolean;
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every((key) => keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    fail("bundle path escapes the extraction root");
  }
}

function assertPath(root: string, path: string, kind: "directory" | "file", executable = false): void {
  assertInside(root, path);
  const rel = relative(root, path);
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      fail(`missing expected bundle path: ${rel.split(sep).join("/")}`);
    }
    if (stat.isSymbolicLink()) {
      fail(`bundle path must not contain a symlink: ${rel.split(sep).join("/")}`);
    }
  }
  const stat = lstatSync(path);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    fail(`expected bundle ${kind}: ${rel.split(sep).join("/")}`);
  }
  if (executable && process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    fail(`bundle executable bit is missing: ${rel.split(sep).join("/")}`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function parseProbeArgs(argv: string[]): ProbeArgs {
  let deb: string | undefined;
  let sha256: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--deb") {
      if (deb) fail("--deb may only be specified once");
      if (!value) fail("--deb requires a path");
      deb = resolve(value);
    } else if (arg === "--sha256") {
      if (sha256) fail("--sha256 may only be specified once");
      if (!value || !/^[a-f0-9]{64}$/.test(value)) {
        fail("--sha256 requires a lowercase SHA-256 digest");
      }
      sha256 = value;
    } else {
      fail(`unknown argument: ${arg ?? ""}`);
    }
    index += 1;
  }
  if (!deb) fail("--deb is required");
  if (!sha256) fail("--sha256 is required before executing an artifact");
  return { deb, sha256 };
}

export function linuxDebLayout(extractRoot: string): LinuxDebLayout {
  const root = resolve(extractRoot);
  return {
    extractRoot: root,
    appPath: join(root, ...LINUX_DEB_APP_REL.split("/")),
    sidecarPath: join(root, ...LINUX_DEB_SIDECAR_REL.split("/")),
    runtimeRoot: join(root, ...LINUX_DEB_RUNTIME_REL.split("/")),
  };
}

export function pinDebArtifact(
  sourcePath: string,
  probeRoot: string,
  expectedSha256: string,
): { path: string; sha256: string } {
  const pinnedPath = join(probeRoot, "artifact.deb");
  copyFileSync(sourcePath, pinnedPath, fsConstants.COPYFILE_EXCL);
  chmodSync(pinnedPath, 0o600);
  assertPath(probeRoot, pinnedPath, "file");
  const sha256 = sha256File(pinnedPath);
  if (sha256 !== expectedSha256) {
    fail("Debian package SHA-256 does not match the trusted expected digest");
  }
  return { path: pinnedPath, sha256 };
}

export function validateExtractedLinuxDeb(extractRoot: string): ValidatedLinuxDebLayout {
  const layout = linuxDebLayout(extractRoot);
  assertPath(layout.extractRoot, layout.appPath, "file", true);
  assertPath(layout.extractRoot, layout.sidecarPath, "file", true);
  assertPath(layout.extractRoot, layout.runtimeRoot, "directory");
  if (dirname(layout.appPath) !== dirname(layout.sidecarPath)) {
    fail("packaged sidecar must be next to the app executable");
  }

  validateNativeBinaryForTarget(layout.appPath, LINUX_DEB_TARGET);
  validateNativeBinaryForTarget(layout.sidecarPath, LINUX_DEB_TARGET);

  const manifestPath = join(layout.runtimeRoot, MANIFEST_FILE_NAME);
  assertPath(layout.extractRoot, manifestPath, "file");
  const loaded = readRuntimeManifestFile(manifestPath, { expectedTarget: LINUX_DEB_TARGET });
  if (!loaded.ok) fail(`invalid packaged runtime manifest: ${loaded.message}`);
  const verified = verifyRuntimeTree(layout.runtimeRoot, loaded.manifest, {
    expectedTarget: LINUX_DEB_TARGET,
    enforceExecutableBit: true,
    allowManifestFile: true,
  });
  if (!verified.ok) fail(`packaged runtime verification failed: ${verified.message}`);

  const listed = new Set(loaded.manifest.files.map((file) => file.path));
  for (const required of REQUIRED_RUNTIME_ENTRIES) {
    if (!listed.has(required)) {
      fail(`packaged runtime missing required entry: ${required}`);
    }
    assertPath(layout.extractRoot, join(layout.runtimeRoot, ...required.split("/")), "file");
  }

  const runtimeRel = runtimeBinaryName(LINUX_DEB_TARGET);
  const runtimePath = join(layout.runtimeRoot, runtimeRel);
  assertPath(layout.extractRoot, runtimePath, "file", true);
  validateNativeBinaryForTarget(runtimePath, LINUX_DEB_TARGET);
  const runtimeEntry = loaded.manifest.files.find((file) => file.path === runtimeRel);
  if (!runtimeEntry) fail(`packaged runtime missing manifest entry: ${runtimeRel}`);

  const keyringRel = `node_modules/${keyringPackageForTarget(LINUX_DEB_TARGET)}/${keyringNativeFileForTarget(LINUX_DEB_TARGET)}`;
  const keyringPath = join(layout.runtimeRoot, ...keyringRel.split("/"));
  assertPath(layout.extractRoot, keyringPath, "file");
  validateNativeBinaryForTarget(keyringPath, LINUX_DEB_TARGET, { requireExecutable: false });

  const sidecarSha256 = sha256File(layout.sidecarPath);
  const runtimeSha256 = sha256File(runtimePath);
  if (sidecarSha256 !== runtimeSha256 || runtimeSha256 !== runtimeEntry.sha256) {
    fail("packaged sidecar, resource runtime, and manifest hashes must match");
  }

  const payloadBytes = loaded.manifest.files.reduce(
    (total, file) => total + statSync(join(layout.runtimeRoot, ...file.path.split("/"))).size,
    0,
  );
  return { ...layout, manifest: loaded.manifest, sidecarSha256, runtimeSha256, payloadBytes };
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  label: string,
  onOverflow: () => void,
  limit = MAX_CHILD_OUTPUT_BYTES,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        onOverflow();
        await reader.cancel();
        fail(`${label} exceeded the output limit`);
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

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
    const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, "child stdout", kill),
      readBoundedStream(child.stderr, "child stderr", kill),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: decodeUtf8(stdoutBytes),
      stderr: decodeUtf8(stderrBytes),
    };
  } catch (error) {
    kill();
    await child.exited;
    throw error;
  }
}

function parseOneJsonLine(result: ChildResult, label: string): unknown {
  if (result.exitCode !== 0) fail(`${label} exited with code ${result.exitCode}`);
  if (result.stderr !== "") fail(`${label} wrote to stderr`);
  if (!result.stdout.endsWith("\n") || result.stdout.indexOf("\n") !== result.stdout.length - 1) {
    fail(`${label} must emit exactly one JSON line`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(`${label} emitted invalid JSON`);
  }
}

function parseInstallSuccess(value: unknown, expected: { published: boolean; reused: boolean }): InstallSuccess {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "ok", "result"])) {
    fail("installer emitted an invalid success envelope");
  }
  if (value.schemaVersion !== 1 || value.ok !== true || !isRecord(value.result)) {
    fail("installer did not succeed");
  }
  const result = value.result;
  if (!exactKeys(result, ["current", "previous", "staged", "reused", "published"])) {
    fail("installer result fields are invalid");
  }
  const current = parseVersionPointer(result.current, "install.current");
  const staged = parseVersionPointer(result.staged, "install.staged");
  if (!current.ok || !staged.ok) fail("installer emitted an invalid runtime pointer");
  if (result.previous !== null) fail("first-start installer must not publish a previous pointer");
  if (result.reused !== expected.reused || result.published !== expected.published) {
    fail("installer publish/reuse state is invalid");
  }
  if (JSON.stringify(current.pointer) !== JSON.stringify(staged.pointer)) {
    fail("installer current and staged pointers must match");
  }
  return {
    current: current.pointer,
    previous: null,
    staged: staged.pointer,
    reused: expected.reused,
    published: expected.published,
  };
}

export function validateStoppedStatusEnvelope(value: unknown): BridgeEnvelope {
  const parsed = validateEnvelope(value);
  if (!parsed.ok) fail(`bridge status envelope is invalid: ${parsed.message}`);
  const envelope = parsed.value;
  if (
    !envelope.ok
    || envelope.operation !== "status"
    || envelope.requestId !== LINUX_DEB_STATUS_REQUEST_ID
  ) {
    fail("bridge status did not succeed");
  }
  const result = envelope.result as StatusResult;
  if (result.status !== "stopped" || result.origin !== null || result.pid !== null) {
    fail("isolated bridge status must report a stopped proxy");
  }
  return envelope;
}

export function validateStableRuntime(stableCwd: string, packagedManifest: RuntimeManifest): void {
  const stableStat = lstatSync(stableCwd);
  if (stableStat.isSymbolicLink() || !stableStat.isDirectory()) {
    fail("stable runtime root must be a real directory");
  }
  const stableManifest = readRuntimeManifestFile(join(stableCwd, MANIFEST_FILE_NAME), {
    expectedTarget: LINUX_DEB_TARGET,
  });
  if (!stableManifest.ok) fail("stable runtime manifest is invalid");
  if (serializeRuntimeManifest(stableManifest.manifest) !== serializeRuntimeManifest(packagedManifest)) {
    fail("stable runtime manifest differs from the packaged manifest");
  }
  const stableVerified = verifyRuntimeTree(stableCwd, stableManifest.manifest, {
    expectedTarget: LINUX_DEB_TARGET,
    enforceExecutableBit: true,
    allowManifestFile: true,
  });
  if (!stableVerified.ok) fail(`stable runtime verification failed: ${stableVerified.message}`);
}

function parseDebFields(text: string): { packageName: string; version: string; architecture: string } {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1]!, match[2]!);
  }
  const packageName = fields.get("Package");
  const version = fields.get("Version");
  const architecture = fields.get("Architecture");
  if (!packageName || !version || !architecture) fail("unable to read Debian package metadata");
  return { packageName, version, architecture };
}

function makeProbeEnv(root: string): Record<string, string> {
  const names = [
    "home",
    "xdg-data",
    "xdg-config",
    "xdg-cache",
    "xdg-state",
    "xdg-runtime",
    "opencodex-home",
    "codex-home",
    "empty-bin",
    "tmp",
  ];
  for (const name of names) {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return {
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    OPENCODEX_HOME: join(root, "opencodex-home"),
    CODEX_HOME: join(root, "codex-home"),
    TMPDIR: join(root, "tmp"),
    PATH: join(root, "empty-bin"),
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
}

export async function probeLinuxDeb(debPath: string, expectedSha256: string): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("Linux .deb probe requires a Linux x64 host");
  }
  const deb = resolve(debPath);
  if (!existsSync(deb)) fail("Debian package does not exist");
  const debStat = lstatSync(deb);
  if (debStat.isSymbolicLink() || !debStat.isFile()) fail("Debian package must be a regular file");
  if (!existsSync(DPKG_DEB)) fail("/usr/bin/dpkg-deb is required");

  const probeRoot = mkdtempSync(join(tmpdir(), "ocx-linux-deb-probe-"));
  chmodSync(probeRoot, 0o700);
  try {
    const pinned = pinDebArtifact(deb, probeRoot, expectedSha256);
    const extractRoot = join(probeRoot, "extract");
    mkdirSync(extractRoot, { mode: 0o700 });
    const toolEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
    const fieldsResult = await runChild(
      [DPKG_DEB, "--field", pinned.path, "Package", "Version", "Architecture"],
      { cwd: probeRoot, env: toolEnv, timeout: EXTRACT_TIMEOUT_MS },
    );
    if (fieldsResult.exitCode !== 0 || fieldsResult.stderr !== "") fail("dpkg-deb metadata read failed");
    const fields = parseDebFields(fieldsResult.stdout);
    if (fields.packageName !== LINUX_DEB_PACKAGE || fields.architecture !== LINUX_DEB_ARCH) {
      fail("Debian package identity does not match the Linux Desktop contract");
    }

    const extractResult = await runChild(
      [DPKG_DEB, "--extract", pinned.path, extractRoot],
      { cwd: probeRoot, env: toolEnv, timeout: EXTRACT_TIMEOUT_MS },
    );
    if (extractResult.exitCode !== 0 || extractResult.stdout !== "" || extractResult.stderr !== "") {
      fail("dpkg-deb extraction failed");
    }

    const layout = validateExtractedLinuxDeb(extractRoot);
    if (layout.manifest.version !== fields.version) {
      fail("Debian package version and runtime manifest version must match");
    }

    const jailRoot = join(probeRoot, "jail");
    mkdirSync(jailRoot, { mode: 0o700 });
    const env = makeProbeEnv(jailRoot);
    const stableRoot = join(jailRoot, "stable-runtime");
    mkdirSync(stableRoot, { mode: 0o700 });
    const installRequest = `${JSON.stringify({
      schemaVersion: 1,
      target: LINUX_DEB_TARGET,
      stableRoot,
    })}\n`;

    const first = parseInstallSuccess(
      parseOneJsonLine(await runChild(
        [layout.sidecarPath, "desktop/runtime/install.ts"],
        { cwd: layout.runtimeRoot, env, stdin: installRequest, timeout: INSTALL_TIMEOUT_MS },
      ), "first installer run"),
      { published: true, reused: false },
    );
    const expectedPointer = versionPointerFromManifest(layout.manifest);
    if (JSON.stringify(first.current) !== JSON.stringify(expectedPointer)) {
      fail("installer published a pointer for the wrong runtime manifest");
    }

    const second = parseInstallSuccess(
      parseOneJsonLine(await runChild(
        [layout.sidecarPath, "desktop/runtime/install.ts"],
        { cwd: layout.runtimeRoot, env, stdin: installRequest, timeout: INSTALL_TIMEOUT_MS },
      ), "second installer run"),
      { published: false, reused: true },
    );
    if (JSON.stringify(first.current) !== JSON.stringify(second.current)) {
      fail("installer reuse changed the published runtime pointer");
    }

    const current = readCurrentPointer(stableRoot);
    if (!current.ok || !current.pointer) fail("published current.json is invalid");
    if (JSON.stringify(current.pointer.current) !== JSON.stringify(first.current) || current.pointer.previous !== null) {
      fail("current.json does not match the installer result");
    }
    const stableCwd = join(stableRoot, ...current.pointer.current.relPath.split("/"));
    assertPath(stableRoot, stableCwd, "directory");
    validateStableRuntime(stableCwd, layout.manifest);

    const statusRequest = `${JSON.stringify({
      schemaVersion: 1,
      requestId: LINUX_DEB_STATUS_REQUEST_ID,
      operation: "status",
      payload: {},
    })}\n`;
    validateStoppedStatusEnvelope(parseOneJsonLine(await runChild(
      [layout.sidecarPath, "desktop/runtime/bootstrap.ts"],
      { cwd: stableCwd, env, stdin: statusRequest, timeout: BRIDGE_TIMEOUT_MS },
    ), "bridge status"));

    const nativeResult = await runChild(
      [layout.sidecarPath, "-e", "await import('@napi-rs/keyring')"],
      {
        cwd: stableCwd,
        env: { ...env, NAPI_RS_ENFORCE_VERSION_CHECK: "1" },
        timeout: NATIVE_SMOKE_TIMEOUT_MS,
      },
    );
    if (nativeResult.exitCode !== 0 || nativeResult.stdout !== "" || nativeResult.stderr !== "") {
      fail("target-native keyring module smoke failed");
    }

    return [
      `package=${fields.packageName}`,
      `version=${fields.version}`,
      `arch=${fields.architecture}`,
      `target=${LINUX_DEB_TARGET}`,
      `manifest=${layout.manifest.id}`,
      `files=${layout.manifest.files.length}`,
      `payloadBytes=${layout.payloadBytes}`,
      `debSha256=${pinned.sha256}`,
      `sidecarSha256=${layout.sidecarSha256}`,
      "install=published+reused",
      "status=stopped",
      "native=ok",
      "pathIsolation=empty",
    ].join(", ");
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  const args = parseProbeArgs(process.argv.slice(2));
  probeLinuxDeb(args.deb, args.sha256)
    .then((summary) => console.log(`probe-linux-deb: ok (${summary})`))
    .catch((error) => {
      console.error(`probe-linux-deb: ${error instanceof Error ? error.message : "probe failed"}`);
      process.exit(1);
    });
}
