import type { BridgeEnvelope, BridgeError } from "./protocol";
import { PROTOCOL_SCHEMA_VERSION } from "./protocol";

export const MAX_REQUEST_BYTES = 64 * 1024;
export const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export type DecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}

export function decodeUtf8(bytes: Uint8Array): DecodeResult {
  const payload = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return { ok: true, value: text };
  } catch {
    return { ok: false, message: "invalid UTF-8" };
  }
}

export function decodeStdin(bytes: Uint8Array): DecodeResult {
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    return { ok: false, message: `request exceeds ${MAX_REQUEST_BYTES} bytes` };
  }
  const text = decodeUtf8(bytes);
  if (!text.ok) {
    return text;
  }
  if (typeof text.value !== "string") {
    return { ok: false, message: "invalid UTF-8" };
  }
  if (text.value.trim().length === 0) {
    return { ok: false, message: "expected a JSON object" };
  }
  try {
    const value: unknown = JSON.parse(text.value);
    return { ok: true, value };
  } catch {
    return { ok: false, message: "invalid JSON" };
  }
}

function orderedError(error: BridgeError): BridgeError {
  if (error.code === "deadline_exceeded") {
    return {
      code: "deadline_exceeded",
      message: error.message,
      retryable: error.retryable,
      reconciliation:
        error.reconciliation === null
          ? null
          : {
              outcome: "unknown",
              followUpOperation: "status",
              blindRetry: false,
            },
    };
  }
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

export function canonicalizeEnvelope(envelope: BridgeEnvelope): BridgeEnvelope {
  if (envelope.ok) {
    return {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      requestId: envelope.requestId,
      ok: true,
      operation: envelope.operation,
      result: envelope.result,
    };
  }
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    requestId: envelope.requestId,
    ok: false,
    operation: envelope.operation,
    error: orderedError(envelope.error),
  };
}

export function encodeEnvelope(envelope: BridgeEnvelope): Uint8Array {
  const json = JSON.stringify(canonicalizeEnvelope(envelope));
  return new TextEncoder().encode(`${json}\n`);
}

export function isSingleJsonObjectLine(text: string): boolean {
  if (!text.endsWith("\n")) {
    return false;
  }
  if (text.indexOf("\n") !== text.length - 1) {
    return false;
  }
  if (text.includes("\u001b")) {
    return false;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}
