#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathsEqualCanonical, readDesktopDirectOwnerRecord } from "../../src/config/desktop-owner";
import { readPid, readRuntimePort } from "../../src/config/process-state";
import { findLiveProxy, probeReadiness } from "../../src/server/proxy-liveness";
import { readRuntimeManifestFile, verifyRuntimeTree, type TargetTriple } from "../runtime/manifest";
import { ACTIVATION_JOURNAL_NAME } from "../runtime/activation-journal";
import { CURRENT_POINTER_NAME, STABLE_VERSIONS_DIR, readCurrentPointer } from "../runtime/staging";
import { validateEnvelope } from "../runtime/protocol";
import {
  LINUX_X64_TARGET,
  FAILURE_FIXTURE,
  clearFailedCandidateMarkers,
  cmdlineMatchesRuntime,
  copyTree,
  overlayCurrentDesktopRuntime,
  createIsolatedHomes,
  distinctSuccessorVersions,
  exactKeys,
  fail,
  invokeBridge,
  invokeInstall,
  isProcessAlive,
  isRecord,
  jsonLooksPathFree,
  readStubConsume,
  readStubPid,
  removeIsolatedHomes,
  resignRuntimeTree,
  rewritePackageVersion,
  runtimeBinaryName,
  seedProbeCanaries,
  stubReadyzHit,
  terminateOwnedProbeChildren,
  verifyProbeCanaries,
  waitUntil,
  writeFailedReadyCli,
  type JsonRecord,
} from "./probe-c-support";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const INSTALL_TIMEOUT_MS = 180_000;
const BRIDGE_TIMEOUT_MS = 120_000;
const FAIL_ACTIVATE_TIMEOUT_MS = 150_000;
const STOP_TIMEOUT_MS = 30_000;
const PORT = 18_231;
const SURVIVOR_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00001";
const ACTIVATE_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00002";
const FAIL_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00003";
const CONFLICT_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00004";
const STOP_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00005";
const BOOTSTRAP_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00006";
const NEW_STATUS_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00007";
const RESTORED_REQUEST_ID = "01K3P2AAAAAAAAAAAAAAA00008";

export const TWO_GENERATION_SUMMARY_KEYS = [
  "schemaVersion",
  "target",
  "oldVersion",
  "newVersion",
  "survivorReattest",
  "activateCommitted",
  "childRecordsReady",
  "candidateFailureRolledBack",
  "conflictFailClosed",
  "generationsRetained",
  "filesystemOwnerRecords",
  "injectedDependencySeams",
  "webviewEvidence",
  "sourceOverlay",
  "failureFixture",
] as const;

export type TwoGenerationSummary = {
  schemaVersion: 1;
  target: typeof LINUX_X64_TARGET;
  oldVersion: string;
  newVersion: string;
  survivorReattest: true;
  activateCommitted: true;
  childRecordsReady: true;
  candidateFailureRolledBack: true;
  conflictFailClosed: true;
  generationsRetained: true;
  filesystemOwnerRecords: true;
  injectedDependencySeams: false;
  webviewEvidence: false;
  sourceOverlay: true;
  failureFixture: typeof FAILURE_FIXTURE;
};

function packagedRuntimeRoot(): string {
  const override = process.env.OCX_PROBE_RUNTIME_ROOT?.trim();
  return override && override.length > 0
    ? resolve(override)
    : join(REPO_ROOT, "desktop/src-tauri/resources/runtime");
}

function generationRoot(stableRoot: string, version: string): string {
  return join(stableRoot, STABLE_VERSIONS_DIR, version);
}

function bunPathFor(generation: string, target: TargetTriple): string {
  return join(generation, runtimeBinaryName(target));
}

function cliPathFor(generation: string): string {
  return join(generation, "src/cli/index.ts");
}

function requireReadyEnvelope(value: JsonRecord, operation: string): JsonRecord {
  const parsed = validateEnvelope(value);
  if (!parsed.ok || !parsed.value.ok || parsed.value.operation !== operation) {
    fail(`${operation} envelope is invalid`);
  }
  const result: unknown = parsed.value.result;
  if (!isRecord(result) || result.status !== "ready") fail(`${operation} is not ready`);
  if (result.owner !== "desktop-direct") fail(`${operation} owner is not desktop-direct`);
  if (typeof result.pid !== "number" || !Number.isSafeInteger(result.pid) || result.pid <= 0) {
    fail(`${operation} pid is invalid`);
  }
  return result;
}

async function proveChildRecords(
  expectedPid: number,
  expectedVersion: string,
  expectedBun: string,
  expectedCli: string,
): Promise<void> {
  const live = await findLiveProxy();
  if (!live || live.pid !== expectedPid || live.version !== expectedVersion) fail("live proxy identity mismatch");
  const ready = await probeReadiness(live.port, { hostname: live.hostname, expectedPid });
  if (!ready || ready.status !== "ready" || ready.pid !== expectedPid) fail("strict readyz failed");
  const owner = readDesktopDirectOwnerRecord();
  const runtime = readRuntimePort(expectedPid);
  if (readPid() !== expectedPid || !runtime || runtime.pid !== expectedPid) fail("pid or runtime-port record mismatch");
  if (!owner || owner.pid !== expectedPid || owner.runtimeVersion !== expectedVersion) {
    fail("desktop-direct owner record mismatch");
  }
  if (!pathsEqualCanonical(owner.bunPath, expectedBun) || !pathsEqualCanonical(owner.cliPath, expectedCli)) {
    fail("owner record paths are not the expected generation");
  }
  if (!cmdlineMatchesRuntime(expectedPid, expectedBun, expectedCli)) fail("process cmdline does not match generation paths");
}

function pointerIds(stableRoot: string): { current: string; previous: string | null; currentVersion: string } {
  const pointer = readCurrentPointer(stableRoot);
  if (!pointer.ok || !pointer.pointer) fail("current pointer is missing");
  return {
    current: pointer.pointer.current.id,
    previous: pointer.pointer.previous?.id ?? null,
    currentVersion: pointer.pointer.current.version,
  };
}

function materializeCandidate(
  sourceRoot: string,
  destRoot: string,
  version: string,
  target: TargetTriple,
  failedReady: boolean,
): void {
  mkdirSync(dirname(destRoot), { recursive: true });
  copyTree(sourceRoot, destRoot);
  overlayCurrentDesktopRuntime(destRoot);
  rewritePackageVersion(destRoot, version);
  if (failedReady) writeFailedReadyCli(destRoot, version);
  resignRuntimeTree(destRoot, version, target);
}

function verifyGeneration(stableRoot: string, version: string, target: TargetTriple): void {
  const root = generationRoot(stableRoot, version);
  const loaded = readRuntimeManifestFile(join(root, "runtime-manifest.json"), { expectedTarget: target });
  if (!loaded.ok) fail("retained generation manifest is missing");
  const verified = verifyRuntimeTree(root, loaded.manifest, {
    expectedTarget: target,
    enforceExecutableBit: true,
    allowManifestFile: true,
  });
  if (!verified.ok) fail("retained generation failed verification");
}

function stagedVersions(stableRoot: string): string[] {
  return readdirSync(join(stableRoot, STABLE_VERSIONS_DIR)).filter(name => name !== "." && name !== "..");
}

export function validateTwoGenerationSummary(value: unknown): TwoGenerationSummary {
  if (!isRecord(value) || !exactKeys(value, TWO_GENERATION_SUMMARY_KEYS)) fail("two-generation summary fields are invalid");
  if (value.schemaVersion !== 1
    || value.target !== LINUX_X64_TARGET
    || typeof value.oldVersion !== "string"
    || typeof value.newVersion !== "string"
    || value.oldVersion === value.newVersion
    || value.survivorReattest !== true
    || value.activateCommitted !== true
    || value.childRecordsReady !== true
    || value.candidateFailureRolledBack !== true
    || value.conflictFailClosed !== true
    || value.generationsRetained !== true
    || value.filesystemOwnerRecords !== true
    || value.injectedDependencySeams !== false
    || value.webviewEvidence !== false
    || value.sourceOverlay !== true
    || value.failureFixture !== FAILURE_FIXTURE) {
    fail("two-generation summary values are invalid");
  }
  if (!jsonLooksPathFree(value)) fail("two-generation summary is not path-free");
  return value as TwoGenerationSummary;
}

export async function runTwoGenerationProbe(): Promise<TwoGenerationSummary> {
  if (process.platform !== "linux" || process.arch !== "x64") fail("two-generation probe requires linux x64");
  const target = LINUX_X64_TARGET;
  const sourceRoot = packagedRuntimeRoot();
  const sourceManifest = readRuntimeManifestFile(join(sourceRoot, "runtime-manifest.json"), { expectedTarget: target });
  if (!sourceManifest.ok) fail("packaged runtime manifest is missing");
  const oldVersion = sourceManifest.manifest.version;
  const { newVersion, failVersion } = distinctSuccessorVersions(oldVersion);
  if (!existsSync(bunPathFor(sourceRoot, target))) fail("packaged runtime binary is missing");

  const homes = createIsolatedHomes("ocx-direct-two-gen-", PORT);
  const canaries = seedProbeCanaries(homes.env.OPENCODEX_HOME, homes.env.CODEX_HOME);
  const previousHome = process.env.OPENCODEX_HOME;
  const previousCodex = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = homes.env.OPENCODEX_HOME;
  process.env.CODEX_HOME = homes.env.CODEX_HOME;
  const trackedPids = new Set<number>();
  let installId: string | null = null;
  try {
    const cleanSource = join(homes.home, "src-old");
    copyTree(sourceRoot, cleanSource);
    overlayCurrentDesktopRuntime(cleanSource);
    resignRuntimeTree(cleanSource, oldVersion, target);
    const sourceBun = bunPathFor(cleanSource, target);
    const installed = await invokeInstall(sourceBun, cleanSource, homes.env, homes.stableRoot, target, INSTALL_TIMEOUT_MS);
    if (installed.published !== true) fail("first runtime was not published");
    const oldRoot = generationRoot(homes.stableRoot, oldVersion);
    const oldBun = bunPathFor(oldRoot, target);
    const oldCli = cliPathFor(oldRoot);

    const bootstrap = async (id: string, bun: string, cwd: string) => invokeBridge(bun, cwd, homes.env, {
      schemaVersion: 1,
      requestId: id,
      operation: "bootstrap",
      payload: {},
    }, BRIDGE_TIMEOUT_MS);

    const first = requireReadyEnvelope(await bootstrap(BOOTSTRAP_REQUEST_ID, oldBun, oldRoot), "bootstrap");
    const firstPid = first.pid as number;
    trackedPids.add(firstPid);
    await proveChildRecords(firstPid, oldVersion, oldBun, oldCli);
    const firstOwner = readDesktopDirectOwnerRecord();
    if (!firstOwner) fail("filesystem owner record missing after start");
    installId = firstOwner.installId;

    const survivor = requireReadyEnvelope(await bootstrap(SURVIVOR_REQUEST_ID, oldBun, oldRoot), "bootstrap");
    if (survivor.pid !== firstPid) fail("survivor bootstrap spawned another child");
    await proveChildRecords(firstPid, oldVersion, oldBun, oldCli);

    const newSource = join(homes.home, "src-new");
    materializeCandidate(sourceRoot, newSource, newVersion, target, false);
    const newSourceBun = bunPathFor(newSource, target);
    const stagedNew = await invokeInstall(newSourceBun, newSource, homes.env, homes.stableRoot, target, INSTALL_TIMEOUT_MS);
    if (stagedNew.published === true) fail("candidate install published before activate");
    const newId = readRuntimeManifestFile(join(newSource, "runtime-manifest.json"), { expectedTarget: target });
    if (!newId.ok) fail("candidate manifest missing");

    const activated = await invokeBridge(oldBun, oldRoot, homes.env, {
      schemaVersion: 1,
      requestId: ACTIVATE_REQUEST_ID,
      operation: "runtime-activate",
      payload: { runtimeManifestId: newId.manifest.id },
    }, BRIDGE_TIMEOUT_MS);
    const activatedParsed = validateEnvelope(activated);
    if (!activatedParsed.ok || !activatedParsed.value.ok) fail("runtime-activate did not succeed");
    const afterActivate = pointerIds(homes.stableRoot);
    if (afterActivate.current !== newId.manifest.id || afterActivate.previous !== sourceManifest.manifest.id) {
      fail("activate did not commit current=new previous=old");
    }
    const newRoot = generationRoot(homes.stableRoot, newVersion);
    const newBun = bunPathFor(newRoot, target);
    const newCli = cliPathFor(newRoot);
    if (!existsSync(newRoot) || !existsSync(newBun)) fail("candidate generation is missing after activate");
    let activatedPid = 0;
    await waitUntil(async () => {
      const envelope = await invokeBridge(newBun, newRoot, homes.env, {
        schemaVersion: 1,
        requestId: NEW_STATUS_REQUEST_ID,
        operation: "status",
        payload: {},
      }, STOP_TIMEOUT_MS);
      const parsed = validateEnvelope(envelope);
      if (!parsed.ok || !parsed.value.ok) return false;
      const result: unknown = parsed.value.result;
      if (!isRecord(result) || result.status !== "ready") return false;
      const pid = Number(result.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      activatedPid = pid;
      return String(result.version ?? "") === newVersion;
    }, BRIDGE_TIMEOUT_MS, "candidate status");
    if (activatedPid === firstPid) fail("candidate reused the old pid");
    trackedPids.add(activatedPid);
    await proveChildRecords(activatedPid, newVersion, newBun, newCli);
    verifyProbeCanaries(homes.env.OPENCODEX_HOME, homes.env.CODEX_HOME, canaries);

    const failSource = join(homes.home, "src-fail");
    materializeCandidate(sourceRoot, failSource, failVersion, target, true);
    const failSourceBun = bunPathFor(failSource, target);
    await invokeInstall(failSourceBun, failSource, homes.env, homes.stableRoot, target, INSTALL_TIMEOUT_MS);
    const failManifest = readRuntimeManifestFile(join(failSource, "runtime-manifest.json"), { expectedTarget: target });
    if (!failManifest.ok) fail("failed candidate manifest missing");
    const failRoot = generationRoot(homes.stableRoot, failVersion);
    const failBun = bunPathFor(failRoot, target);
    const failCli = cliPathFor(failRoot);
    const loadedFail = readRuntimeManifestFile(join(failRoot, "runtime-manifest.json"), { expectedTarget: target });
    if (!loadedFail.ok) fail("staged failed candidate is missing");
    const verifiedFail = verifyRuntimeTree(failRoot, loadedFail.manifest, {
      expectedTarget: target,
      enforceExecutableBit: true,
      allowManifestFile: true,
    });
    if (!verifiedFail.ok) fail("failed candidate is not manifest-valid");
    clearFailedCandidateMarkers(homes.env.OPENCODEX_HOME);

    const preFailurePid = activatedPid;
    const failPromise = invokeBridge(newBun, newRoot, homes.env, {
      schemaVersion: 1,
      requestId: FAIL_REQUEST_ID,
      operation: "runtime-activate",
      payload: { runtimeManifestId: failManifest.manifest.id },
    }, FAIL_ACTIVATE_TIMEOUT_MS);
    let failedCandidatePid: number | null = null;
    await waitUntil(() => {
      const consumed = readStubConsume(homes.env.OPENCODEX_HOME);
      if (consumed === "null" || consumed === "throw") fail("failed candidate did not consume the launch descriptor");
      const pid = readStubPid(homes.env.OPENCODEX_HOME);
      if (pid === null || !isProcessAlive(pid)) return false;
      if (!cmdlineMatchesRuntime(pid, failBun, failCli)) return false;
      if (consumed !== "ok") return false;
      if (!stubReadyzHit(homes.env.OPENCODEX_HOME)) return false;
      failedCandidatePid = pid;
      return true;
    }, 30_000, "failed candidate start");
    if (failedCandidatePid === null) fail("production operation did not start the candidate");
    trackedPids.add(failedCandidatePid);
    const failedActivate = await failPromise;
    const failedParsed = validateEnvelope(failedActivate);
    if (!failedParsed.ok || failedParsed.value.ok) fail("failed candidate unexpectedly succeeded");
    if (failedParsed.value.error?.code !== "proxy_not_ready") fail("failed candidate did not fail after start");
    if (!stubReadyzHit(homes.env.OPENCODEX_HOME)) fail("failed candidate never served failed readyz");
    if (isProcessAlive(failedCandidatePid)) fail("failed candidate remained alive");
    if (isProcessAlive(preFailurePid)) fail("pre-failure pid remained alive");
    const afterFail = pointerIds(homes.stableRoot);
    if (afterFail.current !== newId.manifest.id || afterFail.previous !== sourceManifest.manifest.id) {
      fail("failed candidate rewound or replaced the committed pointer");
    }
    if (existsSync(join(homes.stableRoot, ACTIVATION_JOURNAL_NAME))) {
      fail("activation journal remained after rollback");
    }
    verifyProbeCanaries(homes.env.OPENCODEX_HOME, homes.env.CODEX_HOME, canaries);
    let restoredPid = 0;
    await waitUntil(async () => {
      const envelope = await invokeBridge(newBun, newRoot, homes.env, {
        schemaVersion: 1,
        requestId: RESTORED_REQUEST_ID,
        operation: "status",
        payload: {},
      }, STOP_TIMEOUT_MS);
      const parsed = validateEnvelope(envelope);
      if (!parsed.ok || !parsed.value.ok) return false;
      const result: unknown = parsed.value.result;
      if (!isRecord(result) || result.status !== "ready" || result.version !== newVersion) return false;
      const pid = Number(result.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      restoredPid = pid;
      return true;
    }, BRIDGE_TIMEOUT_MS, "rollback status");
    if (restoredPid === preFailurePid || restoredPid === failedCandidatePid) fail("rollback reused a prior pid");
    trackedPids.add(restoredPid);
    await proveChildRecords(restoredPid, newVersion, newBun, newCli);

    const pointerPath = join(homes.stableRoot, CURRENT_POINTER_NAME);
    const pointerBytes = readFileSync(pointerPath);
    const retainedVersions = stagedVersions(homes.stableRoot);
    if (!retainedVersions.includes(oldVersion) || !retainedVersions.includes(newVersion) || !retainedVersions.includes(failVersion)) {
      fail("staged generations missing before conflict");
    }
    const retainedIdentities = new Map<string, string>();
    for (const version of retainedVersions) {
      verifyGeneration(homes.stableRoot, version, target);
      const loaded = readRuntimeManifestFile(join(generationRoot(homes.stableRoot, version), "runtime-manifest.json"), {
        expectedTarget: target,
      });
      if (!loaded.ok) fail("staged generation identity missing before conflict");
      retainedIdentities.set(version, loaded.manifest.id);
    }
    if (!retainedIdentities.has(failVersion)) fail("failed candidate generation was not staged before conflict");

    const ownerPath = join(homes.env.OPENCODEX_HOME, "desktop-direct-owner.json");
    const ownerRaw = JSON.parse(readFileSync(ownerPath, "utf8")) as JsonRecord;
    ownerRaw.installId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(ownerPath, `${JSON.stringify(ownerRaw)}\n`);
    chmodSync(ownerPath, 0o600);
    const conflict = await invokeBridge(newBun, newRoot, homes.env, {
      schemaVersion: 1,
      requestId: CONFLICT_REQUEST_ID,
      operation: "bootstrap",
      payload: {},
    }, BRIDGE_TIMEOUT_MS);
    const conflictParsed = validateEnvelope(conflict);
    if (!conflictParsed.ok || conflictParsed.value.ok) fail("conflicting ownership did not fail closed");
    if (conflictParsed.value.error?.code !== "ownership_conflict") fail("conflict used the wrong error code");
    const pointerAfter = readFileSync(pointerPath);
    if (Buffer.compare(pointerBytes, pointerAfter) !== 0) fail("conflict changed current pointer bytes");
    const retainedAfter = stagedVersions(homes.stableRoot);
    if (retainedAfter.length !== retainedVersions.length) fail("conflict dropped a generation");
    for (const [version, id] of retainedIdentities) {
      if (!retainedAfter.includes(version)) fail("conflict dropped a generation");
      verifyGeneration(homes.stableRoot, version, target);
      const loaded = readRuntimeManifestFile(join(generationRoot(homes.stableRoot, version), "runtime-manifest.json"), {
        expectedTarget: target,
      });
      if (!loaded.ok || loaded.manifest.id !== id) fail("conflict changed a retained generation identity");
    }

    await invokeBridge(newBun, newRoot, homes.env, {
      schemaVersion: 1,
      requestId: STOP_REQUEST_ID,
      operation: "stop",
      payload: { reason: "app-exit" },
    }, STOP_TIMEOUT_MS).catch(() => ({ ok: false }));
    verifyProbeCanaries(homes.env.OPENCODEX_HOME, homes.env.CODEX_HOME, canaries);

    const summary: TwoGenerationSummary = {
      schemaVersion: 1,
      target,
      oldVersion,
      newVersion,
      survivorReattest: true,
      activateCommitted: true,
      childRecordsReady: true,
      candidateFailureRolledBack: true,
      conflictFailClosed: true,
      generationsRetained: true,
      filesystemOwnerRecords: true,
      injectedDependencySeams: false,
      webviewEvidence: false,
      sourceOverlay: true,
      failureFixture: FAILURE_FIXTURE,
    };
    return validateTwoGenerationSummary(summary);
  } finally {
    await terminateOwnedProbeChildren({
      stableRoot: homes.stableRoot,
      installId,
      trackedPids,
      opencodexHome: homes.env.OPENCODEX_HOME,
    });
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    removeIsolatedHomes(homes.home);
  }
}

async function main(): Promise<void> {
  const summary = await runTwoGenerationProbe();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : "two-generation probe failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
