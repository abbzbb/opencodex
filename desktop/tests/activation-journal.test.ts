import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVATION_JOURNAL_ENVELOPE_TAG,
  ACTIVATION_JOURNAL_NAME,
  decodeActivationJournal,
  encodeActivationJournal,
  intendedPublishedPointer,
  observeActivationJournal,
  removeActivationJournal,
  replaceActivationJournal,
  writeActivationJournal,
  type ActivationJournalRecord,
} from "../runtime/activation-journal";
import type { CurrentPointer, VersionPointer } from "../runtime/staging";

const POSIX = process.platform !== "win32";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function versionPointer(version: string): VersionPointer {
  return {
    id: `ocx-runtime-${version}`,
    version,
    target: "x86_64-unknown-linux-gnu",
    relPath: `versions/${version}`,
  };
}

function currentPointer(current: VersionPointer, previous: VersionPointer | null = null): CurrentPointer {
  return { schemaVersion: 1, current, previous };
}

function sampleRecord(stableRoot: string, overrides: Partial<ActivationJournalRecord> = {}): ActivationJournalRecord {
  const current = versionPointer("2.35.0");
  const candidate = versionPointer("2.36.0");
  const snapshotPointer = currentPointer(current);
  return {
    schemaVersion: 1,
    transactionId: "tx-1",
    token: "lock-token-1",
    intent: "activate",
    kind: "repair",
    mode: "service",
    stableRoot,
    expectedTarget: "x86_64-unknown-linux-gnu",
    snapshot: {
      pointer: snapshotPointer,
      owner: "desktop-service",
      hadLiveProxy: true,
      serviceInstalled: true,
      backend: "scheduler",
      bunPath: join(stableRoot, "versions", "2.35.0", "bun"),
      cliPath: join(stableRoot, "versions", "2.35.0", "cli.ts"),
      previousPid: 9001,
      previousBunPath: join(stableRoot, "versions", "2.35.0", "bun"),
      previousCliPath: join(stableRoot, "versions", "2.35.0", "cli.ts"),
    },
    candidate,
    publishedPointer: intendedPublishedPointer(snapshotPointer, candidate),
    touchedService: true,
    candidatePid: null,
    ...overrides,
  };
}

describe("activation journal", () => {
  test("writes a checksummed exact-key envelope and observes it", () => {
    const stableRoot = tempDir("ocx-journal-write-");
    const record = sampleRecord(stableRoot);
    const written = writeActivationJournal(stableRoot, record);
    expect(written.ok).toBe(true);
    const observed = observeActivationJournal(stableRoot);
    expect(observed.state).toBe("valid");
    if (observed.state !== "valid") return;
    expect(observed.record.transactionId).toBe("tx-1");
    expect(observed.record.intent).toBe("activate");
    expect(observed.record.publishedPointer?.current.version).toBe("2.36.0");
    expect(observed.record.publishedPointer?.previous?.version).toBe("2.35.0");
    const raw = readFileSync(join(stableRoot, ACTIVATION_JOURNAL_NAME), "utf8");
    expect(raw.startsWith(`${ACTIVATION_JOURNAL_ENVELOPE_TAG} `)).toBe(true);
    expect(decodeActivationJournal(raw).ok).toBe(true);
    if (POSIX) {
      expect(lstatSync(join(stableRoot, ACTIVATION_JOURNAL_NAME)).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects extra keys, checksum mismatch, and truncated envelopes", () => {
    const stableRoot = tempDir("ocx-journal-bad-");
    const record = sampleRecord(stableRoot);
    const encoded = encodeActivationJournal(record);
    const body = encoded.split("\n")[1]!;
    const extra = JSON.parse(body) as Record<string, unknown>;
    extra.secret = "nope";
    const extraBody = JSON.stringify(extra);
    const extraSum = createHash("sha256").update(extraBody).digest("hex");
    expect(decodeActivationJournal(`${ACTIVATION_JOURNAL_ENVELOPE_TAG} ${extraSum}\n${extraBody}\n`).ok).toBe(false);

    const written = writeActivationJournal(stableRoot, record);
    expect(written.ok).toBe(true);
    const path = join(stableRoot, ACTIVATION_JOURNAL_NAME);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace(/tx-1/, "tx-2"));
    expect(observeActivationJournal(stableRoot).state).toBe("unreadable");
    writeFileSync(path, "not-a-journal\n");
    expect(observeActivationJournal(stableRoot).state).toBe("unreadable");
  });

  test("POSIX observe rejects a non-owner-only journal mode", () => {
    if (!POSIX) return;
    const stableRoot = tempDir("ocx-journal-mode-");
    const record = sampleRecord(stableRoot);
    expect(writeActivationJournal(stableRoot, record).ok).toBe(true);
    chmodSync(join(stableRoot, ACTIVATION_JOURNAL_NAME), 0o644);
    expect(observeActivationJournal(stableRoot).state).toBe("unreadable");
  });

  test("directory fsync failure fails the journal write", () => {
    const stableRoot = tempDir("ocx-journal-fsync-");
    const record = sampleRecord(stableRoot);
    const written = writeActivationJournal(stableRoot, record, {
      fsyncDirectory: () => ({ ok: false, code: "io_error", message: "dir fsync failed" }),
    });
    expect(written.ok).toBe(false);
  });

  test("refuses a symlink journal", () => {
    if (!POSIX) return;
    const stableRoot = tempDir("ocx-journal-link-");
    const target = join(stableRoot, "elsewhere");
    writeFileSync(target, "x\n");
    symlinkSync(target, join(stableRoot, ACTIVATION_JOURNAL_NAME));
    expect(observeActivationJournal(stableRoot).state).toBe("unreadable");
    const written = writeActivationJournal(stableRoot, sampleRecord(stableRoot));
    expect(written.ok).toBe(false);
  });

  test("compare-before-replace requires the same transaction id", () => {
    const stableRoot = tempDir("ocx-journal-cas-");
    const record = sampleRecord(stableRoot);
    expect(writeActivationJournal(stableRoot, record).ok).toBe(true);
    const next = { ...record, candidatePid: 4242 };
    const mismatch = replaceActivationJournal(stableRoot, { transactionId: "other" }, next);
    expect(mismatch.ok).toBe(false);
    const replaced = replaceActivationJournal(stableRoot, { transactionId: "tx-1" }, next);
    expect(replaced.ok).toBe(true);
    const observed = observeActivationJournal(stableRoot);
    expect(observed.state === "valid" && observed.record.candidatePid).toBe(4242);
  });

  test("compare-before-delete refuses a mismatched transaction and unreadable journal", () => {
    const stableRoot = tempDir("ocx-journal-del-");
    const record = sampleRecord(stableRoot);
    expect(writeActivationJournal(stableRoot, record).ok).toBe(true);
    const refused = removeActivationJournal(stableRoot, { transactionId: "other" });
    expect(refused.ok).toBe(false);
    expect(existsSync(join(stableRoot, ACTIVATION_JOURNAL_NAME))).toBe(true);
    const removed = removeActivationJournal(stableRoot, { transactionId: "tx-1" });
    expect(removed.ok).toBe(true);
    expect(existsSync(join(stableRoot, ACTIVATION_JOURNAL_NAME))).toBe(false);
    expect(removeActivationJournal(stableRoot, { transactionId: "tx-1" }).ok).toBe(true);
  });

  test("does not create a second journal over an existing one", () => {
    const stableRoot = tempDir("ocx-journal-exists-");
    const record = sampleRecord(stableRoot);
    expect(writeActivationJournal(stableRoot, record).ok).toBe(true);
    expect(writeActivationJournal(stableRoot, { ...record, transactionId: "tx-2", token: "lock-token-2" }).ok).toBe(false);
  });

  test("stableRoot must equal the lock root", () => {
    const stableRoot = tempDir("ocx-journal-root-");
    const other = tempDir("ocx-journal-other-");
    const written = writeActivationJournal(stableRoot, sampleRecord(other));
    expect(written.ok).toBe(false);
  });
});
