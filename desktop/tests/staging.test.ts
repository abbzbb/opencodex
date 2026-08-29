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
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createRuntimeManifestFromFiles,
  parseRuntimeManifest,
  runtimeManifestId,
  sha256File,
  writeRuntimeManifestFile,
  type TargetTriple,
} from "../runtime/manifest";
import {
  CURRENT_LOCK_NAME,
  CURRENT_POINTER_NAME,
  STABLE_STAGING_DIR,
  STABLE_VERSIONS_DIR,
  STORE_LOCK_INCOMPLETE_GRACE_MS,
  activateRuntime,
  publishCurrent,
  readCurrentPointer,
  resolveRuntimeByManifestId,
  rollbackCurrent,
  serializeStoreLockRecord,
  stageRuntime,
  verifyPublishedCurrent,
  type StoreLockRecord,
} from "../runtime/staging";

const TARGET: TargetTriple = "x86_64-unknown-linux-gnu";
const POSIX = process.platform !== "win32";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function writeFile(root: string, rel: string, content: string, executable = false): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (POSIX) {
    chmodSync(abs, executable ? 0o755 : 0o644);
  }
}

function packageJson(
  version: string,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify(
    {
      name: "ocx-runtime",
      version,
      dependencies: { bun: "1.4.0" },
      ...extra,
    },
    null,
    2,
  )}\n`;
}

function writePayload(
  version: string,
  options: {
    extra?: Record<string, string>;
    packageExtra?: Record<string, unknown>;
  } = {},
): { root: string; id: string } {
  const root = tempDir(`ocx-runtime-src-${version}-`);
  const files: Array<{ path: string; executable: boolean }> = [
    { path: "package.json", executable: false },
    { path: `ocx-runtime-${TARGET}`, executable: true },
    { path: "src/cli/index.ts", executable: false },
  ];
  writeFile(root, "package.json", packageJson(version, options.packageExtra));
  writeFile(root, `ocx-runtime-${TARGET}`, "#!/bin/sh\necho ocx\n", true);
  writeFile(root, "src/cli/index.ts", `export const version = "${version}";\n`);
  const created = createRuntimeManifestFromFiles({
    id: runtimeManifestId(version, TARGET),
    version,
    target: TARGET,
    root,
    files,
    enforceExecutableBit: POSIX,
  });
  if (!created.ok) {
    throw new Error(`${created.code}: ${created.message}`);
  }
  const written = writeRuntimeManifestFile(root, created.manifest);
  if (!written.ok) {
    throw new Error(`${written.code}: ${written.message}`);
  }
  if (options.extra) {
    for (const [rel, content] of Object.entries(options.extra)) {
      writeFile(root, rel, content);
    }
  }
  return { root, id: created.manifest.id };
}

function writeListedDevDepPayload(version: string): { root: string } {
  const root = tempDir(`ocx-runtime-devdep-${version}-`);
  writeFile(root, "package.json", packageJson(version, { devDependencies: { typescript: "5.0.0" } }));
  writeFile(root, `ocx-runtime-${TARGET}`, "#!/bin/sh\necho ocx\n", true);
  writeFile(root, "node_modules/typescript/index.js", "module.exports = {}\n");
  const files = [
    { path: "package.json", executable: false },
    { path: `ocx-runtime-${TARGET}`, executable: true },
    { path: "node_modules/typescript/index.js", executable: false },
  ];
  const entries = files.map((file) => {
    const hashed = sha256File(join(root, ...file.path.split("/")));
    if (!hashed.ok) {
      throw new Error(hashed.message);
    }
    return { path: file.path, sha256: hashed.sha256, executable: file.executable };
  });
  const parsed = parseRuntimeManifest({
    schemaVersion: 1,
    id: runtimeManifestId(version, TARGET),
    version,
    target: TARGET,
    files: entries,
  });
  if (!parsed.ok) {
    throw new Error(`${parsed.code}: ${parsed.message}`);
  }
  writeRuntimeManifestFile(root, parsed.manifest);
  return { root };
}

function versions(stableRoot: string): string[] {
  const dir = join(stableRoot, STABLE_VERSIONS_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).sort();
}

function plantLock(stableRoot: string, record: StoreLockRecord): string {
  const path = join(stableRoot, CURRENT_LOCK_NAME);
  writeFileSync(path, serializeStoreLockRecord(record));
  return path;
}

describe("stable staging transaction", () => {
  test("current.json publish never unlinks the live pointer", () => {
    const source = readFileSync(join(import.meta.dir, "../runtime/staging.ts"), "utf8");
    expect(source).toContain("A valid current.json is never unlinked before the replacement is published.");
    expect(source).not.toMatch(/unlinkSync\(destPath\)/);
    expect(source).not.toMatch(/unlinkSync\(dest\)/);
  });

  test("stages into versions/<version> and publishes current.json", () => {
    const payload = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-stable-");
    const activated = activateRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(activated.ok).toBe(true);
    if (!activated.ok) {
      return;
    }
    expect(activated.pointer.current.version).toBe("2.35.0");
    expect(activated.pointer.previous).toBeNull();
    expect(activated.absPath).toBe(join(stableRoot, "versions", "2.35.0"));
    expect(existsSync(join(activated.absPath, "package.json"))).toBe(true);
    expect(existsSync(join(activated.absPath, ".env"))).toBe(false);
    expect(lstatSync(join(stableRoot, CURRENT_POINTER_NAME)).isSymbolicLink()).toBe(false);
    const published = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(published.ok).toBe(true);
  });

  test("keeps exactly one rollback generation and prunes older trees", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const v3 = writePayload("2.37.0");
    const stableRoot = tempDir("ocx-runtime-rollback-gen-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.pointer.current.version).toBe("2.36.0");
    expect(second.pointer.previous?.version).toBe("2.35.0");
    expect(versions(stableRoot)).toEqual(["2.35.0", "2.36.0"]);
    const third = activateRuntime({
      sourceRoot: v3.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: second.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) {
      return;
    }
    expect(third.pointer.current.version).toBe("2.37.0");
    expect(third.pointer.previous?.version).toBe("2.36.0");
    expect(versions(stableRoot)).toEqual(["2.36.0", "2.37.0"]);
    expect(existsSync(join(stableRoot, "versions", "2.35.0"))).toBe(false);
  });

  test("rollback swaps current to the retained previous generation", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-rollback-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const rolled = rollbackCurrent({
      stableRoot,
      expectedCurrent: second.pointer.current,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) {
      return;
    }
    expect(rolled.pointer.current.version).toBe("2.35.0");
    expect(rolled.pointer.previous?.version).toBe("2.36.0");
    expect(versions(stableRoot)).toEqual(["2.35.0", "2.36.0"]);
    const verified = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(readFileSync(join(verified.absPath, "src/cli/index.ts"), "utf8")).toContain("2.35.0");
    }
  });

  test("a held current.lock fails closed and leaves the previous current usable", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-lock-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    writeFileSync(join(stableRoot, "current.lock"), "stale\n");
    const failed = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("lock_held");
    }
    const live = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer.current.version).toBe("2.35.0");
    }
  });

  test("compare-and-swap rejects a stale expected current and leaves the live pointer", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-cas-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const staged = stageRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) {
      return;
    }
    const published = publishCurrent({
      stableRoot,
      staged: staged.staged,
      expectedCurrent: null,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(published.ok).toBe(false);
    if (!published.ok) {
      expect(published.code).toBe("cas_mismatch");
    }
    const live = readCurrentPointer(stableRoot);
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer?.current.version).toBe("2.35.0");
    }
  });

  test("a partial copy failure leaves the previous current usable", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-partial-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const failed = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
      hooks: { failCopyOf: "src/cli/index.ts" },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("io_error");
    }
    const live = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer.current.version).toBe("2.35.0");
    }
    expect(existsSync(join(stableRoot, "versions", "2.36.0"))).toBe(false);
    expect(existsSync(join(stableRoot, STABLE_STAGING_DIR)) ? readdirSync(join(stableRoot, STABLE_STAGING_DIR)) : []).toEqual(
      [],
    );
  });

  test("tamper after copy blocks activation and keeps the previous current", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-tamper-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const failed = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
      hooks: {
        afterCopyFile(relPath) {
          if (relPath === "src/cli/index.ts") {
            const dest = join(
              stableRoot,
              STABLE_STAGING_DIR,
              readdirSync(join(stableRoot, STABLE_STAGING_DIR))[0] ?? "",
              "src",
              "cli",
              "index.ts",
            );
            writeFileSync(dest, 'export const version = "tampered";\n');
          }
        },
      },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("hash_mismatch");
    }
    const live = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer.current.version).toBe("2.35.0");
    }
  });

  test("rejects a path-escape payload without publishing", () => {
    const payload = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-escape-");
    const failed = activateRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
      manifest: {
        schemaVersion: 1,
        id: runtimeManifestId("2.35.0", TARGET),
        version: "2.35.0",
        target: TARGET,
        files: [
          {
            path: "../outside.txt",
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            executable: false,
          },
        ],
      },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("path_escape");
    }
    const live = readCurrentPointer(stableRoot);
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer).toBeNull();
    }
  });

  test("rejects a symlink in the source tree and leaves current usable", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    symlinkSync(join(v2.root, "package.json"), join(v2.root, "alias.json"));
    const stableRoot = tempDir("ocx-runtime-symlink-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const failed = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("symlink_forbidden");
    }
    const live = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer.current.version).toBe("2.35.0");
    }
  });

  test("never copies .env or development dependencies", () => {
    const v1 = writePayload("2.35.0");
    const envPayload = writePayload("2.36.0", { extra: { ".env": "SECRET=1\n" } });
    const stableRoot = tempDir("ocx-runtime-env-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const envFailed = activateRuntime({
      sourceRoot: envPayload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(envFailed.ok).toBe(false);
    if (!envFailed.ok) {
      expect(envFailed.code).toBe("forbidden_file");
    }
    expect(existsSync(join(stableRoot, "versions", "2.36.0"))).toBe(false);

    const devPayload = writePayload("2.36.1", {
      packageExtra: { devDependencies: { typescript: "5.0.0" } },
      extra: { "node_modules/typescript/index.js": "module.exports = {}\n" },
    });
    const devFailed = activateRuntime({
      sourceRoot: devPayload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(devFailed.ok).toBe(false);
    if (!devFailed.ok) {
      expect(["forbidden_file", "unexpected_file"]).toContain(devFailed.code);
    }
    const live = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer.current.version).toBe("2.35.0");
      expect(existsSync(join(live.absPath, ".env"))).toBe(false);
      expect(existsSync(join(live.absPath, "node_modules", "typescript"))).toBe(false);
    }
  });

  test("rejects a listed development dependency and an executable-bit mismatch", () => {
    const listed = writeListedDevDepPayload("2.38.0");
    const stableRoot = tempDir("ocx-runtime-dev-listed-");
    const listedFailed = activateRuntime({
      sourceRoot: listed.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(listedFailed.ok).toBe(false);
    if (!listedFailed.ok) {
      expect(listedFailed.code).toBe("forbidden_file");
    }

    if (!POSIX) {
      return;
    }
    const execRoot = tempDir("ocx-runtime-exec-src-");
    writeFile(execRoot, "package.json", packageJson("2.39.0"));
    writeFile(execRoot, `ocx-runtime-${TARGET}`, "#!/bin/sh\necho ocx\n", false);
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.39.0", TARGET),
      version: "2.39.0",
      target: TARGET,
      root: execRoot,
      files: [
        { path: "package.json", executable: false },
        { path: `ocx-runtime-${TARGET}`, executable: true },
      ],
      enforceExecutableBit: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    writeRuntimeManifestFile(execRoot, created.manifest);
    const execFailed = activateRuntime({
      sourceRoot: execRoot,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: true,
    });
    expect(execFailed.ok).toBe(false);
    if (!execFailed.ok) {
      expect(execFailed.code).toBe("executable_bit_mismatch");
    }
  });

  test("stage-only does not publish current.json", () => {
    const payload = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-stage-only-");
    const staged = stageRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) {
      return;
    }
    expect(existsSync(staged.absPath)).toBe(true);
    const live = readCurrentPointer(stableRoot);
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer).toBeNull();
    }
  });

  test("resolves a staged manifest id only after hash verification", () => {
    const payload = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-resolve-");
    const activated = activateRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(activated.ok).toBe(true);
    if (!activated.ok) {
      return;
    }
    const resolved = resolveRuntimeByManifestId({
      stableRoot,
      manifestId: payload.id,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.pointer.version).toBe("2.35.0");
    }
    writeFileSync(join(stableRoot, "versions", "2.35.0", "src/cli/index.ts"), "tamper\n");
    const tampered = resolveRuntimeByManifestId({
      stableRoot,
      manifestId: payload.id,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) {
      expect(tampered.code).toBe("hash_mismatch");
    }
  });

  test("retains a referenced extra generation instead of pruning it", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const v3 = writePayload("2.37.0");
    const stableRoot = tempDir("ocx-runtime-retain-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const third = activateRuntime({
      sourceRoot: v3.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: second.pointer.current,
      enforceExecutableBit: POSIX,
      isVersionReferenced(relPath) {
        return relPath === "versions/2.35.0";
      },
    });
    expect(third.ok).toBe(true);
    if (!third.ok) {
      return;
    }
    expect(third.retained).toEqual(["versions/2.35.0"]);
    expect(versions(stableRoot)).toEqual(["2.35.0", "2.36.0", "2.37.0"]);
  });

  test("staging and versions child symlinks cannot escape the stable root", () => {
    const payload = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-child-symlink-");
    const outside = tempDir("ocx-runtime-escape-target-");
    writeFileSync(join(outside, "sentinel.txt"), "keep\n");

    symlinkSync(outside, join(stableRoot, STABLE_STAGING_DIR));
    const stagingFailed = activateRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(stagingFailed.ok).toBe(false);
    if (!stagingFailed.ok) {
      expect(stagingFailed.code).toBe("symlink_forbidden");
    }
    expect(readdirSync(outside).sort()).toEqual(["sentinel.txt"]);
    expect(existsSync(join(stableRoot, CURRENT_POINTER_NAME))).toBe(false);

    unlinkSync(join(stableRoot, STABLE_STAGING_DIR));
    symlinkSync(outside, join(stableRoot, STABLE_VERSIONS_DIR));
    const versionsFailed = activateRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(versionsFailed.ok).toBe(false);
    if (!versionsFailed.ok) {
      expect(versionsFailed.code).toBe("symlink_forbidden");
    }
    expect(readdirSync(outside).sort()).toEqual(["sentinel.txt"]);
    expect(existsSync(join(stableRoot, CURRENT_POINTER_NAME))).toBe(false);
  });

  test("a dead-owner current.lock is reclaimed and an incomplete lock is recovered after grace", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-lock-crash-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    plantLock(stableRoot, {
      schemaVersion: 1,
      token: "dead-owner",
      pid: 2_147_483_647,
      createdAt: 0,
    });
    const recovered = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
      hooks: { isAlive: () => false },
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) {
      return;
    }
    expect(recovered.pointer.current.version).toBe("2.36.0");
    expect(existsSync(join(stableRoot, CURRENT_LOCK_NAME))).toBe(false);

    writeFileSync(join(stableRoot, CURRENT_LOCK_NAME), "");
    const v3 = writePayload("2.37.0");
    const incomplete = activateRuntime({
      sourceRoot: v3.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: recovered.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) {
      expect(incomplete.code).toBe("lock_held");
    }
    const liveDuringGrace = readCurrentPointer(stableRoot);
    expect(liveDuringGrace.ok).toBe(true);
    if (liveDuringGrace.ok) {
      expect(liveDuringGrace.pointer?.current.version).toBe("2.36.0");
    }

    const aged = new Date(Date.now() - STORE_LOCK_INCOMPLETE_GRACE_MS - 1_000);
    utimesSync(join(stableRoot, CURRENT_LOCK_NAME), aged, aged);
    const afterGrace = activateRuntime({
      sourceRoot: v3.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: recovered.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(afterGrace.ok).toBe(true);
    if (afterGrace.ok) {
      expect(afterGrace.pointer.current.version).toBe("2.37.0");
    }
  });

  test("lock reclaim and release never unlink a successor lock", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-lock-successor-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const lockPath = plantLock(stableRoot, {
      schemaVersion: 1,
      token: "stale-owner",
      pid: 2_147_483_647,
      createdAt: 0,
    });
    const successor = serializeStoreLockRecord({
      schemaVersion: 1,
      token: "successor-owner",
      pid: process.pid,
      createdAt: 10,
    });
    const reclaimFailed = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
      hooks: {
        isAlive: (pid) => pid === process.pid,
        beforeStaleReclaim() {
          unlinkSync(lockPath);
          writeFileSync(lockPath, successor);
        },
      },
    });
    expect(reclaimFailed.ok).toBe(false);
    if (!reclaimFailed.ok) {
      expect(reclaimFailed.code).toBe("lock_held");
    }
    expect(readFileSync(lockPath, "utf8")).toBe(successor);
    const live = readCurrentPointer(stableRoot);
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer?.current.version).toBe("2.35.0");
    }

    unlinkSync(lockPath);
    const releaseSuccessor = serializeStoreLockRecord({
      schemaVersion: 1,
      token: "release-successor",
      pid: process.pid,
      createdAt: 11,
    });
    const staged = stageRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
      hooks: {
        beforeReleaseUnlink() {
          unlinkSync(lockPath);
          writeFileSync(lockPath, releaseSuccessor);
        },
      },
    });
    expect(staged.ok).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(releaseSuccessor);
  });

  test("a current.lock symlink is rejected and the target is not unlinked", () => {
    const payload = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-lock-symlink-");
    const outside = tempDir("ocx-runtime-lock-target-");
    const target = join(outside, "lock-target");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(stableRoot, CURRENT_LOCK_NAME));
    const failed = activateRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("symlink_forbidden");
    }
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(join(stableRoot, CURRENT_LOCK_NAME)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(stableRoot, CURRENT_POINTER_NAME))).toBe(false);
  });

  test("a directory current.lock fails closed without recursive deletion", () => {
    const payload = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-lock-dir-");
    mkdirSync(join(stableRoot, CURRENT_LOCK_NAME));
    writeFileSync(join(stableRoot, CURRENT_LOCK_NAME, "sentinel"), "keep\n");
    const failed = activateRuntime({
      sourceRoot: payload.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("unexpected_file");
    }
    expect(readFileSync(join(stableRoot, CURRENT_LOCK_NAME, "sentinel"), "utf8")).toBe("keep\n");
    expect(existsSync(join(stableRoot, CURRENT_POINTER_NAME))).toBe(false);
  });

  test("replacement identity reuses a matching tree and refuses to overwrite a live generation", () => {
    const v1 = writePayload("2.35.0");
    const stableRoot = tempDir("ocx-runtime-replace-id-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const reused = stageRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(reused.ok).toBe(true);
    if (reused.ok) {
      expect(reused.reused).toBe(true);
    }

    writeFileSync(join(stableRoot, STABLE_VERSIONS_DIR, "2.35.0", "src/cli/index.ts"), "tamper\n");
    const replacement = writePayload("2.35.0");
    const refused = activateRuntime({
      sourceRoot: replacement.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: POSIX,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("version_in_use");
    }
    const pointer = readCurrentPointer(stableRoot);
    expect(pointer.ok).toBe(true);
    if (pointer.ok) {
      expect(pointer.pointer?.current.version).toBe("2.35.0");
      expect(pointer.pointer?.current.id).toBe(first.pointer.current.id);
    }
  });

  test("a failed current.json replace leaves the previous pointer bytes in place", () => {
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-pointer-preserve-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: POSIX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const staged = stageRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) {
      return;
    }
    const before = readFileSync(join(stableRoot, CURRENT_POINTER_NAME));
    let sawExistingPointer = false;
    const published = publishCurrent({
      stableRoot,
      staged: staged.staged,
      expectedCurrent: first.pointer.current,
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
      hooks: {
        beforeCurrentRename() {
          sawExistingPointer = existsSync(join(stableRoot, CURRENT_POINTER_NAME));
        },
        failCurrentRename: true,
      },
    });
    expect(published.ok).toBe(false);
    if (!published.ok) {
      expect(published.code).toBe("io_error");
    }
    expect(sawExistingPointer).toBe(true);
    expect(readFileSync(join(stableRoot, CURRENT_POINTER_NAME)).equals(before)).toBe(true);
    const live = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer.current.version).toBe("2.35.0");
    }
  });

  test("an executable-bit mismatch after copy blocks publish and keeps the previous current", () => {
    if (!POSIX) {
      return;
    }
    const v1 = writePayload("2.35.0");
    const v2 = writePayload("2.36.0");
    const stableRoot = tempDir("ocx-runtime-exec-copy-");
    const first = activateRuntime({
      sourceRoot: v1.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: null,
      enforceExecutableBit: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const failed = activateRuntime({
      sourceRoot: v2.root,
      stableRoot,
      expectedTarget: TARGET,
      expectedCurrent: first.pointer.current,
      enforceExecutableBit: true,
      hooks: {
        afterCopyFile(relPath) {
          if (relPath === `ocx-runtime-${TARGET}`) {
            const stagingRoot = join(stableRoot, STABLE_STAGING_DIR);
            const tempName = readdirSync(stagingRoot)[0] ?? "";
            chmodSync(join(stagingRoot, tempName, relPath), 0o644);
          }
        },
      },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("executable_bit_mismatch");
    }
    const live = verifyPublishedCurrent(stableRoot, {
      expectedTarget: TARGET,
      enforceExecutableBit: true,
    });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.pointer.current.version).toBe("2.35.0");
    }
  });
});
