import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isProcessAlive,
  linuxProcStatReadErrorMeansAlive,
  linuxProcStatState,
  linuxProcStateMeansAlive,
  waitForExit,
} from "../src/lib/process-control";

const linuxTest = process.platform === "linux" ? test : test.skip;
const holders: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  while (holders.length > 0) {
    const holder = holders.pop();
    if (!holder) continue;
    try { holder.stdin.end(); } catch { /* holder gone */ }
    try { holder.kill("SIGKILL"); } catch { /* holder gone */ }
  }
});

describe("process control helpers", () => {
  test("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("reports a clearly invalid pid as exited", () => {
    const invalidPid = 999_999_999;

    expect(isProcessAlive(invalidPid)).toBe(false);
    expect(waitForExit(invalidPid, 1)).toBe(true);
  });

  test("parses Linux /proc/stat state after the final closing parenthesis", () => {
    expect(linuxProcStatState("1234 (bash) S 1 1234 1234 0 0")).toBe("S");
    expect(linuxProcStatState("1234 (bash) R 1 1234 1234 0 0")).toBe("R");
    expect(linuxProcStatState("1234 (bash) Z 1 1234 1234 0 0")).toBe("Z");
    expect(linuxProcStatState("1234 (bash) X 1 1234 1234 0 0")).toBe("X");
    expect(linuxProcStatState("42 (foo) bar) Z 1 42 42 0 0")).toBe("Z");
    expect(linuxProcStatState("42 (a)b)c) S 1 42 42 0 0")).toBe("S");
    expect(linuxProcStatState("1 (emacs (lisp)) D 0 1 1 0 0")).toBe("D");
    expect(linuxProcStatState("")).toBeNull();
    expect(linuxProcStatState("1234 bash S 1")).toBeNull();
    expect(linuxProcStatState("1234 (bash)")).toBeNull();
    expect(linuxProcStatState("1234 (bash) ")).toBeNull();
    expect(linuxProcStatState("1234 (bash) 9 1")).toBeNull();
  });

  test("treats zombie and dead Linux states as not alive", () => {
    expect(linuxProcStateMeansAlive("S")).toBe(true);
    expect(linuxProcStateMeansAlive("R")).toBe(true);
    expect(linuxProcStateMeansAlive("D")).toBe(true);
    expect(linuxProcStateMeansAlive("T")).toBe(true);
    expect(linuxProcStateMeansAlive("I")).toBe(true);
    expect(linuxProcStateMeansAlive("Z")).toBe(false);
    expect(linuxProcStateMeansAlive("X")).toBe(false);
    expect(linuxProcStateMeansAlive("x")).toBe(false);
  });

  test("Linux stat read failures are absent-closed and otherwise conservative", () => {
    expect(linuxProcStatReadErrorMeansAlive({ code: "ENOENT" })).toBe(false);
    expect(linuxProcStatReadErrorMeansAlive({ code: "ESRCH" })).toBe(false);
    expect(linuxProcStatReadErrorMeansAlive({ code: "EACCES" })).toBe(true);
    expect(linuxProcStatReadErrorMeansAlive({ code: "EPERM" })).toBe(true);
    expect(linuxProcStatReadErrorMeansAlive({ code: "EIO" })).toBe(true);
    expect(linuxProcStatReadErrorMeansAlive({})).toBe(true);
    expect(linuxProcStatReadErrorMeansAlive("error")).toBe(true);
  });

  test("waitForExit and stopProxyGracefully inherit isProcessAlive", () => {
    const source = readFileSync(join(import.meta.dir, "../src/lib/process-control.ts"), "utf8");
    expect(source).toContain("if (!isProcessAlive(pid)) return true;");
    expect(source).toContain("return !isProcessAlive(pid);");
    expect(source).toContain("const waitExit = io.waitExit ?? waitForExit");
    expect(source).toContain("return waitExit(pid, exitTimeoutMs)");
    expect(source).not.toMatch(/waitExit = io\.waitExit \?\? killProxy/);
  });

  linuxTest("treats a kernel-confirmed zombie as not alive", async () => {
    const holder = spawn("/bin/sh", ["-c", [
      "/bin/sleep 1000 &",
      "pid=$!",
      "kill -s KILL \"$pid\"",
      "echo \"$pid\"",
      "exec cat >/dev/null",
    ].join("\n")], { stdio: ["pipe", "pipe", "ignore"] });
    holders.push(holder);
    const pid = await readFirstPid(holder);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    expect(linuxProcStatState(stat)).toBe("Z");
    expect(isProcessAlive(pid)).toBe(false);
    expect(waitForExit(pid, 1)).toBe(true);
  });
});

function readFirstPid(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const fail = (error: Error) => {
      child.stdout.off("data", onData);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      child.stdout.off("data", onData);
      const pid = Number.parseInt(buf.slice(0, nl).trim(), 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        fail(new Error("zombie harness did not print a pid"));
        return;
      }
      resolve(pid);
    };
    child.stdout.on("data", onData);
    child.once("error", error => fail(error instanceof Error ? error : new Error(String(error))));
    child.once("exit", () => fail(new Error("zombie harness exited before printing a pid")));
  });
}
