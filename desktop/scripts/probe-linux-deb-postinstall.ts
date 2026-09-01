#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LINUX_DEB_ARCH,
  LINUX_DEB_PACKAGE,
  LINUX_DEB_TARGET,
  parseProbeArgs,
  pinDebArtifact,
  runChild,
} from "./probe-linux-deb";

export const POSTINSTALL_IMAGE = "ocx-desktop-postinstall-probe:debian13";
export const POSTINSTALL_BASE_IMAGE = "debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132";
export const POSTINSTALL_DOCKERFILE = "linux-deb-postinstall.Dockerfile";
export const POSTINSTALL_INSTALLED_RUNTIME = "/usr/lib/OpenCodex/resources/runtime";
const CONTAINER_TIMEOUT_MS = 240_000;
const DOCKER_TIMEOUT_MS = 600_000;
const MAX_DEB_BYTES = 1024 * 1024 * 1024;
const DPKG_DEB = "/usr/bin/dpkg-deb";
const VERSION_RE = /^[A-Za-z0-9.+:~_-]{1,128}$/;

type JsonRecord = Record<string, unknown>;

export type PostInstallSummary = {
  schemaVersion: 1;
  package: typeof LINUX_DEB_PACKAGE;
  version: string;
  architecture: typeof LINUX_DEB_ARCH;
  target: typeof LINUX_DEB_TARGET;
  installed: true;
  appLaunched: true;
  stableRuntime: "published";
  bridgeStatus: "ready";
  owner: "desktop-direct";
  health: "ok";
  readiness: "ready";
  stop: "stopped";
  proxyAbsent: true;
  packageRemoved: true;
  webviewEvidence: false;
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && actual.every(key => keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}

export function dockerCreateArgs(imageId: string, expectedSha256: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) fail("invalid artifact digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) fail("invalid probe image id");
  return [
    "create",
    "--platform", "linux/amd64",
    "--init",
    "--network", "none",
    "--pids-limit", "512",
    "--memory", "2g",
    "--cpus", "2",
    "--security-opt", "no-new-privileges",
    "--env", `EXPECTED_DEB_SHA256=${expectedSha256}`,
    imageId,
  ];
}

export function dockerfileFromImage(source: string): string {
  const match = /^FROM[ \t]+(\S+)/m.exec(source);
  if (!match) fail("Dockerfile FROM is missing");
  return match[1]!;
}

export function parseDockerBuildImageId(stdout: string): string {
  if (!/^sha256:[a-f0-9]{64}\n$/.test(stdout)) fail("post-install probe image build failed");
  return stdout.trim();
}

export function postInstallDockerfilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), POSTINSTALL_DOCKERFILE);
}

export function validatePostInstallSummary(value: unknown): PostInstallSummary {
  const keys = [
    "schemaVersion",
    "package",
    "version",
    "architecture",
    "target",
    "installed",
    "appLaunched",
    "stableRuntime",
    "bridgeStatus",
    "owner",
    "health",
    "readiness",
    "stop",
    "proxyAbsent",
    "packageRemoved",
    "webviewEvidence",
  ] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) fail("post-install summary fields are invalid");
  if (value.schemaVersion !== 1
    || value.package !== LINUX_DEB_PACKAGE
    || typeof value.version !== "string"
    || !VERSION_RE.test(value.version)
    || value.architecture !== LINUX_DEB_ARCH
    || value.target !== LINUX_DEB_TARGET
    || value.installed !== true
    || value.appLaunched !== true
    || value.stableRuntime !== "published"
    || value.bridgeStatus !== "ready"
    || value.owner !== "desktop-direct"
    || value.health !== "ok"
    || value.readiness !== "ready"
    || value.stop !== "stopped"
    || value.proxyAbsent !== true
    || value.packageRemoved !== true
    || value.webviewEvidence !== false) {
    fail("post-install summary did not prove the required lifecycle");
  }
  return value as PostInstallSummary;
}

export function validateDebControlDirectory(controlRoot: string): void {
  const entries = readdirSync(controlRoot).sort();
  if (entries.length !== 2 || entries[0] !== "control" || entries[1] !== "md5sums") {
    fail("Debian control archive contains unexpected maintainer files");
  }
  for (const name of entries) {
    const stat = lstatSync(join(controlRoot, name));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("Debian control archive entries must be regular files");
    }
  }
}

function parseOneJsonLine(stdout: string, stderr: string, exitCode: number): unknown {
  if (exitCode !== 0) {
    const diagnostic = stderr.trim();
    if (/^post-install-harness: [A-Za-z0-9 .:_/-]{1,160}$/.test(diagnostic)) {
      fail(`post-install container exited with code ${exitCode}: ${diagnostic}`);
    }
    fail(`post-install container exited with code ${exitCode}`);
  }
  if (stderr !== "") fail("post-install container wrote to stderr");
  if (!stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) {
    fail("post-install container must emit exactly one JSON line");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return fail("post-install container emitted invalid JSON");
  }
}

function dockerEnv(): Record<string, string> {
  return { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1" };
}

export async function probeLinuxDebPostInstall(
  debPath: string,
  expectedSha256: string,
): Promise<PostInstallSummary> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("Linux .deb post-install probe requires a Linux x64 host");
  }
  const docker = Bun.which("docker");
  if (!docker) fail("docker is required for the Linux .deb post-install probe");
  const deb = resolve(debPath);
  if (!existsSync(deb)) fail("Debian package does not exist");
  const debStat = lstatSync(deb);
  if (debStat.isSymbolicLink() || !debStat.isFile()) fail("Debian package must be a regular file");
  if (debStat.size <= 0 || debStat.size > MAX_DEB_BYTES) fail("Debian package exceeds the probe size limit");
  if (!existsSync(DPKG_DEB)) fail("/usr/bin/dpkg-deb is required");

  const probeRoot = mkdtempSync(join(tmpdir(), "ocx-linux-deb-postinstall-"));
  let containerId: string | null = null;
  try {
    const pinned = pinDebArtifact(deb, probeRoot, expectedSha256);
    const controlRoot = join(probeRoot, "control");
    mkdirSync(controlRoot, { mode: 0o700 });
    const control = await runChild(
      [DPKG_DEB, "--control", pinned.path, controlRoot],
      { cwd: probeRoot, env: dockerEnv(), timeout: CONTAINER_TIMEOUT_MS },
    );
    if (control.exitCode !== 0 || control.stdout !== "" || control.stderr !== "") {
      fail("Debian control archive extraction failed");
    }
    validateDebControlDirectory(controlRoot);
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const dockerfile = join(scriptDir, "linux-deb-postinstall.Dockerfile");
    const build = await runChild(
      [
        docker,
        "build",
        "--quiet",
        "--platform", "linux/amd64",
        "--file", dockerfile,
        "--tag", POSTINSTALL_IMAGE,
        scriptDir,
      ],
      { cwd: probeRoot, env: dockerEnv(), timeout: DOCKER_TIMEOUT_MS },
    );
    if (build.exitCode !== 0 || build.stderr !== "") {
      fail("post-install probe image build failed");
    }
    const imageId = parseDockerBuildImageId(build.stdout);

    const create = await runChild(
      [docker, ...dockerCreateArgs(imageId, pinned.sha256)],
      { cwd: probeRoot, env: dockerEnv(), timeout: CONTAINER_TIMEOUT_MS },
    );
    if (create.exitCode !== 0 || create.stderr !== "" || !/^[a-f0-9]{64}\n$/.test(create.stdout)) {
      fail("post-install probe container creation failed");
    }
    containerId = create.stdout.trim();

    const copy = await runChild(
      [docker, "cp", pinned.path, `${containerId}:/probe/artifact.deb`],
      { cwd: probeRoot, env: dockerEnv(), timeout: CONTAINER_TIMEOUT_MS },
    );
    if (copy.exitCode !== 0 || copy.stdout !== "" || copy.stderr !== "") {
      fail("post-install artifact copy failed");
    }

    const started = await runChild(
      [docker, "start", "--attach", containerId],
      { cwd: probeRoot, env: dockerEnv(), timeout: CONTAINER_TIMEOUT_MS },
    );
    return validatePostInstallSummary(parseOneJsonLine(started.stdout, started.stderr, started.exitCode));
  } finally {
    if (containerId) {
      await runChild(
        [docker, "rm", "--force", containerId],
        { cwd: probeRoot, env: dockerEnv(), timeout: CONTAINER_TIMEOUT_MS },
      ).catch(() => undefined);
    }
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  const args = parseProbeArgs(process.argv.slice(2));
  probeLinuxDebPostInstall(args.deb, args.sha256)
    .then(summary => {
      console.log(
        `probe-linux-deb-postinstall: ok (package=${summary.package}, version=${summary.version}, `
        + `target=${summary.target}, owner=${summary.owner}, readyz=${summary.readiness}, `
        + `stop=${summary.stop}, removed=${summary.packageRemoved})`,
      );
    })
    .catch(error => {
      console.error(`probe-linux-deb-postinstall: ${error instanceof Error ? error.message : "probe failed"}`);
      process.exit(1);
    });
}
