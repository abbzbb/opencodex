import type { BridgeError, MutationTimeoutReconciliation, Operation } from "./protocol";

export const STATUS_DEADLINE_MS = 10_000;
export const BOOTSTRAP_STOP_DEADLINE_MS = 90_000;
export const MUTATION_DEADLINE_MS = 120_000;
export const RUNTIME_ACTIVATION_CLEANUP_GRACE_MS = 10_000;

export const DEADLINE_MS = {
  status: STATUS_DEADLINE_MS,
  bootstrap: BOOTSTRAP_STOP_DEADLINE_MS,
  stop: BOOTSTRAP_STOP_DEADLINE_MS,
  "service-install": MUTATION_DEADLINE_MS,
  "service-start": MUTATION_DEADLINE_MS,
  "service-repair": MUTATION_DEADLINE_MS,
  "runtime-activate": MUTATION_DEADLINE_MS,
  "service-uninstall": MUTATION_DEADLINE_MS,
  "legacy-tray-uninstall": MUTATION_DEADLINE_MS,
} as const satisfies Record<Operation, number>;

export const MUTATION_TIMEOUT_RECONCILIATION: MutationTimeoutReconciliation = {
  outcome: "unknown",
  followUpOperation: "status",
  blindRetry: false,
};

export function deadlineMsFor(operation: Operation): number {
  return DEADLINE_MS[operation];
}

export function cleanupGraceMsFor(operation: Operation): number {
  return operation === "runtime-activate" ? RUNTIME_ACTIVATION_CLEANUP_GRACE_MS : 0;
}

export function requiresTimeoutReconciliation(operation: Operation): boolean {
  return operation !== "status";
}

export function reconciliationForTimeout(
  operation: Operation,
): MutationTimeoutReconciliation | null {
  if (!requiresTimeoutReconciliation(operation)) {
    return null;
  }
  return {
    outcome: "unknown",
    followUpOperation: "status",
    blindRetry: false,
  };
}

export class DeadlineExceededError extends Error {
  readonly code = "deadline_exceeded" as const;

  constructor(message = "deadline exceeded") {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

export function isDeadlineExceededError(value: unknown): value is DeadlineExceededError {
  return value instanceof DeadlineExceededError;
}

export function deadlineExceededError(operation: Operation): BridgeError {
  const reconciliation = reconciliationForTimeout(operation);
  if (reconciliation === null) {
    return {
      code: "deadline_exceeded",
      message: "status deadline exceeded",
      retryable: true,
      reconciliation: null,
    };
  }
  return {
    code: "deadline_exceeded",
    message:
      "operation deadline exceeded; outcome unknown; reconcile with status; blind retry forbidden",
    retryable: false,
    reconciliation,
  };
}

export async function withDeadline<T>(
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  cleanupGraceMs = 0,
): Promise<T> {
  if (
    !Number.isInteger(deadlineMs)
    || deadlineMs < 1
    || !Number.isInteger(cleanupGraceMs)
    || cleanupGraceMs < 0
  ) {
    throw new DeadlineExceededError("invalid deadline");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, deadlineMs);
  });
  const workOutcome = Promise.resolve()
    .then(() => work(controller.signal))
    .then(
      value => ({ kind: "value" as const, value }),
      error => ({ kind: "error" as const, error }),
    );
  try {
    const outcome = await Promise.race([workOutcome, timeout]);
    if (outcome.kind === "value") return outcome.value;
    if (outcome.kind === "error") {
      if (controller.signal.aborted) throw new DeadlineExceededError();
      throw outcome.error;
    }
    if (cleanupGraceMs > 0) {
      await Promise.race([
        workOutcome.then(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, cleanupGraceMs)),
      ]);
    }
    throw new DeadlineExceededError();
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
