/**
 * Desktop service/runtime activation transaction with a durable intent journal.
 *
 * Resolves a requested runtimeManifestId through the verified per-user stable
 * store, writes an owner-only checksummed journal, then stop → prove absence →
 * install/repair candidate paths → start → identity-checked /readyz →
 * CAS-publish current.json → delete the journal (commit). Failures and crash
 * recovery roll back to the snapshotted absolute paths unless current.json is
 * an exact successor (fail closed, keep journal).
 *
 * The live PID lock is not a transaction journal. Crash/timeout recovery reads
 * `<stableRoot>/activation.journal` under `activation.lock` before pointer or
 * owner authorization.
 */

import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { StopTransactionResult } from "../../src/cli/stop-transaction";
import {
  classifyDesktopOwner,
  isPathInsideRoot,
  pathsEqualCanonical,
  type DesktopOwnerKind,
  type DesktopRuntimeIdentity,
} from "../../src/config/desktop-owner";
import { redactSecretString, redactUserPath } from "../../src/lib/redact";
import { isLoopbackHostname } from "../../src/server/auth-cors";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import type { ManagedServiceStopOutcome, ServiceDiagnostic } from "../../src/service";
import {
  acquireActivationLock,
  ActivationLockTimeoutError,
  observeActivationLock,
  type ActivationLockHandle,
  type ActivationLockOptions,
} from "./activation-lock";
import {
  intendedPublishedPointer,
  journalPointersEqual,
  observeActivationJournal,
  removeActivationJournal,
  replaceActivationJournal,
  writeActivationJournal,
  type ActivationJournalRecord,
} from "./activation-journal";
import { DeadlineExceededError } from "./deadline";
import type { RuntimeStoreResult, TargetTriple } from "./manifest";
import type {
  HandlerOutcome,
  Owner,
  ProxyStatus,
  ServiceInstallBackend,
  ServiceState,
} from "./protocol";
import {
  publishCurrent,
  readCurrentPointer,
  resolveRuntimeByManifestId,
  restoreCurrentPointer,
  STABLE_VERSIONS_DIR,
  type CurrentPointer,
  type PublishCurrentSuccess,
  type VersionPointer,
  type VersionReferenceGuard,
} from "./staging";

const ASCII_PRINTABLE_RE = /^[\x20-\u007E]+$/;
const READY_POLL_MS = 150;

export type ServiceMutationKind = "install" | "start" | "repair" | "uninstall";
export type RuntimeActivationMode = "service" | "direct";

export type ServiceManagerEffect = {
  managerStarted: boolean;
};

export type OwnedLiveStopRequest = {
  live: LiveProxy;
  identity: DesktopRuntimeIdentity;
  expectedOwner: DesktopOwnerKind;
};

export type InstalledServicePaths = {
  conflict: boolean;
  bunPath?: string;
  cliPath?: string;
};

export type DesktopServiceMutationDeps = {
  signal: AbortSignal;
  identity: DesktopRuntimeIdentity | null;
  owner: Owner;
  live: LiveProxy | null;
  service: ServiceState;
  expectedTarget: TargetTriple | null;
  backend?: ServiceInstallBackend;
  mode?: RuntimeActivationMode;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  diagnoseService: () => ServiceDiagnostic;
  inspectServiceInstall: () => InstalledServicePaths;
  findLiveProxy: () => Promise<LiveProxy | null>;
  probeReadiness: (
    port: number,
    opts: { hostname?: string; expectedPid?: number },
  ) => Promise<{ ready: boolean; status: "ready" | "pending" | "failed"; pid: number; port: number } | null>;
  runStopTransaction: () => Promise<StopTransactionResult>;
  stopOwnedLive?: (request: OwnedLiveStopRequest) => Promise<void> | void;
  stopOwnedService?: () => Promise<ManagedServiceStopOutcome | void> | ManagedServiceStopOutcome | void;
  isAlive: (pid: number) => boolean;
  classifyOwner: (live: LiveProxy | null, identity: DesktopRuntimeIdentity | null) => Owner;
  installService: (
    identity: DesktopRuntimeIdentity,
    backend: ServiceInstallBackend,
  ) => Promise<void | ServiceManagerEffect>;
  repairService: (
    identity: DesktopRuntimeIdentity,
    opts?: { backend?: ServiceDiagnostic["backend"] },
  ) => Promise<void | ServiceManagerEffect>;
  startService: (identity: DesktopRuntimeIdentity) => Promise<void>;
  startDirect: (identity: DesktopRuntimeIdentity) => Promise<void>;
  uninstallService: () => Promise<boolean> | boolean;
  afterCandidateReady?: () => void | Promise<void>;
  afterPointerPublished?: () => void | Promise<void>;
  afterJournalWrite?: (record: ActivationJournalRecord) => void | Promise<void>;
  beforeRollbackStop?: () => void | Promise<void>;
  beforeJournalPidUpdate?: () => void | Promise<void>;
  readPointer?: (stableRoot: string) => RuntimeStoreResult<{ pointer: CurrentPointer | null }>;
  resolveByManifestId?: typeof resolveRuntimeByManifestId;
  publishPointer?: typeof publishCurrent;
  restorePointer?: typeof restoreCurrentPointer;
  acquireActivationLock?: (
    stableRoot: string,
    options?: ActivationLockOptions,
  ) => Promise<ActivationLockHandle>;
  activationLock?: ActivationLockOptions;
  platform?: NodeJS.Platform;
  resolveIdentity: (absPath: string) => DesktopRuntimeIdentity | null;
  lockToken?: string;
};

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
  const chosen = pathBearing ? fallback : (redacted || fallback);
  const ascii = ASCII_PRINTABLE_RE.test(chosen) ? chosen : fallback;
  return ascii.slice(0, 4096);
}

function fail(
  code: "ownership_conflict" | "service_not_startable" | "proxy_not_ready" | "runtime_integrity_failed" | "stop_failed" | "restore_failed",
  message: unknown,
  retryable: boolean,
): HandlerOutcome {
  return {
    ok: false,
    error: {
      code,
      message: safeMessage(message, code.replaceAll("_", " ")),
      retryable,
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DeadlineExceededError();
}

export function managerStartedFrom(result: void | ServiceManagerEffect | null | undefined): boolean {
  return Boolean(result && typeof result === "object" && result.managerStarted === true);
}

export function stableStoreRootFromIdentity(identity: DesktopRuntimeIdentity): string | null {
  const versionsRoot = dirname(identity.stableRuntimeRoot);
  if (basename(versionsRoot) !== STABLE_VERSIONS_DIR) return null;
  return dirname(versionsRoot);
}

export function retainReferencedRuntimeGenerations(input: {
  serviceInstall?: InstalledServicePaths | null;
  owner?: { bunPath: string; cliPath: string } | null;
  pointer?: CurrentPointer | null;
  candidate?: VersionPointer | null;
}): VersionReferenceGuard {
  const rels = new Set<string>();
  if (input.pointer) {
    rels.add(input.pointer.current.relPath);
    if (input.pointer.previous) rels.add(input.pointer.previous.relPath);
  }
  if (input.candidate) rels.add(input.candidate.relPath);
  return (relPath, absPath) => {
    if (rels.has(relPath)) return true;
    const candidates = [
      input.serviceInstall?.bunPath,
      input.serviceInstall?.cliPath,
      input.owner?.bunPath,
      input.owner?.cliPath,
    ];
    return candidates.some(path => typeof path === "string" && isPathInsideRoot(absPath, path));
  };
}

function mapServiceState(service: ServiceDiagnostic, extraConflict: boolean): ServiceState {
  if (service.conflict || extraConflict) {
    return { installed: true, startable: false, stateCode: "conflict" };
  }
  if (!service.installed) {
    return { installed: false, startable: false, stateCode: "absent" };
  }
  if (service.startable) {
    return { installed: true, startable: true, stateCode: "startable" };
  }
  return { installed: true, startable: false, stateCode: "not-startable" };
}

function serviceMutationResult(
  changed: boolean,
  service: ServiceState,
  proxyStatus: ProxyStatus,
): HandlerOutcome {
  return { ok: true, result: { changed, service, proxyStatus } };
}

function mutationAuthorized(
  kind: ServiceMutationKind,
  mode: RuntimeActivationMode,
  owner: Owner,
  service: ServiceState,
  live: LiveProxy | null,
): boolean {
  if (owner === "unknown/conflict") return false;
  if (mode === "direct") {
    if (kind === "start" || kind === "uninstall") return false;
    return owner === "desktop-direct";
  }
  if (kind === "install") {
    return owner === "desktop-direct"
      || (owner === "existing-external" && !service.installed && live === null);
  }
  return owner === "desktop-service";
}

function bindIsLoopback(live: LiveProxy): boolean {
  const hostname = (live.hostname ?? "127.0.0.1").trim();
  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]") return false;
  return isLoopbackHostname(hostname);
}

async function proveAbsent(deps: DesktopServiceMutationDeps, pid: number | null): Promise<boolean> {
  throwIfAborted(deps.signal);
  const live = await deps.findLiveProxy();
  if (live) return false;
  if (pid !== null && deps.isAlive(pid)) return false;
  return true;
}

function serviceHealthyForCandidate(
  service: ServiceState,
  install: InstalledServicePaths,
  candidate: DesktopRuntimeIdentity,
): boolean {
  return service.installed
    && service.startable
    && service.stateCode === "startable"
    && servicePathsMatchCandidate(install, candidate);
}

function healthFailure(service: ServiceState, install: InstalledServicePaths, candidate: DesktopRuntimeIdentity): HandlerOutcome {
  if (!servicePathsMatchCandidate(install, candidate) || service.stateCode === "conflict") {
    return fail("ownership_conflict", "service paths changed during activation", false);
  }
  return fail("service_not_startable", "installed service is not startable", false);
}

function serviceResidual(deps: DesktopServiceMutationDeps): boolean {
  const install = deps.inspectServiceInstall();
  const diagnosed = deps.diagnoseService();
  const service = mapServiceState(diagnosed, install.conflict);
  return service.installed
    || service.stateCode === "conflict"
    || install.conflict
    || Boolean(install.bunPath)
    || Boolean(install.cliPath);
}

async function waitReady(
  deps: DesktopServiceMutationDeps,
  identity: DesktopRuntimeIdentity,
  expectedOwner: DesktopOwnerKind,
  expectedPid: number | null,
): Promise<{ ok: true; live: LiveProxy } | { ok: false; outcome: HandlerOutcome }> {
  for (;;) {
    throwIfAborted(deps.signal);
    const live = await deps.findLiveProxy();
    throwIfAborted(deps.signal);
    if (live?.pid) {
      if (!bindIsLoopback(live)) {
        return { ok: false, outcome: fail("proxy_not_ready", "proxy bind is not loopback", false) };
      }
      if (expectedPid !== null && live.pid !== expectedPid) {
        return { ok: false, outcome: fail("ownership_conflict", "a foreign proxy claimed candidate readiness", false) };
      }
      const ready = await deps.probeReadiness(live.port, { hostname: live.hostname, expectedPid: live.pid });
      throwIfAborted(deps.signal);
      if (ready?.status === "failed") {
        return { ok: false, outcome: fail("proxy_not_ready", "candidate readiness failed", true) };
      }
      if (ready?.ready && live.version === identity.runtimeVersion) {
        const owner = deps.classifyOwner(live, identity);
        if (owner !== expectedOwner) {
          return { ok: false, outcome: fail("ownership_conflict", "candidate ownership was not proven", false) };
        }
        return { ok: true, live };
      }
    }
    await deps.sleep(READY_POLL_MS, deps.signal);
  }
}

type ActivationSnapshot = {
  owner: Owner;
  hadLiveProxy: boolean;
  serviceInstalled: boolean;
  backend: ServiceDiagnostic["backend"];
  serviceInstall: InstalledServicePaths;
  pointer: CurrentPointer;
  previousPid: number | null;
  previousIdentity: DesktopRuntimeIdentity | null;
};

type RollbackPlan = {
  snapshot: ActivationSnapshot;
  published: boolean;
  publishedPointer: CurrentPointer | null;
  touchedService: boolean;
  installedService: boolean;
  repairedService: boolean;
  kind: ServiceMutationKind;
  mode: RuntimeActivationMode;
  candidatePointer: VersionPointer | null;
  candidatePid: number | null;
  stableRoot: string;
  expectedTarget: TargetTriple;
  abandonOnly: boolean;
  transactionId: string;
};

type RollbackOutcome = { ok: true } | { ok: false; outcome: HandlerOutcome };

function liveMatchesIdentity(
  live: LiveProxy,
  identity: DesktopRuntimeIdentity | null,
): boolean {
  return Boolean(identity && live.version === identity.runtimeVersion);
}

function classifyLiveAgainstPlan(
  live: LiveProxy,
  plan: RollbackPlan,
  deps: DesktopServiceMutationDeps,
  candidate: DesktopRuntimeIdentity | null,
): "candidate" | "snapshot" | "foreign" {
  if (!live.pid || !bindIsLoopback(live)) return "foreign";
  const previous = plan.snapshot.previousIdentity;
  if (candidate && liveMatchesIdentity(live, candidate)) {
    const owner = deps.classifyOwner(live, candidate);
    if (owner === "desktop-service" || owner === "desktop-direct") return "candidate";
    return "foreign";
  }
  if (previous && liveMatchesIdentity(live, previous)) {
    const owner = deps.classifyOwner(live, previous);
    if (owner === plan.snapshot.owner && (owner === "desktop-service" || owner === "desktop-direct")) {
      return "snapshot";
    }
  }
  return "foreign";
}

function journalPidUnproven(
  journalPid: number | null,
  live: LiveProxy | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (journalPid === null || !isAlive(journalPid)) return false;
  return !live || live.pid !== journalPid;
}

function inspectServiceDecision(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
  candidate: DesktopRuntimeIdentity | null,
  refuseUnexpected: boolean,
): { action: "none" | "stop" } | { refuse: HandlerOutcome } {
  const install = deps.inspectServiceInstall();
  const diagnosed = deps.diagnoseService();
  const service = mapServiceState(diagnosed, install.conflict);
  if (service.stateCode === "conflict" || install.conflict || diagnosed.conflict) {
    if (refuseUnexpected) return { refuse: recoveryRequired("recovery refused a conflicting service") };
    return { action: "none" };
  }
  if (plan.mode === "direct" && !plan.touchedService) {
    if (diagnosed.installed || service.installed || install.bunPath || install.cliPath) {
      return { refuse: recoveryRequired("direct recovery refused a service that appeared") };
    }
    return { action: "none" };
  }
  const snapshotIdentity = plan.snapshot.previousIdentity;
  const hasInstall = Boolean(diagnosed.installed || install.bunPath || install.cliPath);
  if (!hasInstall) return { action: "none" };
  if (plan.touchedService || plan.installedService || plan.repairedService) {
    if (candidate && servicePathsMatchCandidate(install, candidate)) return { action: "stop" };
    if (snapshotIdentity && servicePathsMatchCandidate(install, snapshotIdentity)) return { action: "none" };
    if (refuseUnexpected) return { refuse: recoveryRequired("recovery refused a foreign or unexpected service") };
    return { action: "none" };
  }
  if ((plan.kind === "start" || plan.kind === "uninstall") && snapshotIdentity) {
    if (servicePathsMatchCandidate(install, snapshotIdentity)) return { action: "stop" };
    if (refuseUnexpected) return { refuse: recoveryRequired("recovery refused a foreign or unexpected service") };
    return { action: "none" };
  }
  if (refuseUnexpected) return { refuse: recoveryRequired("recovery refused a foreign or unexpected service") };
  return { action: "none" };
}

async function restorePublishedPointer(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
): Promise<RollbackOutcome & { casMismatch?: boolean }> {
  if (!plan.published || !plan.publishedPointer || !plan.snapshot.pointer) return { ok: true };
  const restore = deps.restorePointer ?? restoreCurrentPointer;
  const restored = restore({
    stableRoot: plan.stableRoot,
    expectedPublished: plan.publishedPointer,
    restore: plan.snapshot.pointer,
    expectedTarget: plan.expectedTarget,
    isVersionReferenced: retainReferencedRuntimeGenerations({
      serviceInstall: plan.snapshot.serviceInstall,
      owner: plan.snapshot.previousIdentity,
      pointer: plan.snapshot.pointer,
      candidate: plan.candidatePointer,
    }),
  });
  if (restored.ok) return { ok: true };
  if (restored.code === "cas_mismatch") {
    return { ok: true, casMismatch: true };
  }
  return { ok: false, outcome: fail("restore_failed", restored.message, false) };
}

async function startIfNeeded(
  deps: DesktopServiceMutationDeps,
  identity: DesktopRuntimeIdentity,
  alreadyStarted: boolean,
): Promise<void> {
  if (alreadyStarted) return;
  await deps.startService(identity);
}

async function uninstallAndProveAbsent(deps: DesktopServiceMutationDeps): Promise<RollbackOutcome> {
  try {
    await deps.uninstallService();
  } catch (error) {
    return { ok: false, outcome: fail("restore_failed", error, false) };
  }
  if (serviceResidual(deps)) {
    return { ok: false, outcome: fail("restore_failed", "service remained after rollback uninstall", false) };
  }
  return { ok: true };
}

async function restoreSnapshotServiceState(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
): Promise<RollbackOutcome> {
  const snapshot = plan.snapshot;
  const previous = snapshot.previousIdentity;
  const hadOwnedService = snapshot.serviceInstalled
    && Boolean(snapshot.serviceInstall.bunPath && snapshot.serviceInstall.cliPath)
    && snapshot.owner === "desktop-service";
  const hadDirect = snapshot.owner === "desktop-direct" && snapshot.hadLiveProxy;
  const startOnly = plan.kind === "start" && !plan.installedService && !plan.repairedService;

  if (startOnly) {
    if (snapshot.hadLiveProxy && previous) {
      try {
        await deps.startService(previous);
      } catch (error) {
        return { ok: false, outcome: fail("restore_failed", error, false) };
      }
      const ready = await waitReady(deps, previous, "desktop-service", null);
      if (!ready.ok) return { ok: false, outcome: fail("restore_failed", "rollback readiness failed", false) };
      return { ok: true };
    }
    if (!(await proveAbsent(deps, plan.candidatePid).catch(() => false))) {
      return { ok: false, outcome: fail("restore_failed", "rollback could not prove absence", false) };
    }
    return { ok: true };
  }

  if (hadOwnedService && previous && (plan.repairedService || plan.installedService || plan.touchedService)) {
    try {
      const effect = await deps.repairService(previous, { backend: snapshot.backend });
      const started = managerStartedFrom(effect);
      if (snapshot.hadLiveProxy) {
        await startIfNeeded(deps, previous, started);
        const ready = await waitReady(deps, previous, "desktop-service", null);
        if (!ready.ok) return { ok: false, outcome: fail("restore_failed", "rollback readiness failed", false) };
        return { ok: true };
      }
      if (started) {
        const stop = await deps.runStopTransaction();
        if (!stop.ok) {
          const nativeRestoreFailedWithAbsentProxy = stop.code === "restore_failed" && stop.proxyAbsent === true;
          if (!nativeRestoreFailedWithAbsentProxy) {
            return { ok: false, outcome: fail("restore_failed", stop.message, false) };
          }
        }
      }
      if (!(await proveAbsent(deps, plan.candidatePid).catch(() => false))) {
        return { ok: false, outcome: fail("restore_failed", "rollback could not prove absence", false) };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, outcome: fail("restore_failed", error, false) };
    }
  }

  if (plan.touchedService || plan.installedService) {
    const removed = await uninstallAndProveAbsent(deps);
    if (!removed.ok) return removed;
  } else if (serviceResidual(deps) && snapshot.owner === "desktop-direct") {
    return { ok: false, outcome: fail("restore_failed", "service remained after rollback", false) };
  }

  if (hadDirect && previous) {
    if (serviceResidual(deps)) {
      return { ok: false, outcome: fail("restore_failed", "refusing to start direct while a service remains", false) };
    }
    try {
      await deps.startDirect(previous);
    } catch (error) {
      return { ok: false, outcome: fail("restore_failed", error, false) };
    }
    const ready = await waitReady(deps, previous, "desktop-direct", null);
    if (!ready.ok) return { ok: false, outcome: fail("restore_failed", "rollback readiness failed", false) };
  }
  return { ok: true };
}

async function rollbackToSnapshot(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
  candidate: DesktopRuntimeIdentity | null,
): Promise<RollbackOutcome> {
  const stopped = await stopIfOwnedLiveAndService(deps, plan, candidate, false);
  if (!stopped.ok) return stopped;

  if (plan.abandonOnly) {
    return { ok: true };
  }

  const pointerRestored = await restorePublishedPointer(deps, plan);
  if (!pointerRestored.ok) return pointerRestored;
  if (pointerRestored.casMismatch) {
    return { ok: true };
  }

  return restoreSnapshotServiceState(deps, plan);
}

async function rollbackThen(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
  fallback: HandlerOutcome,
  candidate: DesktopRuntimeIdentity | null,
): Promise<HandlerOutcome> {
  const rolled = await rollbackToSnapshot(deps, plan, candidate);
  if (!rolled.ok) return rolled.outcome;
  const cleared = removeActivationJournal(plan.stableRoot, { transactionId: plan.transactionId });
  if (!cleared.ok) {
    return fail("restore_failed", "activation journal could not be cleared after rollback", false);
  }
  return fallback;
}

function pointerMatchesIdentity(
  pointer: CurrentPointer,
  identity: DesktopRuntimeIdentity,
  expectedTarget: TargetTriple,
  stableRoot: string,
): boolean {
  if (pointer.current.id !== identity.runtimeManifestId) return false;
  if (pointer.current.version !== identity.runtimeVersion) return false;
  if (pointer.current.target !== expectedTarget) return false;
  const expectedRel = `${STABLE_VERSIONS_DIR}/${identity.runtimeVersion}`;
  if (pointer.current.relPath !== expectedRel) return false;
  return pathsEqualCanonical(identity.stableRuntimeRoot, join(stableRoot, expectedRel));
}

function servicePathsMatchCandidate(install: InstalledServicePaths, candidate: DesktopRuntimeIdentity): boolean {
  return !install.conflict
    && typeof install.bunPath === "string"
    && typeof install.cliPath === "string"
    && pathsEqualCanonical(install.bunPath, candidate.bunPath)
    && pathsEqualCanonical(install.cliPath, candidate.cliPath);
}

type LockedObservation = {
  identity: DesktopRuntimeIdentity;
  live: LiveProxy | null;
  diagnosed: ServiceDiagnostic;
  install: InstalledServicePaths;
  service: ServiceState;
  owner: Owner;
  pointer: CurrentPointer;
};

async function refreshLockedObservation(
  deps: DesktopServiceMutationDeps,
  stableRoot: string,
  callerIdentity: DesktopRuntimeIdentity,
  expectedTarget: TargetTriple,
): Promise<{ ok: true; observed: LockedObservation } | { ok: false; outcome: HandlerOutcome }> {
  throwIfAborted(deps.signal);
  const readPointer = deps.readPointer ?? readCurrentPointer;
  const snapshotPointer = readPointer(stableRoot);
  if (!snapshotPointer.ok) {
    return { ok: false, outcome: fail("runtime_integrity_failed", "current runtime pointer is unreadable", false) };
  }
  if (!snapshotPointer.pointer || !pointerMatchesIdentity(snapshotPointer.pointer, callerIdentity, expectedTarget, stableRoot)) {
    return { ok: false, outcome: fail("runtime_integrity_failed", "current pointer does not match the verified runtime identity", false) };
  }
  const resolveById = deps.resolveByManifestId ?? resolveRuntimeByManifestId;
  const resolvedCurrent = resolveById({
    stableRoot,
    manifestId: snapshotPointer.pointer.current.id,
    expectedTarget,
  });
  if (!resolvedCurrent.ok) {
    return { ok: false, outcome: fail("runtime_integrity_failed", "current runtime failed verification", false) };
  }
  const identity = deps.resolveIdentity(resolvedCurrent.absPath);
  if (!identity || identity.installId !== callerIdentity.installId) {
    return { ok: false, outcome: fail("runtime_integrity_failed", "current runtime failed identity verification", false) };
  }
  if (!pointerMatchesIdentity(snapshotPointer.pointer, identity, expectedTarget, stableRoot)) {
    return { ok: false, outcome: fail("runtime_integrity_failed", "current pointer does not match the verified runtime identity", false) };
  }
  const identityRoot = stableStoreRootFromIdentity(identity);
  if (!identityRoot || !pathsEqualCanonical(identityRoot, stableRoot)) {
    return { ok: false, outcome: fail("runtime_integrity_failed", "current runtime is outside the verified stable store", false) };
  }
  const live = await deps.findLiveProxy();
  throwIfAborted(deps.signal);
  const diagnosed = deps.diagnoseService();
  const install = deps.inspectServiceInstall();
  const service = mapServiceState(diagnosed, install.conflict);
  const owner = deps.classifyOwner(live, identity);
  return {
    ok: true,
    observed: {
      identity,
      live,
      diagnosed,
      install,
      service,
      owner,
      pointer: snapshotPointer.pointer,
    },
  };
}

async function inspectHealthyCandidate(
  deps: DesktopServiceMutationDeps,
  candidate: DesktopRuntimeIdentity,
): Promise<{ ok: true; service: ServiceState; install: InstalledServicePaths } | { ok: false; outcome: HandlerOutcome }> {
  const install = deps.inspectServiceInstall();
  const service = mapServiceState(deps.diagnoseService(), install.conflict);
  if (!serviceHealthyForCandidate(service, install, candidate)) {
    return { ok: false, outcome: healthFailure(service, install, candidate) };
  }
  return { ok: true, service, install };
}

function recoveredRetry(): HandlerOutcome {
  return fail("runtime_integrity_failed", "activation recovered; retry status", true);
}

function recoveryRequired(message: string): HandlerOutcome {
  return fail("restore_failed", message, false);
}

function expectedRelPath(version: string): string {
  return `${STABLE_VERSIONS_DIR}/${version}`;
}

function journalSelfConsistent(
  journal: ActivationJournalRecord,
  snapshotCurrent: DesktopRuntimeIdentity,
  expectedTarget: TargetTriple,
): HandlerOutcome | null {
  const intended = intendedPublishedPointer(journal.snapshot.pointer, journal.candidate);
  if (!journalPointersEqual(journal.publishedPointer, intended)) {
    return recoveryRequired("journal published pointer is inconsistent");
  }
  if (journal.candidate.target !== expectedTarget
    || journal.snapshot.pointer.current.target !== expectedTarget
    || (journal.snapshot.pointer.previous && journal.snapshot.pointer.previous.target !== expectedTarget)) {
    return recoveryRequired("journal target is inconsistent");
  }
  if (journal.candidate.relPath !== expectedRelPath(journal.candidate.version)
    || journal.snapshot.pointer.current.relPath !== expectedRelPath(journal.snapshot.pointer.current.version)
    || (journal.snapshot.pointer.previous
      && journal.snapshot.pointer.previous.relPath !== expectedRelPath(journal.snapshot.pointer.previous.version))) {
    return recoveryRequired("journal relPath is inconsistent");
  }
  if (!journal.snapshot.previousBunPath
    || !journal.snapshot.previousCliPath
    || !pathsEqualCanonical(journal.snapshot.previousBunPath, snapshotCurrent.bunPath)
    || !pathsEqualCanonical(journal.snapshot.previousCliPath, snapshotCurrent.cliPath)) {
    return recoveryRequired("journal previous identity paths are inconsistent");
  }
  if (journal.snapshot.owner === "desktop-service") {
    if (!journal.snapshot.serviceInstalled || !journal.snapshot.backend) {
      return recoveryRequired("journal desktop-service snapshot is inconsistent");
    }
    if (!journal.snapshot.bunPath
      || !journal.snapshot.cliPath
      || !pathsEqualCanonical(journal.snapshot.bunPath, snapshotCurrent.bunPath)
      || !pathsEqualCanonical(journal.snapshot.cliPath, snapshotCurrent.cliPath)) {
      return recoveryRequired("journal service paths are inconsistent");
    }
  } else {
    if (journal.snapshot.serviceInstalled
      || journal.snapshot.bunPath !== null
      || journal.snapshot.cliPath !== null) {
      return recoveryRequired("journal claimed service paths on a non-service snapshot");
    }
  }
  return null;
}

async function probeExactReady(
  deps: DesktopServiceMutationDeps,
  live: LiveProxy,
  identity: DesktopRuntimeIdentity,
  expectedOwner: DesktopOwnerKind,
): Promise<"ready" | "unhealthy"> {
  if (!live.pid || !bindIsLoopback(live) || live.version !== identity.runtimeVersion) return "unhealthy";
  const ready = await deps.probeReadiness(live.port, { hostname: live.hostname, expectedPid: live.pid });
  if (!ready || ready.status === "failed" || ready.status === "pending" || !ready.ready) return "unhealthy";
  if (ready.pid !== live.pid) return "unhealthy";
  const owner = deps.classifyOwner(live, identity);
  if (owner !== expectedOwner) return "unhealthy";
  return "ready";
}

function verifyJournalGeneration(
  deps: DesktopServiceMutationDeps,
  stableRoot: string,
  pointer: VersionPointer,
  expectedTarget: TargetTriple,
): DesktopRuntimeIdentity | null {
  const resolveById = deps.resolveByManifestId ?? resolveRuntimeByManifestId;
  const resolved = resolveById({
    stableRoot,
    manifestId: pointer.id,
    expectedTarget,
  });
  if (!resolved.ok) return null;
  if (resolved.pointer.id !== pointer.id
    || resolved.pointer.version !== pointer.version
    || resolved.pointer.relPath !== pointer.relPath
    || resolved.pointer.target !== pointer.target) {
    return null;
  }
  const expectedAbs = join(stableRoot, pointer.relPath);
  if (!pathsEqualCanonical(resolved.absPath, expectedAbs)) return null;
  const identity = deps.resolveIdentity(resolved.absPath);
  if (!identity) return null;
  if (!pointerMatchesIdentity(
    { schemaVersion: 1, current: pointer, previous: null },
    identity,
    expectedTarget,
    stableRoot,
  )) {
    return null;
  }
  return identity;
}

function expectedOwnerForLive(
  who: "candidate" | "snapshot",
  plan: RollbackPlan,
): DesktopOwnerKind | null {
  if (who === "candidate") {
    return plan.mode === "direct" ? "desktop-direct" : "desktop-service";
  }
  if (plan.snapshot.owner === "desktop-service" || plan.snapshot.owner === "desktop-direct") {
    return plan.snapshot.owner;
  }
  return null;
}

async function stopProvenOwnedProxy(
  deps: DesktopServiceMutationDeps,
  live: LiveProxy,
  identity: DesktopRuntimeIdentity,
  expectedOwner: DesktopOwnerKind,
): Promise<RollbackOutcome> {
  if (!live.pid || !deps.stopOwnedLive) {
    return { ok: false, outcome: fail("restore_failed", "owned live stop seam is unavailable", false) };
  }
  try {
    await deps.stopOwnedLive({ live, identity, expectedOwner });
  } catch (error) {
    return { ok: false, outcome: fail("restore_failed", error, false) };
  }
  return { ok: true };
}

async function runRollbackStopTransaction(deps: DesktopServiceMutationDeps): Promise<RollbackOutcome> {
  let stop: StopTransactionResult;
  try {
    stop = await deps.runStopTransaction();
  } catch (error) {
    return { ok: false, outcome: fail("restore_failed", error, false) };
  }
  if (!stop.ok) {
    const nativeRestoreFailedWithAbsentProxy = stop.code === "restore_failed" && stop.proxyAbsent === true;
    if (!nativeRestoreFailedWithAbsentProxy) {
      return { ok: false, outcome: fail("restore_failed", stop.message, false) };
    }
  }
  return { ok: true };
}

async function applyOwnedServiceStop(
  deps: DesktopServiceMutationDeps,
): Promise<{ ok: true; canRespawn: boolean } | { ok: false; outcome: HandlerOutcome }> {
  if (!deps.stopOwnedService) return { ok: true, canRespawn: false };
  let outcome: ManagedServiceStopOutcome | void;
  try {
    outcome = await deps.stopOwnedService();
  } catch (error) {
    return { ok: false, outcome: fail("restore_failed", error, false) };
  }
  if (outcome && outcome.state === "failed") {
    return { ok: false, outcome: fail("restore_failed", "owned service stop failed", false) };
  }
  return {
    ok: true,
    canRespawn: outcome?.state === "stopped" && outcome.canRespawn === true,
  };
}

async function stopIfOwnedLiveAndService(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
  candidate: DesktopRuntimeIdentity | null,
  refuseUnexpectedService: boolean,
): Promise<RollbackOutcome> {
  if (deps.beforeRollbackStop) await deps.beforeRollbackStop();
  const live = await deps.findLiveProxy().catch(() => null);
  const who = live ? classifyLiveAgainstPlan(live, plan, deps, candidate) : null;
  if (journalPidUnproven(plan.candidatePid, live, deps.isAlive)) {
    return { ok: false, outcome: recoveryRequired("journal pid is alive but not a proven candidate") };
  }
  if (live && who === "foreign") {
    const install = deps.inspectServiceInstall();
    const pathsStillCandidate = Boolean(candidate && servicePathsMatchCandidate(install, candidate));
    if (refuseUnexpectedService || pathsStillCandidate) {
      return { ok: false, outcome: fail("restore_failed", "rollback refused to stop a successor proxy", false) };
    }
  }
  if (live && (who === "candidate" || (who === "snapshot" && !plan.snapshot.hadLiveProxy))) {
    const identity = who === "candidate" ? candidate : plan.snapshot.previousIdentity;
    const expectedOwner = expectedOwnerForLive(who, plan);
    if (!identity || !expectedOwner) {
      return { ok: false, outcome: fail("restore_failed", "owned live identity is unavailable", false) };
    }
    const stopped = await stopProvenOwnedProxy(deps, live, identity, expectedOwner);
    if (!stopped.ok) return stopped;
  }
  const serviceDecision = inspectServiceDecision(deps, plan, candidate, refuseUnexpectedService);
  if ("refuse" in serviceDecision) return { ok: false, outcome: serviceDecision.refuse };
  let serviceCanRespawn = false;
  if (serviceDecision.action === "stop") {
    const stoppedService = await applyOwnedServiceStop(deps);
    if (!stoppedService.ok) return stoppedService;
    serviceCanRespawn = stoppedService.canRespawn;
  }
  const liveAgain = await deps.findLiveProxy().catch(() => null);
  if (liveAgain) {
    const whoAgain = classifyLiveAgainstPlan(liveAgain, plan, deps, candidate);
    if (whoAgain === "foreign") {
      const installAgain = deps.inspectServiceInstall();
      const pathsStillCandidate = Boolean(candidate && servicePathsMatchCandidate(installAgain, candidate));
      if (refuseUnexpectedService || pathsStillCandidate) {
        return { ok: false, outcome: fail("restore_failed", "rollback refused to stop a successor proxy", false) };
      }
    } else if (whoAgain === "candidate" || whoAgain === "snapshot") {
      const stopped = await runRollbackStopTransaction(deps);
      if (!stopped.ok) return stopped;
    }
  } else if (serviceCanRespawn) {
    const stopped = await runRollbackStopTransaction(deps);
    if (!stopped.ok) return stopped;
  }
  const provenPid = live && (who === "candidate" || who === "snapshot") ? live.pid ?? null : null;
  if (provenPid !== null) {
    const absent = await proveAbsent(deps, provenPid).catch(() => false);
    if (!absent) return { ok: false, outcome: fail("restore_failed", "rollback could not prove absence", false) };
  }
  return { ok: true };
}

async function recoverFromJournal(
  deps: DesktopServiceMutationDeps,
  stableRoot: string,
  expectedTarget: TargetTriple,
): Promise<{ handled: false } | { handled: true; outcome: HandlerOutcome }> {
  const observed = observeActivationJournal(stableRoot);
  if (observed.state === "absent") return { handled: false };
  if (observed.state === "unreadable") {
    return { handled: true, outcome: recoveryRequired("activation journal is unreadable") };
  }
  const journal = observed.record;
  if (resolve(journal.stableRoot) !== resolve(stableRoot)) {
    return { handled: true, outcome: recoveryRequired("activation journal stableRoot mismatch") };
  }
  if (journal.expectedTarget !== expectedTarget) {
    return { handled: true, outcome: recoveryRequired("activation journal target mismatch") };
  }

  const snapshotCurrent = verifyJournalGeneration(deps, stableRoot, journal.snapshot.pointer.current, expectedTarget);
  if (!snapshotCurrent) {
    return { handled: true, outcome: recoveryRequired("journal snapshot current failed verification") };
  }
  if (journal.snapshot.pointer.previous) {
    const snapshotPrevious = verifyJournalGeneration(
      deps,
      stableRoot,
      journal.snapshot.pointer.previous,
      expectedTarget,
    );
    if (!snapshotPrevious) {
      return { handled: true, outcome: recoveryRequired("journal snapshot previous failed verification") };
    }
  }
  const candidate = verifyJournalGeneration(deps, stableRoot, journal.candidate, expectedTarget);
  if (!candidate) {
    return { handled: true, outcome: recoveryRequired("journal candidate failed verification") };
  }
  const inconsistent = journalSelfConsistent(journal, snapshotCurrent, expectedTarget);
  if (inconsistent) return { handled: true, outcome: inconsistent };

  const readPointer = deps.readPointer ?? readCurrentPointer;
  const pointer = readPointer(stableRoot);
  if (!pointer.ok || !pointer.pointer) {
    return { handled: true, outcome: recoveryRequired("current pointer is unreadable during recovery") };
  }

  const derived = journal.publishedPointer
    ?? intendedPublishedPointer(journal.snapshot.pointer, journal.candidate);
  const isSnapshot = journalPointersEqual(pointer.pointer, journal.snapshot.pointer);
  const isPostImage = derived ? journalPointersEqual(pointer.pointer, derived) : false;

  if (!isSnapshot && !isPostImage) {
    return { handled: true, outcome: recoveryRequired("activation journal conflicts with a successor pointer") };
  }

  const plan: RollbackPlan = {
    snapshot: {
      owner: journal.snapshot.owner,
      hadLiveProxy: journal.snapshot.hadLiveProxy,
      serviceInstalled: journal.snapshot.serviceInstalled,
      backend: journal.snapshot.backend,
      serviceInstall: {
        conflict: false,
        ...(journal.snapshot.bunPath ? { bunPath: journal.snapshot.bunPath } : {}),
        ...(journal.snapshot.cliPath ? { cliPath: journal.snapshot.cliPath } : {}),
      },
      pointer: journal.snapshot.pointer,
      previousPid: journal.snapshot.previousPid,
      previousIdentity: snapshotCurrent,
    },
    published: isPostImage,
    publishedPointer: derived,
    touchedService: journal.touchedService,
    installedService: journal.kind === "install" && journal.touchedService,
    repairedService: journal.kind === "repair" && journal.touchedService,
    kind: journal.kind,
    mode: journal.mode,
    candidatePointer: journal.candidate,
    candidatePid: journal.candidatePid,
    stableRoot,
    expectedTarget,
    abandonOnly: false,
    transactionId: journal.transactionId,
  };

  const live = await deps.findLiveProxy().catch(() => null);
  const who = live ? classifyLiveAgainstPlan(live, plan, deps, candidate) : null;
  if (journalPidUnproven(journal.candidatePid, live, deps.isAlive)) {
    return { handled: true, outcome: recoveryRequired("journal pid is alive but not a proven candidate") };
  }
  if (live && who === "foreign") {
    return { handled: true, outcome: recoveryRequired("recovery refused to stop a successor proxy") };
  }

  if (isPostImage && live && who === "candidate") {
    const expectedOwner: DesktopOwnerKind = journal.mode === "direct" ? "desktop-direct" : "desktop-service";
    let canFinalize = journal.mode !== "service";
    if (journal.mode === "service") {
      const healthy = await inspectHealthyCandidate(deps, candidate);
      canFinalize = healthy.ok;
    }
    if (canFinalize) {
      const ready = await probeExactReady(deps, live, candidate, expectedOwner);
      if (ready === "ready") {
        const cleared = removeActivationJournal(stableRoot, {
          transactionId: journal.transactionId,
          identity: observed.identity,
        });
        if (!cleared.ok) {
          return { handled: true, outcome: recoveryRequired("activation journal could not be cleared") };
        }
        return { handled: true, outcome: recoveredRetry() };
      }
    }
  }

  const stopped = await stopIfOwnedLiveAndService(deps, plan, candidate, true);
  if (!stopped.ok) return { handled: true, outcome: stopped.outcome };

  if (isPostImage) {
    const restored = await restorePublishedPointer(deps, plan);
    if (!restored.ok) return { handled: true, outcome: restored.outcome };
    if (restored.casMismatch) {
      return { handled: true, outcome: recoveryRequired("activation journal conflicts with a successor pointer") };
    }
  }

  const serviceRestored = await restoreSnapshotServiceState(deps, plan);
  if (!serviceRestored.ok) return { handled: true, outcome: serviceRestored.outcome };

  const cleared = removeActivationJournal(stableRoot, { transactionId: journal.transactionId });
  if (!cleared.ok) {
    return { handled: true, outcome: recoveryRequired("activation journal could not be cleared") };
  }
  return { handled: true, outcome: recoveredRetry() };
}

async function persistJournal(
  deps: DesktopServiceMutationDeps,
  record: ActivationJournalRecord,
): Promise<HandlerOutcome | null> {
  const written = writeActivationJournal(record.stableRoot, record);
  if (!written.ok) {
    return fail("runtime_integrity_failed", "activation journal could not be written", false);
  }
  if (deps.afterJournalWrite) await deps.afterJournalWrite(record);
  return null;
}

async function updateJournalCandidatePid(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
  pid: number | null,
): Promise<HandlerOutcome | null> {
  if (deps.beforeJournalPidUpdate) await deps.beforeJournalPidUpdate();
  const observed = observeActivationJournal(plan.stableRoot);
  if (observed.state !== "valid" || observed.record.transactionId !== plan.transactionId) {
    return fail("restore_failed", "activation journal missing during candidate pid update", false);
  }
  if (observed.record.candidatePid === pid) return null;
  const replaced = replaceActivationJournal(
    plan.stableRoot,
    { transactionId: plan.transactionId, identity: observed.identity },
    { ...observed.record, candidatePid: pid },
  );
  if (!replaced.ok) {
    return fail("restore_failed", "activation journal could not be updated", false);
  }
  return null;
}

async function finalizePublishedCandidate(
  deps: DesktopServiceMutationDeps,
  plan: RollbackPlan,
  candidate: DesktopRuntimeIdentity,
  expectedOwner: DesktopOwnerKind,
): Promise<HandlerOutcome> {
  const live = await deps.findLiveProxy().catch(() => null);
  if (live && bindIsLoopback(live) && live.version === candidate.runtimeVersion) {
    if (plan.mode === "service") {
      const healthy = await inspectHealthyCandidate(deps, candidate);
      if (!healthy.ok) return rollbackThen(deps, plan, healthy.outcome, candidate);
    }
    const who = classifyLiveAgainstPlan(live, plan, deps, candidate);
    if (who === "candidate") {
      if (plan.candidatePid !== null && live.pid !== plan.candidatePid) {
        const pidUpdate = await updateJournalCandidatePid(deps, plan, live.pid ?? null);
        if (pidUpdate) return rollbackThen(deps, plan, pidUpdate, candidate);
        plan.candidatePid = live.pid ?? null;
      }
      const ready = await probeExactReady(deps, live, candidate, expectedOwner);
      if (ready === "ready") {
        if (plan.mode === "service") {
          const healthy = await inspectHealthyCandidate(deps, candidate);
          if (!healthy.ok) return rollbackThen(deps, plan, healthy.outcome, candidate);
          const cleared = removeActivationJournal(plan.stableRoot, { transactionId: plan.transactionId });
          if (!cleared.ok) return fail("restore_failed", "activation journal could not be cleared", false);
          return serviceMutationResult(true, healthy.service, "ready");
        }
        const service = mapServiceState(deps.diagnoseService(), deps.inspectServiceInstall().conflict);
        const cleared = removeActivationJournal(plan.stableRoot, { transactionId: plan.transactionId });
        if (!cleared.ok) return fail("restore_failed", "activation journal could not be cleared", false);
        return serviceMutationResult(true, service, "ready");
      }
      return rollbackThen(
        deps,
        plan,
        fail("proxy_not_ready", "candidate readiness failed after publish", true),
        candidate,
      );
    }
    return fail("restore_failed", "successor proxy after publish", false);
  }
  if (live && classifyLiveAgainstPlan(live, plan, deps, candidate) === "foreign") {
    return fail("restore_failed", "successor proxy after publish", false);
  }
  return rollbackThen(
    deps,
    plan,
    fail("proxy_not_ready", "candidate readiness failed after publish", true),
    candidate,
  );
}

function journalFromPlan(
  plan: RollbackPlan,
  token: string,
  candidate: VersionPointer,
  previousIdentity: DesktopRuntimeIdentity | null,
): ActivationJournalRecord {
  return {
    schemaVersion: 1,
    transactionId: plan.transactionId,
    token,
    intent: "activate",
    kind: plan.kind,
    mode: plan.mode,
    stableRoot: plan.stableRoot,
    expectedTarget: plan.expectedTarget,
    snapshot: {
      pointer: plan.snapshot.pointer,
      owner: plan.snapshot.owner,
      hadLiveProxy: plan.snapshot.hadLiveProxy,
      serviceInstalled: plan.snapshot.serviceInstalled,
      backend: plan.snapshot.backend,
      bunPath: plan.snapshot.serviceInstall.bunPath ?? null,
      cliPath: plan.snapshot.serviceInstall.cliPath ?? null,
      previousPid: plan.snapshot.previousPid,
      previousBunPath: previousIdentity?.bunPath ?? null,
      previousCliPath: previousIdentity?.cliPath ?? null,
    },
    candidate,
    publishedPointer: intendedPublishedPointer(plan.snapshot.pointer, candidate),
    touchedService: plan.touchedService,
    candidatePid: plan.candidatePid,
  };
}

async function runDesktopServiceMutationLocked(
  kind: ServiceMutationKind,
  input: { runtimeManifestId?: string; backend?: ServiceInstallBackend },
  deps: DesktopServiceMutationDeps,
  stableRoot: string,
  lockToken: string,
): Promise<HandlerOutcome> {
  const mode = deps.mode ?? "service";
  throwIfAborted(deps.signal);
  if (!deps.identity) {
    return fail("runtime_integrity_failed", "desktop runtime identity is unavailable", false);
  }
  if (!deps.expectedTarget) {
    return fail("runtime_integrity_failed", "desktop runtime target is unavailable", false);
  }
  if ((input.backend ?? deps.backend) === "windows-native"
    && (deps.platform ?? process.platform) !== "win32") {
    return fail("service_not_startable", "windows-native service backend is unavailable on this platform", false);
  }

  const recovered = await recoverFromJournal(deps, stableRoot, deps.expectedTarget);
  if (recovered.handled) return recovered.outcome;

  const refreshed = await refreshLockedObservation(deps, stableRoot, deps.identity, deps.expectedTarget);
  if (!refreshed.ok) return refreshed.outcome;
  const observed = refreshed.observed;
  if (!mutationAuthorized(kind, mode, observed.owner, observed.service, observed.live)) {
    return fail("ownership_conflict", "service mutation is not permitted for this owner", false);
  }

  if (kind === "uninstall") {
    const snapshot: ActivationSnapshot = {
      owner: observed.owner,
      hadLiveProxy: observed.live !== null,
      serviceInstalled: observed.diagnosed.installed === true && observed.diagnosed.conflict !== true,
      backend: observed.diagnosed.backend,
      serviceInstall: observed.install,
      pointer: observed.pointer,
      previousPid: observed.live?.pid ?? null,
      previousIdentity: observed.identity,
    };
    const plan: RollbackPlan = {
      snapshot,
      published: false,
      publishedPointer: null,
      touchedService: true,
      installedService: false,
      repairedService: false,
      kind,
      mode,
      candidatePointer: observed.pointer.current,
      candidatePid: observed.live?.pid ?? null,
      stableRoot,
      expectedTarget: deps.expectedTarget,
      abandonOnly: false,
      transactionId: randomUUID(),
    };
    const journalError = await persistJournal(
      deps,
      journalFromPlan(plan, lockToken, observed.pointer.current, observed.identity),
    );
    if (journalError) return journalError;
    const stop = await deps.runStopTransaction();
    if (!stop.ok) {
      return fail(stop.code === "ownership_conflict" ? "ownership_conflict" : "stop_failed", stop.message, stop.retryable);
    }
    if (!(await proveAbsent(deps, observed.live?.pid ?? null))) {
      return fail("stop_failed", "proxy remained after stop", true);
    }
    const removed = await deps.uninstallService();
    const diagnosed = deps.diagnoseService();
    const install = deps.inspectServiceInstall();
    const service = mapServiceState(diagnosed, install.conflict);
    if (removed === false || service.installed || service.stateCode === "conflict") {
      return fail("stop_failed", "service remained after uninstall", false);
    }
    if (!(await proveAbsent(deps, observed.live?.pid ?? null))) {
      return fail("stop_failed", "proxy remained after uninstall", true);
    }
    const cleared = removeActivationJournal(stableRoot, { transactionId: plan.transactionId });
    if (!cleared.ok) return fail("restore_failed", "activation journal could not be cleared", false);
    return serviceMutationResult(true, service, "stopped");
  }

  if (kind === "start") {
    if (!observed.service.startable) {
      return fail("service_not_startable", "installed service is not startable", false);
    }
    const snapshot: ActivationSnapshot = {
      owner: observed.owner,
      hadLiveProxy: observed.live !== null,
      serviceInstalled: observed.diagnosed.installed === true && observed.diagnosed.conflict !== true,
      backend: observed.diagnosed.backend,
      serviceInstall: observed.install,
      pointer: observed.pointer,
      previousPid: observed.live?.pid ?? null,
      previousIdentity: observed.identity,
    };
    const plan: RollbackPlan = {
      snapshot,
      published: false,
      publishedPointer: null,
      touchedService: false,
      installedService: false,
      repairedService: false,
      kind,
      mode,
      candidatePointer: observed.pointer.current,
      candidatePid: null,
      stableRoot,
      expectedTarget: deps.expectedTarget,
      abandonOnly: false,
      transactionId: randomUUID(),
    };
    const started = !observed.live;
    if (started) {
      const journalError = await persistJournal(
        deps,
        journalFromPlan(plan, lockToken, observed.pointer.current, observed.identity),
      );
      if (journalError) return journalError;
      try {
        await deps.startService(observed.identity);
      } catch (error) {
        return rollbackThen(deps, plan, fail("service_not_startable", error, true), observed.identity);
      }
    }
    const ready = await waitReady(deps, observed.identity, "desktop-service", plan.candidatePid).catch((error) => {
      if (error instanceof DeadlineExceededError) {
        return { ok: false as const, outcome: fail("proxy_not_ready", error, true), deadline: true };
      }
      return { ok: false as const, outcome: fail("proxy_not_ready", error, true) };
    });
    if (!ready.ok) {
      return started ? rollbackThen(deps, plan, ready.outcome, observed.identity) : ready.outcome;
    }
    plan.candidatePid = ready.live.pid ?? null;
    const pidUpdate = await updateJournalCandidatePid(deps, plan, plan.candidatePid);
    if (pidUpdate) {
      return started ? rollbackThen(deps, plan, pidUpdate, observed.identity) : pidUpdate;
    }
    try {
      if (deps.afterCandidateReady) await deps.afterCandidateReady();
    } catch (error) {
      return rollbackThen(deps, plan, fail("runtime_integrity_failed", error, true), observed.identity);
    }
    const healthy = await inspectHealthyCandidate(deps, observed.identity);
    if (!healthy.ok) {
      return rollbackThen(deps, plan, healthy.outcome, observed.identity);
    }
    if (started) {
      const cleared = removeActivationJournal(stableRoot, { transactionId: plan.transactionId });
      if (!cleared.ok) return fail("restore_failed", "activation journal could not be cleared", false);
    }
    return serviceMutationResult(started, healthy.service, "ready");
  }

  if (!input.runtimeManifestId) {
    return fail("runtime_integrity_failed", "runtime manifest id is required", false);
  }

  const resolveById = deps.resolveByManifestId ?? resolveRuntimeByManifestId;
  const resolved = resolveById({
    stableRoot,
    manifestId: input.runtimeManifestId,
    expectedTarget: deps.expectedTarget,
  });
  if (!resolved.ok) {
    return fail("runtime_integrity_failed", "requested runtime is not a verified stable generation", false);
  }

  const candidate = deps.resolveIdentity(resolved.absPath);
  if (!candidate || candidate.runtimeManifestId !== input.runtimeManifestId) {
    return fail("runtime_integrity_failed", "requested runtime failed identity verification", false);
  }
  if (candidate.installId !== observed.identity.installId) {
    return fail("ownership_conflict", "requested runtime is not this Desktop install", false);
  }
  const candidateRoot = stableStoreRootFromIdentity(candidate);
  if (!candidateRoot || !pathsEqualCanonical(candidateRoot, stableRoot)) {
    return fail("runtime_integrity_failed", "requested runtime is outside the verified stable store", false);
  }

  const snapshot: ActivationSnapshot = {
    owner: observed.owner,
    hadLiveProxy: observed.live !== null,
    serviceInstalled: observed.diagnosed.installed === true && observed.diagnosed.conflict !== true,
    backend: observed.diagnosed.backend,
    serviceInstall: observed.install,
    pointer: observed.pointer,
    previousPid: observed.live?.pid ?? null,
    previousIdentity: observed.identity,
  };
  const referenced = retainReferencedRuntimeGenerations({
    serviceInstall: observed.install,
    owner: observed.identity,
    pointer: snapshot.pointer,
    candidate: resolved.pointer,
  });
  const willInstall = kind === "install" && !snapshot.serviceInstalled && mode !== "direct";
  const willRepair = mode !== "direct" && !willInstall;
  const plan: RollbackPlan = {
    snapshot,
    published: false,
    publishedPointer: null,
    touchedService: willInstall || willRepair,
    installedService: willInstall,
    repairedService: willRepair,
    kind,
    mode,
    candidatePointer: resolved.pointer,
    candidatePid: null,
    stableRoot,
    expectedTarget: deps.expectedTarget,
    abandonOnly: false,
    transactionId: randomUUID(),
  };

  const journalError = await persistJournal(
    deps,
    journalFromPlan(plan, lockToken, resolved.pointer, observed.identity),
  );
  if (journalError) return journalError;

  try {
    const stop = await deps.runStopTransaction();
    if (!stop.ok) {
      return fail(stop.code === "ownership_conflict" ? "ownership_conflict" : "stop_failed", stop.message, stop.retryable);
    }
    if (!(await proveAbsent(deps, snapshot.previousPid))) {
      return fail("stop_failed", "proxy remained after stop", true);
    }

    let managerStarted = false;
    try {
      if (mode === "direct") {
        await deps.startDirect(candidate);
      } else if (willInstall) {
        const effect = await deps.installService(candidate, input.backend ?? deps.backend ?? "platform-default");
        managerStarted = managerStartedFrom(effect);
      } else {
        const effect = await deps.repairService(candidate, { backend: snapshot.backend });
        managerStarted = managerStartedFrom(effect);
      }
      if (mode !== "direct") {
        await startIfNeeded(deps, candidate, managerStarted);
      }
    } catch (error) {
      if (error instanceof DeadlineExceededError) throw error;
      return rollbackThen(deps, plan, fail("service_not_startable", error, true), candidate);
    }

    const expectedOwner: DesktopOwnerKind = mode === "direct" ? "desktop-direct" : "desktop-service";
    const ready = await waitReady(deps, candidate, expectedOwner, plan.candidatePid).catch((error) => {
      if (error instanceof DeadlineExceededError) throw error;
      return { ok: false as const, outcome: fail("proxy_not_ready", error, true) };
    });
    if (!ready.ok) {
      return rollbackThen(deps, plan, ready.outcome, candidate);
    }
    plan.candidatePid = ready.live.pid ?? null;
    const pidUpdate = await updateJournalCandidatePid(deps, plan, plan.candidatePid);
    if (pidUpdate) return rollbackThen(deps, plan, pidUpdate, candidate);

    if (deps.afterCandidateReady) await deps.afterCandidateReady();

    if (mode === "service") {
      const healthy = await inspectHealthyCandidate(deps, candidate);
      if (!healthy.ok) {
        return rollbackThen(deps, plan, healthy.outcome, candidate);
      }
    }

    const publish = deps.publishPointer ?? publishCurrent;
    const published: RuntimeStoreResult<PublishCurrentSuccess> = publish({
      stableRoot,
      staged: resolved.pointer,
      expectedCurrent: snapshot.pointer.current,
      expectedTarget: deps.expectedTarget,
      isVersionReferenced: referenced,
    });
    if (!published.ok) {
      return rollbackThen(
        deps,
        { ...plan, abandonOnly: published.code === "cas_mismatch" },
        published.code === "cas_mismatch"
          ? fail("runtime_integrity_failed", "current runtime pointer changed during activation", false)
          : fail("runtime_integrity_failed", "current runtime pointer could not be published", false),
        candidate,
      );
    }
    plan.published = true;
    plan.publishedPointer = published.pointer;
    if (deps.afterPointerPublished) await deps.afterPointerPublished();
    return finalizePublishedCandidate(deps, plan, candidate, expectedOwner);
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      await rollbackToSnapshot(deps, plan, candidate).catch(() => ({ ok: false }));
      throw error;
    }
    return rollbackThen(deps, plan, fail("runtime_integrity_failed", error, true), candidate);
  }
}

export async function runDesktopServiceMutation(
  kind: ServiceMutationKind,
  input: { runtimeManifestId?: string; backend?: ServiceInstallBackend },
  deps: DesktopServiceMutationDeps,
): Promise<HandlerOutcome> {
  throwIfAborted(deps.signal);

  if ((input.backend ?? deps.backend) === "windows-native"
    && (deps.platform ?? process.platform) !== "win32") {
    return fail("service_not_startable", "windows-native service backend is unavailable on this platform", false);
  }
  if (!deps.identity) {
    return fail("runtime_integrity_failed", "desktop runtime identity is unavailable", false);
  }
  const stableRoot = stableStoreRootFromIdentity(deps.identity);
  if (!stableRoot) {
    return fail("runtime_integrity_failed", "stable runtime store is unavailable", false);
  }

  const pending = activationIsPending(stableRoot, deps.isAlive);
  if (!pending.pending) {
    const mode = deps.mode ?? "service";
    if (deps.owner === "unknown/conflict") {
      return fail("ownership_conflict", "ownership evidence is conflicting", false);
    }
    if (!mutationAuthorized(kind, mode, deps.owner, deps.service, deps.live)) {
      return fail("ownership_conflict", "service mutation is not permitted for this owner", false);
    }
  }

  const acquire = deps.acquireActivationLock ?? acquireActivationLock;
  let handle: ActivationLockHandle;
  try {
    handle = await acquire(stableRoot, {
      signal: deps.signal,
      isAlive: deps.isAlive,
      sleep: async ms => {
        throwIfAborted(deps.signal);
        await deps.sleep(ms, deps.signal);
      },
      ...deps.activationLock,
    });
  } catch (error) {
    if (error instanceof DeadlineExceededError) throw error;
    if (error instanceof ActivationLockTimeoutError) {
      return fail("service_not_startable", error, true);
    }
    return fail("runtime_integrity_failed", error, false);
  }

  try {
    return await runDesktopServiceMutationLocked(kind, input, deps, stableRoot, handle.token);
  } catch (error) {
    if (error instanceof DeadlineExceededError) throw error;
    throw error;
  } finally {
    handle.release();
  }
}

export function activationIsPending(
  stableRoot: string,
  isAlive: (pid: number) => boolean,
): { pending: boolean; recoverable: boolean } {
  const lock = observeActivationLock(stableRoot, { isAlive });
  const journal = observeActivationJournal(stableRoot);
  if (lock.state === "live") {
    return { pending: true, recoverable: false };
  }
  if (journal.state === "valid" || journal.state === "unreadable") {
    return { pending: true, recoverable: true };
  }
  if (lock.state === "incomplete") {
    return { pending: true, recoverable: true };
  }
  return { pending: false, recoverable: false };
}

export async function recoverDesktopActivationIfNeeded(
  deps: DesktopServiceMutationDeps,
  stableRoot: string,
): Promise<HandlerOutcome | null> {
  if (!deps.expectedTarget) {
    return fail("runtime_integrity_failed", "desktop runtime target is unavailable", false);
  }
  const pending = activationIsPending(stableRoot, deps.isAlive);
  if (!pending.pending) return null;
  if (!pending.recoverable) {
    return fail("service_not_startable", "activation is in progress", true);
  }
  const acquire = deps.acquireActivationLock ?? acquireActivationLock;
  let handle: ActivationLockHandle;
  try {
    handle = await acquire(stableRoot, {
      signal: deps.signal,
      isAlive: deps.isAlive,
      sleep: async ms => {
        throwIfAborted(deps.signal);
        await deps.sleep(ms, deps.signal);
      },
      ...deps.activationLock,
    });
  } catch (error) {
    if (error instanceof DeadlineExceededError) throw error;
    if (error instanceof ActivationLockTimeoutError) {
      return fail("service_not_startable", error, true);
    }
    return fail("runtime_integrity_failed", error, false);
  }
  try {
    const recovered = await recoverFromJournal(deps, stableRoot, deps.expectedTarget);
    if (recovered.handled) return recovered.outcome;
    return null;
  } finally {
    handle.release();
  }
}

export function classifyOwnerForActivation(input: {
  identity: DesktopRuntimeIdentity | null;
  live: LiveProxy | null;
  service: { installed: boolean; startable: boolean; conflict: boolean };
  serviceInstall: InstalledServicePaths;
  commandLine?: string | null;
  isAlive: (pid: number) => boolean;
}): Owner {
  return classifyDesktopOwner({
    identity: input.identity,
    livePid: input.live?.pid ?? null,
    livePort: input.live?.port ?? null,
    commandLine: input.commandLine,
    service: input.service,
    serviceInstall: input.serviceInstall,
    isAlive: input.isAlive,
  }).owner;
}
