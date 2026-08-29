/**
 * Shared stop orchestration for CLI `ocx stop` and the Desktop bridge.
 *
 * Callers inject I/O. This module must not import `./index` (that file dispatches
 * on load) and the result must not carry tokens, config bodies, or reusable
 * credentials.
 */

import { redactSecretString, redactUserPath } from "../lib/redact";

export type StopTransactionCode = "stopped" | "ownership_conflict" | "stop_failed" | "restore_failed";
export type RestoreStatus = "restored" | "not-needed" | "failed";

export type StopTransactionEvent =
  | { type: "service_stopped" }
  | { type: "service_ownership"; message: string }
  | { type: "service_stop_failed"; message: string }
  | { type: "proxy_stopped"; pid: number }
  | { type: "proxy_stop_failed"; pid: number; detail: string; ownershipRefused: boolean }
  | { type: "proxy_absence_failed"; pid: number | null; message: string }
  | { type: "no_running_proxy" }
  | { type: "environment_restore_failed"; message: string }
  | { type: "native_restore"; success: boolean; message: string }
  | { type: "native_restore_threw"; message: string }
  | { type: "grok_restore"; ok: boolean; changed: boolean; message: string }
  | { type: "grok_restore_threw"; message: string };

export type ServiceStopOutcome =
  | { state: "absent"; canRespawn?: false }
  | { state: "stopped"; canRespawn?: boolean }
  | { state: "failed"; message: string; canRespawn?: boolean };

export type StopTransactionDeps = {
  stopServiceIfInstalled: () => boolean | ServiceStopOutcome;
  isServiceOwnershipError: (err: unknown) => boolean;
  readPid: () => number | null;
  stopProxy: (pid: number) => Promise<void>;
  removePid: (pid: number) => void;
  removeRuntimePort: (pid: number) => void;
  readPidFileValue: () => number | null;
  readRuntimePortPid: () => number | null;
  findLiveProxy: () => Promise<{ pid?: number | null } | null>;
  removePidIfValueIs: (value: number | null) => void;
  removeRuntimePortIfPidIs: (pid: number | null) => void;
  revertSystemEnv: () => void;
  restoreNativeCodexAsync: () => Promise<{ success: boolean; message: string }>;
  stripGrokConfig: () => { ok: boolean; changed: boolean; message: string };
  isProxyOwnershipRefused: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  absenceProbeAttempts?: number;
  absenceProbeDelayMs?: number;
  serviceRespawnWindowMs?: number;
};

type StopTransactionFields = {
  serviceStopped: boolean;
  proxyStopped: boolean;
  proxyAbsent: boolean;
  restoreStatus: RestoreStatus;
  grokStatus: RestoreStatus;
  events: StopTransactionEvent[];
};

export type StopTransactionResult =
  | ({ ok: true; code: "stopped" } & StopTransactionFields)
  | ({
      ok: false;
      code: "ownership_conflict" | "stop_failed" | "restore_failed";
      retryable: boolean;
      message: string;
    } & StopTransactionFields);

const MAX_TRANSACTION_MESSAGE_LENGTH = 1024;
const SERVICE_RESPAWN_WINDOW_MS = 7_000;

function safeMessage(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const printable = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  const secretRedacted = redactSecretString(printable).replace(/\bBearer\s+\[REDACTED\]/gi, "[REDACTED]");
  const redacted = redactUserPath(secretRedacted).trim();
  const pathBearing = /[A-Za-z]:[\\/]/.test(redacted)
    || /\\\\/.test(redacted)
    || /~[\w.-]*\//.test(redacted)
    || /[%$][A-Za-z_]/.test(redacted)
    || /\/[\w.\-~%]+\//.test(redacted);
  if (pathBearing) return `${fallback} (details withheld)`;
  return (redacted || fallback).slice(0, MAX_TRANSACTION_MESSAGE_LENGTH);
}

function normalizeServiceStopOutcome(value: boolean | ServiceStopOutcome): ServiceStopOutcome {
  if (typeof value === "boolean") return value ? { state: "stopped" } : { state: "absent" };
  return value;
}

function restoreStatusFromEvents(events: StopTransactionEvent[]): RestoreStatus {
  for (const event of events) {
    if (event.type === "native_restore_threw") return "failed";
    if (event.type === "environment_restore_failed") return "failed";
    if (event.type === "native_restore") return event.success ? "restored" : "failed";
  }
  return "not-needed";
}

function grokStatusFromEvents(events: StopTransactionEvent[]): RestoreStatus {
  for (const event of events) {
    if (event.type === "grok_restore_threw") return "failed";
    if (event.type === "grok_restore") {
      if (!event.ok) return "failed";
      return event.changed ? "restored" : "not-needed";
    }
  }
  return "not-needed";
}

function restoreFailureMessage(events: StopTransactionEvent[]): string {
  for (const event of events) {
    if (event.type === "native_restore" && !event.success) return event.message;
    if (event.type === "native_restore_threw") return event.message;
    if (event.type === "environment_restore_failed") return event.message;
    if (event.type === "grok_restore" && !event.ok) return event.message;
    if (event.type === "grok_restore_threw") return event.message;
  }
  return "Client restore failed";
}

async function restoreSharedClientStateAfterStop(
  deps: StopTransactionDeps,
  events: StopTransactionEvent[],
): Promise<boolean> {
  let restored = true;
  try {
    const result = await deps.restoreNativeCodexAsync();
    const message = safeMessage(result.message, "Native Codex restore completed");
    if (result.success) events.push({ type: "native_restore", success: true, message });
    else {
      restored = false;
      events.push({ type: "native_restore", success: false, message });
    }
  } catch (error) {
    restored = false;
    events.push({ type: "native_restore_threw", message: safeMessage(error, "Native Codex restore failed") });
  }

  // A refused or thrown Grok strip is actionable because it would point Grok at a dead proxy.
  try {
    const grok = deps.stripGrokConfig();
    events.push({
      type: "grok_restore",
      ok: grok.ok,
      changed: grok.changed,
      message: safeMessage(grok.message, "Grok config restore completed"),
    });
    if (!grok.ok) restored = false;
  } catch (error) {
    restored = false;
    events.push({ type: "grok_restore_threw", message: safeMessage(error, "Grok config restore failed") });
  }
  return restored;
}

async function confirmProxyRemainsAbsent(
  deps: StopTransactionDeps,
  events: StopTransactionEvent[],
  canRespawn: boolean,
): Promise<boolean> {
  const attempts = Math.max(2, deps.absenceProbeAttempts ?? 5);
  const delayMs = Math.max(1, deps.absenceProbeDelayMs ?? 500);
  const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const respawnWindowMs = Math.max(0, deps.serviceRespawnWindowMs ?? SERVICE_RESPAWN_WINDOW_MS);
  const startedAt = now();
  let attempt = 0;
  for (;;) {
    let live: { pid?: number | null } | null;
    try {
      live = await deps.findLiveProxy();
    } catch (error) {
      events.push({
        type: "proxy_absence_failed",
        pid: null,
        message: safeMessage(error, "Proxy absence could not be verified"),
      });
      return false;
    }
    if (live !== null) {
      events.push({
        type: "proxy_absence_failed",
        pid: live.pid ?? null,
        message: "Proxy is still running after the stop transaction",
      });
      return false;
    }
    attempt += 1;
    if (canRespawn) {
      const remainingMs = respawnWindowMs - (now() - startedAt);
      if (remainingMs <= 0 && attempt >= 2) return true;
      await sleep(Math.min(delayMs, Math.max(1, remainingMs)));
      continue;
    }
    if (attempt >= attempts) return true;
    await sleep(delayMs);
  }
}

export async function runStopTransaction(deps: StopTransactionDeps): Promise<StopTransactionResult> {
  const events: StopTransactionEvent[] = [];
  let serviceStopFailed = false;
  let proxyStopFailed = false;
  let stoppedService = false;
  let serviceCanRespawn = false;
  let proxyStopped = false;
  // An ownership mismatch means the service manager was never even contacted: the installed
  // service is still live and will respawn the proxy. Tearing down SHARED state in that
  // situation (native Codex config, the Grok fence) removes config out from under a running
  // service — the exact failure this flag prevents. A plain service-stop failure is also
  // unsafe for shared teardown because the supervisor may still respawn the proxy.
  let ownershipBlocked = false;
  let ownershipMessage = "";
  let stopFailureMessage = "";
  let serviceFailureMessage = "";

  try {
    const service = normalizeServiceStopOutcome(deps.stopServiceIfInstalled());
    stoppedService = service.state === "stopped";
    serviceCanRespawn = service.canRespawn === true;
    if (service.state === "stopped") events.push({ type: "service_stopped" });
    if (service.state === "failed") {
      serviceStopFailed = true;
      serviceFailureMessage = safeMessage(service.message, "Service manager failed to stop");
      events.push({ type: "service_stop_failed", message: serviceFailureMessage });
    }
  } catch (err) {
    if (deps.isServiceOwnershipError(err)) {
      ownershipBlocked = true;
      ownershipMessage = safeMessage(err, "Service ownership conflict");
      events.push({ type: "service_ownership", message: ownershipMessage });
    } else {
      serviceStopFailed = true;
      serviceFailureMessage = safeMessage(err, "Service manager failed to stop");
      events.push({ type: "service_stop_failed", message: serviceFailureMessage });
    }
  }

  const pid = deps.readPid();
  if (pid) {
    try {
      // Graceful-first (management-API drain) — on Windows this is the only path where
      // the proxy's shutdown handlers actually run; taskkill /F is the fallback inside.
      await deps.stopProxy(pid);
      events.push({ type: "proxy_stopped", pid });
      proxyStopped = true;
      deps.removePid(pid);
      deps.removeRuntimePort(pid);
    } catch (err) {
      proxyStopFailed = true;
      const detail = safeMessage(err, "Proxy stop failed");
      stopFailureMessage = `Failed to stop proxy (PID ${pid}).`;
      events.push({
        type: "proxy_stop_failed",
        pid,
        detail,
        ownershipRefused: deps.isProxyOwnershipRefused(err),
      });
      if (deps.isProxyOwnershipRefused(err)) {
        ownershipBlocked = true;
        ownershipMessage = detail;
      }
    }
  } else {
    // Snapshot the stale on-disk state BEFORE the async probe: a concurrent `ocx start`
    // can write fresh records mid-probe, and the purge below must never delete those.
    const stalePidValue = deps.readPidFileValue();
    const staleRuntimePid = deps.readRuntimePortPid();
    // Orphan recovery: a live proxy can outlive its pid file (crash, manual delete,
    // corrupt file). Identity-checked liveness still finds it via the runtime record.
    let live: { pid?: number | null } | null = null;
    try {
      live = await deps.findLiveProxy();
    } catch (error) {
      proxyStopFailed = true;
      stopFailureMessage = "Proxy discovery failed before stop.";
      events.push({
        type: "proxy_absence_failed",
        pid: null,
        message: safeMessage(error, "Proxy discovery failed before stop"),
      });
    }
    if (live?.pid) {
      try {
        await deps.stopProxy(live.pid);
        events.push({ type: "proxy_stopped", pid: live.pid });
        proxyStopped = true;
      } catch (err) {
        proxyStopFailed = true;
        const detail = safeMessage(err, "Proxy stop failed");
        stopFailureMessage = `Failed to stop proxy (PID ${live.pid}).`;
        events.push({
          type: "proxy_stop_failed",
          pid: live.pid,
          detail,
          ownershipRefused: deps.isProxyOwnershipRefused(err),
        });
        if (deps.isProxyOwnershipRefused(err)) {
          ownershipBlocked = true;
          ownershipMessage = detail;
        }
      }
    } else if (!proxyStopFailed && !stoppedService) {
      events.push({ type: "no_running_proxy" });
    }
    if (!proxyStopFailed) {
      deps.removePidIfValueIs(stalePidValue);
      deps.removeRuntimePortIfPidIs(staleRuntimePid);
    }
  }

  const proxyAbsent = !ownershipBlocked && !proxyStopFailed
    ? await confirmProxyRemainsAbsent(deps, events, serviceCanRespawn)
    : false;
  let restoreFailed = false;
  if (proxyAbsent && !serviceStopFailed) {
    try {
      deps.revertSystemEnv();
    } catch (error) {
      restoreFailed = true;
      events.push({
        type: "environment_restore_failed",
        message: safeMessage(error, "Environment restore failed"),
      });
    }
    if (!await restoreSharedClientStateAfterStop(deps, events)) restoreFailed = true;
  }

  const restoreStatus = restoreStatusFromEvents(events);
  const grokStatus = grokStatusFromEvents(events);
  const fields: StopTransactionFields = {
    serviceStopped: stoppedService,
    proxyStopped,
    proxyAbsent,
    restoreStatus,
    grokStatus,
    events,
  };

  if (ownershipBlocked) {
    return {
      ok: false,
      code: "ownership_conflict",
      retryable: false,
      message: ownershipMessage || "Ownership conflict",
      ...fields,
    };
  }
  if (serviceStopFailed || proxyStopFailed || !proxyAbsent) {
    return {
      ok: false,
      code: "stop_failed",
      retryable: true,
      message: stopFailureMessage || serviceFailureMessage || "Proxy absence could not be verified.",
      ...fields,
    };
  }
  if (restoreFailed || restoreStatus === "failed" || grokStatus === "failed") {
    return {
      ok: false,
      code: "restore_failed",
      retryable: true,
      message: restoreFailureMessage(events),
      ...fields,
    };
  }
  return {
    ok: true,
    code: "stopped",
    ...fields,
    proxyAbsent: true,
  };
}

export const STOP_TRANSACTION_CODES: readonly StopTransactionCode[] = [
  "stopped",
  "ownership_conflict",
  "stop_failed",
  "restore_failed",
];
