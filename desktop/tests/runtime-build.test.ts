import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildRuntimePayload,
  bunPackageForTarget,
  hostTargetTriple,
  keyringNativeFileForTarget,
  keyringPackageForTarget,
  parseBuildArgs,
  runtimeBinaryName,
  validateNativeBinaryForTarget,
  validateRuntimeHostReport,
  type RuntimeBuildDeps,
} from "../scripts/build-runtime";
import {
  MANIFEST_FILE_NAME,
  TARGET_TRIPLES,
  readRuntimeManifestFile,
  verifyRuntimeTree,
  walkRegularFiles,
  type TargetTriple,
} from "../runtime/manifest";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function currentTarget(): TargetTriple {
  const target = hostTargetTriple();
  if (!target) throw new Error("test host is outside the closed Desktop target set");
  return target;
}

function sameOsOtherArch(target: TargetTriple): TargetTriple {
  if (target.startsWith("aarch64-")) return target.replace("aarch64-", "x86_64-") as TargetTriple;
  return target.replace("x86_64-", "aarch64-") as TargetTriple;
}

function writeRegular(path: string, content: string | Uint8Array, executable = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (process.platform !== "win32") chmodSync(path, executable ? 0o755 : 0o644);
}

function writeNative(path: string, target: TargetTriple, executable: boolean, marker?: string): void {
  const bytes = new Uint8Array(4096);
  if (target.includes("linux")) {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    new DataView(bytes.buffer).setUint16(18, target.startsWith("aarch64-") ? 183 : 62, true);
  } else if (target.includes("windows")) {
    bytes.set([0x4d, 0x5a], 0);
    new DataView(bytes.buffer).setUint32(0x3c, 0x80, true);
    bytes.set([0x50, 0x45, 0, 0], 0x80);
    new DataView(bytes.buffer).setUint16(0x84, target.startsWith("aarch64-") ? 0xaa64 : 0x8664, true);
  } else {
    bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
    new DataView(bytes.buffer).setUint32(4, target.startsWith("aarch64-") ? 0x0100000c : 0x01000007, true);
  }
  if (marker) bytes.set(new TextEncoder().encode(marker), 256);
  writeRegular(path, bytes, executable);
}

function packageJson(): string {
  return `${JSON.stringify(
    {
      name: "fixture-runtime",
      version: "2.36.0",
      dependencies: {
        "@napi-rs/keyring": "1.3.0",
        bun: "1.4.0",
      },
      devDependencies: { typescript: "7.0.2" },
    },
    null,
    2,
  )}\n`;
}

type Fixture = {
  root: string;
  bunPath: string;
  output: string;
  target: TargetTriple;
};

function sourceFixture(): Fixture {
  const root = tempDir("ocx-runtime-build-source-");
  const outputParent = tempDir("ocx-runtime-build-output-");
  const target = currentTarget();
  writeRegular(join(root, "package.json"), packageJson());
  writeRegular(join(root, "bun.lock"), "fixture-lock\n");
  writeRegular(join(root, "src/cli/index.ts"), "export {};\n");
  writeRegular(join(root, "gui/dist/index.html"), "<!doctype html>\n");
  writeRegular(join(root, "desktop/runtime/bootstrap.ts"), "export {};\n");
  writeRegular(join(root, "desktop/runtime/install.ts"), "export {};\n");
  for (const asset of ["architecture.png", "banner.png", "claude-code-models.gif", "codex-app-picker.png"]) {
    writeRegular(join(root, "assets", asset), `fixture:${asset}\n`);
  }
  const bunPath = join(root, "tooling", "bun");
  writeNative(bunPath, target, true);
  return { root, bunPath, output: join(outputParent, "runtime"), target };
}

function writePackage(nodeModules: string, name: string): string {
  const root = join(nodeModules, ...name.split("/"));
  writeRegular(join(root, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
  return root;
}

function fixtureDeps(
  fixture: Fixture,
  options: { wrongKeyring?: boolean; devLeak?: boolean; outputSymlink?: boolean } = {},
): RuntimeBuildDeps {
  return {
    sourceRoot: fixture.root,
    randomSuffix: () => "fixture",
    installProductionDependencies: ({ payloadRoot }) => {
      const nodeModules = join(payloadRoot, "node_modules");
      writePackage(nodeModules, "bun");
      writePackage(nodeModules, "@napi-rs/keyring");
      const nativeTarget = options.wrongKeyring ? sameOsOtherArch(fixture.target) : fixture.target;
      const keyringPackage = keyringPackageForTarget(nativeTarget);
      const keyringRoot = writePackage(nodeModules, keyringPackage);
      writeNative(join(keyringRoot, keyringNativeFileForTarget(nativeTarget)), nativeTarget, false);
      writePackage(nodeModules, bunPackageForTarget(fixture.target));
      if (options.devLeak) writePackage(nodeModules, "typescript");
      if (options.outputSymlink && process.platform !== "win32") {
        symlinkSync(join(payloadRoot, "package.json"), join(nodeModules, "linked-package.json"));
      }
    },
    validateRuntimeHost: () => {},
    smokeNativeModule: () => {},
  };
}

describe("runtime build arguments and target binaries", () => {
  test("accepts the closed CLI and rejects unknown or cross-target input", () => {
    const target = currentTarget();
    expect(parseBuildArgs(["--target", target, "--output", "out", "--bun", "bun"]).target).toBe(target);
    expect(() => parseBuildArgs(["--target", "x86_64-unknown-linux-musl", "--output", "out"])).toThrow(
      "unsupported target triple",
    );
    expect(() => parseBuildArgs(["--target", target, "--output", "out", "--extra", "x"])).toThrow(
      "unknown argument",
    );
    expect(runtimeBinaryName("x86_64-pc-windows-msvc")).toEndWith(".exe");
    expect(runtimeBinaryName("x86_64-unknown-linux-gnu")).not.toEndWith(".exe");
    expect(hostTargetTriple("linux", "x64", "musl")).toBeNull();
    expect(hostTargetTriple("linux", "x64", null)).toBeNull();
    expect(hostTargetTriple("linux", "x64", "gnu")).toBe("x86_64-unknown-linux-gnu");
  });

  test("rejects compile placeholders and the wrong architecture", () => {
    const root = tempDir("ocx-runtime-build-binary-");
    const target = currentTarget();
    const stub = join(root, "stub");
    writeNative(stub, target, true, "OCX_DESKTOP_SIDECAR_STUB");
    expect(() => validateNativeBinaryForTarget(stub, target)).toThrow("compile placeholder");
    const wrong = join(root, "wrong");
    writeNative(wrong, sameOsOtherArch(target), true);
    expect(() => validateNativeBinaryForTarget(wrong, target)).toThrow("architecture");

    const malformedElf = join(root, "malformed-elf");
    writeNative(malformedElf, "x86_64-unknown-linux-gnu", true);
    const elfBytes = new Uint8Array(readFileSync(malformedElf));
    elfBytes[4] = 1;
    writeRegular(malformedElf, elfBytes, true);
    expect(() => validateNativeBinaryForTarget(malformedElf, "x86_64-unknown-linux-gnu")).toThrow(
      "64-bit ELF",
    );

    const malformedPe = join(root, "malformed-pe.exe");
    writeNative(malformedPe, "x86_64-pc-windows-msvc", false);
    const peBytes = new Uint8Array(readFileSync(malformedPe));
    peBytes[0x82] = 1;
    writeRegular(malformedPe, peBytes, false);
    expect(() => validateNativeBinaryForTarget(malformedPe, "x86_64-pc-windows-msvc")).toThrow(
      "not PE",
    );
  });

  test("requires the executed runtime to report the target platform, arch, and glibc", () => {
    expect(() => validateRuntimeHostReport(
      { platform: "linux", arch: "x64", glibcVersionRuntime: "2.41" },
      "x86_64-unknown-linux-gnu",
    )).not.toThrow();
    expect(() => validateRuntimeHostReport(
      { platform: "linux", arch: "x64", glibcVersionRuntime: null },
      "x86_64-unknown-linux-gnu",
    )).toThrow("does not report glibc");
    expect(() => validateRuntimeHostReport(
      { platform: "linux", arch: "arm64", glibcVersionRuntime: "2.41" },
      "x86_64-unknown-linux-gnu",
    )).toThrow("platform or architecture");
  });
});

describe("target runtime payload", () => {
  test("publishes a verified complete manifest after all payload files", async () => {
    const fixture = sourceFixture();
    mkdirSync(fixture.output);
    writeRegular(join(fixture.output, ".keep"), "");
    const built = await buildRuntimePayload(
      { target: fixture.target, output: fixture.output, bun: fixture.bunPath },
      fixtureDeps(fixture),
    );
    expect(built.output).toBe(fixture.output);
    expect(existsSync(join(fixture.output, runtimeBinaryName(fixture.target)))).toBe(true);
    const loaded = readRuntimeManifestFile(join(fixture.output, MANIFEST_FILE_NAME), {
      expectedTarget: fixture.target,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const verified = verifyRuntimeTree(fixture.output, loaded.manifest, {
      expectedTarget: fixture.target,
      enforceExecutableBit: process.platform !== "win32",
      allowManifestFile: true,
    });
    expect(verified.ok).toBe(true);
    const walked = walkRegularFiles(fixture.output);
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    const actual = walked.files.map(file => file.path).filter(path => path !== MANIFEST_FILE_NAME);
    expect(loaded.manifest.files.map(file => file.path)).toEqual(actual);
    const manifestTime = lstatSync(join(fixture.output, MANIFEST_FILE_NAME)).mtimeMs;
    const latestPayloadTime = Math.max(
      ...walked.files.filter(file => file.path !== MANIFEST_FILE_NAME).map(file => file.stat.mtimeMs),
    );
    expect(manifestTime).toBeGreaterThanOrEqual(latestPayloadTime);
    expect(existsSync(join(fixture.output, ".keep"))).toBe(false);
    expect(readdirSync(dirname(fixture.output)).some(name => name.includes(".placeholder-"))).toBe(false);
  });

  test("fails closed on missing GUI, forbidden env files, and source symlinks", async () => {
    const missing = sourceFixture();
    rmSync(join(missing.root, "gui/dist"), { recursive: true });
    await expect(
      buildRuntimePayload(
        { target: missing.target, output: missing.output, bun: missing.bunPath },
        fixtureDeps(missing),
      ),
    ).rejects.toThrow("missing required source path: gui/dist");
    expect(existsSync(missing.output)).toBe(false);

    const forbidden = sourceFixture();
    writeRegular(join(forbidden.root, "src/.env.local"), "SECRET=redacted\n");
    await expect(
      buildRuntimePayload(
        { target: forbidden.target, output: forbidden.output, bun: forbidden.bunPath },
        fixtureDeps(forbidden),
      ),
    ).rejects.toThrow("forbidden path");
    expect(existsSync(forbidden.output)).toBe(false);

    if (process.platform !== "win32") {
      const linked = sourceFixture();
      symlinkSync(join(linked.root, "package.json"), join(linked.root, "src/linked.ts"));
      await expect(
        buildRuntimePayload(
          { target: linked.target, output: linked.output, bun: linked.bunPath },
          fixtureDeps(linked),
        ),
      ).rejects.toThrow("symlink is not allowed");
      expect(existsSync(linked.output)).toBe(false);
    }
  });

  test("rejects wrong native packages, dev leakage, and generated symlinks", async () => {
    const wrong = sourceFixture();
    await expect(buildRuntimePayload(
      { target: wrong.target, output: wrong.output, bun: wrong.bunPath },
      fixtureDeps(wrong, { wrongKeyring: true }),
    )).rejects.toThrow("missing target-native production dependency");
    expect(existsSync(wrong.output)).toBe(false);

    const leaked = sourceFixture();
    await expect(buildRuntimePayload(
      { target: leaked.target, output: leaked.output, bun: leaked.bunPath },
      fixtureDeps(leaked, { devLeak: true }),
    )).rejects.toThrow("development dependency is not allowed");
    expect(existsSync(leaked.output)).toBe(false);

    if (process.platform !== "win32") {
      const linked = sourceFixture();
      await expect(buildRuntimePayload(
        { target: linked.target, output: linked.output, bun: linked.bunPath },
        fixtureDeps(linked, { outputSymlink: true }),
      )).rejects.toThrow("symlink is not allowed");
      expect(existsSync(linked.output)).toBe(false);
    }
  });

  test("refuses cross-target builds and preserves an existing output", async () => {
    const fixture = sourceFixture();
    await expect(
      buildRuntimePayload(
        { target: sameOsOtherArch(fixture.target), output: fixture.output, bun: fixture.bunPath },
        fixtureDeps(fixture),
      ),
    ).rejects.toThrow("matching target host");

    mkdirSync(fixture.output);
    writeRegular(join(fixture.output, "marker.txt"), "keep\n");
    await expect(
      buildRuntimePayload(
        { target: fixture.target, output: fixture.output, bun: fixture.bunPath },
        fixtureDeps(fixture),
      ),
    ).rejects.toThrow("output already exists");
    expect(readFileSync(join(fixture.output, "marker.txt"), "utf8")).toBe("keep\n");
  });
});

test("closed target list stays synchronized with host mapping", () => {
  expect(TARGET_TRIPLES).toContain(currentTarget());
});
