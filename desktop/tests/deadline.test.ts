import { describe, expect, test } from "bun:test";
import { runBridge, type BridgeHandler } from "../runtime/bootstrap";
import {
  BOOTSTRAP_STOP_DEADLINE_MS,
  DEADLINE_MS,
  DeadlineExceededError,
  MUTATION_DEADLINE_MS,
  MUTATION_TIMEOUT_RECONCILIATION,
  RUNTIME_ACTIVATION_CLEANUP_GRACE_MS,
  STATUS_DEADLINE_MS,
  cleanupGraceMsFor,
  deadlineExceededError,
  deadlineMsFor,
  reconciliationForTimeout,
  requiresTimeoutReconciliation,
  withDeadline,
} from "../runtime/deadline";
import { OPERATIONS, type Operation } from "../runtime/protocol";

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ1";

describe("exact budgets", () => {
  test("status is 10s, bootstrap/stop are 90s, service/tray mutations are 120s", () => {
    expect(STATUS_DEADLINE_MS).toBe(10_000);
    expect(BOOTSTRAP_STOP_DEADLINE_MS).toBe(90_000);
    expect(MUTATION_DEADLINE_MS).toBe(120_000);
    expect(RUNTIME_ACTIVATION_CLEANUP_GRACE_MS).toBe(10_000);
    expect(deadlineMsFor("status")).toBe(10_000);
    expect(deadlineMsFor("bootstrap")).toBe(90_000);
    expect(deadlineMsFor("stop")).toBe(90_000);
    expect(deadlineMsFor("service-install")).toBe(120_000);
    expect(deadlineMsFor("service-start")).toBe(120_000);
    expect(deadlineMsFor("service-repair")).toBe(120_000);
    expect(deadlineMsFor("runtime-activate")).toBe(120_000);
    expect(deadlineMsFor("service-uninstall")).toBe(120_000);
    expect(deadlineMsFor("legacy-tray-uninstall")).toBe(120_000);
    expect(DEADLINE_MS.status).toBe(10_000);
    expect(cleanupGraceMsFor("runtime-activate")).toBe(10_000);
    expect(cleanupGraceMsFor("service-repair")).toBe(0);
  });

  test("every closed operation has a budget", () => {
    for (const operation of OPERATIONS) {
      expect(Number.isInteger(deadlineMsFor(operation))).toBe(true);
      expect(deadlineMsFor(operation)).toBeGreaterThan(0);
    }
  });
});

describe("mutation timeout reconciliation", () => {
  test("status timeout is retryable and does not ask for blind mutation replay", () => {
    expect(requiresTimeoutReconciliation("status")).toBe(false);
    expect(reconciliationForTimeout("status")).toBeNull();
    const error = deadlineExceededError("status");
    expect(error.code).toBe("deadline_exceeded");
    expect(error.retryable).toBe(true);
    if (error.code === "deadline_exceeded") {
      expect(error.reconciliation).toBeNull();
    }
  });

  test("side-effect timeouts are outcome unknown and forbid blind retry", () => {
    const mutations: Operation[] = [
      "bootstrap",
      "stop",
      "service-install",
      "service-start",
      "service-repair",
      "runtime-activate",
      "service-uninstall",
      "legacy-tray-uninstall",
    ];
    for (const operation of mutations) {
      expect(requiresTimeoutReconciliation(operation)).toBe(true);
      expect(reconciliationForTimeout(operation)).toEqual(MUTATION_TIMEOUT_RECONCILIATION);
      const error = deadlineExceededError(operation);
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("reconcile with status");
      expect(error.message).toContain("blind retry forbidden");
      if (error.code === "deadline_exceeded") {
        expect(error.reconciliation).toEqual({
          outcome: "unknown",
          followUpOperation: "status",
          blindRetry: false,
        });
      }
    }
  });
});

describe("withDeadline", () => {
  test("resolves when work finishes inside the budget", async () => {
    const value = await withDeadline(1000, async (signal) => {
      expect(signal.aborted).toBe(false);
      return 7;
    });
    expect(value).toBe(7);
  });

  test("rejects with DeadlineExceededError and aborts the signal", async () => {
    let aborted = false;
    await expect(
      withDeadline(15, async (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return 1;
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(aborted).toBe(true);
  });

  test("waits a bounded cleanup grace after abort before reporting timeout", async () => {
    let cleanupFinished = false;
    const started = performance.now();
    await expect(
      withDeadline(10, async (signal) => {
        await new Promise<void>(resolve => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await new Promise(resolve => setTimeout(resolve, 15));
        cleanupFinished = true;
        return 1;
      }, 50),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(cleanupFinished).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });
});

describe("bridge maps deadline to exit 1", () => {
  test("expired mutation handler emits deadline_exceeded with reconciliation", async () => {
    const writes: Uint8Array[] = [];
    const code = await runBridge({
      stdin: JSON.stringify({
        schemaVersion: 1,
        requestId: ULID,
        operation: "stop",
        payload: { reason: "update" },
      }),
      handler: async (_request, context) => {
        expect(context.deadlineMs).toBe(DEADLINE_MS.stop);
        throw new DeadlineExceededError();
      },
      writeStdout: (bytes) => writes.push(bytes),
    });
    expect(code).toBe(1);
    const json = JSON.parse(new TextDecoder().decode(writes[0])) as {
      ok: boolean;
      error: {
        code: string;
        retryable: boolean;
        reconciliation: { outcome: string; followUpOperation: string; blindRetry: boolean } | null;
      };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("deadline_exceeded");
    expect(json.error.retryable).toBe(false);
    expect(json.error.reconciliation).toEqual({
      outcome: "unknown",
      followUpOperation: "status",
      blindRetry: false,
    });
  });
});
