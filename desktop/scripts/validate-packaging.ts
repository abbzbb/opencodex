#!/usr/bin/env bun
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_TRIPLES = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;

const SIDECAR_BIN_NAME = "ocx-runtime";
const SIDECAR_CONFIG_PATH = "binaries/ocx-runtime";
const RUNTIME_RESOURCE_REL = "resources/runtime";
const STUB_MARKER = "OCX_DESKTOP_SIDECAR_STUB";
const ELF_EM_X86_64 = 62;
const ELF_EM_AARCH64 = 183;

type TargetTriple = (typeof TARGET_TRIPLES)[number];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDir, "..");
const srcTauri = join(desktopRoot, "src-tauri");
const requireReal = process.argv.includes("--require-real");

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

function elfMachine(bytes: Uint8Array): number | null {
  if (bytes.length < 20) {
    return null;
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return null;
  }
  const little = bytes[5] === 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(18, little);
}

function expectedElfMachine(triple: TargetTriple): number | null {
  if (triple === "x86_64-unknown-linux-gnu") {
    return ELF_EM_X86_64;
  }
  if (triple === "aarch64-unknown-linux-gnu") {
    return ELF_EM_AARCH64;
  }
  return null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

const tauriConf = JSON.parse(readFileSync(join(srcTauri, "tauri.conf.json"), "utf8")) as {
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
function hostLinuxTriple(): TargetTriple | null {
  if (process.platform !== "linux") {
    return null;
  }
  if (process.arch === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  if (process.arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  return null;
}

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
  const asText = Buffer.from(bytes).toString("utf8");
  const isStub = asText.includes(STUB_MARKER);
  if (isStub) {
    stubCount += 1;
    continue;
  }
  realSidecarCount += 1;
  const expectedMachine = expectedElfMachine(parsed.triple);
  if (expectedMachine !== null) {
    if (process.platform !== "win32" && !isExecutable(st.mode)) {
      fail(`unix sidecar is not executable: ${name}`);
    }
    const machine = elfMachine(bytes);
    if (machine !== expectedMachine) {
      fail(`sidecar architecture does not match ${parsed.triple}`);
    }
  }
}

if (requireReal) {
  if (stubCount > 0 && realSidecarCount === 0) {
    fail("a real ocx-runtime sidecar is required; only a compile placeholder is present");
  }
  const hostTriple = hostLinuxTriple();
  if (hostTriple) {
    const expectedName = sidecarSourceFileName(hostTriple);
    const hasHost = names.includes(expectedName);
    if (!hasHost) {
      fail(`missing host sidecar ${expectedName}`);
    }
    const bytes = new Uint8Array(readFileSync(join(binariesDir, expectedName)));
    if (Buffer.from(bytes).toString("utf8").includes(STUB_MARKER)) {
      fail("host sidecar is a compile placeholder, not a real runtime");
    }
  }
}

console.log(
  `validate-packaging: ok (sidecars=${names.filter((name) => name !== ".gitignore").length}, real=${realSidecarCount}, stubs=${stubCount})`,
);
