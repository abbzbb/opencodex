#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readRuntimeManifestFile } from "../runtime/manifest";
import { LINUX_DEB_APP_REL, LINUX_DEB_PACKAGE, LINUX_DEB_RUNTIME_REL, LINUX_DEB_SIDECAR_REL } from "./probe-linux-deb";
import { LINUX_X64_TARGET, copyTree, fail, runtimeBinaryName } from "./probe-c-support";

export type PackedRuntimeDeb = {
  deb: string;
  sha256: string;
  version: string;
  package: typeof LINUX_DEB_PACKAGE;
};

function debianControl(version: string): string {
  return [
    `Package: ${LINUX_DEB_PACKAGE}`,
    "Architecture: amd64",
    `Version: ${version}`,
    "Maintainer: OpenCodex Desktop Probe <probe@example.test>",
    "Description: OpenCodex runtime-layout probe package (no GUI)",
    "Section: utils",
    "Priority: optional",
    "",
  ].join("\n");
}

export function packLinuxRuntimeDeb(input: {
  runtimeRoot: string;
  outputDeb: string;
}): PackedRuntimeDeb {
  const runtimeRoot = resolve(input.runtimeRoot);
  const outputDeb = resolve(input.outputDeb);
  const manifest = readRuntimeManifestFile(join(runtimeRoot, "runtime-manifest.json"), {
    expectedTarget: LINUX_X64_TARGET,
  });
  if (!manifest.ok) fail("runtime manifest is missing");
  const bunName = runtimeBinaryName(LINUX_X64_TARGET);
  const bunPath = join(runtimeRoot, bunName);
  if (!existsSync(bunPath)) fail("runtime binary is missing");
  const stage = mkdtempSync(join(tmpdir(), "ocx-runtime-deb-"));
  try {
    const debian = join(stage, "DEBIAN");
    mkdirSync(debian, { recursive: true, mode: 0o755 });
    writeFileSync(join(debian, "control"), debianControl(manifest.manifest.version));
    const sidecar = join(stage, LINUX_DEB_SIDECAR_REL);
    mkdirSync(join(stage, "usr/bin"), { recursive: true, mode: 0o755 });
    copyFileSync(bunPath, sidecar);
    chmodSync(sidecar, 0o755);
    const payload = join(stage, LINUX_DEB_RUNTIME_REL);
    mkdirSync(payload, { recursive: true, mode: 0o755 });
    copyTree(runtimeRoot, payload);
    if (existsSync(join(stage, LINUX_DEB_APP_REL))) fail("runtime-layout deb must not ship a GUI binary");
    const built = spawnSync("dpkg-deb", ["-b", stage, outputDeb], { stdio: "ignore" });
    if (built.status !== 0 || !existsSync(outputDeb)) fail("dpkg-deb failed");
    const sha256 = createHash("sha256").update(readFileSync(outputDeb)).digest("hex");
    return {
      deb: outputDeb,
      sha256,
      version: manifest.manifest.version,
      package: LINUX_DEB_PACKAGE,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): { runtimeRoot: string; output: string } {
  let runtimeRoot: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--runtime-root") {
      if (!value) fail("--runtime-root requires a path");
      runtimeRoot = resolve(value);
      index += 1;
    } else if (arg === "--output") {
      if (!value) fail("--output requires a path");
      output = resolve(value);
      index += 1;
    } else {
      fail("unknown argument");
    }
  }
  if (!runtimeRoot || !output) fail("--runtime-root and --output are required");
  return { runtimeRoot, output };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const packed = packLinuxRuntimeDeb({ runtimeRoot: args.runtimeRoot, outputDeb: args.output });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      package: packed.package,
      version: packed.version,
      sha256: packed.sha256,
      name: basename(packed.deb),
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "pack failed"}\n`);
    process.exit(1);
  }
}
