import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POSTINSTALL_BASE_IMAGE,
  POSTINSTALL_INSTALLED_RUNTIME,
  dockerCreateArgs,
  dockerfileFromImage,
  parseDockerBuildImageId,
  postInstallDockerfilePath,
  validateDebControlDirectory,
  validatePostInstallSummary,
  type PostInstallSummary,
} from "../scripts/probe-linux-deb-postinstall";
import {
  FORBIDDEN_HOST_COMMANDS,
  validatePublishedCurrentPointer,
} from "../scripts/probe-linux-deb-postinstall-container";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-deb-control-"));
  tempDirs.push(dir);
  return dir;
}

function validSummary(): PostInstallSummary {
  return {
    schemaVersion: 1,
    package: "open-codex",
    version: "2.36.0",
    architecture: "amd64",
    target: "x86_64-unknown-linux-gnu",
    installed: true,
    appLaunched: true,
    stableRuntime: "published",
    bridgeStatus: "ready",
    owner: "desktop-direct",
    health: "ok",
    readiness: "ready",
    stop: "stopped",
    proxyAbsent: true,
    packageRemoved: true,
    webviewEvidence: false,
  };
}

describe("Linux Debian post-install probe", () => {
  test("uses a digest-pinned Debian 13 base and a private reaping container", () => {
    expect(POSTINSTALL_BASE_IMAGE).toMatch(/^debian:trixie-slim@sha256:[a-f0-9]{64}$/);
    const imageId = `sha256:${"b".repeat(64)}`;
    const args = dockerCreateArgs(imageId, "a".repeat(64));
    expect(args).toContain("--init");
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("EXPECTED_DEB_SHA256=" + "a".repeat(64));
    expect(args.at(-1)).toBe(imageId);
  });

  test("Dockerfile FROM is exactly POSTINSTALL_BASE_IMAGE", () => {
    const dockerfile = readFileSync(postInstallDockerfilePath(), "utf8");
    expect(dockerfileFromImage(dockerfile)).toBe(POSTINSTALL_BASE_IMAGE);
  });

  test("creates the container from the immutable build image ID", () => {
    const imageId = parseDockerBuildImageId(`sha256:${"b".repeat(64)}\n`);
    expect(imageId).toBe(`sha256:${"b".repeat(64)}`);
    expect(dockerCreateArgs(imageId, "a".repeat(64)).at(-1)).toBe(imageId);
    expect(() => parseDockerBuildImageId("probe:image\n")).toThrow("image build failed");
    expect(() => dockerCreateArgs("ocx-desktop-postinstall-probe:debian13", "a".repeat(64))).toThrow("invalid probe image id");
  });

  test("forbids host node, bun, npm, ocx, and Codex CLI", () => {
    expect([...FORBIDDEN_HOST_COMMANDS]).toEqual(["node", "bun", "npm", "ocx", "opencodex", "codex"]);
  });

  test("importing the container harness does not start main", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../scripts/probe-linux-deb-postinstall-container.ts"),
      "utf8",
    );
    expect(source).toMatch(/\nif \(import\.meta\.main\) \{\n  main\(\)\.catch/);
    expect(source).not.toMatch(/\nmain\(\)\.catch/);
  });

  test("current pointer must match the stable manifest identity", () => {
    const manifest = {
      id: "ocx-runtime-2.36.0-x86_64-unknown-linux-gnu",
      version: "2.36.0",
      target: "x86_64-unknown-linux-gnu",
    };
    const pointer = {
      schemaVersion: 1,
      current: {
        id: manifest.id,
        version: manifest.version,
        target: manifest.target,
        relPath: "versions/2.36.0",
      },
      previous: null,
    };
    expect(() => validatePublishedCurrentPointer(pointer, manifest, "2.36.0")).not.toThrow();
    expect(() => validatePublishedCurrentPointer({
      ...pointer,
      current: { ...pointer.current, id: "other" },
    }, manifest, "2.36.0")).toThrow("disagrees with the stable manifest");
    expect(() => validatePublishedCurrentPointer({
      ...pointer,
      current: { ...pointer.current, version: "0.0.1" },
    }, manifest, "2.36.0")).toThrow("disagrees with the stable manifest");
    expect(() => validatePublishedCurrentPointer({
      ...pointer,
      current: { ...pointer.current, target: "aarch64-unknown-linux-gnu" },
    }, manifest, "2.36.0")).toThrow("disagrees with the stable manifest");
    expect(() => validatePublishedCurrentPointer({
      ...pointer,
      current: { ...pointer.current, relPath: "versions/other" },
    }, manifest, "2.36.0")).toThrow("disagrees with the stable manifest");
    expect(() => validatePublishedCurrentPointer({
      ...pointer,
      previous: pointer.current,
    }, manifest, "2.36.0")).toThrow("previous runtime");
  });

  test("entrypoint independently proves package and resource-tree removal", () => {
    const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/probe-linux-deb-postinstall-entrypoint.sh"), "utf8");
    expect(script).toContain(`[ ! -e ${POSTINSTALL_INSTALLED_RUNTIME} ]`);
    expect(script).toContain("db:Status-Status");
    expect(script).toContain("[ \"$pkg_status\" != installed ]");
  });

  test("accepts only the complete installed-app lifecycle proof", () => {
    expect(validatePostInstallSummary(validSummary())).toEqual(validSummary());

    for (const [field, value] of [
      ["readiness", "failed"],
      ["owner", "existing-external"],
      ["proxyAbsent", false],
      ["packageRemoved", false],
      ["webviewEvidence", true],
    ] as const) {
      expect(() => validatePostInstallSummary({ ...validSummary(), [field]: value })).toThrow(
        "did not prove the required lifecycle",
      );
    }
  });

  test("rejects extra fields so diagnostics and secrets cannot enter evidence", () => {
    expect(() => validatePostInstallSummary({
      ...validSummary(),
      attestationSecret: "must-not-escape",
    })).toThrow("summary fields are invalid");
  });

  test("rejects Debian maintainer scripts before dpkg executes the package", () => {
    const clean = tempDir();
    writeFileSync(join(clean, "control"), "Package: open-codex\n");
    writeFileSync(join(clean, "md5sums"), "fixture\n");
    expect(() => validateDebControlDirectory(clean)).not.toThrow();

    const scripted = tempDir();
    mkdirSync(scripted, { recursive: true });
    writeFileSync(join(scripted, "control"), "Package: open-codex\n");
    writeFileSync(join(scripted, "md5sums"), "fixture\n");
    writeFileSync(join(scripted, "postinst"), "#!/bin/sh\n");
    expect(() => validateDebControlDirectory(scripted)).toThrow("unexpected maintainer files");
  });
});
