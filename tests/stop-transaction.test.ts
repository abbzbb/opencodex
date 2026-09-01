import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runStopTransaction,
  STOP_TRANSACTION_CODES,
  type StopTransactionDeps,
  type StopTransactionResult,
} from "../src/cli/stop-transaction";

const STOP_TX_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "stop-transaction.ts"), "utf8");
const CLI_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");

function baseDeps(overrides: Partial<StopTransactionDeps> = {}): StopTransactionDeps {
  return {
    stopServiceIfInstalled: () => ({ state: "absent" }),
    isServiceOwnershipError: () => false,
    readPid: () => null,
    stopProxy: async () => {},
    removePid: () => {},
    removeRuntimePort: () => {},
    readPidFileValue: () => null,
    readRuntimePortPid: () => null,
    findLiveProxy: async () => null,
    removePidIfValueIs: () => {},
    removeRuntimePortIfPidIs: () => {},
    revertSystemEnv: () => {},
    restoreNativeCodexAsync: async () => ({ success: true, message: "Native Codex restored." }),
    stripGrokConfig: () => ({ ok: true, changed: true, message: "Grok config restored." }),
    isProxyOwnershipRefused: () => false,
    sleep: async () => {},
    absenceProbeAttempts: 3,
    ...overrides,
  };
}

function ownKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const item of value) ownKeys(item, into);
    return into;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    ownKeys(nested, into);
  }
  return into;
}

function assertNoCredentials(result: StopTransactionResult) {
  const keys = ownKeys(result);
  for (const key of [
    "token",
    "apiKey",
    "api_key",
    "authorization",
    "password",
    "secret",
    "credential",
    "OPENCODEX_API_AUTH_TOKEN",
    "config",
  ]) {
    expect(keys.has(key)).toBe(false);
  }
  const json = JSON.stringify(result);
  expect(json).not.toContain("sk-live-");
  expect(json).not.toContain("Bearer ");
}

describe("runStopTransaction", () => {
  test("stops a tracked pid, restores native Codex then Grok, and reports stopped", async () => {
    const calls: string[] = [];
    const removed: number[] = [];
    const result = await runStopTransaction(baseDeps({
      stopServiceIfInstalled: () => {
        calls.push("service");
        return true;
      },
      readPid: () => {
        calls.push("readPid");
        return 4242;
      },
      stopProxy: async pid => {
        calls.push(`stopProxy:${pid}`);
      },
      removePid: pid => {
        calls.push("removePid");
        removed.push(pid);
      },
      removeRuntimePort: pid => {
        calls.push("removeRuntimePort");
        removed.push(pid);
      },
      findLiveProxy: async () => {
        calls.push("findLiveProxy");
        return null;
      },
      revertSystemEnv: () => {
        calls.push("revertSystemEnv");
      },
      restoreNativeCodexAsync: async () => {
        calls.push("restoreNative");
        return { success: true, message: "Native Codex restored." };
      },
      stripGrokConfig: () => {
        calls.push("stripGrok");
        return { ok: true, changed: true, message: "Grok config restored." };
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      code: "stopped",
      serviceStopped: true,
      proxyStopped: true,
      proxyAbsent: true,
      restoreStatus: "restored",
      grokStatus: "restored",
    });
    expect(calls).toEqual([
      "service",
      "readPid",
      "stopProxy:4242",
      "removePid",
      "removeRuntimePort",
      "findLiveProxy",
      "findLiveProxy",
      "findLiveProxy",
      "revertSystemEnv",
      "restoreNative",
      "stripGrok",
    ]);
    expect(removed).toEqual([4242, 4242]);
    assertNoCredentials(result);
  });

  test("orphan path snapshots stale state before the live probe and purges only after a successful stop", async () => {
    const calls: string[] = [];
    let probes = 0;
    const result = await runStopTransaction(baseDeps({
      readPidFileValue: () => {
        calls.push("snapshotPid");
        return 7;
      },
      readRuntimePortPid: () => {
        calls.push("snapshotRuntime");
        return 7;
      },
      findLiveProxy: async () => {
        calls.push("findLiveProxy");
        probes += 1;
        return probes === 1 ? { pid: 7 } : null;
      },
      stopProxy: async pid => {
        calls.push(`stopProxy:${pid}`);
      },
      removePidIfValueIs: value => {
        calls.push(`purgePid:${value}`);
      },
      removeRuntimePortIfPidIs: pid => {
        calls.push(`purgeRuntime:${pid}`);
      },
      revertSystemEnv: () => {
        calls.push("revertSystemEnv");
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.code).toBe("stopped");
    expect(result.proxyStopped).toBe(true);
    expect(calls.slice(0, 4)).toEqual(["snapshotPid", "snapshotRuntime", "findLiveProxy", "stopProxy:7"]);
    expect(calls.indexOf("snapshotPid")).toBeLessThan(calls.indexOf("findLiveProxy"));
    expect(calls.indexOf("purgePid:7")).toBeGreaterThan(calls.indexOf("stopProxy:7"));
    expect(calls.indexOf("purgePid:7")).toBeLessThan(calls.indexOf("revertSystemEnv"));
  });

  test("orphan stop failure skips snapshot purge and shared restore", async () => {
    const purged: string[] = [];
    let restored = false;
    const result = await runStopTransaction(baseDeps({
      readPidFileValue: () => 11,
      readRuntimePortPid: () => 11,
      findLiveProxy: async () => ({ pid: 11 }),
      stopProxy: async () => {
        throw new Error("taskkill exited 1");
      },
      removePidIfValueIs: () => {
        purged.push("pid");
      },
      removeRuntimePortIfPidIs: () => {
        purged.push("runtime");
      },
      restoreNativeCodexAsync: async () => {
        restored = true;
        return { success: true, message: "Native Codex restored." };
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe("stop_failed");
    expect(result.retryable).toBe(true);
    expect(result.proxyAbsent).toBe(false);
    expect(result.message).toContain("PID 11");
    expect(purged).toEqual([]);
    expect(restored).toBe(false);
    assertNoCredentials(result);
  });

  test("orphan discovery failure stays structured and skips purge and restore", async () => {
    const calls: string[] = [];
    const result = await runStopTransaction(baseDeps({
      readPidFileValue: () => 17,
      readRuntimePortPid: () => 17,
      findLiveProxy: async () => {
        throw new Error("Authorization: Bearer secret-value /home/alice/runtime.json");
      },
      removePidIfValueIs: () => calls.push("purgePid"),
      removeRuntimePortIfPidIs: () => calls.push("purgeRuntime"),
      revertSystemEnv: () => calls.push("restoreEnv"),
      restoreNativeCodexAsync: async () => {
        calls.push("restoreNative");
        return { success: true, message: "restored" };
      },
    }));

    expect(result).toMatchObject({
      ok: false,
      code: "stop_failed",
      retryable: true,
      proxyAbsent: false,
      message: "Proxy discovery failed before stop.",
    });
    expect(result.events.some(event => event.type === "no_running_proxy")).toBe(false);
    expect(calls).toEqual([]);
    assertNoCredentials(result);
    expect(JSON.stringify(result)).not.toContain("/home/alice");
  });

  test("service ownership conflict skips every shared restore and is not retryable", async () => {
    const calls: string[] = [];
    const result = await runStopTransaction(baseDeps({
      stopServiceIfInstalled: () => {
        throw Object.assign(new Error("Service was installed with CODEX_HOME=/other"), { name: "ServiceOwnershipError" });
      },
      isServiceOwnershipError: err => err instanceof Error && err.name === "ServiceOwnershipError",
      revertSystemEnv: () => {
        calls.push("revertSystemEnv");
      },
      restoreNativeCodexAsync: async () => {
        calls.push("restoreNative");
        return { success: true, message: "Native Codex restored." };
      },
      stripGrokConfig: () => {
        calls.push("stripGrok");
        return { ok: true, changed: true, message: "Grok config restored." };
      },
    }));

    expect(result).toMatchObject({
      ok: false,
      code: "ownership_conflict",
      retryable: false,
      proxyAbsent: false,
      restoreStatus: "not-needed",
      grokStatus: "not-needed",
    });
    expect(result.message).toContain("CODEX_HOME=/other");
    expect(calls).toEqual([]);
    expect(result.events.some(event => event.type === "service_ownership")).toBe(true);
    assertNoCredentials(result);
  });

  test("proxy ownership refusal on a tracked pid skips restore", async () => {
    const calls: string[] = [];
    const result = await runStopTransaction(baseDeps({
      readPid: () => 88,
      stopProxy: async () => {
        throw new Error("run the stop from that home");
      },
      isProxyOwnershipRefused: () => true,
      restoreNativeCodexAsync: async () => {
        calls.push("restoreNative");
        return { success: true, message: "Native Codex restored." };
      },
      stripGrokConfig: () => {
        calls.push("stripGrok");
        return { ok: true, changed: true, message: "Grok config restored." };
      },
    }));

    expect(result.code).toBe("ownership_conflict");
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.proxyAbsent).toBe(false);
    expect(result.restoreStatus).toBe("not-needed");
    expect(result.grokStatus).toBe("not-needed");
    expect(calls).toEqual([]);
    const failed = result.events.find(event => event.type === "proxy_stop_failed");
    expect(failed).toMatchObject({ type: "proxy_stop_failed", pid: 88, ownershipRefused: true });
  });

  test("a plain service-manager failure still stops the proxy but cannot report success", async () => {
    const result = await runStopTransaction(baseDeps({
      stopServiceIfInstalled: () => {
        throw new Error("launchctl exited 1");
      },
      readPid: () => 5,
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("stop_failed");
    expect(result.serviceStopped).toBe(false);
    expect(result.proxyStopped).toBe(true);
    expect(result.proxyAbsent).toBe(true);
    expect(result.events.some(event => event.type === "service_stop_failed")).toBe(true);
  });

  test("a proxy that respawns during the stabilization window blocks restore", async () => {
    let probes = 0;
    let restored = false;
    const result = await runStopTransaction(baseDeps({
      readPid: () => 5,
      findLiveProxy: async () => {
        probes += 1;
        return probes === 2 ? { pid: 77 } : null;
      },
      restoreNativeCodexAsync: async () => {
        restored = true;
        return { success: true, message: "restored" };
      },
    }));
    expect(result).toMatchObject({
      ok: false,
      code: "stop_failed",
      proxyStopped: true,
      proxyAbsent: false,
    });
    expect(restored).toBe(false);
    expect(result.events).toContainEqual({
      type: "proxy_absence_failed",
      pid: 77,
      message: "Proxy is still running after the stop transaction",
    });
  });

  test("a respawn-capable service is watched for the full delayed restart window", async () => {
    let now = 0;
    const probeTimes: number[] = [];
    let restored = false;
    const result = await runStopTransaction(baseDeps({
      stopServiceIfInstalled: () => ({ state: "stopped", canRespawn: true }),
      readPid: () => 5,
      now: () => now,
      sleep: async ms => { now += ms; },
      absenceProbeAttempts: 2,
      absenceProbeDelayMs: 1_000,
      findLiveProxy: async () => {
        probeTimes.push(now);
        return now === 5_000 ? { pid: 77 } : null;
      },
      restoreNativeCodexAsync: async () => {
        restored = true;
        return { success: true, message: "restored" };
      },
    }));
    expect(result).toMatchObject({
      ok: false,
      code: "stop_failed",
      proxyAbsent: false,
    });
    expect(restored).toBe(false);
    expect(probeTimes).toContain(5_000);
  });

  test("environment restore failure is reported after confirmed absence", async () => {
    const result = await runStopTransaction(baseDeps({
      revertSystemEnv: () => { throw new Error("environment rollback failed"); },
    }));
    expect(result).toMatchObject({
      ok: false,
      code: "restore_failed",
      proxyAbsent: true,
      restoreStatus: "failed",
    });
  });

  test("dependency diagnostics are redacted and bounded at the transaction boundary", async () => {
    const secret = "leaked-stop-secret-value";
    const home = process.env.HOME ?? "/home/test-user";
    const result = await runStopTransaction(baseDeps({
      readPid: () => 13,
      restoreNativeCodexAsync: async () => ({
        success: false,
        message: `Authorization: Bearer ${secret}\npath=${home}/.opencodex/config.json`,
      }),
    }));
    const serialized = JSON.stringify(result);
    expect(result.code).toBe("restore_failed");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(home);
    expect(serialized.length).toBeLessThan(10_000);
  });

  test("credential-only dependency diagnostics are redacted without relying on path withholding", async () => {
    const secret = "credential-only-stop-secret-value";
    const result = await runStopTransaction(baseDeps({
      stopServiceIfInstalled: () => ({
        state: "failed",
        message: `Authorization: Bearer ${secret}`,
      }),
    }));
    const serialized = JSON.stringify(result);
    expect(result.code).toBe("stop_failed");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).toContain("[REDACTED]");
  });

  test("native Codex restore failure after a successful stop is restore_failed with proxyAbsent", async () => {
    const grokCalled = { value: false };
    const result = await runStopTransaction(baseDeps({
      readPid: () => 3,
      restoreNativeCodexAsync: async () => ({ success: false, message: "config.toml restore incomplete" }),
      stripGrokConfig: () => {
        grokCalled.value = true;
        return { ok: true, changed: true, message: "Grok config restored." };
      },
    }));

    expect(result).toMatchObject({
      ok: false,
      code: "restore_failed",
      retryable: true,
      proxyStopped: true,
      proxyAbsent: true,
      restoreStatus: "failed",
      grokStatus: "restored",
    });
    expect(result.message).toBe("config.toml restore incomplete");
    expect(grokCalled.value).toBe(true);
    assertNoCredentials(result);
  });

  test("a refused Grok strip is restore_failed even when the proxy is already gone", async () => {
    const result = await runStopTransaction(baseDeps({
      readPid: () => 9,
      stripGrokConfig: () => ({ ok: false, changed: false, message: "Grok fence is owned by another home" }),
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("restore_failed");
    expect(result.proxyAbsent).toBe(true);
    expect(result.restoreStatus).toBe("restored");
    expect(result.grokStatus).toBe("failed");
    expect(result.message).toContain("Grok fence");
  });

  test("a partial Grok cleanup failure is not reported as restored", async () => {
    const result = await runStopTransaction(baseDeps({
      readPid: () => 9,
      stripGrokConfig: () => ({ ok: false, changed: true, message: "Grok cleanup incomplete" }),
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("restore_failed");
    expect(result.grokStatus).toBe("failed");
  });

  test("Grok not-needed and native restored still reports stopped", async () => {
    const result = await runStopTransaction(baseDeps({
      stripGrokConfig: () => ({ ok: true, changed: false, message: "no Grok fence" }),
    }));
    expect(result.ok).toBe(true);
    expect(result.code).toBe("stopped");
    expect(result.proxyAbsent).toBe(true);
    expect(result.restoreStatus).toBe("restored");
    expect(result.grokStatus).toBe("not-needed");
  });

  test("no running proxy logs absence, still restores, and does not claim a stop", async () => {
    const result = await runStopTransaction(baseDeps());
    expect(result).toMatchObject({
      ok: true,
      code: "stopped",
      serviceStopped: false,
      proxyStopped: false,
      proxyAbsent: true,
    });
    expect(result.events.some(event => event.type === "no_running_proxy")).toBe(true);
  });

  test("a stopped service with no proxy does not emit no_running_proxy", async () => {
    const result = await runStopTransaction(baseDeps({
      stopServiceIfInstalled: () => true,
    }));
    expect(result.ok).toBe(true);
    expect(result.serviceStopped).toBe(true);
    expect(result.events.some(event => event.type === "no_running_proxy")).toBe(false);
    expect(result.events.some(event => event.type === "service_stopped")).toBe(true);
  });
});

describe("stop transaction wiring", () => {
  test("the module does not import the CLI dispatcher", () => {
    expect(STOP_TX_SOURCE).not.toMatch(/from ["']\.\/index["']/);
    expect(STOP_TX_SOURCE).not.toMatch(/from ["']\.\/index\.ts["']/);
    expect(STOP_TX_SOURCE).not.toMatch(/cli\/index/);
  });

  test("CLI handleStop is a thin renderer of the transaction result", () => {
    const from = CLI_SOURCE.indexOf("async function handleStop(");
    const to = CLI_SOURCE.indexOf("async function handleUninstall(");
    const stopFn = CLI_SOURCE.slice(from, to);
    expect(stopFn).toContain("runStopTransaction(");
    expect(stopFn).toContain("stopServiceIfInstalled: stopServiceForTransaction");
    expect(stopFn).toContain("return result.ok");
    expect(stopFn).toContain("process.exitCode = 1");
    expect(stopFn).not.toContain("process.exit(1)");
    expect(stopFn).not.toContain("ownershipBlocked");
    expect(STOP_TRANSACTION_CODES).toEqual([
      "stopped",
      "ownership_conflict",
      "stop_failed",
      "restore_failed",
    ]);
  });
});
