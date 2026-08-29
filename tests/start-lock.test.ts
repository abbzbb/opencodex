import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireStartLock,
  getStartLockPath,
  PINNED_PORT_BIND_RETRY_MS,
  PINNED_PORT_PREFER_RETRY_MS,
  PINNED_PORT_RECLAIM_TIMEOUT_MS,
  START_LOCK_INCOMPLETE_GRACE_MS,
  releaseStartLock,
  START_LOCK_PUBLISH_SLACK_MS,
  START_LOCK_WAIT_TIMEOUT_MS,
  StartLockTimeoutError,
  withStartLock,
  type StartLockHandle,
} from "../src/config/start-lock";

let testDir = "";
let held: StartLockHandle | null = null;

function plantOwner(record: { token: string; pid: number; createdAt: number }): { lockPath: string; ownerPath: string } {
  const lockPath = getStartLockPath();
  mkdirSync(lockPath, { mode: 0o700 });
  const ownerPath = join(lockPath, `${record.token}.json`);
  writeFileSync(ownerPath, `${JSON.stringify({ version: 1, ...record })}\n`, { encoding: "utf8", mode: 0o600 });
  return { lockPath, ownerPath };
}

function ownerNames(lockPath: string): string[] {
  return existsSync(lockPath) ? readdirSync(lockPath).sort() : [];
}

function agePath(path: string): void {
  const old = new Date(Date.now() - START_LOCK_INCOMPLETE_GRACE_MS - 1_000);
  utimesSync(path, old, old);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-start-lock-"));
  process.env.OPENCODEX_HOME = testDir;
  held = null;
});

afterEach(() => {
  try { held?.release(); } catch { /* fixture teardown */ }
  held = null;
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("start lock", () => {
  test("the start-lock leaf stays a paths-only config module and never recursively deletes", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "config", "start-lock.ts"), "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\.\/config["']/);
    expect(source).not.toMatch(/from\s+["']\.\.\/lab(?:\/|["'])/);
    expect(source).toContain('from "./paths"');
    expect(source).not.toMatch(/\brmSync\s*\(/);
    expect(source).not.toMatch(/rmdirSync\s*\([^)]*recursive/);
    expect(source).toContain('openSync(ownerPath, "wx", 0o600)');
    expect(source).toContain('mkdirSync(lockPath, { mode: 0o700 })');
    expect(source).toContain("`${record.token}.json`");
  });

  test("exclusion: a live owner blocks a second claim", async () => {
    held = await acquireStartLock({ waitTimeoutMs: 0 });
    await expect(acquireStartLock({ waitTimeoutMs: 0 })).rejects.toBeInstanceOf(StartLockTimeoutError);
    expect(ownerNames(held.lockPath)).toEqual([`${held.token}.json`]);
    expect(JSON.parse(readFileSync(held.ownerPath, "utf8"))).toMatchObject({
      version: 1,
      token: held.token,
      pid: held.pid,
    });
  });

  test("wait/release: a waiter acquires after the owner releases", async () => {
    held = await acquireStartLock({ waitTimeoutMs: 0 });
    let resumeWait: (() => void) | undefined;
    let notifySleep: (() => void) | undefined;
    const sleepStarted = new Promise<void>(resolve => {
      notifySleep = resolve;
    });
    const pending = acquireStartLock({
      waitTimeoutMs: 1_000,
      pollIntervalMs: 1,
      sleep: () => {
        notifySleep?.();
        return new Promise<void>(resolve => {
          resumeWait = resolve;
        });
      },
    });
    await sleepStarted;
    expect(ownerNames(held.lockPath)).toEqual([`${held.token}.json`]);
    const firstToken = held.token;
    releaseStartLock(held);
    held = null;
    expect(existsSync(getStartLockPath())).toBe(false);
    resumeWait?.();
    held = await pending;
    expect(held.token).not.toBe(firstToken);
    expect(ownerNames(held.lockPath)).toEqual([`${held.token}.json`]);
  });

  test("live owner is never reclaimed", async () => {
    const planted = plantOwner({ token: "live-owner", pid: 4242, createdAt: 1 });
    await expect(acquireStartLock({
      waitTimeoutMs: 0,
      isAlive: pid => pid === 4242,
    })).rejects.toBeInstanceOf(StartLockTimeoutError);
    expect(ownerNames(planted.lockPath)).toEqual(["live-owner.json"]);
    expect(readFileSync(planted.ownerPath, "utf8")).toContain("live-owner");
  });

  test("dead owner is reclaimed when the observed token still matches", async () => {
    plantOwner({ token: "dead-owner", pid: 2_147_483_647, createdAt: 0 });
    held = await acquireStartLock({
      waitTimeoutMs: 0,
      isAlive: () => false,
    });
    expect(held.token).not.toBe("dead-owner");
    expect(ownerNames(held.lockPath)).toEqual([`${held.token}.json`]);
    expect(JSON.parse(readFileSync(held.ownerPath, "utf8")).pid).toBe(held.pid);
  });

  test("an in-progress empty publication is not removed during its grace window", async () => {
    const lockPath = getStartLockPath();
    mkdirSync(lockPath, { mode: 0o700 });
    await expect(acquireStartLock({ waitTimeoutMs: 0 }))
      .rejects.toBeInstanceOf(StartLockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);
    expect(ownerNames(lockPath)).toEqual([]);
  });

  test("old empty and partial publications are reclaimed without recursive deletion", async () => {
    const lockPath = getStartLockPath();
    mkdirSync(lockPath, { mode: 0o700 });
    agePath(lockPath);
    held = await acquireStartLock({ waitTimeoutMs: 0 });
    held.release();
    held = null;

    mkdirSync(lockPath, { mode: 0o700 });
    const partial = join(lockPath, "partial-owner.json");
    writeFileSync(partial, '{"version":1,"token":', { mode: 0o600 });
    agePath(partial);
    agePath(lockPath);
    held = await acquireStartLock({ waitTimeoutMs: 0 });
    expect(ownerNames(lockPath)).toEqual([`${held.token}.json`]);
  });

  test("incomplete reclaim does not remove a replacement directory", async () => {
    const lockPath = getStartLockPath();
    mkdirSync(lockPath, { mode: 0o700 });
    const partial = join(lockPath, "partial-owner.json");
    writeFileSync(partial, "{", { mode: 0o600 });
    agePath(partial);
    agePath(lockPath);

    await expect(acquireStartLock({
      waitTimeoutMs: 0,
      beforeIncompleteReclaim: () => {
        unlinkSync(partial);
        rmdirSync(lockPath);
        mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(join(lockPath, "successor-owner.json"), "{", { mode: 0o600 });
      },
    })).rejects.toBeInstanceOf(StartLockTimeoutError);
    expect(ownerNames(lockPath)).toEqual(["successor-owner.json"]);
  });

  test("successor token safety: reclaim and release never unlink a replacement owner", async () => {
    const stale = plantOwner({ token: "stale-owner", pid: 2_147_483_647, createdAt: 0 });
    const successor = `${JSON.stringify({
      version: 1,
      token: "successor-owner",
      pid: process.pid,
      createdAt: 10,
    })}\n`;

    await expect(acquireStartLock({
      waitTimeoutMs: 0,
      isAlive: pid => pid === process.pid,
      beforeStaleReclaim: () => {
        unlinkSync(stale.ownerPath);
        rmdirSync(stale.lockPath);
        mkdirSync(stale.lockPath, { mode: 0o700 });
        writeFileSync(join(stale.lockPath, "successor-owner.json"), successor, {
          encoding: "utf8",
          mode: 0o600,
        });
      },
    })).rejects.toBeInstanceOf(StartLockTimeoutError);

    expect(ownerNames(stale.lockPath)).toEqual(["successor-owner.json"]);
    expect(readFileSync(join(stale.lockPath, "successor-owner.json"), "utf8")).toBe(successor);

    unlinkSync(join(stale.lockPath, "successor-owner.json"));
    rmdirSync(stale.lockPath);
    held = await acquireStartLock({
      waitTimeoutMs: 0,
      randomToken: () => "claimed-owner",
    });
    unlinkSync(held.ownerPath);
    const renamed = join(held.lockPath, "successor-owner.json");
    writeFileSync(renamed, successor, { encoding: "utf8", mode: 0o600 });
    releaseStartLock(held);
    held = null;
    expect(ownerNames(getStartLockPath())).toEqual(["successor-owner.json"]);
    expect(readFileSync(renamed, "utf8")).toBe(successor);
  });

  test("stale reclaim never removes a replacement with the same token and record", async () => {
    const record = { token: "reused-token", pid: 2_147_483_647, createdAt: 0 };
    const stale = plantOwner(record);
    const replacement = `${JSON.stringify({ version: 1, ...record })}\n`;

    await expect(acquireStartLock({
      waitTimeoutMs: 0,
      isAlive: () => false,
      beforeStaleReclaim: () => {
        unlinkSync(stale.ownerPath);
        rmdirSync(stale.lockPath);
        mkdirSync(stale.lockPath, { mode: 0o700 });
        writeFileSync(stale.ownerPath, replacement, { encoding: "utf8", mode: 0o600 });
      },
    })).rejects.toBeInstanceOf(StartLockTimeoutError);

    expect(ownerNames(stale.lockPath)).toEqual(["reused-token.json"]);
    expect(readFileSync(stale.ownerPath, "utf8")).toBe(replacement);
  });

  test("timeout is bounded and typed", async () => {
    plantOwner({ token: "blocking-owner", pid: 99, createdAt: 1 });
    let nowMs = 1_000;
    const sleeps: number[] = [];
    await expect(acquireStartLock({
      waitTimeoutMs: 200,
      pollIntervalMs: 50,
      now: () => nowMs,
      sleep: async ms => {
        sleeps.push(ms);
        nowMs += ms;
      },
      isAlive: () => true,
    })).rejects.toBeInstanceOf(StartLockTimeoutError);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(nowMs).toBeGreaterThanOrEqual(1_200);
    expect(ownerNames(getStartLockPath())).toEqual(["blocking-owner.json"]);
  });

  test("the default waiter budget outlasts pinned-port reclaim plus bind and publish slack", () => {
    expect(PINNED_PORT_RECLAIM_TIMEOUT_MS).toBe(60_000);
    expect(START_LOCK_WAIT_TIMEOUT_MS).toBe(
      PINNED_PORT_RECLAIM_TIMEOUT_MS
      + PINNED_PORT_PREFER_RETRY_MS
      + PINNED_PORT_BIND_RETRY_MS
      + START_LOCK_PUBLISH_SLACK_MS,
    );
    expect(START_LOCK_WAIT_TIMEOUT_MS).toBeGreaterThan(PINNED_PORT_RECLAIM_TIMEOUT_MS);
  });

  test("withStartLock releases after success and after a thrown publication failure", async () => {
    const seen: string[] = [];
    const value = await withStartLock(async handle => {
      seen.push(handle.token);
      expect(ownerNames(handle.lockPath)).toEqual([`${handle.token}.json`]);
      return 7;
    }, { waitTimeoutMs: 0 });
    expect(value).toBe(7);
    expect(seen).toHaveLength(1);
    expect(existsSync(getStartLockPath())).toBe(false);

    await expect(withStartLock(async () => {
      expect(existsSync(getStartLockPath())).toBe(true);
      throw new Error("runtime-port write failed");
    }, { waitTimeoutMs: 0 })).rejects.toThrow("runtime-port write failed");
    expect(existsSync(getStartLockPath())).toBe(false);
  });

  test("two OS processes serialize and a killed owner is reclaimed", async () => {
    const startLockPath = join(import.meta.dir, "../src/config/start-lock.ts");
    const env = { ...process.env, OPENCODEX_HOME: testDir };

    async function spawnLockWorker(source: string): Promise<ReturnType<typeof Bun.spawn>> {
      return Bun.spawn([process.execPath, "-e", source], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    async function readLine(stream: ReadableStream<Uint8Array>, label: string, timeoutMs = 4_000): Promise<string> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value?: undefined }>(resolve => setTimeout(() => resolve({ done: true }), remaining)),
        ]);
        if (result.value) buf += decoder.decode(result.value, { stream: true });
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          reader.releaseLock();
          return buf.slice(0, nl);
        }
        if (result.done) break;
      }
      throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(buf)}`);
    }

    const holder = await spawnLockWorker(`
      import { acquireStartLock } from ${JSON.stringify(startLockPath)};
      const handle = await acquireStartLock({ waitTimeoutMs: 5_000, pollIntervalMs: 20 });
      process.stdout.write("acquired\\n");
      await Bun.sleep(60_000);
      handle.release();
    `);
    expect(await readLine(holder.stdout, "holder acquire")).toBe("acquired");
    expect(existsSync(getStartLockPath())).toBe(true);

    const waiter = await spawnLockWorker(`
      import { acquireStartLock } from ${JSON.stringify(startLockPath)};
      const handle = await acquireStartLock({ waitTimeoutMs: 5_000, pollIntervalMs: 20 });
      process.stdout.write("waiter-acquired\\n");
      handle.release();
    `);
    await Bun.sleep(60);
    expect(waiter.exitCode).toBeNull();

    holder.kill("SIGKILL");
    await holder.exited;
    expect(await readLine(waiter.stdout, "waiter acquire after crash")).toBe("waiter-acquired");
    expect(await waiter.exited).toBe(0);
    expect(existsSync(getStartLockPath())).toBe(false);
  }, 15_000);
});
