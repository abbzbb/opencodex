import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createRuntimeManifestFromFiles,
  runtimeManifestId,
  writeRuntimeManifestFile,
  type TargetTriple,
} from "../runtime/manifest";
import {
  EXIT_PROTOCOL_FAILURE,
  EXIT_RUNTIME_FAILURE,
  EXIT_SUCCESS,
  parseInstallRequest,
  runInstall,
} from "../runtime/install";
import { readCurrentPointer } from "../runtime/staging";

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
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(root: string, rel: string, content: string, executable = false): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (POSIX) chmodSync(abs, executable ? 0o755 : 0o644);
}

function payload(version: string): string {
  const root = tempDir(`ocx-install-source-${version}-`);
  const files = [
    { path: "package.json", executable: false },
    { path: `ocx-runtime-${TARGET}`, executable: true },
    { path: "src/cli/index.ts", executable: false },
    { path: "desktop/runtime/bootstrap.ts", executable: false },
    { path: "desktop/runtime/install.ts", executable: false },
  ];
  writeFile(root, "package.json", `${JSON.stringify({ name: "ocx-runtime", version, dependencies: {} })}\n`);
  writeFile(root, `ocx-runtime-${TARGET}`, "#!/bin/sh\nexit 0\n", true);
  writeFile(root, "src/cli/index.ts", "export {};\n");
  writeFile(root, "desktop/runtime/bootstrap.ts", "export {};\n");
  writeFile(root, "desktop/runtime/install.ts", "export {};\n");
  const created = createRuntimeManifestFromFiles({
    id: runtimeManifestId(version, TARGET),
    version,
    target: TARGET,
    root,
    files,
    enforceExecutableBit: POSIX,
  });
  if (!created.ok) throw new Error(created.message);
  const written = writeRuntimeManifestFile(root, created.manifest);
  if (!written.ok) throw new Error(written.message);
  return root;
}

async function invoke(options: Parameters<typeof runInstall>[0]): Promise<{ code: number; text: string; value: any }> {
  let text = "";
  const code = await runInstall({
    ...options,
    writeStdout(bytes) {
      text += new TextDecoder().decode(bytes);
    },
  });
  return { code, text, value: JSON.parse(text) };
}

describe("packaged runtime installer protocol", () => {
  test("accepts only the exact request schema", () => {
    const stableRoot = tempDir("ocx-install-request-");
    expect(parseInstallRequest({ schemaVersion: 1, target: TARGET, stableRoot }).ok).toBe(true);
    expect(parseInstallRequest({ schemaVersion: 1, target: TARGET, stableRoot, sourceRoot: "/tmp" }).ok).toBe(false);
    expect(parseInstallRequest({ schemaVersion: 2, target: TARGET, stableRoot }).ok).toBe(false);
    expect(parseInstallRequest({ schemaVersion: 1, target: "x86_64-unknown-linux-musl", stableRoot }).ok).toBe(false);
    expect(parseInstallRequest({ schemaVersion: 1, target: TARGET, stableRoot: "relative" }).ok).toBe(false);
  });

  test("publishes a verified first runtime and emits one path-free JSON object", async () => {
    const sourceRoot = payload("2.36.0");
    const stableRoot = tempDir("ocx-install-stable-");
    const result = await invoke({
      cwd: sourceRoot,
      stdin: JSON.stringify({ schemaVersion: 1, target: TARGET, stableRoot }),
    });
    expect(result.code).toBe(EXIT_SUCCESS);
    expect(result.text.endsWith("\n")).toBe(true);
    expect(result.text.indexOf("\n")).toBe(result.text.length - 1);
    expect(result.value.ok).toBe(true);
    expect(result.value.result.published).toBe(true);
    expect(result.value.result.current.version).toBe("2.36.0");
    expect(result.text).not.toContain(sourceRoot);
    expect(result.text).not.toContain(stableRoot);
    const current = readCurrentPointer(stableRoot);
    expect(current.ok && current.pointer?.current.version === "2.36.0").toBe(true);
  });

  test("protocol errors have exit 2 and never echo input paths", async () => {
    const stableRoot = tempDir("ocx-install-protocol-");
    const result = await invoke({
      stdin: JSON.stringify({ schemaVersion: 1, target: TARGET, stableRoot, sourceRoot: "/secret/source" }),
    });
    expect(result.code).toBe(EXIT_PROTOCOL_FAILURE);
    expect(result.value).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: "protocol_mismatch",
        message: "runtime install request is invalid",
        retryable: false,
      },
    });
    expect(result.text).not.toContain(stableRoot);
    expect(result.text).not.toContain("/secret/source");
  });

  test("store failures are fixed, path-free, and only lock contention is retryable", async () => {
    const sourceRoot = payload("2.36.0");
    const stableRoot = tempDir("ocx-install-runtime-failure-");
    const base = { cwd: sourceRoot, stdin: JSON.stringify({ schemaVersion: 1, target: TARGET, stableRoot }) };
    const locked = await invoke({
      ...base,
      syncRuntime: () => ({ ok: false, code: "lock_held", message: `locked at ${stableRoot}` }),
    });
    expect(locked.code).toBe(EXIT_RUNTIME_FAILURE);
    expect(locked.value.error.retryable).toBe(true);
    expect(locked.text).not.toContain(stableRoot);

    const failed = await invoke({
      ...base,
      syncRuntime: () => ({ ok: false, code: "hash_mismatch", message: `bad ${sourceRoot}` }),
    });
    expect(failed.code).toBe(EXIT_RUNTIME_FAILURE);
    expect(failed.value.error.retryable).toBe(false);
    expect(failed.text).not.toContain(sourceRoot);
  });

  test("rejects source and stable root overlap before invoking the store", async () => {
    const sourceRoot = payload("2.36.0");
    let called = false;
    const result = await invoke({
      cwd: sourceRoot,
      stdin: JSON.stringify({
        schemaVersion: 1,
        target: TARGET,
        stableRoot: join(sourceRoot, "runtime"),
      }),
      syncRuntime: () => {
        called = true;
        throw new Error("must not run");
      },
    });
    expect(result.code).toBe(EXIT_RUNTIME_FAILURE);
    expect(called).toBe(false);
    expect(result.text).not.toContain(sourceRoot);
  });
});
