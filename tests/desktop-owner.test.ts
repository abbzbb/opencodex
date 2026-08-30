import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDesktopOwner,
  consumeDesktopLaunchDescriptor,
  consumeLaunchDescriptorAndPublish,
  createDesktopLaunchDescriptor,
  DESKTOP_LAUNCH_DESCRIPTOR_ENV,
  desktopDirectRecordsComplete,
  digestLaunchNonce,
  getDesktopDirectOwnerPath,
  getDesktopLaunchDir,
  publishDesktopDirectOwnerRecord,
  readDesktopDirectOwnerRecord,
  readRuntimePortOwnerId,
  reclaimStaleDesktopDirectRecords,
  removeDesktopDirectOwnerRecord,
  writeRuntimePortOwnerId,
  type DesktopDirectOwnerRecord,
  type DesktopRuntimeIdentity,
} from "../src/config/desktop-owner";
import { getRuntimePortPath, writeRuntimePort } from "../src/config/process-state";

const SOURCE = readFileSync(join(import.meta.dir, "..", "src", "config", "desktop-owner.ts"), "utf8");
const CLI_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");

let home = "";

const identity: DesktopRuntimeIdentity = {
  installId: "install-1",
  runtimeManifestId: "ocx-runtime-2.35.0-x64",
  runtimeVersion: "2.35.0",
  bunPath: "/opt/opencodex/versions/2.35.0/bun",
  cliPath: "/opt/opencodex/versions/2.35.0/src/cli/index.ts",
  stableRuntimeRoot: "/opt/opencodex/versions/2.35.0",
};

function ownerRecord(overrides: Partial<DesktopDirectOwnerRecord> = {}): DesktopDirectOwnerRecord {
  return {
    schemaVersion: 1,
    ownerId: "0123456789abcdef0123456789abcdef",
    installId: identity.installId,
    runtimeManifestId: identity.runtimeManifestId,
    runtimeVersion: identity.runtimeVersion,
    bunPath: identity.bunPath,
    cliPath: identity.cliPath,
    pid: 4242,
    nonceDigest: digestLaunchNonce("ab".repeat(32)),
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-desktop-owner-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("desktop-owner leaf", () => {
  test("stays a narrow config leaf and never imports CLI dispatch or Lab", () => {
    expect(SOURCE).not.toMatch(/from\s+["']\.\.\/lab(?:\/|["'])/);
    expect(SOURCE).not.toMatch(/from\s+["']\.\.\/cli(?:\/|["'])/);
    expect(SOURCE).not.toMatch(/from\s+["']\.\.\/config["']/);
    expect(SOURCE).not.toMatch(/src\/cli\/index/);
    expect(SOURCE).toContain("from \"./paths\"");
    expect(SOURCE).toContain("from \"./atomic-write\"");
    expect(SOURCE).toContain("desktop-direct-owner.json");
    expect(SOURCE).toContain(DESKTOP_LAUNCH_DESCRIPTOR_ENV);
  });

  test("creates an owner-only one-shot launch descriptor and consumes it once", () => {
    const created = createDesktopLaunchDescriptor(identity, { nonce: "ab".repeat(32) });
    expect(created.path.startsWith(getDesktopLaunchDir())).toBe(true);
    const raw = readFileSync(created.path, "utf8");
    expect(raw).toContain("\"nonce\"");
    expect(raw).not.toContain("nonceDigest");
    if (process.platform !== "win32") {
      const { mode } = lstatSync(created.path);
      expect(mode & 0o077).toBe(0);
    }
    const first = consumeDesktopLaunchDescriptor(created.path, { identity });
    expect(first?.installId).toBe(identity.installId);
    expect(first?.nonce).toBe("ab".repeat(32));
    expect(existsSync(created.path)).toBe(false);
    expect(consumeDesktopLaunchDescriptor(created.path, { identity })).toBeNull();
  });

  test("rejects a launch descriptor symlink without reading or deleting its outside target", () => {
    if (process.platform === "win32") return;
    const created = createDesktopLaunchDescriptor(identity, { nonce: "ab".repeat(32) });
    const raw = readFileSync(created.path, "utf8");
    const outside = join(home, "outside-descriptor.json");
    writeFileSync(outside, raw, { encoding: "utf8", mode: 0o600 });
    unlinkSync(created.path);
    symlinkSync(outside, created.path);

    expect(consumeDesktopLaunchDescriptor(created.path, { identity })).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe(raw);
    expect(lstatSync(created.path).isSymbolicLink()).toBe(true);
  });

  test("child publish writes both records without storing the raw nonce", () => {
    const created = createDesktopLaunchDescriptor(identity, { nonce: "cd".repeat(32) });
    writeRuntimePort({ pid: 77, port: 10100, hostname: "127.0.0.1" });
    const published = consumeLaunchDescriptorAndPublish({
      descriptorPath: created.path,
      pid: 77,
      port: 10100,
      hostname: "127.0.0.1",
      identity,
      expectedBunPath: identity.bunPath,
      expectedCliPath: identity.cliPath,
      runtimeVersion: identity.runtimeVersion,
    });
    expect(published?.ownerId).toMatch(/^[a-f0-9]{32}$/);
    expect(desktopDirectRecordsComplete(77)).toBe(true);
    const owner = readDesktopDirectOwnerRecord();
    expect(owner?.pid).toBe(77);
    expect(owner?.nonceDigest).toBe(digestLaunchNonce("cd".repeat(32)));
    const ownerRaw = readFileSync(getDesktopDirectOwnerPath(), "utf8");
    const runtimeRaw = readFileSync(getRuntimePortPath(), "utf8");
    expect(ownerRaw).not.toContain("cd".repeat(32));
    expect(runtimeRaw).not.toContain("cd".repeat(32));
    expect(runtimeRaw).not.toContain("sk-live-");
    expect(readRuntimePortOwnerId(77)).toBe(owner?.ownerId);
  });

  test("child rejects a descriptor whose executable paths do not name this process", () => {
    const created = createDesktopLaunchDescriptor(identity, { nonce: "ef".repeat(32) });
    writeRuntimePort({ pid: 78, port: 10100, hostname: "127.0.0.1" });
    const published = consumeLaunchDescriptorAndPublish({
      descriptorPath: created.path,
      pid: 78,
      port: 10100,
      hostname: "127.0.0.1",
      expectedBunPath: "/opt/opencodex/versions/2.35.0/other-bun",
      expectedCliPath: identity.cliPath,
      runtimeVersion: identity.runtimeVersion,
    });
    expect(published).toBeNull();
    expect(readDesktopDirectOwnerRecord()).toBeNull();
    expect(readRuntimePortOwnerId(78)).toBeNull();
  });

  test("start owns Desktop publication and cleanup while the bridge never writes owner records", () => {
    expect(CLI_SOURCE).toContain("consumeLaunchDescriptorAndPublish({");
    expect(CLI_SOURCE).toContain("expectedBunPath: process.execPath");
    expect(CLI_SOURCE).toContain("expectedCliPath: process.argv[1]");
    expect(CLI_SOURCE).toContain("removeDesktopDirectOwnerRecord(process.pid)");
    expect(SOURCE).toContain("constants.O_NOFOLLOW");
    expect(SOURCE).toContain("readJsonFileNoFollow");
  });

  test("classifies a fully matching pair as desktop-direct", () => {
    const owner = ownerRecord();
    publishDesktopDirectOwnerRecord(owner);
    writeRuntimePort({ pid: owner.pid, port: 10100, hostname: "127.0.0.1" });
    expect(writeRuntimePortOwnerId(owner.ownerId, owner.pid)).toBe(true);
    const classified = classifyDesktopOwner({
      identity,
      livePid: owner.pid,
      livePort: 10100,
      commandLine: `${identity.bunPath} ${identity.cliPath} start`,
      service: { installed: false, startable: false, conflict: false },
      isAlive: () => true,
    });
    expect(classified).toEqual({ owner: "desktop-direct", complete: true });
  });

  test("partial owner records and mismatched evidence fail closed as unknown/conflict", () => {
    const owner = ownerRecord();
    publishDesktopDirectOwnerRecord(owner);
    writeRuntimePort({ pid: owner.pid, port: 10100, hostname: "127.0.0.1" });
    expect(classifyDesktopOwner({
      identity,
      livePid: owner.pid,
      livePort: 10100,
      commandLine: `${identity.bunPath} ${identity.cliPath} start`,
      service: { installed: false, startable: false, conflict: false },
      isAlive: () => true,
    }).owner).toBe("unknown/conflict");

    writeRuntimePortOwnerId(owner.ownerId, owner.pid);
    expect(classifyDesktopOwner({
      identity: { ...identity, installId: "other-install" },
      livePid: owner.pid,
      livePort: 10100,
      commandLine: `${identity.bunPath} ${identity.cliPath} start`,
      service: { installed: false, startable: false, conflict: false },
      isAlive: () => true,
    }).owner).toBe("unknown/conflict");
    expect(classifyDesktopOwner({
      identity,
      livePid: owner.pid,
      livePort: 9999,
      commandLine: `${identity.bunPath} ${identity.cliPath} start`,
      service: { installed: false, startable: false, conflict: false },
      isAlive: () => true,
    }).owner).toBe("unknown/conflict");
    expect(classifyDesktopOwner({
      identity,
      livePid: owner.pid,
      livePort: 10100,
      commandLine: "/usr/bin/foreign start",
      service: { installed: false, startable: false, conflict: false },
      isAlive: () => true,
    }).owner).toBe("unknown/conflict");
  });

  test("service bun/cli paths inside the Desktop runtime classify as desktop-service", () => {
    expect(classifyDesktopOwner({
      identity,
      livePid: 11,
      livePort: 10100,
      commandLine: `${identity.bunPath} ${identity.cliPath} start`,
      service: { installed: true, startable: true, conflict: false },
      serviceInstall: { bunPath: identity.bunPath, cliPath: identity.cliPath },
      isAlive: () => true,
    })).toEqual({ owner: "desktop-service", complete: true });
    expect(classifyDesktopOwner({
      identity,
      livePid: 11,
      livePort: 10100,
      commandLine: `${identity.bunPath} ${identity.cliPath} start`,
      service: { installed: true, startable: true, conflict: false },
      serviceInstall: { bunPath: "/usr/local/bin/bun", cliPath: "/usr/local/lib/ocx/src/cli/index.ts" },
      isAlive: () => true,
    }).owner).toBe("existing-external");
    expect(classifyDesktopOwner({
      identity,
      livePid: 11,
      livePort: 10100,
      commandLine: `${identity.bunPath} ${identity.cliPath} start`,
      service: { installed: true, startable: true, conflict: false },
      serviceInstall: {
        bunPath: "/opt/opencodex/versions/2.35.0/other-bun",
        cliPath: identity.cliPath,
      },
      isAlive: () => true,
    }).owner).toBe("existing-external");
  });

  test("absent records with a live proxy are existing-external", () => {
    writeRuntimePort({ pid: 9, port: 10100, hostname: "127.0.0.1" });
    expect(classifyDesktopOwner({
      identity,
      livePid: 9,
      livePort: 10100,
      commandLine: "ocx start",
      service: { installed: false, startable: false, conflict: false },
      isAlive: () => true,
    })).toEqual({ owner: "existing-external", complete: true });
  });

  test("compare-before-clean removes a complete dead pair and leaves partial records", () => {
    const owner = ownerRecord({ createdAt: Date.now() - 120_000 });
    publishDesktopDirectOwnerRecord(owner);
    writeRuntimePort({ pid: owner.pid, port: 10100 });
    writeRuntimePortOwnerId(owner.ownerId, owner.pid);
    expect(reclaimStaleDesktopDirectRecords({ isAlive: () => false, now: Date.now() })).toBe(true);
    expect(existsSync(getDesktopDirectOwnerPath())).toBe(false);

    publishDesktopDirectOwnerRecord(owner);
    writeRuntimePort({ pid: owner.pid, port: 10100 });
    expect(reclaimStaleDesktopDirectRecords({ isAlive: () => false, now: Date.now() })).toBe(false);
    expect(existsSync(getDesktopDirectOwnerPath())).toBe(true);
    expect(existsSync(getRuntimePortPath())).toBe(true);
  });

  test("normal cleanup only removes the matching owner record", () => {
    const owner = ownerRecord();
    publishDesktopDirectOwnerRecord(owner);
    expect(removeDesktopDirectOwnerRecord(owner.pid + 1)).toBe(false);
    expect(readDesktopDirectOwnerRecord()?.ownerId).toBe(owner.ownerId);
    expect(removeDesktopDirectOwnerRecord(owner.pid, "f".repeat(32))).toBe(false);
    expect(removeDesktopDirectOwnerRecord(owner.pid, owner.ownerId)).toBe(true);
    expect(readDesktopDirectOwnerRecord()).toBeNull();
  });

  test("classification result does not carry paths, nonce, or credentials", () => {
    const owner = ownerRecord({ bunPath: "/home/secret-user/.opencodex/bun" });
    publishDesktopDirectOwnerRecord(owner);
    const classified = classifyDesktopOwner({
      identity: { ...identity, bunPath: owner.bunPath },
      livePid: owner.pid,
      livePort: 10100,
      service: { installed: false, startable: false, conflict: false },
      isAlive: () => true,
    });
    const json = JSON.stringify(classified);
    expect(json).not.toContain("secret-user");
    expect(json).not.toContain(owner.nonceDigest);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("/home/");
  });
});
