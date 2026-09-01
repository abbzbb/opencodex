import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../src/config";
import { durableBunRuntime } from "../src/lib/bun-runtime";
import { buildWinswXml } from "../src/lib/winsw";
import {
  buildUnit,
  installManagedServiceWithRuntime,
  repairService,
  serviceRuntimeWinswEntry,
  validateServiceRuntimeIdentity,
  writeServiceInstallStateForRuntime,
} from "../src/service";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-service-runtime-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  home = "";
});

function writeRegular(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "runtime\n");
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

describe("service runtime identity seam", () => {
  test("rejects relative paths, missing files, and symlinks", () => {
    const bun = join(home, "bun");
    const cli = join(home, "cli.ts");
    writeRegular(bun);
    writeRegular(cli);
    expect(() => validateServiceRuntimeIdentity({ bunPath: "bun", cliPath: cli })).toThrow(/absolute regular files/);
    expect(() => validateServiceRuntimeIdentity({ bunPath: bun, cliPath: join(home, "missing.ts") })).toThrow(/absolute regular files/);
    if (process.platform !== "win32") {
      const link = join(home, "bun-link");
      symlinkSync(bun, link);
      expect(() => validateServiceRuntimeIdentity({ bunPath: link, cliPath: cli })).toThrow(/absolute regular files/);
    }
  });

  test("writeServiceInstallStateForRuntime records the verified Bun and CLI paths", () => {
    const bun = join(home, "versions", "2.36.0", "ocx-runtime");
    const cli = join(home, "versions", "2.36.0", "src", "cli", "index.ts");
    writeRegular(bun);
    mkdirSync(join(home, "versions", "2.36.0", "src", "cli"), { recursive: true });
    writeFileSync(cli, "export {};\n");
    writeServiceInstallStateForRuntime({ bunPath: bun, cliPath: cli });
    const raw = readFileSync(join(getConfigDir(), "service-state.json"), "utf8");
    const state = JSON.parse(raw) as {
      bunPath?: string;
      cliPath?: string;
    };
    expect(raw).toContain("bunPath");
    expect(state.bunPath).toBe(bun);
    expect(state.cliPath).toBe(cli);
  });

  test("concurrent explicit runtime bindings do not cross candidate paths", async () => {
    const bunA = join(home, "a", "bun");
    const bunB = join(home, "b", "bun");
    const cliA = join(home, "a", "cli.ts");
    const cliB = join(home, "b", "cli.ts");
    writeRegular(bunA);
    writeRegular(bunB);
    writeRegular(cliA);
    writeRegular(cliB);
    const [unitA, unitB] = await Promise.all([
      Promise.resolve(buildUnit(undefined, { bunPath: bunA, cliPath: cliA })),
      Promise.resolve(buildUnit(undefined, { bunPath: bunB, cliPath: cliB })),
    ]);
    expect(unitA).toContain(bunA);
    expect(unitA).toContain(cliA);
    expect(unitB).toContain(bunB);
    expect(unitB).toContain(cliB);
    expect(unitA).not.toContain(bunB);
    expect(unitB).not.toContain(bunA);
    expect(unitA).toContain('OCX_BUN_RUNTIME_SOURCE=process');
  });

  test("installManagedServiceWithRuntime always prepares through the safe installer", async () => {
    const bun = join(home, "bun");
    const cli = join(home, "cli.ts");
    writeRegular(bun);
    writeRegular(cli);
    let prepared = 0;
    const seen: string[] = [];
    await installManagedServiceWithRuntime({ bunPath: bun, cliPath: cli }, {
      platform: "linux",
      diagnose: () => ({
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
      }),
      managerOps: () => ({
        status: () => "stopped",
        stop: () => { prepared += 1; },
      }),
      stopTrackedProxy: async () => { prepared += 1; },
      install: async runtime => { seen.push(runtime.bunPath); },
    });
    expect(prepared).toBeGreaterThan(0);
    expect(seen).toEqual([bun]);
    const source = readFileSync(join(import.meta.dir, "../src/service.ts"), "utf8");
    expect(source).toContain("await installServiceSafely(backend");
    expect(source).not.toContain("serviceRuntimeOverride");
    expect(source).not.toContain("withServiceRuntimeIdentity");
  });

  test("installManagedServiceWithRuntime refuses native backend off Windows before prepare", async () => {
    const bun = join(home, "bun");
    const cli = join(home, "cli.ts");
    writeRegular(bun);
    writeRegular(cli);
    let prepared = 0;
    await expect(installManagedServiceWithRuntime({ bunPath: bun, cliPath: cli }, {
      platform: "linux",
      backend: "native",
      diagnose: () => ({
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
      }),
      managerOps: () => ({
        status: () => "stopped",
        stop: () => { prepared += 1; },
      }),
      stopTrackedProxy: async () => { prepared += 1; },
      install: async () => { prepared += 1; },
    })).rejects.toThrow(/native Windows service backend is unavailable/);
    expect(prepared).toBe(0);
  });

  test("WinSW native install/repair XML uses the candidate bun and cli, not current/npm paths", async () => {
    const bun = join(home, "versions", "2.36.0", "ocx-runtime");
    const cli = join(home, "versions", "2.36.0", "src", "cli", "index.ts");
    writeRegular(bun);
    mkdirSync(join(home, "versions", "2.36.0", "src", "cli"), { recursive: true });
    writeFileSync(cli, "export {};\n");
    const currentCli = join(import.meta.dir, "../src/cli/index.ts");
    const currentBun = durableBunRuntime().path;
    const entry = serviceRuntimeWinswEntry({ bunPath: bun, cliPath: cli });
    expect(entry.bun).toBe(bun);
    expect(entry.cli).toBe(cli);
    expect(entry.bunRuntimeSource).toBe("process");
    const xml = buildWinswXml(entry);
    expect(xml).toContain(`<executable>${bun}</executable>`);
    expect(xml).toContain(`&quot;${cli}&quot; start --port`);
    expect(xml).not.toContain(currentCli);
    expect(xml).not.toBe(buildWinswXml({
      bun: currentBun,
      bunRuntimeSource: durableBunRuntime().source,
      cli: currentCli,
    }));
    if (currentBun !== bun) expect(xml).not.toContain(`<executable>${currentBun}</executable>`);

    let installedEntry = entry;
    await installManagedServiceWithRuntime({ bunPath: bun, cliPath: cli }, {
      platform: "win32",
      backend: "native",
      diagnose: () => ({
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
      }),
      managerOps: () => ({
        status: () => null,
        stop: () => {},
      }),
      stopTrackedProxy: async () => {},
      installWinsw: async seen => {
        installedEntry = seen;
      },
    });
    expect(installedEntry.bun).toBe(bun);
    expect(installedEntry.cli).toBe(cli);
    const installedXml = buildWinswXml(installedEntry);
    expect(installedXml).toContain(`<executable>${bun}</executable>`);
    expect(installedXml).toContain(cli);
    expect(installedXml).not.toContain(currentCli);

    let repairedEntry = entry;
    await repairService({
      platform: "win32",
      runtime: { bunPath: bun, cliPath: cli },
      diagnose: () => ({
        supported: true,
        installed: true,
        enabled: true,
        running: false,
        viable: true,
        startable: true,
        stale: false,
        conflict: false,
        backend: "native",
        summary: "native",
      }),
      assertEnv: () => {},
      assertAuth: () => {},
      installWinsw: async seen => {
        repairedEntry = seen;
      },
      writeNativeState: () => {},
    });
    expect(repairedEntry.bun).toBe(bun);
    expect(repairedEntry.cli).toBe(cli);
    const repairedXml = buildWinswXml(repairedEntry);
    expect(repairedXml).toContain(`<executable>${bun}</executable>`);
    expect(repairedXml).toContain(`&quot;${cli}&quot; start --port`);
    expect(repairedXml).not.toContain(currentCli);

    let nativeStarts = 0;
    await installManagedServiceWithRuntime({ bunPath: bun, cliPath: cli }, {
      platform: "win32",
      backend: "native",
      diagnose: () => ({
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
      }),
      managerOps: () => ({
        status: () => null,
        stop: () => {},
      }),
      stopTrackedProxy: async () => {},
      installWinsw: async () => {
        nativeStarts += 1;
      },
    });
    expect(nativeStarts).toBe(1);
    const handlerSource = readFileSync(join(import.meta.dir, "../desktop/runtime/handlers.ts"), "utf8");
    const installWrapper = handlerSource.slice(
      handlerSource.indexOf("async function productionInstallService"),
      handlerSource.indexOf("async function productionRepairService"),
    );
    expect(installWrapper).toContain("return { managerStarted: true }");
    expect(installWrapper).toContain("installManagedServiceWithRuntime");

    const source = readFileSync(join(import.meta.dir, "../src/service.ts"), "utf8");
    const managed = source.slice(
      source.indexOf("export async function installManagedServiceWithRuntime"),
      source.indexOf("export function assertWindowsNativeServiceAccountSupported"),
    );
    expect(managed).toContain("serviceRuntimeWinswEntry");
    expect(managed).not.toContain("defaultWinswEntry");
    const repair = source.slice(
      source.indexOf("export async function repairService"),
      source.indexOf("export async function installManagedServiceWithRuntime"),
    );
    expect(repair).toContain("if (runtime)");
    expect(repair).toContain("serviceRuntimeWinswEntry(runtime)");
    expect(repair.indexOf("if (runtime)")).toBeLessThan(repair.indexOf("serviceRuntimeWinswEntry(runtime)"));
    expect(repair.indexOf("serviceRuntimeWinswEntry(runtime)")).toBeLessThan(repair.indexOf("defaultWinswEntry(import.meta.dir)"));
  });

  test("fresh Windows scheduler install threads candidate assets through the safe path", async () => {
    const bun = join(home, "versions", "2.36.0", "ocx-runtime");
    const cli = join(home, "versions", "2.36.0", "src", "cli", "index.ts");
    writeRegular(bun);
    mkdirSync(join(home, "versions", "2.36.0", "src", "cli"), { recursive: true });
    writeFileSync(cli, "export {};\n");
    const calls: string[] = [];
    await installManagedServiceWithRuntime({ bunPath: bun, cliPath: cli }, {
      platform: "win32",
      backend: "scheduler",
      probeWindowsScheduler: () => ({ status: "absent" }),
      installFreshWindowsScheduler: async deps => {
        calls.push("fresh");
        deps.publishAssets?.();
        deps.writeState?.();
      },
      diagnose: () => ({
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
      }),
    });
    expect(calls).toEqual(["fresh"]);
    const state = JSON.parse(readFileSync(join(getConfigDir(), "service-state.json"), "utf8")) as {
      bunPath?: string;
      cliPath?: string;
    };
    expect(state.bunPath).toBe(bun);
    expect(state.cliPath).toBe(cli);
    const script = readFileSync(join(getConfigDir(), "opencodex-service.cmd"), "utf8");
    expect(script).toContain(bun);
    expect(script).toContain(cli);
    const source = readFileSync(join(import.meta.dir, "../src/service.ts"), "utf8");
    const managed = source.slice(
      source.indexOf("export async function installManagedServiceWithRuntime"),
      source.indexOf("export function assertWindowsNativeServiceAccountSupported"),
    );
    expect(managed).toContain("installFreshWindowsSchedulerSafely");
    expect(managed).toContain('scheduler.status === "absent"');
    expect(managed.indexOf('scheduler.status === "absent"')).toBeLessThan(managed.indexOf("installWindows(validated)"));
  });
});
