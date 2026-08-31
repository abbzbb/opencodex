import { decodeStdin, encodeEnvelope, MAX_REQUEST_BYTES } from "./codec";
import { createBridgeHandler } from "./handlers";
import { sanitizeLogMetadataString } from "../../src/lib/redact";
import {
  cleanupGraceMsFor,
  deadlineExceededError,
  DeadlineExceededError,
  deadlineMsFor,
  isDeadlineExceededError,
  withDeadline,
} from "./deadline";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  EXIT_OPERATION_FAILURE,
  EXIT_PROTOCOL_FAILURE,
  EXIT_SUCCESS,
  parseBridgeRequest,
  projectStopTransactionResult,
  protocolMismatch,
  stopFailureToError,
  validateBridgeError,
  validateEnvelope,
  validateResult,
  type BridgeRequest,
  type HandlerOutcome,
} from "./protocol";

export type BridgeContext = {
  signal: AbortSignal;
  deadlineMs: number;
};

export type BridgeHandler = (
  request: BridgeRequest,
  context: BridgeContext,
) => HandlerOutcome | Promise<HandlerOutcome>;

export type RunBridgeOptions = {
  handler?: BridgeHandler;
  stdin?: Uint8Array | string;
  readStdin?: () => Promise<Uint8Array> | Uint8Array;
  writeStdout?: (bytes: Uint8Array) => void;
  onHandlerOutput?: (output: HandlerOutput) => void;
};

export type HandlerOutput = {
  stdout: string;
  stderr: string;
  truncated: boolean;
};

const MAX_HANDLER_OUTPUT_BYTES = 64 * 1024;
const rawStdoutWrite = process.stdout.write.bind(process.stdout);

type OutputCollector = {
  append(chunk: unknown, encoding?: unknown): void;
  text(): string;
  truncated(): boolean;
};

function createOutputCollector(): OutputCollector {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let wasTruncated = false;
  return {
    append(chunk, encoding) {
      const bytes = typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8")
        : chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(String(chunk), "utf8");
      const remaining = MAX_HANDLER_OUTPUT_BYTES - size;
      if (remaining <= 0) {
        wasTruncated = true;
        return;
      }
      const accepted = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
      chunks.push(accepted);
      size += accepted.byteLength;
      if (accepted.byteLength !== bytes.byteLength) wasTruncated = true;
    },
    text() {
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(joined);
    },
    truncated: () => wasTruncated,
  };
}

function captureWrite(collector: OutputCollector): typeof process.stdout.write {
  return ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    collector.append(chunk, encodingOrCallback);
    const done = typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : typeof callback === "function" ? callback : null;
    if (done) queueMicrotask(() => done());
    return true;
  }) as typeof process.stdout.write;
}

async function invokeHandlerCaptured(
  handler: BridgeHandler,
  request: BridgeRequest,
  context: BridgeContext,
  onOutput?: (output: HandlerOutput) => void,
): Promise<HandlerOutcome> {
  const stdout = createOutputCollector();
  const stderr = createOutputCollector();
  const previousStdoutWrite = process.stdout.write;
  const previousStderrWrite = process.stderr.write;
  const previousConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  const appendConsole = (collector: OutputCollector, values: unknown[]) => {
    collector.append(`${values.map(value => value instanceof Error ? value.message : String(value)).join(" ")}\n`);
  };
  process.stdout.write = captureWrite(stdout);
  process.stderr.write = captureWrite(stderr);
  console.log = (...values: unknown[]) => appendConsole(stdout, values);
  console.info = (...values: unknown[]) => appendConsole(stdout, values);
  console.debug = (...values: unknown[]) => appendConsole(stdout, values);
  console.warn = (...values: unknown[]) => appendConsole(stderr, values);
  console.error = (...values: unknown[]) => appendConsole(stderr, values);
  try {
    return await handler(request, context);
  } finally {
    process.stdout.write = previousStdoutWrite;
    process.stderr.write = previousStderrWrite;
    console.log = previousConsole.log;
    console.info = previousConsole.info;
    console.debug = previousConsole.debug;
    console.warn = previousConsole.warn;
    console.error = previousConsole.error;
    if (onOutput) {
      try {
        onOutput({
          stdout: sanitizeLogMetadataString(stdout.text(), MAX_HANDLER_OUTPUT_BYTES) ?? "",
          stderr: sanitizeLogMetadataString(stderr.text(), MAX_HANDLER_OUTPUT_BYTES) ?? "",
          truncated: stdout.truncated() || stderr.truncated(),
        });
      } catch {
        // Diagnostics are best-effort and cannot affect the bridge result.
      }
    }
  }
}

export function unsupportedBridgeHandler(request: BridgeRequest): HandlerOutcome {
  return {
    ok: false,
    error: {
      code: "unsupported_operation",
      message: `unsupported_operation: ${request.operation} is not wired`,
      retryable: false,
    },
  };
}

export const defaultBridgeHandler = createBridgeHandler();

async function readStdinBytes(options: RunBridgeOptions): Promise<Uint8Array> {
  if (options.readStdin) {
    return await options.readStdin();
  }
  if (typeof options.stdin === "string") {
    return new TextEncoder().encode(options.stdin);
  }
  if (options.stdin instanceof Uint8Array) {
    return options.stdin;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BYTES) return new Uint8Array(MAX_REQUEST_BYTES + 1);
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

function writeStdout(bytes: Uint8Array, options: RunBridgeOptions): void {
  if (options.writeStdout) {
    options.writeStdout(bytes);
    return;
  }
  rawStdoutWrite(bytes);
}

function unexpectedOperationError(operation: BridgeRequest["operation"]) {
  if (operation === "stop") {
    return { code: "stop_failed" as const, message: "stop operation failed", retryable: true };
  }
  if (operation === "bootstrap" || operation === "status") {
    return { code: "proxy_not_ready" as const, message: `${operation} operation failed`, retryable: true };
  }
  return {
    code: "service_not_startable" as const,
    message: `${operation} operation failed`,
    retryable: false,
  };
}

function emit(
  envelope: ReturnType<typeof buildSuccessEnvelope> | ReturnType<typeof buildFailureEnvelope>,
  options: RunBridgeOptions,
): number {
  const validated = validateEnvelope(envelope);
  const out = validated.ok
    ? validated.value
    : buildFailureEnvelope("", "", protocolMismatch("invalid envelope"));
  writeStdout(encodeEnvelope(out), options);
  if (out.ok) {
    return EXIT_SUCCESS;
  }
  return out.error.code === "protocol_mismatch" ? EXIT_PROTOCOL_FAILURE : EXIT_OPERATION_FAILURE;
}

function mapHandlerOutcome(operation: BridgeRequest["operation"], outcome: HandlerOutcome): HandlerOutcome {
  if (!outcome.ok) {
    return outcome;
  }
  if (operation === "stop") {
    const projected = projectStopTransactionResult(outcome.result);
    if (!projected.ok) return { ok: false, error: protocolMismatch(projected.message) };
    if (!projected.value.ok) {
      return { ok: false, error: stopFailureToError(projected.value) };
    }
    return { ok: true, result: projected.value };
  }
  return outcome;
}

export async function runBridge(options: RunBridgeOptions = {}): Promise<number> {
  const handler = options.handler ?? defaultBridgeHandler;
  let bytes: Uint8Array;
  try {
    bytes = await readStdinBytes(options);
  } catch {
    return emit(buildFailureEnvelope("", "", protocolMismatch("failed to read stdin")), options);
  }

  const decoded = decodeStdin(bytes);
  if (!decoded.ok) {
    return emit(buildFailureEnvelope("", "", protocolMismatch(decoded.message)), options);
  }

  const parsed = parseBridgeRequest(decoded.value);
  if (!parsed.ok) {
    return emit(buildFailureEnvelope(parsed.requestId, parsed.operation, parsed.error), options);
  }

  const request = parsed.request;
  const deadlineMs = deadlineMsFor(request.operation);
  let outcome: HandlerOutcome;
  try {
    outcome = await withDeadline(
      deadlineMs,
      async (signal) => invokeHandlerCaptured(
        handler,
        request,
        { signal, deadlineMs },
        options.onHandlerOutput,
      ),
      cleanupGraceMsFor(request.operation),
    );
  } catch (error) {
    if (isDeadlineExceededError(error) || error instanceof DeadlineExceededError) {
      outcome = { ok: false, error: deadlineExceededError(request.operation) };
    } else {
      outcome = {
        ok: false,
        error: unexpectedOperationError(request.operation),
      };
    }
  }

  outcome = mapHandlerOutcome(request.operation, outcome);
  if (outcome.ok) {
    const result = validateResult(request.operation, outcome.result);
    if (!result.ok) {
      return emit(
        buildFailureEnvelope(
          request.requestId,
          request.operation,
          protocolMismatch(result.message),
        ),
        options,
      );
    }
    return emit(buildSuccessEnvelope(request.requestId, request.operation, result.value), options);
  }

  const error = validateBridgeError(outcome.error);
  if (!error.ok) {
    return emit(
      buildFailureEnvelope(
        request.requestId,
        request.operation,
        protocolMismatch(error.message),
      ),
      options,
    );
  }
  return emit(buildFailureEnvelope(request.requestId, request.operation, error.value), options);
}

const meta = import.meta as ImportMeta & { main?: boolean };
if (meta.main === true) {
  runBridge()
    .then((code) => {
      process.exit(code);
    })
    .catch(() => {
      process.exit(EXIT_PROTOCOL_FAILURE);
    });
}
