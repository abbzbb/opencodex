import { isAbsolute, resolve } from "node:path";
import { observeActivationLock } from "./activation-lock";
import { observeActivationJournal } from "./activation-journal";
import { decodeStdin, MAX_REQUEST_BYTES } from "./codec";
import {
  isInsideRoot,
  isPlainObject,
  isTargetTriple,
  type RuntimeStoreResult,
  type TargetTriple,
} from "./manifest";
import {
  syncPackagedRuntime,
  type SyncPackagedRuntimeInput,
  type SyncPackagedRuntimeSuccess,
  type VersionPointer,
} from "./staging";

export const INSTALL_SCHEMA_VERSION = 1 as const;
export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME_FAILURE = 1;
export const EXIT_PROTOCOL_FAILURE = 2;
export const MAX_STABLE_ROOT_BYTES = 4096;

export type InstallRequest = {
  schemaVersion: 1;
  target: TargetTriple;
  stableRoot: string;
};

export type InstallResult = {
  current: VersionPointer;
  previous: VersionPointer | null;
  staged: VersionPointer;
  reused: boolean;
  published: boolean;
};

export type InstallEnvelope =
  | { schemaVersion: 1; ok: true; result: InstallResult }
  | {
      schemaVersion: 1;
      ok: false;
      error: {
        code: "protocol_mismatch" | "runtime_integrity_failed";
        message: string;
        retryable: boolean;
      };
    };

type ParseInstallResult =
  | { ok: true; request: InstallRequest }
  | { ok: false };

export type RunInstallOptions = {
  cwd?: string;
  stdin?: Uint8Array | string;
  readStdin?: () => Promise<Uint8Array> | Uint8Array;
  writeStdout?: (bytes: Uint8Array) => void;
  syncRuntime?: (
    input: SyncPackagedRuntimeInput,
  ) => RuntimeStoreResult<SyncPackagedRuntimeSuccess>;
};

const REQUEST_KEYS = ["schemaVersion", "target", "stableRoot"] as const;
const encoder = new TextEncoder();
const rawStdoutWrite = process.stdout.write.bind(process.stdout);

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === REQUEST_KEYS.length
    && REQUEST_KEYS.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => (REQUEST_KEYS as readonly string[]).includes(key));
}

function validStableRoot(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_STABLE_ROOT_BYTES
    && isAbsolute(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseInstallRequest(value: unknown): ParseInstallResult {
  if (!isPlainObject(value) || !hasExactKeys(value)) {
    return { ok: false };
  }
  if (!Object.is(value.schemaVersion, INSTALL_SCHEMA_VERSION)) {
    return { ok: false };
  }
  if (!isTargetTriple(value.target) || !validStableRoot(value.stableRoot)) {
    return { ok: false };
  }
  return {
    ok: true,
    request: {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      target: value.target,
      stableRoot: value.stableRoot,
    },
  };
}

function protocolFailure(): InstallEnvelope {
  return {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    ok: false,
    error: {
      code: "protocol_mismatch",
      message: "runtime install request is invalid",
      retryable: false,
    },
  };
}

function runtimeFailure(retryable: boolean): InstallEnvelope {
  return {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    ok: false,
    error: {
      code: "runtime_integrity_failed",
      message: "packaged runtime installation failed",
      retryable,
    },
  };
}

function successEnvelope(result: SyncPackagedRuntimeSuccess): InstallEnvelope {
  return {
    schemaVersion: INSTALL_SCHEMA_VERSION,
    ok: true,
    result: {
      current: result.pointer.current,
      previous: result.pointer.previous,
      staged: result.staged,
      reused: result.reused,
      published: result.published,
    },
  };
}

function encodeEnvelope(envelope: InstallEnvelope): Uint8Array {
  return encoder.encode(`${JSON.stringify(envelope)}\n`);
}

async function readStdinBytes(options: RunInstallOptions): Promise<Uint8Array> {
  if (options.readStdin) {
    return await options.readStdin();
  }
  if (typeof options.stdin === "string") {
    return encoder.encode(options.stdin);
  }
  if (options.stdin instanceof Uint8Array) {
    return options.stdin;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      return new Uint8Array(MAX_REQUEST_BYTES + 1);
    }
    chunks.push(bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function emit(envelope: InstallEnvelope, options: RunInstallOptions): number {
  const bytes = encodeEnvelope(envelope);
  if (options.writeStdout) {
    options.writeStdout(bytes);
  } else {
    rawStdoutWrite(bytes);
  }
  if (envelope.ok) return EXIT_SUCCESS;
  return envelope.error.code === "protocol_mismatch" ? EXIT_PROTOCOL_FAILURE : EXIT_RUNTIME_FAILURE;
}

export async function runInstall(options: RunInstallOptions = {}): Promise<number> {
  let bytes: Uint8Array;
  try {
    bytes = await readStdinBytes(options);
  } catch {
    return emit(protocolFailure(), options);
  }
  const decoded = decodeStdin(bytes);
  if (!decoded.ok) {
    return emit(protocolFailure(), options);
  }
  const parsed = parseInstallRequest(decoded.value);
  if (!parsed.ok) {
    return emit(protocolFailure(), options);
  }

  const sourceRoot = resolve(options.cwd ?? process.cwd());
  const stableRoot = resolve(parsed.request.stableRoot);
  if (isInsideRoot(sourceRoot, stableRoot) || isInsideRoot(stableRoot, sourceRoot)) {
    return emit(runtimeFailure(false), options);
  }

  const journal = observeActivationJournal(stableRoot);
  if (journal.state !== "absent") {
    return emit(runtimeFailure(false), options);
  }
  const lock = observeActivationLock(stableRoot);
  if (lock.state === "live" || lock.state === "incomplete") {
    return emit(runtimeFailure(lock.state === "live"), options);
  }

  let synced: RuntimeStoreResult<SyncPackagedRuntimeSuccess>;
  try {
    synced = (options.syncRuntime ?? syncPackagedRuntime)({
      sourceRoot,
      stableRoot,
      expectedTarget: parsed.request.target,
    });
  } catch {
    return emit(runtimeFailure(false), options);
  }
  if (!synced.ok) {
    return emit(runtimeFailure(synced.code === "lock_held"), options);
  }
  return emit(successEnvelope(synced), options);
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  runInstall()
    .then((code) => process.exit(code))
    .catch(() => process.exit(EXIT_PROTOCOL_FAILURE));
}
