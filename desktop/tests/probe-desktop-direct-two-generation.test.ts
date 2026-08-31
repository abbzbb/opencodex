import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TWO_GENERATION_SUMMARY_KEYS,
  validateTwoGenerationSummary,
  type TwoGenerationSummary,
} from "../scripts/probe-desktop-direct-two-generation";
import {
  argvMatchesRuntime,
  distinctSuccessorVersions,
  execStartBindsRuntime,
  jsonLooksPathFree,
} from "../scripts/probe-c-support";

function validSummary(): TwoGenerationSummary {
  return {
    schemaVersion: 1,
    target: "x86_64-unknown-linux-gnu",
    oldVersion: "2.36.0",
    newVersion: "2.36.1",
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
    failureFixture: "cooperative-ready-failed",
  };
}

function rustSources(): string[] {
  const root = join(import.meta.dir, "../src-tauri/src");
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.name.endsWith(".rs")) files.push(abs);
    }
  }
  return files;
}

describe("desktop-direct two-generation probe contract", () => {
  test("accepts the exact path-free summary", () => {
    const summary = validateTwoGenerationSummary(validSummary());
    expect(Object.keys(summary)).toEqual([...TWO_GENERATION_SUMMARY_KEYS]);
    expect(jsonLooksPathFree(summary)).toBe(true);
  });

  test("rejects extra keys, seams, and path-bearing payloads", () => {
    expect(() => validateTwoGenerationSummary({ ...validSummary(), extra: true })).toThrow();
    expect(() => validateTwoGenerationSummary({ ...validSummary(), injectedDependencySeams: true })).toThrow();
    expect(() => validateTwoGenerationSummary({ ...validSummary(), sourceOverlay: false })).toThrow();
    expect(() => validateTwoGenerationSummary({ ...validSummary(), failureFixture: "chmod-0644" })).toThrow();
    expect(() => validateTwoGenerationSummary({
      ...validSummary(),
      oldVersion: "OPENCODEX_HOME",
    })).toThrow();
  });

  test("allocates successor versions distinct from any source", () => {
    for (const source of ["2.36.0", "2.36.1", "2.36.0+new", "1.0.0+fail"]) {
      const versions = distinctSuccessorVersions(source);
      expect(versions.newVersion).not.toBe(source);
      expect(versions.failVersion).not.toBe(source);
      expect(versions.newVersion).not.toBe(versions.failVersion);
    }
  });

  test("argv matcher requires exact bun argv0 and cli argv1", () => {
    const bun = "/tmp/runtime/versions/2.36.1/ocx-runtime-x86_64-unknown-linux-gnu";
    const cli = "/tmp/runtime/versions/2.36.1/src/cli/index.ts";
    const shadowBun = "/tmp/runtime/versions/2.36.1-shadow/ocx-runtime-x86_64-unknown-linux-gnu";
    const shadowCli = "/tmp/runtime/versions/2.36.1-shadow/src/cli/index.ts";
    expect(argvMatchesRuntime([bun, cli, "start", "--port", "18231"], bun, cli)).toBe(true);
    expect(argvMatchesRuntime([shadowBun, shadowCli, "start"], bun, cli)).toBe(false);
    expect(argvMatchesRuntime(["/usr/bin/echo", bun, cli], bun, cli)).toBe(false);
    expect(argvMatchesRuntime([bun, "/tmp/runtime/unrelated.ts"], bun, cli)).toBe(false);
    expect(execStartBindsRuntime(
      `{ path=/bin/sh ; argv[]=/bin/sh -lc exec '${bun}' '${cli}' start --port 18241 ; }`,
      bun,
      cli,
    )).toBe(true);
    expect(execStartBindsRuntime(
      `{ path=/bin/sh ; argv[]=/bin/sh -lc exec '${shadowBun}' '${shadowCli}' start --port 18241 ; }`,
      bun,
      cli,
    )).toBe(false);
  });

  test("failed-candidate injection is manifest-valid ready-failed, not chmod", () => {
    const source = readFileSync(join(import.meta.dir, "../scripts/probe-desktop-direct-two-generation.ts"), "utf8");
    expect(source).toContain("writeFailedReadyCli");
    expect(source).toContain("failedReady");
    expect(source).toContain("stubReadyzHit");
    expect(source).not.toMatch(/chmodSync\([^)]*0o644/);
    expect(source).toContain("sourceOverlay");
    expect(source).toContain("failureFixture");
    expect(source).toContain("terminateOwnedProbeChildren");
  });

  test("Rust shell does not publish desktop-direct owner records", () => {
    const sources = rustSources().map(path => readFileSync(path, "utf8")).join("\n");
    expect(sources).not.toContain("desktop-direct-owner.json");
    expect(sources).not.toContain("writeDesktopDirectOwner");
  });
});
