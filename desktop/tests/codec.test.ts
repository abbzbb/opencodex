import { describe, expect, test } from "bun:test";
import { runBridge, unsupportedBridgeHandler, type BridgeHandler } from "../runtime/bootstrap";
import {
  decodeStdin,
  decodeUtf8,
  encodeEnvelope,
  isSingleJsonObjectLine,
  MAX_REQUEST_BYTES,
} from "../runtime/codec";
import {
  EXIT_OPERATION_FAILURE,
  EXIT_PROTOCOL_FAILURE,
  EXIT_SUCCESS,
  buildFailureEnvelope,
  buildSuccessEnvelope,
  protocolMismatch,
  type Operation,
} from "../runtime/protocol";

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ1";

const SERVICE_ABSENT = {
  installed: false,
  startable: false,
  stateCode: "absent",
} as const;

function statusRequest(extra?: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    requestId: ULID,
    operation: "status",
    payload: {},
    ...extra,
  };
}

async function invoke(
  input: unknown | string | Uint8Array,
  handler?: BridgeHandler,
): Promise<{ code: number; text: string; json: Record<string, unknown>; writes: number }> {
  const writes: Uint8Array[] = [];
  const stdin =
    typeof input === "string" || input instanceof Uint8Array ? input : `${JSON.stringify(input)}\n`;
  const code = await runBridge({
    stdin,
    handler,
    writeStdout: (bytes) => {
      writes.push(bytes);
    },
  });
  const text = new TextDecoder().decode(
    writes.reduce((all, chunk) => {
      const next = new Uint8Array(all.byteLength + chunk.byteLength);
      next.set(all, 0);
      next.set(chunk, all.byteLength);
      return next;
    }, new Uint8Array()),
  );
  return { code, text, json: JSON.parse(text) as Record<string, unknown>, writes: writes.length };
}

const readyStatusHandler: BridgeHandler = (request) => ({
  ok: true,
  result: {
    status: "ready",
    origin: "http://localhost:10100",
    pid: 4321,
    version: "2.35.0",
    owner: "desktop-direct",
    service: SERVICE_ABSENT,
    allowedMutations: ["stop"],
  },
});

describe("stdin codec", () => {
  test("decodes one UTF-8 JSON object and strips a BOM", () => {
    const body = JSON.stringify(statusRequest());
    const decoded = decodeStdin(new TextEncoder().encode(`\n${body}\n`));
    expect(decoded.ok).toBe(true);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)]);
    const fromBom = decodeStdin(bom);
    expect(fromBom.ok).toBe(true);
  });

  test("rejects invalid UTF-8, empty input, extra JSON, and oversize requests", () => {
    expect(decodeUtf8(new Uint8Array([0xc3])).ok).toBe(false);
    expect(decodeStdin(new Uint8Array([0xff])).ok).toBe(false);
    expect(decodeStdin(new TextEncoder().encode("")).ok).toBe(false);
    expect(decodeStdin(new TextEncoder().encode("   \n")).ok).toBe(false);
    expect(decodeStdin(new TextEncoder().encode("{}{}")).ok).toBe(false);
    expect(decodeStdin(new TextEncoder().encode("[]")).ok).toBe(true);
    expect(decodeStdin(new Uint8Array(MAX_REQUEST_BYTES + 1)).ok).toBe(false);
  });

  test("encodes exactly one JSON object plus a single newline and no ANSI", () => {
    const bytes = encodeEnvelope(
      buildFailureEnvelope(ULID, "status", protocolMismatch("invalid JSON")),
    );
    const text = new TextDecoder().decode(bytes);
    expect(isSingleJsonObjectLine(text)).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("\n")).toBe(text.length - 1);
    expect(text.includes("\u001b")).toBe(false);
    expect(JSON.parse(text).ok).toBe(false);
  });
});

describe("runBridge stdout and exit codes", () => {
  test("valid request plus success result exits 0 with one envelope", async () => {
    const { code, text, json, writes } = await invoke(statusRequest(), readyStatusHandler);
    expect(code).toBe(EXIT_SUCCESS);
    expect(writes).toBe(1);
    expect(isSingleJsonObjectLine(text)).toBe(true);
    expect(json.ok).toBe(true);
    expect(json.requestId).toBe(ULID);
    expect(json.operation).toBe("status");
    expect(json.schemaVersion).toBe(1);
    expect("error" in json).toBe(false);
  });

  test("handler stdout and stderr cannot contaminate the envelope", async () => {
    const writes: Uint8Array[] = [];
    let diagnostics: { stdout: string; stderr: string; truncated: boolean } | undefined;
    const code = await runBridge({
      stdin: `${JSON.stringify(statusRequest())}\n`,
      handler: (request) => {
        console.log("HANDLER_STDOUT");
        process.stdout.write("DIRECT_STDOUT\n");
        console.error("HANDLER_STDERR Authorization: Bearer exposed-value");
        process.stderr.write("DIRECT_STDERR\n");
        return readyStatusHandler(request, { signal: new AbortController().signal, deadlineMs: 10_000 });
      },
      writeStdout: bytes => writes.push(bytes),
      onHandlerOutput: output => { diagnostics = output; },
    });
    const text = new TextDecoder().decode(writes[0]);
    expect(code).toBe(EXIT_SUCCESS);
    expect(writes).toHaveLength(1);
    expect(isSingleJsonObjectLine(text)).toBe(true);
    expect(text).not.toContain("HANDLER_");
    expect(diagnostics?.stdout).toContain("HANDLER_STDOUT");
    expect(diagnostics?.stderr).not.toContain("exposed-value");
  });

  test("unexpected wired handler faults use operation-specific errors", async () => {
    const status = await invoke(statusRequest(), () => {
      throw new Error("Authorization: Bearer must-not-leak");
    });
    expect(status.code).toBe(EXIT_OPERATION_FAILURE);
    expect((status.json.error as { code: string }).code).toBe("proxy_not_ready");
    expect(JSON.stringify(status.json)).not.toContain("must-not-leak");

    const stop = await invoke(
      { schemaVersion: 1, requestId: ULID, operation: "stop", payload: { reason: "app-exit" } },
      () => { throw new Error("stop internals"); },
    );
    expect((stop.json.error as { code: string }).code).toBe("stop_failed");
  });

  test("unsupported handler returns unsupported_operation and exit 1", async () => {
    const { code, json } = await invoke(statusRequest(), unsupportedBridgeHandler);
    expect(code).toBe(EXIT_OPERATION_FAILURE);
    expect(json.ok).toBe(false);
    expect((json.error as { code: string }).code).toBe("unsupported_operation");
    const outcome = unsupportedBridgeHandler({
      schemaVersion: 1,
      requestId: ULID,
      operation: "bootstrap",
      payload: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unsupported_operation");
  });

  test("protocol failures exit 2 and never call the handler", async () => {
    let called = 0;
    const handler: BridgeHandler = () => {
      called += 1;
      return { ok: true, result: { changed: true } };
    };
    const badVersion = await invoke({ ...statusRequest(), schemaVersion: 2 }, handler);
    const extraField = await invoke({ ...statusRequest(), extra: 1 }, handler);
    const unknownOp = await invoke({ ...statusRequest(), operation: "launch" }, handler);
    const notJson = await invoke("{", handler);
    const twoDocs = await invoke("{}\n{}", handler);
    expect(called).toBe(0);
    for (const result of [badVersion, extraField, unknownOp, notJson, twoDocs]) {
      expect(result.code).toBe(EXIT_PROTOCOL_FAILURE);
      expect(result.json.ok).toBe(false);
      expect((result.json.error as { code: string }).code).toBe("protocol_mismatch");
      expect(result.writes).toBe(1);
      expect(isSingleJsonObjectLine(result.text)).toBe(true);
    }
    expect(unknownOp.json.operation).toBe("launch");
    expect(unknownOp.json.requestId).toBe(ULID);
  });

  test("validates before calling the handler for every operation payload", async () => {
    let called = 0;
    const handler: BridgeHandler = () => {
      called += 1;
      return { ok: false, error: { code: "unsupported_operation", message: "wired-check", retryable: false } };
    };
    const ops: Array<[Operation, unknown]> = [
      ["bootstrap", {}],
      ["status", {}],
      ["stop", { reason: "app-exit" }],
      ["service-install", { backend: "platform-default", runtimeManifestId: "manifest-1" }],
      ["service-start", {}],
      ["service-repair", { runtimeManifestId: "manifest-1" }],
      ["service-uninstall", {}],
      ["legacy-tray-uninstall", {}],
    ];
    for (const [operation, payload] of ops) {
      const result = await invoke(
        { schemaVersion: 1, requestId: ULID, operation, payload },
        handler,
      );
      expect(result.code).toBe(EXIT_OPERATION_FAILURE);
      expect((result.json.error as { message: string }).message).toBe("wired-check");
    }
    expect(called).toBe(ops.length);

    const rejected = await invoke(
      { schemaVersion: 1, requestId: ULID, operation: "stop", payload: { reason: "app-exit", extra: 1 } },
      handler,
    );
    expect(rejected.code).toBe(EXIT_PROTOCOL_FAILURE);
    expect(called).toBe(ops.length);
  });

  test("invalid handler result is a protocol failure, not stdout pollution", async () => {
    const { code, json, text } = await invoke(statusRequest(), () => ({
      ok: true,
      result: { changed: true },
    }));
    expect(code).toBe(EXIT_PROTOCOL_FAILURE);
    expect((json.error as { code: string }).code).toBe("protocol_mismatch");
    expect(text.match(/\n/g)?.length).toBe(1);
  });

  test("maps stop transaction failure onto an operation-failure envelope", async () => {
    const { code, json } = await invoke(
      { schemaVersion: 1, requestId: ULID, operation: "stop", payload: { reason: "update" } },
      () => ({
        ok: true,
        result: {
          ok: false,
          code: "stop_failed",
          proxyAbsent: false,
          retryable: true,
          message: "stop failed",
          serviceStopped: false,
          proxyStopped: false,
          restoreStatus: "not-needed",
          grokStatus: "not-needed",
          events: [{ type: "proxy_stop_failed", detail: "local only" }],
        },
      }),
    );
    expect(code).toBe(EXIT_OPERATION_FAILURE);
    expect(json.ok).toBe(false);
    expect((json.error as { code: string }).code).toBe("stop_failed");
    expect("result" in json).toBe(false);
  });

  test("projects internal stop success without leaking diagnostic events", async () => {
    const { code, json } = await invoke(
      { schemaVersion: 1, requestId: ULID, operation: "stop", payload: { reason: "app-exit" } },
      () => ({
        ok: true,
        result: {
          ok: true,
          code: "stopped",
          serviceStopped: false,
          proxyStopped: true,
          proxyAbsent: true,
          restoreStatus: "restored",
          grokStatus: "not-needed",
          events: [{ type: "proxy_stopped", pid: 42 }],
        },
      }),
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(json.ok).toBe(true);
    expect((json.result as Record<string, unknown>).proxyAbsent).toBe(true);
    expect("events" in (json.result as Record<string, unknown>)).toBe(false);
  });

  test("success encode uses canonical top-level key order", () => {
    const text = new TextDecoder().decode(
      encodeEnvelope(
        buildSuccessEnvelope(ULID, "legacy-tray-uninstall", { changed: false }),
      ),
    );
    expect(text.startsWith('{"schemaVersion":1,"requestId":')).toBe(true);
    expect(text.includes('"ok":true')).toBe(true);
    expect(text.includes('"operation":"legacy-tray-uninstall"')).toBe(true);
  });
});
