#!/usr/bin/env bun
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_FILE_NAME,
  TARGET_TRIPLES,
  readRuntimeManifestFile,
  verifyRuntimeTree,
  type TargetTriple,
} from "../runtime/manifest";
import {
  hostTargetTriple,
  keyringNativeFileForTarget,
  keyringPackageForTarget,
  runtimeBinaryName,
  validateNativeBinaryForTarget,
} from "./build-runtime";

const SIDECAR_BIN_NAME = "ocx-runtime";
const SIDECAR_CONFIG_PATH = "binaries/ocx-runtime";
const RUNTIME_RESOURCE_REL = "resources/runtime";
const STUB_MARKER = "OCX_DESKTOP_SIDECAR_STUB";
const REQUIRED_RUNTIME_ENTRIES = [
  "package.json",
  "src/cli/index.ts",
  "desktop/runtime/bootstrap.ts",
  "gui/dist/index.html",
] as const;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDir, "..");
const srcTauri = join(desktopRoot, "src-tauri");
const requireReal = process.argv.includes("--require-real");

function parseRequestedTarget(): TargetTriple | undefined {
  const args = process.argv.slice(2);
  let target: TargetTriple | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--require-real") continue;
    if (arg !== "--target") fail(`unknown argument: ${arg ?? ""}`);
    const value = args[index + 1];
    if (!value || !(TARGET_TRIPLES as readonly string[]).includes(value)) {
      fail("--target must name a closed Desktop target triple");
    }
    if (target) fail("--target may only be specified once");
    target = value as TargetTriple;
    index += 1;
  }
  return target;
}

const requestedTarget = parseRequestedTarget();

function fail(message: string): never {
  console.error(`validate-packaging: ${message}`);
  process.exit(1);
}

function isWindowsTriple(triple: string): boolean {
  return triple.includes("windows");
}

function sidecarSourceFileName(triple: string): string {
  if (isWindowsTriple(triple)) {
    return `${SIDECAR_BIN_NAME}-${triple}.exe`;
  }
  return `${SIDECAR_BIN_NAME}-${triple}`;
}

function parseSidecarFileName(name: string): { triple: TargetTriple; windows: boolean } | null {
  if (!name.startsWith(`${SIDECAR_BIN_NAME}-`)) {
    return null;
  }
  let rest = name.slice(`${SIDECAR_BIN_NAME}-`.length);
  const windows = rest.endsWith(".exe");
  if (windows) {
    rest = rest.slice(0, -".exe".length);
  }
  if (!(TARGET_TRIPLES as readonly string[]).includes(rest)) {
    return null;
  }
  const triple = rest as TargetTriple;
  if (windows !== isWindowsTriple(triple)) {
    return null;
  }
  return { triple, windows };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function containsStubMarker(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).toString("utf8").includes(STUB_MARKER);
}

function validateNative(path: string, target: TargetTriple, requireExecutable = true): void {
  try {
    validateNativeBinaryForTarget(path, target, { requireExecutable });
  } catch (error) {
    fail(error instanceof Error ? error.message : "native binary validation failed");
  }
}

function hasRequiredRuntimeEntry(
  paths: ReadonlySet<string>,
  required: string,
): boolean {
  if (paths.has(required)) {
    return true;
  }
  const prefix = `${required}/`;
  for (const path of paths) {
    if (path.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function validatePackagedRuntime(runtimeDir: string, expectedTarget?: TargetTriple): boolean {
  let runtimeStat;
  try {
    runtimeStat = lstatSync(runtimeDir);
  } catch {
    return false;
  }
  if (runtimeStat.isSymbolicLink()) {
    fail(`packaged runtime must not be a symlink: ${RUNTIME_RESOURCE_REL}`);
  }
  if (!runtimeStat.isDirectory()) {
    fail(`packaged runtime must be a directory: ${RUNTIME_RESOURCE_REL}`);
  }

  const manifestPath = join(runtimeDir, MANIFEST_FILE_NAME);
  let manifestStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch {
    return false;
  }
  if (manifestStat.isSymbolicLink()) {
    fail(`${MANIFEST_FILE_NAME} must not be a symlink`);
  }
  if (!manifestStat.isFile()) {
    fail(`${MANIFEST_FILE_NAME} must be a regular file`);
  }

  const loaded = readRuntimeManifestFile(manifestPath);
  if (!loaded.ok) {
    fail(`invalid ${MANIFEST_FILE_NAME}: ${loaded.message}`);
  }
  if (expectedTarget && loaded.manifest.target !== expectedTarget) {
    fail(`packaged runtime target does not match ${expectedTarget}`);
  }
  const verified = verifyRuntimeTree(runtimeDir, loaded.manifest, {
    expectedTarget: loaded.manifest.target,
    allowManifestFile: true,
  });
  if (!verified.ok) {
    fail(`packaged runtime verification failed: ${verified.message}`);
  }

  const listed = new Set(loaded.manifest.files.map((file) => file.path));
  for (const required of REQUIRED_RUNTIME_ENTRIES) {
    if (!hasRequiredRuntimeEntry(listed, required)) {
      fail(`packaged runtime missing required entry: ${required}`);
    }
  }

  const expectedBin = runtimeBinaryName(loaded.manifest.target);
  const expectedKeyring = `node_modules/${keyringPackageForTarget(loaded.manifest.target)}/${keyringNativeFileForTarget(loaded.manifest.target)}`;
  for (const required of [expectedBin, expectedKeyring]) {
    if (!listed.has(required)) fail(`packaged runtime missing required entry: ${required}`);
  }
  const binPath = join(runtimeDir, expectedBin);
  if (!existsSync(binPath)) {
    fail(`packaged runtime missing sidecar file ${expectedBin}`);
  }
  const binStat = lstatSync(binPath);
  if (binStat.isSymbolicLink()) {
    fail(`packaged runtime sidecar must not be a symlink: ${expectedBin}`);
  }
  validateNative(binPath, loaded.manifest.target);
  validateNative(join(runtimeDir, ...expectedKeyring.split("/")), loaded.manifest.target, false);
  return true;
}

const tauriConf = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8")) as {
  version?: unknown;
  bundle?: {
    externalBin?: unknown;
    resources?: unknown;
    createUpdaterArtifacts?: unknown;
  };
  app?: {
    withGlobalTauri?: unknown;
    security?: { csp?: unknown; assetProtocol?: { enable?: unknown } };
  };
  plugins?: { updater?: unknown };
};
const rootPackage = JSON.parse(readFileSync(join(desktopRoot, "..", "package.json"), "utf8")) as {
  version?: unknown;
};
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
  version?: unknown;
};
if (
  typeof rootPackage.version !== "string"
  || rootPackage.version !== desktopPackage.version
  || rootPackage.version !== tauriConf.version
) {
  fail("root, Desktop package, and Tauri versions must match");
}

if (JSON.stringify(tauriConf.bundle?.externalBin) !== JSON.stringify([SIDECAR_CONFIG_PATH])) {
  fail(`bundle.externalBin must be ["${SIDECAR_CONFIG_PATH}"]`);
}
if (SIDECAR_CONFIG_PATH.includes("x86_64") || SIDECAR_CONFIG_PATH.includes("aarch64")) {
  fail("bundle.externalBin must not embed a target triple");
}
const resources = tauriConf.bundle?.resources;
if (!Array.isArray(resources) || !resources.includes(RUNTIME_RESOURCE_REL)) {
  fail(`bundle.resources must include "${RUNTIME_RESOURCE_REL}"`);
}
if (tauriConf.bundle?.createUpdaterArtifacts !== false) {
  fail("bundle.createUpdaterArtifacts must be false");
}
if (tauriConf.plugins?.updater !== undefined) {
  fail("plugins.updater must not be configured");
}
if (tauriConf.app?.withGlobalTauri !== false) {
  fail("app.withGlobalTauri must be false");
}
if (tauriConf.app?.security?.assetProtocol?.enable !== false) {
  fail("assetProtocol must be disabled");
}
const csp = tauriConf.app?.security?.csp;
if (typeof csp !== "string" || !csp.includes("default-src 'self'") || !csp.includes("frame-ancestors 'none'")) {
  fail("CSP must stay restrictive");
}
if (csp.includes("*")) {
  fail("CSP must not contain a wildcard");
}

const capabilities = JSON.parse(readFileSync(join(srcTauri, "capabilities/main.json"), "utf8")) as {
  permissions?: unknown;
};
if (!Array.isArray(capabilities.permissions) || capabilities.permissions.length !== 0) {
  fail("main capability permissions must be empty");
}

const binariesDir = join(srcTauri, "binaries");
let names: string[] = [];
try {
  names = readdirSync(binariesDir);
} catch {
  names = [];
}

let realSidecarCount = 0;
let stubCount = 0;
for (const name of names) {
  if (name === ".gitignore") {
    continue;
  }
  const parsed = parseSidecarFileName(name);
  if (!parsed) {
    fail(`unexpected sidecar filename: ${name}`);
  }
  const abs = join(binariesDir, name);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    fail(`sidecar must not be a symlink: ${name}`);
  }
  if (!st.isFile()) {
    fail(`sidecar must be a regular file: ${name}`);
  }
  const bytes = new Uint8Array(readFileSync(abs));
  const digest = sha256(bytes);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    fail(`unable to hash sidecar: ${name}`);
  }
  const isStub = containsStubMarker(bytes);
  if (isStub) {
    const expected = parsed.windows
      ? Buffer.from("MZOCX_DESKTOP_SIDECAR_STUB")
      : Buffer.from("#!/bin/sh\necho OCX_DESKTOP_SIDECAR_STUB >&2\nexit 2\n");
    if (!Buffer.from(bytes).equals(expected)) {
      fail(`invalid compile placeholder: ${name}`);
    }
    stubCount += 1;
    continue;
  }
  realSidecarCount += 1;
  validateNative(abs, parsed.triple);
}

let requiredTarget = requestedTarget;
if (requireReal && !requiredTarget) {
  requiredTarget = hostTargetTriple() ?? fail("this host is outside the closed Desktop target set");
}
const runtimeDir = join(srcTauri, RUNTIME_RESOURCE_REL);
const packagedRuntimeVerified = validatePackagedRuntime(runtimeDir, requiredTarget);

if (requireReal) {
  if (!requiredTarget) fail("a closed Desktop target is required");
  if (stubCount > 0 && realSidecarCount === 0) {
    fail("a real ocx-runtime sidecar is required; only a compile placeholder is present");
  }
  const expectedName = sidecarSourceFileName(requiredTarget);
  const hasHost = names.includes(expectedName);
  if (!hasHost) {
    fail(`missing host sidecar ${expectedName}`);
  }
  const bytes = new Uint8Array(readFileSync(join(binariesDir, expectedName)));
  if (containsStubMarker(bytes)) {
    fail("host sidecar is a compile placeholder, not a real runtime");
  }
  if (!packagedRuntimeVerified) {
    fail("a verified packaged runtime is required");
  }
}

console.log(
  `validate-packaging: ok (sidecars=${names.filter((name) => name !== ".gitignore").length}, real=${realSidecarCount}, stubs=${stubCount}, packagedRuntime=${packagedRuntimeVerified ? "verified" : "absent"})`,
);
