import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestLaunchNonce,
  getDesktopDirectOwnerPath,
  publishDesktopDirectOwnerRecord,
  writeRuntimePortOwnerId,
  type DesktopRuntimeIdentity,
} from "../../src/config/desktop-owner";
import { writeRuntimePort } from "../../src/config/process-state";
import { runBridge } from "../runtime/bootstrap";
import {
  createBridgeHandler,
  resolveDesktopRuntimeIdentity,
  type BridgeHandlerDeps,
} from "../runtime/handlers";
import {
  createRuntimeManifestFromFiles,
  runtimeManifestId,
  writeRuntimeManifestFile,
  type TargetTriple,
} from "../runtime/manifest";
import {
  EXIT_OPERATION_FAILURE,
  EXIT_SUCCESS,
  type Operation,
} from "../runtime/protocol";
import { isSingleJsonObjectLine } from "../runtime/codec";

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const HANDLER_SOURCE = readFileSync(join(import.meta.dir, "..", "runtime", "handlers.ts"), "utf8");
const BOOTSTRAP_SOURCE = readFileSync(join(import.meta.dir, "..", "runtime", "bootstrap.ts"), "utf8");

const identity: DesktopRuntimeIdentity = {
  installId: "install-1",
  runtimeManifestId: "ocx-runtime-2.35.0-x64",
  runtimeVersion: "2.35.0",
  bunPath: "/opt/opencodex/versions/2.35.0/bun",
  cliPath: "/opt/opencodex/versions/2.35.0/src/cli/index.ts",
  stableRuntimeRoot: "/opt/opencodex/versions/2.35.0",
};

const SERVICE_ABSENT = {
  supported: true,
  installed: false,
  enabled: false,
  running: false,
  viable: false,
  startable: false,
  stale: false,
  conflict: false,
  backend: null,
  summary: "not installed",
} as const;

const SERVICE_STARTABLE = {
  ...SERVICE_ABSENT,
  installed: true,
  startable: true,
  enabled: true,
  summary: "installed and startable",
} as const;

const SERVICE_NOT_STARTABLE = {
  ...SERVICE_ABSENT,
  installed: true,
  startable: false,
  stale: true,
  summary: "installed, not startable",
} as const;

const SERVICE_CONFLICT = {
  ...SERVICE_ABSENT,
  installed: true,
  startable: false,
  conflict: true,
  summary: "conflict",
} as const;

const LIVE = {
  pid: 4242,
  port: 10100,
  hostname: "127.0.0.1",
  source: "runtime" as const,
  version: "2.35.0",
};

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-desktop-handlers-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  home = "";
});

function request(operation: Operation, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    requestId: ULID,
    operation,
    payload,
  };
}

async function invoke(
  operation: Operation,
  deps: BridgeHandlerDeps,
  payload: Record<string, unknown> = {},
): Promise<{ code: number; text: string; json: Record<string, unknown> }> {
  const writes: Uint8Array[] = [];
  const code = await runBridge({
    stdin: `${JSON.stringify(request(operation, payload))}\n`,
    handler: createBridgeHandler(deps),
    writeStdout: bytes => writes.push(bytes),
  });
  const text = new TextDecoder().decode(writes[0] ?? new Uint8Array());
  return { code, text, json: JSON.parse(text) as Record<string, unknown> };
}

function baseDeps(overrides: BridgeHandlerDeps = {}): BridgeHandlerDeps {
  return {
    diagnoseService: () => SERVICE_ABSENT,
    inspectServiceInstall: () => ({ conflict: false }),
    getBindHostname: () => "127.0.0.1",
    getPreferredPort: () => 10100,
    cwd: home,
    hasForbiddenEnvFile: () => false,
    identity: null,
    sleep: async () => {},
    readCommandLine: () => `${identity.bunPath} ${identity.cliPath} start`,
    isAlive: () => true,
    ...overrides,
  };
}

function hostTarget(): TargetTriple {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  if (process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  return "x86_64-unknown-linux-gnu";
}

function writeVerifiedRuntimeTree(): { root: string; bunPath: string; cliPath: string } {
  const target = hostTarget();
  const root = join(home, "runtime", "versions", identity.runtimeVersion);
  const bunName = `ocx-runtime-${target}${target.includes("windows") ? ".exe" : ""}`;
  const bunPath = join(root, bunName);
  const cliPath = join(root, "src", "cli", "index.ts");
  mkdirSync(join(root, "src", "cli"), { recursive: true });
  writeFileSync(bunPath, "runtime\n");
  writeFileSync(cliPath, "export {};\n");
  if (process.platform !== "win32") chmodSync(bunPath, 0o755);
  const created = createRuntimeManifestFromFiles({
    id: runtimeManifestId(identity.runtimeVersion, target),
    version: identity.runtimeVersion,
    target,
    root,
    files: [
      { path: bunName, executable: process.platform !== "win32" },
      { path: "src/cli/index.ts", executable: false },
    ],
  });
  if (!created.ok) throw new Error(created.message);
  const written = writeRuntimeManifestFile(root, created.manifest);
  if (!written.ok) throw new Error(written.message);
  return { root, bunPath, cliPath };
}

describe("production bridge handler contract", () => {
  test("derives identity only from a hash-verified stable runtime generation", () => {
    const tree = writeVerifiedRuntimeTree();
    const resolved = resolveDesktopRuntimeIdentity(tree.root);
    expect(resolved).toMatchObject({
      runtimeVersion: identity.runtimeVersion,
      bunPath: tree.bunPath,
      cliPath: tree.cliPath,
      stableRuntimeRoot: tree.root,
    });
    expect(resolved?.installId).toMatch(/^[a-f0-9]{32}$/);
    writeFileSync(tree.cliPath, "tampered\n");
    expect(resolveDesktopRuntimeIdentity(tree.root)).toBeNull();
  });

  test("does not import CLI dispatch, hold the start lock, or write owner records", () => {
    expect(HANDLER_SOURCE).not.toMatch(/from\s+["'][^"']*cli\/index(?:\.ts)?["']/);
    expect(HANDLER_SOURCE).not.toContain("withStartLock");
    expect(HANDLER_SOURCE).not.toContain("acquireStartLock");
    expect(HANDLER_SOURCE).not.toContain("publishDesktopDirect");
    expect(HANDLER_SOURCE).not.toContain("writeRuntimePortOwnerId");
    expect(HANDLER_SOURCE).toContain("findLiveProxy");
    expect(HANDLER_SOURCE).toContain("probeReadiness");
    expect(HANDLER_SOURCE).toContain("runStopTransaction");
    expect(HANDLER_SOURCE).toContain("selfLaunchArgv");
    expect(HANDLER_SOURCE).toContain("program: input.identity.bunPath");
    expect(HANDLER_SOURCE).toContain("cliChildStartArgv(input.port, input.identity.cliPath)");
    expect(BOOTSTRAP_SOURCE).toContain("createBridgeHandler");
    expect(BOOTSTRAP_SOURCE).not.toContain("withStartLock");
    expect(HANDLER_SOURCE).toContain("redactSecretString(printable)");
    expect(HANDLER_SOURCE).toContain("Bearer\\s+\\[REDACTED\\]");
  });

  test("attaches to an existing-external live proxy and does not start", async () => {
    let starts = 0;
    const result = await invoke("bootstrap", baseDeps({
      findLiveProxy: async () => LIVE,
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
      startDirect: async () => { starts += 1; },
      startService: async () => { starts += 1; },
    }));
    expect(result.code).toBe(EXIT_SUCCESS);
    expect(result.json.ok).toBe(true);
    const body = result.json.result as Record<string, unknown>;
    expect(body.owner).toBe("existing-external");
    expect(body.status).toBe("ready");
    expect(body.origin).toBe("http://127.0.0.1:10100");
    expect(body.pid).toBe(LIVE.pid);
    expect(body.allowedMutations).toEqual(["stop"]);
    expect(starts).toBe(0);
    expect(existsSync(getDesktopDirectOwnerPath())).toBe(false);
    expect(isSingleJsonObjectLine(result.text)).toBe(true);
  });

  test("status reports conflict as a success envelope with no mutations", async () => {
    publishDesktopDirectOwnerRecord({
      schemaVersion: 1,
      ownerId: "0123456789abcdef0123456789abcdef",
      installId: identity.installId,
      runtimeManifestId: identity.runtimeManifestId,
      runtimeVersion: identity.runtimeVersion,
      bunPath: identity.bunPath,
      cliPath: identity.cliPath,
      pid: LIVE.pid,
      nonceDigest: digestLaunchNonce("ab".repeat(32)),
      createdAt: Date.now() - 60_000,
    });
    writeRuntimePort({ pid: LIVE.pid, port: LIVE.port, hostname: LIVE.hostname });
    const status = await invoke("status", baseDeps({
      identity,
      findLiveProxy: async () => LIVE,
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
    }));
    expect(status.code).toBe(EXIT_SUCCESS);
    expect(status.json.ok).toBe(true);
    const body = status.json.result as Record<string, unknown>;
    expect(body.owner).toBe("unknown/conflict");
    expect(body.allowedMutations).toEqual([]);
    expect(JSON.stringify(status.json)).not.toContain(identity.bunPath);
    expect(JSON.stringify(status.json)).not.toContain("secret");
  });

  test("bootstrap and stop deny conflict without mutating", async () => {
    publishDesktopDirectOwnerRecord({
      schemaVersion: 1,
      ownerId: "0123456789abcdef0123456789abcdef",
      installId: identity.installId,
      runtimeManifestId: identity.runtimeManifestId,
      runtimeVersion: identity.runtimeVersion,
      bunPath: identity.bunPath,
      cliPath: identity.cliPath,
      pid: LIVE.pid,
      nonceDigest: digestLaunchNonce("ab".repeat(32)),
      createdAt: Date.now() - 60_000,
    });
    writeRuntimePort({ pid: LIVE.pid, port: LIVE.port, hostname: LIVE.hostname });
    let starts = 0;
    let stops = 0;
    const deps = baseDeps({
      identity,
      findLiveProxy: async () => LIVE,
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
      startDirect: async () => { starts += 1; },
      runStopTransaction: async () => {
        stops += 1;
        return {
          ok: true,
          code: "stopped",
          serviceStopped: false,
          proxyStopped: true,
          proxyAbsent: true,
          restoreStatus: "not-needed",
          grokStatus: "not-needed",
          events: [],
        };
      },
    });
    const bootstrap = await invoke("bootstrap", deps);
    const stop = await invoke("stop", deps, { reason: "app-exit" });
    expect(bootstrap.code).toBe(EXIT_OPERATION_FAILURE);
    expect((bootstrap.json.error as { code: string }).code).toBe("ownership_conflict");
    expect(stop.code).toBe(EXIT_OPERATION_FAILURE);
    expect((stop.json.error as { code: string }).code).toBe("ownership_conflict");
    expect(starts).toBe(0);
    expect(stops).toBe(0);
    expect("result" in bootstrap.json).toBe(false);
  });

  test("stop of existing-external runs the structured transaction", async () => {
    const stop = await invoke("stop", baseDeps({
      findLiveProxy: async () => LIVE,
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
      runStopTransaction: async () => ({
        ok: true,
        code: "stopped",
        serviceStopped: false,
        proxyStopped: true,
        proxyAbsent: true,
        restoreStatus: "restored",
        grokStatus: "not-needed",
        events: [{ type: "proxy_stopped", pid: LIVE.pid }],
      }),
    }), { reason: "app-exit" });
    expect(stop.code).toBe(EXIT_SUCCESS);
    const body = stop.json.result as Record<string, unknown>;
    expect(body.code).toBe("stopped");
    expect(body.proxyAbsent).toBe(true);
    expect("events" in body).toBe(false);
  });

  test("concurrent bootstrap attaches to the single start winner", async () => {
    const state: { live: typeof LIVE | null; starts: number } = { live: null, starts: 0 };
    const deps = baseDeps({
      identity,
      findLiveProxy: async () => state.live,
      probeReadiness: async () => state.live
        ? { ready: true, status: "ready", pid: state.live.pid, port: state.live.port }
        : null,
      startDirect: async () => {
        state.starts += 1;
        state.live = LIVE;
      },
    });
    const handler = createBridgeHandler(deps);
    const [first, second] = await Promise.all([
      runBridge({
        stdin: `${JSON.stringify(request("bootstrap"))}\n`,
        handler,
        writeStdout: () => {},
      }),
      runBridge({
        stdin: `${JSON.stringify(request("bootstrap"))}\n`,
        handler,
        writeStdout: () => {},
      }),
    ]);
    expect(first).toBe(EXIT_SUCCESS);
    expect(second).toBe(EXIT_SUCCESS);
    expect(state.starts).toBeGreaterThanOrEqual(1);
    expect(state.live).toEqual(LIVE);
  });

  test("installed not-startable service fails closed and does not spawn direct", async () => {
    let starts = 0;
    const result = await invoke("bootstrap", baseDeps({
      diagnoseService: () => SERVICE_NOT_STARTABLE,
      findLiveProxy: async () => null,
      startDirect: async () => { starts += 1; },
      startService: async () => { starts += 1; },
    }));
    expect(result.code).toBe(EXIT_OPERATION_FAILURE);
    expect((result.json.error as { code: string }).code).toBe("service_not_startable");
    expect(starts).toBe(0);
  });

  test("startable service waits on service start rather than a direct child", async () => {
    let direct = 0;
    let service = 0;
    let live: typeof LIVE | null = null;
    const result = await invoke("bootstrap", baseDeps({
      identity,
      diagnoseService: () => SERVICE_STARTABLE,
      findLiveProxy: async () => live,
      probeReadiness: async () => live
        ? { ready: true, status: "ready", pid: live.pid, port: live.port }
        : null,
      startDirect: async () => { direct += 1; },
      startService: async () => {
        service += 1;
        live = LIVE;
      },
    }));
    expect(result.code).toBe(EXIT_SUCCESS);
    expect(direct).toBe(0);
    expect(service).toBe(1);
    expect((result.json.result as { owner: string }).owner).toBe("existing-external");
  });

  test("cold start without a verified runtime identity fails closed", async () => {
    let starts = 0;
    const result = await invoke("bootstrap", baseDeps({
      identity: null,
      findLiveProxy: async () => null,
      startDirect: async () => { starts += 1; },
      startService: async () => { starts += 1; },
    }));
    expect(result.code).toBe(EXIT_OPERATION_FAILURE);
    expect((result.json.error as { code: string }).code).toBe("runtime_integrity_failed");
    expect(starts).toBe(0);
  });

  test("service conflict and wildcard binds fail closed", async () => {
    const conflict = await invoke("bootstrap", baseDeps({
      diagnoseService: () => SERVICE_CONFLICT,
      findLiveProxy: async () => null,
      startDirect: async () => { throw new Error("must not start"); },
    }));
    expect((conflict.json.error as { code: string }).code).toBe("ownership_conflict");

    const wildcard = await invoke("bootstrap", baseDeps({
      getBindHostname: () => "0.0.0.0",
      findLiveProxy: async () => ({ ...LIVE, hostname: "0.0.0.0" }),
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
      startDirect: async () => { throw new Error("must not start"); },
    }));
    expect((wildcard.json.error as { code: string }).code).toBe("proxy_not_ready");
    expect(JSON.stringify(wildcard.json)).not.toContain("0.0.0.0");
  });

  test("partial owner records keep bootstrap from claiming a winner", async () => {
    publishDesktopDirectOwnerRecord({
      schemaVersion: 1,
      ownerId: "0123456789abcdef0123456789abcdef",
      installId: identity.installId,
      runtimeManifestId: identity.runtimeManifestId,
      runtimeVersion: identity.runtimeVersion,
      bunPath: "/home/secret-user/.opencodex/bun",
      cliPath: identity.cliPath,
      pid: LIVE.pid,
      nonceDigest: digestLaunchNonce("ab".repeat(32)),
      createdAt: Date.now() - 60_000,
    });
    writeRuntimePort({ pid: LIVE.pid, port: LIVE.port, hostname: LIVE.hostname });
    const result = await invoke("bootstrap", baseDeps({
      identity: { ...identity, bunPath: "/home/secret-user/.opencodex/bun" },
      findLiveProxy: async () => LIVE,
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
    }));
    expect(result.code).toBe(EXIT_OPERATION_FAILURE);
    expect((result.json.error as { code: string }).code).toBe("ownership_conflict");
    const json = JSON.stringify(result.json);
    expect(json).not.toContain("secret-user");
    expect(json).not.toContain("/home/");
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("ab".repeat(32));
  });

  test("proven desktop-direct records allow bootstrap without a second start", async () => {
    const ownerId = "0123456789abcdef0123456789abcdef";
    publishDesktopDirectOwnerRecord({
      schemaVersion: 1,
      ownerId,
      installId: identity.installId,
      runtimeManifestId: identity.runtimeManifestId,
      runtimeVersion: identity.runtimeVersion,
      bunPath: identity.bunPath,
      cliPath: identity.cliPath,
      pid: LIVE.pid,
      nonceDigest: digestLaunchNonce("ab".repeat(32)),
      createdAt: Date.now() - 60_000,
    });
    writeRuntimePort({ pid: LIVE.pid, port: LIVE.port, hostname: LIVE.hostname });
    writeRuntimePortOwnerId(ownerId, LIVE.pid);
    let starts = 0;
    const result = await invoke("bootstrap", baseDeps({
      identity,
      findLiveProxy: async () => LIVE,
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
      startDirect: async () => { starts += 1; },
    }));
    expect(result.code).toBe(EXIT_SUCCESS);
    expect((result.json.result as { owner: string }).owner).toBe("desktop-direct");
    expect(starts).toBe(0);
    expect(JSON.stringify(result.json)).not.toContain(identity.bunPath);
  });

  test("service mutations stay unsupported and envelopes leak no secrets", async () => {
    const result = await invoke("service-start", baseDeps({
      findLiveProxy: async () => LIVE,
      probeReadiness: async () => ({ ready: true, status: "ready", pid: LIVE.pid, port: LIVE.port }),
    }));
    expect(result.code).toBe(EXIT_OPERATION_FAILURE);
    expect((result.json.error as { code: string }).code).toBe("unsupported_operation");
    expect(result.text).not.toContain("Authorization");
    expect(result.text).not.toContain(home);
  });
});
