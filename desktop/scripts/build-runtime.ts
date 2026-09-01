#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MANIFEST_FILE_NAME,
  TARGET_TRIPLES,
  createRuntimeManifestFromFiles,
  runtimeManifestId,
  verifyRuntimeTree,
  walkRegularFiles,
  writeRuntimeManifestFile,
  type RuntimeManifest,
  type TargetTriple,
} from "../runtime/manifest";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const REQUIRED_SOURCE_PATHS = [
  "package.json",
  "bun.lock",
  "src",
  "gui/dist",
  "desktop/runtime",
] as const;
const RUNTIME_ASSETS = [
  "assets/architecture.png",
  "assets/banner.png",
  "assets/claude-code-models.gif",
  "assets/codex-app-picker.png",
] as const;
const REQUIRED_RUNTIME_FILES = [
  "src/cli/index.ts",
  "gui/dist/index.html",
  "desktop/runtime/bootstrap.ts",
  "desktop/runtime/install.ts",
] as const;
const SIDECAR_STUB_MARKER = "OCX_DESKTOP_SIDECAR_STUB";
const MIN_NATIVE_BINARY_BYTES = 4096;

const KEYRING_PACKAGE_BY_TARGET: Record<TargetTriple, string> = {
  "aarch64-apple-darwin": "@napi-rs/keyring-darwin-arm64",
  "x86_64-apple-darwin": "@napi-rs/keyring-darwin-x64",
  "x86_64-pc-windows-msvc": "@napi-rs/keyring-win32-x64-msvc",
  "aarch64-pc-windows-msvc": "@napi-rs/keyring-win32-arm64-msvc",
  "x86_64-unknown-linux-gnu": "@napi-rs/keyring-linux-x64-gnu",
  "aarch64-unknown-linux-gnu": "@napi-rs/keyring-linux-arm64-gnu",
};

const KEYRING_NATIVE_FILE_BY_TARGET: Record<TargetTriple, string> = {
  "aarch64-apple-darwin": "keyring.darwin-arm64.node",
  "x86_64-apple-darwin": "keyring.darwin-x64.node",
  "x86_64-pc-windows-msvc": "keyring.win32-x64-msvc.node",
  "aarch64-pc-windows-msvc": "keyring.win32-arm64-msvc.node",
  "x86_64-unknown-linux-gnu": "keyring.linux-x64-gnu.node",
  "aarch64-unknown-linux-gnu": "keyring.linux-arm64-gnu.node",
};

const BUN_PACKAGE_BY_TARGET: Record<TargetTriple, string> = {
  "aarch64-apple-darwin": "@oven/bun-darwin-aarch64",
  "x86_64-apple-darwin": "@oven/bun-darwin-x64",
  "x86_64-pc-windows-msvc": "@oven/bun-windows-x64",
  "aarch64-pc-windows-msvc": "@oven/bun-windows-aarch64",
  "x86_64-unknown-linux-gnu": "@oven/bun-linux-x64",
  "aarch64-unknown-linux-gnu": "@oven/bun-linux-aarch64",
};

export type RuntimeBuildArgs = {
  target: TargetTriple;
  output: string;
  bun?: string;
};

export type RuntimeBuildResult = {
  output: string;
  manifest: RuntimeManifest;
  runtimeBinary: string;
  fileCount: number;
};

export type RuntimeBuildDeps = {
  sourceRoot?: string;
  installProductionDependencies?: (input: {
    bunPath: string;
    payloadRoot: string;
  }) => void | Promise<void>;
  smokeNativeModule?: (input: { bunPath: string; payloadRoot: string }) => void | Promise<void>;
  validateRuntimeHost?: (input: { bunPath: string; target: TargetTriple }) => void | Promise<void>;
  randomSuffix?: () => string;
};

export type RuntimeHostReport = {
  platform: string;
  arch: string;
  glibcVersionRuntime: string | null;
};

function fail(message: string): never {
  throw new Error(`runtime build failed: ${message}`);
}

function parseTarget(value: string): TargetTriple {
  if (!(TARGET_TRIPLES as readonly string[]).includes(value)) {
    fail(`unsupported target triple: ${value}`);
  }
  return value as TargetTriple;
}

export function parseBuildArgs(argv: string[]): RuntimeBuildArgs {
  let target: TargetTriple | undefined;
  let output: string | undefined;
  let bun: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--target" && flag !== "--output" && flag !== "--bun") {
      fail(`unknown argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`missing value for ${flag}`);
    }
    index += 1;
    if (flag === "--target") {
      if (target) fail("--target may only be specified once");
      target = parseTarget(value);
    } else if (flag === "--output") {
      if (output) fail("--output may only be specified once");
      output = value;
    } else {
      if (bun) fail("--bun may only be specified once");
      bun = value;
    }
  }
  if (!target) fail("--target is required");
  if (!output) fail("--output is required");
  return { target, output, ...(bun ? { bun } : {}) };
}

export function hostTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  linuxLibc: "gnu" | "musl" | null = detectLinuxLibc(),
): TargetTriple | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "linux" && linuxLibc !== "gnu") return null;
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

function detectLinuxLibc(): "gnu" | "musl" | null {
  if (process.platform !== "linux") return null;
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const header = report?.header;
    if (typeof header?.glibcVersionRuntime === "string" && header.glibcVersionRuntime.length > 0) {
      return "gnu";
    }
    const ldd = readFileSync("/usr/bin/ldd", "utf8");
    if (ldd.toLowerCase().includes("musl")) return "musl";
  } catch {
    return null;
  }
  return null;
}

export function runtimeBinaryName(target: TargetTriple): string {
  return `ocx-runtime-${target}${target.includes("windows") ? ".exe" : ""}`;
}

export function keyringPackageForTarget(target: TargetTriple): string {
  return KEYRING_PACKAGE_BY_TARGET[target];
}

export function keyringNativeFileForTarget(target: TargetTriple): string {
  return KEYRING_NATIVE_FILE_BY_TARGET[target];
}

export function bunPackageForTarget(target: TargetTriple): string {
  return BUN_PACKAGE_BY_TARGET[target];
}

function expectedMachine(target: TargetTriple): "x64" | "arm64" {
  return target.startsWith("aarch64-") ? "arm64" : "x64";
}

function readHeader(path: string): { bytes: Uint8Array; size: number; mode: number } {
  const meta = lstatSync(path);
  if (meta.isSymbolicLink() || !meta.isFile()) {
    fail("runtime binary must be a regular file");
  }
  if (meta.size < MIN_NATIVE_BINARY_BYTES) {
    fail("runtime binary is too small to be a real target runtime");
  }
  const fd = openSync(path, "r");
  try {
    const bytes = new Uint8Array(Math.min(4096, meta.size));
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, read), size: meta.size, mode: meta.mode };
  } finally {
    closeSync(fd);
  }
}

function uint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian);
}

function uint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

export function validateNativeBinaryForTarget(
  path: string,
  target: TargetTriple,
  options: { requireExecutable?: boolean } = {},
): void {
  const { bytes, mode } = readHeader(path);
  if (Buffer.from(bytes).toString("utf8").includes(SIDECAR_STUB_MARKER)) {
    fail("compile placeholder is not a real runtime binary");
  }
  const machine = expectedMachine(target);
  if ((options.requireExecutable ?? true) && !target.includes("windows") && (mode & 0o111) === 0) {
    fail("runtime binary is not executable");
  }
  if (target.includes("linux")) {
    if (
      bytes.length < 20
      || bytes[0] !== 0x7f
      || bytes[1] !== 0x45
      || bytes[2] !== 0x4c
      || bytes[3] !== 0x46
      || bytes[4] !== 2
      || (bytes[5] !== 1 && bytes[5] !== 2)
    ) {
      fail("runtime binary is not a 64-bit ELF");
    }
    const elfMachine = uint16(bytes, 18, bytes[5] === 1);
    const expected = machine === "x64" ? 62 : 183;
    if (elfMachine !== expected) fail("runtime binary architecture does not match target");
    return;
  }
  if (target.includes("windows")) {
    if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
      fail("runtime binary is not PE");
    }
    const peOffset = uint32(bytes, 0x3c, true);
    if (
      peOffset + 6 > bytes.length
      || bytes[peOffset] !== 0x50
      || bytes[peOffset + 1] !== 0x45
      || bytes[peOffset + 2] !== 0
      || bytes[peOffset + 3] !== 0
    ) {
      fail("runtime binary is not PE");
    }
    const peMachine = uint16(bytes, peOffset + 4, true);
    const expected = machine === "x64" ? 0x8664 : 0xaa64;
    if (peMachine !== expected) fail("runtime binary architecture does not match target");
    return;
  }
  if (bytes.length < 8) fail("runtime binary is not Mach-O");
  const magicLe = uint32(bytes, 0, true);
  const magicBe = uint32(bytes, 0, false);
  const littleEndian = magicLe === 0xfeedfacf;
  if (!littleEndian && magicBe !== 0xfeedfacf) fail("runtime binary is not a thin 64-bit Mach-O");
  const cpu = uint32(bytes, 4, littleEndian);
  const expected = machine === "x64" ? 0x01000007 : 0x0100000c;
  if (cpu !== expected) fail("runtime binary architecture does not match target");
}

export function validateRuntimeHostReport(report: RuntimeHostReport, target: TargetTriple): void {
  const expectedPlatform = target.includes("apple") ? "darwin" : target.includes("windows") ? "win32" : "linux";
  const expectedArch = target.startsWith("aarch64-") ? "arm64" : "x64";
  if (report.platform !== expectedPlatform || report.arch !== expectedArch) {
    fail("runtime process platform or architecture does not match target");
  }
  if (target.includes("linux-gnu") && !report.glibcVersionRuntime) {
    fail("runtime process does not report glibc for a GNU target");
  }
}

function validateRuntimeHost(input: { bunPath: string; target: TargetTriple }): void {
  const source = [
    "const header = process.report?.getReport?.().header;",
    "console.log(JSON.stringify({",
    "platform: process.platform,",
    "arch: process.arch,",
    "glibcVersionRuntime: typeof header?.glibcVersionRuntime === 'string' ? header.glibcVersionRuntime : null",
    "}));",
  ].join("");
  const result = spawnSync(input.bunPath, ["-e", source], {
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, BUN_INSPECT: "0" },
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) fail("runtime host report failed");
  let report: unknown;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch {
    fail("runtime host report is invalid");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) fail("runtime host report is invalid");
  const value = report as Record<string, unknown>;
  if (
    typeof value.platform !== "string"
    || typeof value.arch !== "string"
    || (value.glibcVersionRuntime !== null && typeof value.glibcVersionRuntime !== "string")
  ) {
    fail("runtime host report is invalid");
  }
  validateRuntimeHostReport(value as RuntimeHostReport, input.target);
}

function assertRealDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  const meta = lstatSync(resolved);
  if (meta.isSymbolicLink() || !meta.isDirectory()) fail(`${label} must be a real directory`);
  const real = realpathSync.native(resolved);
  const samePath = process.platform === "win32"
    ? real.toLowerCase() === resolved.toLowerCase()
    : real === resolved;
  if (!samePath) fail(`${label} must not traverse a symlink`);
  return resolved;
}

function forbiddenName(name: string): boolean {
  return /^\.env(?:\..*)?$/.test(name) || name === ".git";
}

function copyTreeStrict(source: string, destination: string, rel = ""): void {
  const sourceMeta = lstatSync(source);
  if (sourceMeta.isSymbolicLink()) fail(`symlink is not allowed: ${rel || basename(source)}`);
  if (forbiddenName(basename(source))) fail(`forbidden path: ${rel || basename(source)}`);
  if (sourceMeta.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (process.platform !== "win32") chmodSync(destination, sourceMeta.mode & 0o111 ? 0o755 : 0o644);
    if (lstatSync(source).isSymbolicLink()) fail(`source changed during copy: ${rel}`);
    return;
  }
  if (!sourceMeta.isDirectory()) fail(`unexpected file type: ${rel || basename(source)}`);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).sort()) {
    const childRel = rel ? `${rel}/${name}` : name;
    copyTreeStrict(join(source, name), join(destination, name), childRel);
  }
}

function copyRequiredSource(sourceRoot: string, payloadRoot: string): void {
  for (const rel of [...REQUIRED_SOURCE_PATHS, ...RUNTIME_ASSETS]) {
    const source = join(sourceRoot, rel);
    if (!existsSync(source)) fail(`missing required source path: ${rel}`);
    copyTreeStrict(source, join(payloadRoot, rel), rel);
  }
  for (const rel of REQUIRED_RUNTIME_FILES) {
    const path = join(payloadRoot, rel);
    if (!existsSync(path) || !lstatSync(path).isFile()) fail(`missing required runtime file: ${rel}`);
  }
}

function packagePath(nodeModules: string, packageName: string): string {
  return join(nodeModules, ...packageName.split("/"));
}

function readPackageJson(path: string): Record<string, unknown> {
  const meta = lstatSync(path);
  if (meta.isSymbolicLink() || !meta.isFile()) fail("package.json must be a regular file");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("package.json must be an object");
  return value as Record<string, unknown>;
}

function requiredProductionPackages(payloadRoot: string): string[] {
  const pkg = readPackageJson(join(payloadRoot, "package.json"));
  const dependencies = pkg.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    fail("package.json dependencies must be an object");
  }
  return Object.keys(dependencies as Record<string, unknown>).sort();
}

function pruneTargetPackages(nodeModules: string, scope: string, prefix: string, keep: string): void {
  const scopeDir = join(nodeModules, scope);
  if (!existsSync(scopeDir)) fail(`missing production package scope: ${scope}`);
  for (const name of readdirSync(scopeDir)) {
    if (!name.startsWith(prefix)) continue;
    const fullName = `${scope}/${name}`;
    const path = join(scopeDir, name);
    const meta = lstatSync(path);
    if (meta.isSymbolicLink()) fail(`symlink is not allowed: node_modules/${fullName}`);
    if (fullName !== keep) rmSync(path, { recursive: true, force: false });
  }
}

function verifyProductionClosure(payloadRoot: string, target: TargetTriple): void {
  const nodeModules = join(payloadRoot, "node_modules");
  const nodeModulesMeta = lstatSync(nodeModules);
  if (nodeModulesMeta.isSymbolicLink() || !nodeModulesMeta.isDirectory()) {
    fail("production node_modules is missing");
  }
  const binDir = join(nodeModules, ".bin");
  if (existsSync(binDir)) {
    const meta = lstatSync(binDir);
    if (meta.isSymbolicLink() || !meta.isDirectory()) fail("node_modules/.bin must be a real directory");
    rmSync(binDir, { recursive: true, force: false });
  }

  const expectedKeyring = KEYRING_PACKAGE_BY_TARGET[target];
  const expectedBun = BUN_PACKAGE_BY_TARGET[target];
  pruneTargetPackages(nodeModules, "@napi-rs", "keyring-", expectedKeyring);
  pruneTargetPackages(nodeModules, "@oven", "bun-", expectedBun);
  for (const name of [expectedKeyring, expectedBun]) {
    const path = packagePath(nodeModules, name);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
      fail(`missing target-native production dependency: ${name}`);
    }
  }

  for (const name of requiredProductionPackages(payloadRoot)) {
    const path = packagePath(nodeModules, name);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) fail(`missing production dependency: ${name}`);
  }
  const keyringNative = join(
    packagePath(nodeModules, expectedKeyring),
    KEYRING_NATIVE_FILE_BY_TARGET[target],
  );
  validateNativeBinaryForTarget(keyringNative, target, { requireExecutable: false });
}

function installProductionDependencies(input: { bunPath: string; payloadRoot: string }): void {
  const result = spawnSync(
    input.bunPath,
    ["install", "--production", "--frozen-lockfile", "--ignore-scripts"],
    {
      cwd: input.payloadRoot,
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    },
  );
  if (result.error || result.status !== 0) fail("production dependency installation failed");
}

function smokeNativeModule(input: { bunPath: string; payloadRoot: string }): void {
  const result = spawnSync(input.bunPath, ["-e", "await import('@napi-rs/keyring')"], {
    cwd: input.payloadRoot,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, NAPI_RS_ENFORCE_VERSION_CHECK: "1" },
  });
  if (result.error || result.status !== 0) fail("target-native keyring smoke failed");
}

function executableBit(mode: number): boolean {
  return process.platform !== "win32" && (mode & 0o111) !== 0;
}

function defaultBunPath(sourceRoot: string): string {
  // The Bun npm package uses bin/bun.exe on every supported platform.
  return join(sourceRoot, "node_modules", "bun", "bin", "bun.exe");
}

function isTrackedPlaceholder(path: string): boolean {
  if (!existsSync(path)) return false;
  const meta = lstatSync(path);
  if (meta.isSymbolicLink() || !meta.isDirectory()) return false;
  const entries = readdirSync(path);
  if (entries.length !== 1 || entries[0] !== ".keep") return false;
  const keep = lstatSync(join(path, ".keep"));
  return !keep.isSymbolicLink() && keep.isFile();
}

export async function buildRuntimePayload(
  args: RuntimeBuildArgs,
  deps: RuntimeBuildDeps = {},
): Promise<RuntimeBuildResult> {
  const sourceRoot = assertRealDirectory(deps.sourceRoot ?? REPO_ROOT, "source root");
  const host = hostTargetTriple();
  if (!host || host !== args.target) {
    fail(`target ${args.target} must be built on its matching target host`);
  }
  const bunPath = resolve(args.bun ?? defaultBunPath(sourceRoot));
  validateNativeBinaryForTarget(bunPath, args.target);
  await (deps.validateRuntimeHost ?? validateRuntimeHost)({ bunPath, target: args.target });

  const requestedOutput = resolve(args.output);
  const outputParent = assertRealDirectory(dirname(requestedOutput), "output parent");
  const output = join(outputParent, basename(requestedOutput));
  const replacePlaceholder = isTrackedPlaceholder(output);
  if (existsSync(output) && !replacePlaceholder) fail("output already exists");
  const copiedSources = [...REQUIRED_SOURCE_PATHS, ...RUNTIME_ASSETS].map(rel => join(sourceRoot, rel));
  const sameOrInside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (
    output === sourceRoot
    || sameOrInside(output, sourceRoot)
    || copiedSources.some(source => sameOrInside(source, output))
  ) {
    fail("output overlaps a runtime source path");
  }
  const suffix = deps.randomSuffix?.() ?? randomBytes(8).toString("hex");
  const tempRoot = join(outputParent, `.${basename(output)}.tmp-${suffix}`);
  if (existsSync(tempRoot)) fail("temporary output already exists");
  mkdirSync(tempRoot, { recursive: false, mode: 0o700 });

  let published = false;
  try {
    copyRequiredSource(sourceRoot, tempRoot);
    await (deps.installProductionDependencies ?? installProductionDependencies)({
      bunPath,
      payloadRoot: tempRoot,
    });
    verifyProductionClosure(tempRoot, args.target);

    const runtimeBinary = runtimeBinaryName(args.target);
    copyFileSync(bunPath, join(tempRoot, runtimeBinary));
    if (!args.target.includes("windows")) chmodSync(join(tempRoot, runtimeBinary), 0o755);
    validateNativeBinaryForTarget(join(tempRoot, runtimeBinary), args.target);

    const installedBun = join(tempRoot, "node_modules", "bun", "bin", "bun.exe");
    mkdirSync(dirname(installedBun), { recursive: true });
    copyFileSync(bunPath, installedBun);
    if (!args.target.includes("windows")) chmodSync(installedBun, 0o755);

    await (deps.smokeNativeModule ?? smokeNativeModule)({ bunPath, payloadRoot: tempRoot });

    const walked = walkRegularFiles(tempRoot);
    if (!walked.ok) fail(`${walked.code}: ${walked.message}`);
    const packageJson = readPackageJson(join(tempRoot, "package.json"));
    const version = packageJson.version;
    if (typeof version !== "string") fail("package.json version is invalid");
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId(version, args.target),
      version,
      target: args.target,
      root: tempRoot,
      files: walked.files.map(file => ({ path: file.path, executable: executableBit(file.stat.mode) })),
      enforceExecutableBit: process.platform !== "win32",
    });
    if (!created.ok) fail(`${created.code}: ${created.message}`);
    const written = writeRuntimeManifestFile(tempRoot, created.manifest);
    if (!written.ok) fail(`${written.code}: ${written.message}`);
    const verified = verifyRuntimeTree(tempRoot, created.manifest, {
      expectedTarget: args.target,
      enforceExecutableBit: process.platform !== "win32",
      allowManifestFile: true,
    });
    if (!verified.ok) fail(`${verified.code}: ${verified.message}`);

    if (replacePlaceholder) {
      const placeholderBackup = join(outputParent, `.${basename(output)}.placeholder-${suffix}`);
      renameSync(output, placeholderBackup);
      try {
        renameSync(tempRoot, output);
      } catch (error) {
        renameSync(placeholderBackup, output);
        throw error;
      }
      published = true;
      try {
        rmSync(placeholderBackup, { recursive: true, force: false });
      } catch {
        // The payload is already atomically published; a leftover empty placeholder
        // backup is harmless and must not turn a successful build into a false failure.
      }
    } else {
      renameSync(tempRoot, output);
      published = true;
    }
    return {
      output,
      manifest: created.manifest,
      runtimeBinary: join(output, runtimeBinary),
      fileCount: created.manifest.files.length,
    };
  } finally {
    if (!published && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    const result = await buildRuntimePayload(parseBuildArgs(process.argv.slice(2)));
    console.log(
      `build-runtime: ok (target=${result.manifest.target}, files=${result.fileCount}, manifest=${MANIFEST_FILE_NAME})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "runtime build failed");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
