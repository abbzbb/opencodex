import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PINNED_PORT_BIND_RETRY_MS,
  PINNED_PORT_PREFER_RETRY_MS,
  PINNED_PORT_RECLAIM_TIMEOUT_MS,
} from "../src/config/start-lock";

const cliPath = resolve(import.meta.dir, "../src/cli/index.ts");
const CLI_SOURCE = readFileSync(cliPath, "utf8");
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

type Fixture = {
  root: string;
  ocxHome: string;
  env: Record<string, string>;
};

function fixture(overrides: Record<string, unknown> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-start-lock-cli-"));
  roots.push(root);
  const ocxHome = join(root, "ocx");
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  const codexHome = join(root, "codex");
  for (const path of [ocxHome, home, runtime, codexHome]) mkdirSync(path, { recursive: true });
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port: 0,
    hostname: "127.0.0.1",
    codexAutoStart: true,
    syncResumeHistory: false,
    clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
    claudeCode: { systemEnv: false },
    providers: {},
    defaultProvider: "openai",
    ...overrides,
  }));
  return {
    root,
    ocxHome,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: ocxHome,
      XDG_RUNTIME_DIR: runtime,
      NO_PROXY: "127.0.0.1,localhost",
    },
  };
}

function sliceFn(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, label: string, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function spawnCli(fx: Fixture, argv: string[]): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn([process.execPath, cliPath, ...argv], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function waitForRuntime(fx: Fixture, pid?: number): Promise<{ pid: number; port: number }> {
  const runtimePath = join(fx.ocxHome, "runtime-port.json");
  return waitFor(() => {
    if (!existsSync(runtimePath)) return null;
    try {
      const value = JSON.parse(readFileSync(runtimePath, "utf8")) as { pid?: number; port?: number };
      if (typeof value.pid !== "number" || typeof value.port !== "number" || value.port <= 0) return null;
      if (pid !== undefined && value.pid !== pid) return null;
      return { pid: value.pid, port: value.port };
    } catch {
      return null;
    }
  }, "runtime-port publication");
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null) await child.exited;
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("handleStart start-lock wiring (source-level)", () => {
  const startFn = sliceFn(CLI_SOURCE, "async function handleStart(", "async function handleEnsure(");
  const ensureFn = sliceFn(CLI_SOURCE, "async function handleEnsure(", "async function handleTrayProxyStart(");
  const trayFn = sliceFn(CLI_SOURCE, "async function handleTrayProxyStart(", "const PROXY_RESTART_OBSERVE_MS");
  const lockRegion = sliceFn(startFn, "await withStartLock(", "if (started.kind === \"already-running\")");

  test("handleStart acquires the lock, rediscovers, publishes, then releases before any process.exit", () => {
    expect(CLI_SOURCE).toContain('from "../config/start-lock"');
    expect(startFn).toContain("withStartLock");
    const firstDiscovery = startFn.indexOf("findProxyOwnerBeforeJournalRecovery()");
    const lockIdx = startFn.indexOf("await withStartLock(");
    const lockedDiscovery = lockRegion.indexOf("findProxyOwnerBeforeJournalRecovery()");
    expect(firstDiscovery).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(firstDiscovery);
    expect(lockedDiscovery).toBeGreaterThan(-1);
    expect(lockRegion).toContain("writePid(process.pid)");
    expect(lockRegion).toContain("writeRuntimePort(");
    expect(lockRegion).toContain("server = startServer(port");
    expect(lockRegion).not.toMatch(/process\.exit\s*\(/);
    expect(startFn.indexOf("await maybeShowUpdatePrompt()")).toBeGreaterThan(-1);
    expect(startFn.indexOf("await maybeShowUpdatePrompt()")).toBeLessThan(lockIdx);
  });

  test("chooseListenPort uses the shared reclaim/prefer-retry budgets and does not process.exit", () => {
    const choose = sliceFn(CLI_SOURCE, "async function chooseListenPort(", "function exitIfProxyAlreadyRunning(");
    expect(choose).toContain("timeoutMs: PINNED_PORT_RECLAIM_TIMEOUT_MS");
    expect(choose).toContain("preferRetryMs: hardPin ? PINNED_PORT_PREFER_RETRY_MS : 750");
    expect(choose).not.toMatch(/process\.exit\s*\(/);
    expect(PINNED_PORT_RECLAIM_TIMEOUT_MS).toBe(60_000);
    expect(CLI_SOURCE).toContain("timeoutMs: PINNED_PORT_BIND_RETRY_MS");
    expect(PINNED_PORT_BIND_RETRY_MS).toBe(3_000);
    expect(PINNED_PORT_PREFER_RETRY_MS).toBe(5_000);
  });

  test("ensure and tray spawners never acquire the start lock while waiting on a child", () => {
    expect(ensureFn).not.toContain("withStartLock");
    expect(ensureFn).not.toContain("acquireStartLock");
    expect(ensureFn).toContain("spawn(process.execPath, startArgv");
    expect(ensureFn).toContain("waitForProxy()");
    expect(trayFn).not.toContain("withStartLock");
    expect(trayFn).not.toContain("acquireStartLock");
    const bootstrap = readFileSync(join(import.meta.dir, "../desktop/runtime/bootstrap.ts"), "utf8");
    expect(bootstrap).not.toContain("start-lock");
    expect(bootstrap).not.toContain("acquireStartLock");
    expect(bootstrap).not.toContain("withStartLock");
  });

  test("publication failure rolls back the unpublished listener before release", () => {
    expect(lockRegion).toContain("server.stop(true)");
    expect(lockRegion).toContain("removePid(process.pid)");
    expect(lockRegion).toContain("removeRuntimePort(process.pid)");
  });
});

describe("concurrent start children", () => {
  test("two ocx start processes serialize: one binds, the other reports already running", async () => {
    const fx = fixture();
    const first = spawnCli(fx, ["start"]);
    const second = spawnCli(fx, ["start"]);
    const runtime = await waitForRuntime(fx);
    const lockPath = join(fx.ocxHome, "ocx.start.lock");

    const loser = await Promise.race([
      first.exited.then(code => ({ child: first, code })),
      second.exited.then(code => ({ child: second, code })),
    ]);
    const winner = loser.child === first ? second : first;
    expect(loser.code).toBe(1);
    expect(await new Response(loser.child.stderr).text()).toContain("Proxy already running");
    expect(winner.exitCode).toBeNull();
    expect(runtime.pid).toBe(winner.pid);
    expect(existsSync(lockPath)).toBe(false);

    const health = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/healthz`, { signal: AbortSignal.timeout(500) });
        const body = await response.json() as { pid?: number };
        return response.ok && body.pid === winner.pid ? true : null;
      } catch {
        return null;
      }
    }, "winner healthz");
    expect(health).toBe(true);
  }, 30_000);

  test("two ocx ensure parents do not hold the lock; one start child wins", async () => {
    const fx = fixture();
    const first = spawnCli(fx, ["ensure"]);
    const second = spawnCli(fx, ["ensure"]);
    const runtime = await waitForRuntime(fx);
    const [firstCode, secondCode] = await Promise.all([first.exited, second.exited]);
    expect(firstCode).toBe(0);
    expect(secondCode).toBe(0);
    expect(existsSync(join(fx.ocxHome, "ocx.start.lock"))).toBe(false);
    expect(existsSync(join(fx.ocxHome, "runtime-port.json"))).toBe(true);
    const body = JSON.parse(readFileSync(join(fx.ocxHome, "runtime-port.json"), "utf8")) as { pid: number; port: number };
    expect(body.port).toBe(runtime.port);
    const health = await fetch(`http://127.0.0.1:${body.port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    const json = await health.json() as { pid?: number };
    expect(json.pid).toBe(body.pid);
  }, 30_000);

  test("a failed runtime-port publication releases the lock and does not leave a listener", async () => {
    const fx = fixture();
    mkdirSync(join(fx.ocxHome, "runtime-port.json"));
    const child = spawnCli(fx, ["start"]);
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("publication-failure start did not exit")), 15_000)),
    ]);
    const stderr = await new Response(child.stderr).text();
    expect(code, stderr).not.toBe(0);
    expect(stderr).toContain("Failed to bind or publish start records");
    expect(existsSync(join(fx.ocxHome, "ocx.start.lock"))).toBe(false);
    expect(existsSync(join(fx.ocxHome, "ocx.pid"))).toBe(false);
  }, 20_000);
});
