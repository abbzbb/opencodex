import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVATION_LOCK_DIR_NAME,
  acquireActivationLock,
  activationLockPath,
  ActivationLockTimeoutError,
  withActivationLock,
  type ActivationLockHandle,
} from "../runtime/activation-lock";

let testDir = "";
let held: ActivationLockHandle | null = null;

function ownerNames(lockPath: string): string[] {
  return existsSync(lockPath) ? readdirSync(lockPath).sort() : [];
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-activation-lock-"));
  held = null;
});

afterEach(() => {
  try { held?.release(); } catch { /* fixture teardown */ }
  held = null;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("desktop activation lock", () => {
  test("lives under the stable root, not OPENCODEX_HOME or homedir", async () => {
    const decoyHome = mkdtempSync(join(tmpdir(), "ocx-activation-decoy-home-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const previousUserHome = process.env.HOME;
    process.env.OPENCODEX_HOME = decoyHome;
    process.env.HOME = decoyHome;
    try {
      held = await acquireActivationLock(testDir, { waitTimeoutMs: 0 });
      expect(held.lockPath).toBe(join(testDir, ACTIVATION_LOCK_DIR_NAME));
      expect(held.lockPath).toBe(activationLockPath(testDir));
      expect(existsSync(join(decoyHome, ACTIVATION_LOCK_DIR_NAME))).toBe(false);
      expect(readFileSync(held.ownerPath, "utf8")).toContain(String(held.pid));
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousUserHome;
      rmSync(decoyHome, { recursive: true, force: true });
    }
  });

  test("exclusion: a live owner blocks a second claim", async () => {
    held = await acquireActivationLock(testDir, { waitTimeoutMs: 0 });
    await expect(acquireActivationLock(testDir, { waitTimeoutMs: 0 })).rejects.toBeInstanceOf(ActivationLockTimeoutError);
    expect(ownerNames(held.lockPath)).toEqual([`${held.token}.json`]);
  });

  test("wait/release: a waiter acquires after the owner releases", async () => {
    held = await acquireActivationLock(testDir, { waitTimeoutMs: 0 });
    let waiting = false;
    const pending = acquireActivationLock(testDir, {
      waitTimeoutMs: 1_000,
      pollIntervalMs: 1,
      sleep: async () => {
        waiting = true;
        await Promise.resolve();
      },
    });
    for (let i = 0; i < 1_000 && !waiting; i++) await Promise.resolve();
    expect(waiting).toBe(true);
    held.release();
    held = null;
    const waiter = await pending;
    expect(waiter.token).toBeTruthy();
    waiter.release();
  });

  test("stale PID reclaim is compare-before-reclaim and a live PID is not stolen", async () => {
    held = await acquireActivationLock(testDir, { waitTimeoutMs: 0, pid: 4242 });
    const lockPath = held.lockPath;
    const token = held.token;
    await expect(acquireActivationLock(testDir, {
      waitTimeoutMs: 0,
      isAlive: () => true,
    })).rejects.toBeInstanceOf(ActivationLockTimeoutError);
    expect(ownerNames(lockPath)).toEqual([`${token}.json`]);

    const reclaimed = await acquireActivationLock(testDir, {
      waitTimeoutMs: 0,
      isAlive: pid => pid !== 4242,
    });
    expect(reclaimed.token).not.toBe(token);
    reclaimed.release();
    held.release();
    expect(existsSync(lockPath)).toBe(false);
    held = null;
  });

  test("withActivationLock releases on throw", async () => {
    await expect(withActivationLock(testDir, async () => {
      expect(existsSync(join(testDir, ACTIVATION_LOCK_DIR_NAME))).toBe(true);
      throw new Error("activation exploded");
    }, { waitTimeoutMs: 0 })).rejects.toThrow("activation exploded");
    expect(existsSync(join(testDir, ACTIVATION_LOCK_DIR_NAME))).toBe(false);
  });

  test("two OS processes serialize and a killed owner is reclaimed", async () => {
    const lockModule = join(import.meta.dir, "../runtime/activation-lock.ts");
    const env = { ...process.env };
    const workers: Array<ReturnType<typeof Bun.spawn>> = [];

    async function spawnLockWorker(source: string): Promise<ReturnType<typeof Bun.spawn>> {
      const child = Bun.spawn([process.execPath, "-e", source], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      workers.push(child);
      return child;
    }

    function stdoutStream(child: ReturnType<typeof Bun.spawn>, label: string): ReadableStream<Uint8Array> {
      const stream = child.stdout;
      if (stream == null || typeof stream === "number") {
        throw new Error(`${label} stdout is unavailable`);
      }
      return stream;
    }

    async function readLine(stream: ReadableStream<Uint8Array>, label: string, timeoutMs = 4_000): Promise<string> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              reader.read(),
              new Promise<{ done: true; value?: undefined }>(resolve => {
                timer = setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()));
              }),
            ]);
            if (result.value) buf += decoder.decode(result.value, { stream: true });
            const nl = buf.indexOf("\n");
            if (nl >= 0) return buf.slice(0, nl);
            if (result.done) break;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* stream already closed */ }
      }
      throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(buf)}`);
    }

    try {
      const holder = await spawnLockWorker(`
        import { acquireActivationLock } from ${JSON.stringify(lockModule)};
        const handle = await acquireActivationLock(${JSON.stringify(testDir)}, { waitTimeoutMs: 5_000, pollIntervalMs: 20 });
        process.stdout.write("acquired\\n");
        await new Promise(() => {});
      `);
      expect(await readLine(stdoutStream(holder, "holder"), "holder acquire")).toBe("acquired");
      expect(existsSync(join(testDir, ACTIVATION_LOCK_DIR_NAME))).toBe(true);

      const waiter = await spawnLockWorker(`
        import { acquireActivationLock } from ${JSON.stringify(lockModule)};
        const handle = await acquireActivationLock(${JSON.stringify(testDir)}, { waitTimeoutMs: 5_000, pollIntervalMs: 20 });
        process.stdout.write("waiter-acquired\\n");
        handle.release();
      `);
      for (let i = 0; i < 20 && waiter.exitCode === null; i++) await Promise.resolve();
      expect(waiter.exitCode).toBeNull();

      holder.kill("SIGKILL");
      await holder.exited;
      expect(await readLine(stdoutStream(waiter, "waiter"), "waiter acquire after crash")).toBe("waiter-acquired");
      expect(await waiter.exited).toBe(0);
      expect(existsSync(join(testDir, ACTIVATION_LOCK_DIR_NAME))).toBe(false);
    } finally {
      for (const worker of workers) {
        try { worker.kill("SIGKILL"); } catch { /* already exited */ }
      }
      await Promise.all(workers.map(worker => worker.exited.catch(() => 1)));
    }
  }, 15_000);
});
