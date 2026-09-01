import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LINUX_DEB_APP_REL,
  LINUX_DEB_RUNTIME_REL,
  LINUX_DEB_SIDECAR_REL,
  LINUX_DEB_STATUS_REQUEST_ID,
  LINUX_DEB_TARGET,
  linuxDebLayout,
  parseProbeArgs,
  pinDebArtifact,
  readBoundedStream,
  runChild,
  validateExtractedLinuxDeb,
  validateStableRuntime,
  validateStoppedStatusEnvelope,
} from "../scripts/probe-linux-deb";
import {
  createRuntimeManifestFromFiles,
  runtimeManifestId,
  writeRuntimeManifestFile,
} from "../runtime/manifest";
import {
  keyringNativeFileForTarget,
  keyringPackageForTarget,
  runtimeBinaryName,
} from "../scripts/build-runtime";

const tempDirs: string[] = [];
const linuxX64Test = process.platform === "linux" && process.arch === "x64" ? test : test.skip;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-linux-deb-fixture-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function writeRegular(path: string, bytes: string | Uint8Array, executable = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  if (process.platform !== "win32") chmodSync(path, executable ? 0o755 : 0o644);
}

function elf(marker?: string): Uint8Array {
  const bytes = new Uint8Array(4096);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  new DataView(bytes.buffer).setUint16(18, 62, true);
  if (marker) bytes.set(new TextEncoder().encode(marker), 256);
  return bytes;
}

function bundleFixture(options: { cliPath?: string } = {}): ReturnType<typeof linuxDebLayout> {
  const layout = linuxDebLayout(tempDir());
  writeRegular(layout.appPath, elf(), true);
  writeRegular(layout.sidecarPath, elf(), true);

  const runtimeBinary = runtimeBinaryName(LINUX_DEB_TARGET);
  const keyring = `node_modules/${keyringPackageForTarget(LINUX_DEB_TARGET)}/${keyringNativeFileForTarget(LINUX_DEB_TARGET)}`;
  const cliPath = options.cliPath ?? "src/cli/index.ts";
  const files = [
    { path: "package.json", executable: false },
    { path: cliPath, executable: false },
    { path: "desktop/runtime/bootstrap.ts", executable: false },
    { path: "desktop/runtime/install.ts", executable: false },
    { path: "gui/dist/index.html", executable: false },
    { path: runtimeBinary, executable: true },
    { path: keyring, executable: false },
  ];
  writeRegular(join(layout.runtimeRoot, "package.json"), `${JSON.stringify({ version: "2.36.0" })}\n`);
  writeRegular(join(layout.runtimeRoot, cliPath), "export {};\n");
  writeRegular(join(layout.runtimeRoot, "desktop/runtime/bootstrap.ts"), "export {};\n");
  writeRegular(join(layout.runtimeRoot, "desktop/runtime/install.ts"), "export {};\n");
  writeRegular(join(layout.runtimeRoot, "gui/dist/index.html"), "<!doctype html>\n");
  writeRegular(join(layout.runtimeRoot, runtimeBinary), readFileSync(layout.sidecarPath), true);
  writeRegular(join(layout.runtimeRoot, keyring), elf());
  const created = createRuntimeManifestFromFiles({
    id: runtimeManifestId("2.36.0", LINUX_DEB_TARGET),
    version: "2.36.0",
    target: LINUX_DEB_TARGET,
    root: layout.runtimeRoot,
    files,
    enforceExecutableBit: process.platform !== "win32",
  });
  if (!created.ok) throw new Error(created.message);
  const written = writeRuntimeManifestFile(layout.runtimeRoot, created.manifest);
  if (!written.ok) throw new Error(written.message);
  return layout;
}

describe("Linux Debian package probe", () => {
  test("parses only one explicit Debian artifact", () => {
    const digest = "a".repeat(64);
    expect(parseProbeArgs(["--deb", "bundle.deb", "--sha256", digest])).toEqual({
      deb: join(process.cwd(), "bundle.deb"),
      sha256: digest,
    });
    expect(() => parseProbeArgs([])).toThrow("--deb is required");
    expect(() => parseProbeArgs(["--target", LINUX_DEB_TARGET])).toThrow("unknown argument");
    expect(() => parseProbeArgs(["--deb", "a"])).toThrow("--sha256 is required");
    expect(() => parseProbeArgs(["--deb", "a", "--sha256", "bad"])).toThrow("lowercase SHA-256");
    expect(() => parseProbeArgs([
      "--deb", "a", "--deb", "b", "--sha256", digest,
    ])).toThrow("only be specified once");
  });

  test("stops consuming child output at the hard byte limit", async () => {
    let killed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
        controller.close();
      },
    });
    await expect(readBoundedStream(stream, "fixture", () => {
      killed = true;
    }, 8)).rejects.toThrow("exceeded the output limit");
    expect(killed).toBe(true);
  });

  linuxX64Test("kills and awaits a child that exceeds its deadline", async () => {
    const started = Date.now();
    const result = await runChild(
      [process.execPath, "-e", "await Bun.sleep(10_000)"],
      {
        cwd: tempDir(),
        env: { PATH: "", LANG: "C.UTF-8" },
        timeout: 25,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("pins and hashes a private artifact snapshot before later use", () => {
    const root = tempDir();
    const source = join(root, "source.deb");
    const probeRoot = tempDir();
    writeRegular(source, "trusted artifact bytes");
    const digest = createHash("sha256").update("trusted artifact bytes").digest("hex");
    const pinned = pinDebArtifact(source, probeRoot, digest);
    writeRegular(source, "replacement bytes");
    expect(readFileSync(pinned.path, "utf8")).toBe("trusted artifact bytes");
    expect(pinned.sha256).toBe(digest);

    const mismatchRoot = tempDir();
    expect(() => pinDebArtifact(source, mismatchRoot, "0".repeat(64))).toThrow(
      "does not match the trusted expected digest",
    );
  });

  linuxX64Test("accepts the exact Tauri Linux layout with identical runtime copies", () => {
    const layout = bundleFixture();
    const validated = validateExtractedLinuxDeb(layout.extractRoot);
    expect(validated.appPath).toEndWith(LINUX_DEB_APP_REL);
    expect(validated.sidecarPath).toEndWith(LINUX_DEB_SIDECAR_REL);
    expect(validated.runtimeRoot).toEndWith(LINUX_DEB_RUNTIME_REL);
    expect(validated.sidecarSha256).toBe(validated.runtimeSha256);
    expect(validated.manifest.target).toBe(LINUX_DEB_TARGET);
    expect(validated.manifest.files.length).toBe(7);
  });

  linuxX64Test("rejects a sidecar that differs from the resource manifest", () => {
    const layout = bundleFixture();
    writeRegular(layout.sidecarPath, elf("different-runtime"), true);
    expect(() => validateExtractedLinuxDeb(layout.extractRoot)).toThrow("hashes must match");
  });

  linuxX64Test("requires exact entrypoint files and re-verifies the stable generation", () => {
    const descendant = bundleFixture({ cliPath: "src/cli/index.ts/placeholder" });
    expect(() => validateExtractedLinuxDeb(descendant.extractRoot)).toThrow(
      "missing required entry: src/cli/index.ts",
    );

    const stable = bundleFixture();
    const validated = validateExtractedLinuxDeb(stable.extractRoot);
    expect(() => validateStableRuntime(stable.runtimeRoot, validated.manifest)).not.toThrow();
    writeRegular(join(stable.runtimeRoot, "gui/dist/index.html"), "tampered\n");
    expect(() => validateStableRuntime(stable.runtimeRoot, validated.manifest)).toThrow(
      "stable runtime verification failed",
    );
  });

  test("requires the status response to correlate to the fixed request", () => {
    const result = {
      status: "stopped",
      origin: null,
      pid: null,
      version: null,
      owner: "existing-external",
      service: { installed: false, startable: false, stateCode: "absent" },
      allowedMutations: [],
    };
    expect(() => validateStoppedStatusEnvelope({
      schemaVersion: 1,
      requestId: LINUX_DEB_STATUS_REQUEST_ID,
      ok: true,
      operation: "status",
      result,
    })).not.toThrow();
    expect(() => validateStoppedStatusEnvelope({
      schemaVersion: 1,
      requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      ok: true,
      operation: "status",
      result,
    })).toThrow("bridge status did not succeed");
  });

  linuxX64Test("rejects symlinked or relocated installed paths", () => {
    const linked = bundleFixture();
    const outside = join(tempDir(), "outside-runtime");
    copyFileSync(linked.sidecarPath, outside);
    rmSync(linked.sidecarPath);
    symlinkSync(outside, linked.sidecarPath);
    expect(() => validateExtractedLinuxDeb(linked.extractRoot)).toThrow("must not contain a symlink");

    const moved = bundleFixture();
    const wrong = join(moved.extractRoot, "usr/lib/OpenCodex/runtime");
    renameSync(moved.runtimeRoot, wrong);
    expect(() => validateExtractedLinuxDeb(moved.extractRoot)).toThrow("missing expected bundle path");
  });
});
