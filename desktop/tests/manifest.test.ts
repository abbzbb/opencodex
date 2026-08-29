import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MANIFEST_SCHEMA_VERSION,
  TARGET_TRIPLES,
  createRuntimeManifestFromFiles,
  parseRuntimeManifest,
  runtimeManifestId,
  sha256Bytes,
  validateRelativeRuntimePath,
  verifyRuntimeTree,
  writeRuntimeManifestFile,
  type TargetTriple,
} from "../runtime/manifest";

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

function packageJson(version: string, extra: Record<string, unknown> = {}): string {
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

function closedManifest(files: Array<{ path: string; sha256: string; executable: boolean }>, extra?: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    id: runtimeManifestId("2.35.0", TARGET),
    version: "2.35.0",
    target: TARGET,
    files,
    ...extra,
  };
}

describe("closed runtime manifest schema", () => {
  test("schemaVersion is 1 and target triples are the closed Desktop set", () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(1);
    expect([...TARGET_TRIPLES]).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ]);
  });

  test("accepts a closed object and canonicalizes file order", () => {
    const pkg = packageJson("2.35.0");
    const bin = "#!/bin/sh\necho ok\n";
    const parsed = parseRuntimeManifest(
      closedManifest([
        {
          path: "ocx-runtime-x86_64-unknown-linux-gnu",
          sha256: sha256Bytes(new TextEncoder().encode(bin)),
          executable: true,
        },
        {
          path: "package.json",
          sha256: sha256Bytes(new TextEncoder().encode(pkg)),
          executable: false,
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.files.map((file) => file.path)).toEqual([
        "ocx-runtime-x86_64-unknown-linux-gnu",
        "package.json",
      ]);
    }
  });

  test("rejects unknown fields, missing fields, and non-hex hashes", () => {
    expect(parseRuntimeManifest(closedManifest([], { extra: true })).ok).toBe(false);
    const missing = parseRuntimeManifest({
      schemaVersion: 1,
      id: "manifest-1",
      version: "2.35.0",
      target: TARGET,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("invalid_manifest");
    }
    const badHash = parseRuntimeManifest(
      closedManifest([
        {
          path: "package.json",
          sha256: "ABCDef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          executable: false,
        },
      ]),
    );
    expect(badHash.ok).toBe(false);
  });

  test("rejects target triples outside the closed allowlist", () => {
    const parsed = parseRuntimeManifest(
      closedManifest(
        [
          {
            path: "package.json",
            sha256: sha256Bytes(new TextEncoder().encode("{}\n")),
            executable: false,
          },
        ],
        { target: "x86_64-unknown-linux-musl" },
      ),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("invalid_manifest");
    }
  });
});

describe("relative path contract", () => {
  test("rejects traversal, absolute paths, and Windows path shapes", () => {
    const rejected = [
      "../escape",
      "..",
      "./foo",
      "/etc/passwd",
      "C:\\Windows\\System32\\cmd.exe",
      "foo\\bar",
      "foo/../../etc/passwd",
      "foo//bar",
      "foo/./bar",
      "",
      "foo:",
    ];
    for (const path of rejected) {
      const result = validateRelativeRuntimePath(path);
      expect(result.ok).toBe(false);
    }
  });

  test("rejects .env, current.json, and nested runtime-manifest.json", () => {
    expect(validateRelativeRuntimePath(".env").ok).toBe(false);
    expect(validateRelativeRuntimePath(".env.local").ok).toBe(false);
    expect(validateRelativeRuntimePath("config/.env").ok).toBe(false);
    expect(validateRelativeRuntimePath("current.json").ok).toBe(false);
    expect(validateRelativeRuntimePath("runtime-manifest.json").ok).toBe(false);
    expect(validateRelativeRuntimePath(".git/config").ok).toBe(false);
    expect(validateRelativeRuntimePath("src/cli/index.ts").ok).toBe(true);
  });
});

describe("tree verification", () => {
  test("verifies SHA-256 and rejects a tampered payload file", () => {
    const root = tempDir("ocx-manifest-tamper-");
    writeFile(root, "package.json", packageJson("2.35.0"));
    writeFile(root, "bin/run.sh", "#!/bin/sh\necho 1\n", true);
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "bin/run.sh", executable: true },
      ],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    writeFile(root, "bin/run.sh", "#!/bin/sh\necho tampered\n", true);
    const verified = verifyRuntimeTree(root, created.manifest, {
      expectedTarget: TARGET,
      enforceExecutableBit: POSIX,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("hash_mismatch");
    }
  });

  test("rejects a target mismatch against the expected triple", () => {
    const parsed = parseRuntimeManifest(
      closedManifest([
        {
          path: "package.json",
          sha256: sha256Bytes(new TextEncoder().encode(packageJson("2.35.0"))),
          executable: false,
        },
      ]),
      { expectedTarget: "aarch64-apple-darwin" },
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("target_mismatch");
    }
  });

  test("rejects unexpected extra files", () => {
    const root = tempDir("ocx-manifest-extra-");
    writeFile(root, "package.json", packageJson("2.35.0"));
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [{ path: "package.json", executable: false }],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    writeFile(root, "notes.txt", "leftover\n");
    const verified = verifyRuntimeTree(root, created.manifest, { enforceExecutableBit: POSIX });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("unexpected_file");
    }
  });

  test("rejects a missing listed file", () => {
    const root = tempDir("ocx-manifest-missing-");
    writeFile(root, "package.json", packageJson("2.35.0"));
    writeFile(root, "bin/run.sh", "ok\n", true);
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "bin/run.sh", executable: true },
      ],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    rmSync(join(root, "bin", "run.sh"));
    const verified = verifyRuntimeTree(root, created.manifest, { enforceExecutableBit: POSIX });
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.code).toBe("missing_file");
    }
  });

  test("rejects a symlink in the payload tree", () => {
    const root = tempDir("ocx-manifest-symlink-");
    writeFile(root, "package.json", packageJson("2.35.0"));
    symlinkSync(join(root, "package.json"), join(root, "link.json"));
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "link.json", executable: false },
      ],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.code).toBe("symlink_forbidden");
    }
  });

  test("rejects an intermediate directory symlink used as a path escape", () => {
    const root = tempDir("ocx-manifest-dirlink-");
    const outside = tempDir("ocx-manifest-outside-");
    writeFile(outside, "secret.txt", "secret\n");
    writeFile(root, "package.json", packageJson("2.35.0"));
    symlinkSync(outside, join(root, "vendor"));
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "vendor/secret.txt", executable: false },
      ],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.code).toBe("symlink_forbidden");
    }
  });

  test("rejects an executable-bit mismatch when enforcement is on", () => {
    if (!POSIX) {
      return;
    }
    const root = tempDir("ocx-manifest-exec-");
    writeFile(root, "package.json", packageJson("2.35.0"));
    writeFile(root, "bin/run.sh", "#!/bin/sh\necho 1\n", false);
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "bin/run.sh", executable: true },
      ],
      enforceExecutableBit: true,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.code).toBe("executable_bit_mismatch");
    }
  });

  test("does not treat an executable-bit mismatch as fatal when enforcement is off", () => {
    const root = tempDir("ocx-manifest-exec-off-");
    writeFile(root, "package.json", packageJson("2.35.0"));
    writeFile(root, "bin/run.sh", "#!/bin/sh\necho 1\n", false);
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "bin/run.sh", executable: true },
      ],
      enforceExecutableBit: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const verified = verifyRuntimeTree(root, created.manifest, { enforceExecutableBit: false });
    expect(verified.ok).toBe(true);
  });

  test("allows a package that is both a production and development dependency", () => {
    const root = tempDir("ocx-manifest-prod-dev-");
    writeFile(
      root,
      "package.json",
      packageJson("2.35.0", {
        dependencies: { typescript: "5.0.0" },
        devDependencies: { typescript: "5.0.0" },
      }),
    );
    writeFile(root, "node_modules/typescript/index.js", "module.exports = {}\n");
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "node_modules/typescript/index.js", executable: false },
      ],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(true);
  });

  test("rejects .env and development dependency paths", () => {
    const root = tempDir("ocx-manifest-forbidden-");
    writeFile(
      root,
      "package.json",
      packageJson("2.35.0", { devDependencies: { typescript: "5.0.0" } }),
    );
    writeFile(root, "node_modules/typescript/index.js", "module.exports = {}\n");
    writeFile(root, ".env", "SECRET=1\n");
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [
        { path: "package.json", executable: false },
        { path: "node_modules/typescript/index.js", executable: false },
      ],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.code).toBe("forbidden_file");
    }
  });

  test("writes a canonical manifest file beside the payload", () => {
    const root = tempDir("ocx-manifest-write-");
    writeFile(root, "package.json", packageJson("2.35.0"));
    const created = createRuntimeManifestFromFiles({
      id: runtimeManifestId("2.35.0", TARGET),
      version: "2.35.0",
      target: TARGET,
      root,
      files: [{ path: "package.json", executable: false }],
      enforceExecutableBit: POSIX,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const written = writeRuntimeManifestFile(root, created.manifest);
    expect(written.ok).toBe(true);
    const verified = verifyRuntimeTree(root, created.manifest, { enforceExecutableBit: POSIX });
    expect(verified.ok).toBe(true);
  });
});
