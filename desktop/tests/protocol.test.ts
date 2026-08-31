import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  EXIT_OPERATION_FAILURE,
  EXIT_PROTOCOL_FAILURE,
  EXIT_SUCCESS,
  OPERATIONS,
  OWNERS,
  buildFailureEnvelope,
  buildSuccessEnvelope,
  echoRequestId,
  exitCodeForEnvelope,
  isRequestId,
  isRuntimeManifestId,
  parseBridgeRequest,
  projectStopTransactionResult,
  protocolMismatch,
  stopFailureToError,
  validateAllowedMutations,
  validateBootstrapResult,
  validateBridgeError,
  validateEnvelope,
  validateLegacyTrayUninstallResult,
  validatePayload,
  validateResult,
  validateServiceMutationResult,
  validateServiceState,
  validateStatusResult,
  validateStopFailureResult,
  validateStopSuccessResult,
  validateStopTransactionResult,
  type Operation,
} from "../runtime/protocol";

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const UUID = "550e8400-e29b-41d4-a716-446655440000";

const SERVICE_ABSENT = {
  installed: false,
  startable: false,
  stateCode: "absent",
} as const;

function request(operation: Operation, payload: unknown, extra?: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    requestId: ULID,
    operation,
    payload,
    ...extra,
  };
}

function expectProtocolFail(input: unknown, message?: string | RegExp) {
  const parsed = parseBridgeRequest(input);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.error.code).toBe("protocol_mismatch");
    expect(parsed.error.retryable).toBe(false);
    if (typeof message === "string") {
      expect(parsed.error.message).toBe(message);
    } else if (message) {
      expect(parsed.error.message).toMatch(message);
    }
  }
}

describe("closed enumerations", () => {
  test("operations are the PLAN v1 set", () => {
    expect([...OPERATIONS]).toEqual([
      "bootstrap",
      "status",
      "stop",
      "runtime-activate",
      "service-install",
      "service-start",
      "service-repair",
      "service-uninstall",
      "legacy-tray-uninstall",
    ]);
  });

  test("error codes are the PLAN v1 set", () => {
    expect([...ERROR_CODES]).toEqual([
      "protocol_mismatch",
      "unsupported_operation",
      "deadline_exceeded",
      "service_not_startable",
      "ownership_conflict",
      "proxy_not_ready",
      "stop_failed",
      "restore_failed",
      "runtime_integrity_failed",
    ]);
  });

  test("owners are the PLAN v1 set", () => {
    expect([...OWNERS]).toEqual([
      "existing-external",
      "desktop-direct",
      "desktop-service",
      "unknown/conflict",
    ]);
  });

  test("exit codes are 0 success / 1 operation / 2 protocol", () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_OPERATION_FAILURE).toBe(1);
    expect(EXIT_PROTOCOL_FAILURE).toBe(2);
  });
});

describe("requestId", () => {
  test("accepts UUID and ULID-like values up to 64 ASCII", () => {
    expect(isRequestId(UUID)).toBe(true);
    expect(isRequestId(ULID)).toBe(true);
    expect(isRequestId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isRequestId(`${ULID}ABCDEFGHJKMNPQ`)).toBe(true);
  });

  test("rejects empty, overlong, non-ASCII, and non UUID/ULID-like values", () => {
    expect(isRequestId("")).toBe(false);
    expect(isRequestId("a".repeat(65))).toBe(false);
    expect(isRequestId("01J")).toBe(false);
    expect(isRequestId("not a request id")).toBe(false);
    expect(isRequestId("01ILOU01234567890123456789")).toBe(false);
    expect(isRequestId("请求标识")).toBe(false);
    expect(isRequestId("01JABCDEFGHJKMNPQRSTVWXYZ!")).toBe(false);
  });

  test("echoRequestId drops overlong or non-ASCII values", () => {
    expect(echoRequestId(ULID)).toBe(ULID);
    expect(echoRequestId("x".repeat(65))).toBe("");
    expect(echoRequestId("naïve")).toBe("");
    expect(echoRequestId(1)).toBe("");
  });
});

describe("runtimeManifestId", () => {
  test("accepts staged id tokens and rejects paths", () => {
    expect(isRuntimeManifestId("ocx-runtime-aarch64-apple-darwin")).toBe(true);
    expect(isRuntimeManifestId("/abs/path")).toBe(false);
    expect(isRuntimeManifestId("C:\\Windows\\ocx")).toBe(false);
    expect(isRuntimeManifestId("../escape")).toBe(false);
    expect(isRuntimeManifestId("foo/bar")).toBe(false);
    expect(isRuntimeManifestId("")).toBe(false);
  });
});

describe("request payloads", () => {
  test("accepts empty payload operations", () => {
    for (const operation of [
      "bootstrap",
      "status",
      "service-start",
      "service-uninstall",
      "legacy-tray-uninstall",
    ] as const) {
      const parsed = parseBridgeRequest(request(operation, {}));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.request.operation).toBe(operation);
        expect(parsed.request.payload).toEqual({});
      }
    }
  });

  test("accepts stop reasons", () => {
    for (const reason of ["app-exit", "update", "uninstall"] as const) {
      const parsed = parseBridgeRequest(request("stop", { reason }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.request.operation === "stop") {
        expect(parsed.request.payload.reason).toBe(reason);
      }
    }
  });

  test("accepts service-install backends", () => {
    for (const backend of ["platform-default", "windows-native"] as const) {
      const parsed = parseBridgeRequest(
        request("service-install", { backend, runtimeManifestId: "manifest-1" }),
      );
      expect(parsed.ok).toBe(true);
    }
  });

  test("accepts service-repair manifest id", () => {
    const parsed = parseBridgeRequest(request("service-repair", { runtimeManifestId: "manifest-1" }));
    expect(parsed.ok).toBe(true);
  });

  test("accepts runtime-activate manifest id", () => {
    const parsed = parseBridgeRequest(request("runtime-activate", { runtimeManifestId: "manifest-1" }));
    expect(parsed.ok).toBe(true);
  });

  test("rejects unknown fields on every request and payload", () => {
    expectProtocolFail(request("status", {}, { extra: 1 }), "unknown field: extra");
    expectProtocolFail(request("status", { extra: 1 }), "unknown field: extra");
    expectProtocolFail(request("stop", { reason: "app-exit", extra: true }), "unknown field: extra");
    expectProtocolFail(
      request("service-install", {
        backend: "platform-default",
        runtimeManifestId: "manifest-1",
        extra: 1,
      }),
      "unknown field: extra",
    );
    expectProtocolFail(
      request("service-repair", { runtimeManifestId: "manifest-1", extra: 1 }),
      "unknown field: extra",
    );
    expectProtocolFail(
      request("runtime-activate", { runtimeManifestId: "manifest-1", extra: 1 }),
      "unknown field: extra",
    );
  });

  test("rejects missing fields, unknown operation, and unsupported version", () => {
    expectProtocolFail(
      { requestId: ULID, operation: "status", payload: {} },
      "missing field: schemaVersion",
    );
    expectProtocolFail(
      { schemaVersion: 1, operation: "status", payload: {} },
      "missing field: requestId",
    );
    expectProtocolFail(
      { schemaVersion: 1, requestId: ULID, operation: "status" },
      "missing field: payload",
    );
    expectProtocolFail(
      { schemaVersion: 2, requestId: ULID, operation: "status", payload: {} },
      "unsupported schemaVersion",
    );
    expectProtocolFail(
      { schemaVersion: "1", requestId: ULID, operation: "status", payload: {} },
      "unsupported schemaVersion",
    );
    expectProtocolFail(
      { schemaVersion: 1, requestId: ULID, operation: "launch", payload: {} },
      "unknown operation",
    );
    expectProtocolFail(
      { schemaVersion: 1, requestId: "bad", operation: "status", payload: {} },
      "invalid requestId",
    );
    expectProtocolFail(null, "expected a JSON object");
    expectProtocolFail([], "expected a JSON object");
  });

  test("rejects wrong payload types and values before any handler would run", () => {
    expectProtocolFail(request("status", null), /payload must be an object/);
    expectProtocolFail(request("status", []), /payload must be an object/);
    expectProtocolFail(request("stop", {}), "missing field: reason");
    expectProtocolFail(request("stop", { reason: "App-Exit" }), "invalid payload");
    expectProtocolFail(
      request("service-install", { backend: "systemd", runtimeManifestId: "manifest-1" }),
      "invalid payload",
    );
    expectProtocolFail(
      request("service-install", { backend: "platform-default", runtimeManifestId: "/abs" }),
      "invalid payload",
    );
    expectProtocolFail(request("service-repair", { runtimeManifestId: "../x" }), "invalid payload");
    expectProtocolFail(request("runtime-activate", { runtimeManifestId: "../x" }), "invalid payload");
    expectProtocolFail(request("runtime-activate", { runtimeManifestId: "/abs/path" }), "invalid payload");
    expectProtocolFail(request("runtime-activate", {}), "missing field: runtimeManifestId");
    expect(validatePayload("bootstrap", {}).ok).toBe(true);
    expect(validatePayload("bootstrap", { x: 1 }).ok).toBe(false);
  });
});

describe("closed results", () => {
  const bootstrapResult = {
    status: "ready",
    origin: "http://127.0.0.1:10100",
    pid: 1234,
    version: "2.35.0",
    owner: "desktop-direct",
    service: SERVICE_ABSENT,
    allowedMutations: ["stop"],
  };

  const statusConflict = {
    status: "failed",
    origin: null,
    pid: null,
    version: null,
    owner: "unknown/conflict",
    service: { installed: true, startable: false, stateCode: "conflict" },
    allowedMutations: [],
  };

  test("accepts bootstrap and status results", () => {
    expect(validateBootstrapResult(bootstrapResult).ok).toBe(true);
    expect(validateStatusResult(statusConflict).ok).toBe(true);
    expect(validateStatusResult({
      ...statusConflict,
      origin: "http://localhost:10100",
      pid: 9,
      version: "2.35.0",
      status: "ready",
      owner: "existing-external",
      allowedMutations: ["stop"],
    }).ok).toBe(true);
    expect(validateResult("bootstrap", bootstrapResult).ok).toBe(true);
    expect(validateResult("status", statusConflict).ok).toBe(true);
  });

  test("rejects unknown fields and non-loopback origins on results", () => {
    expect(validateBootstrapResult({ ...bootstrapResult, extra: 1 }).ok).toBe(false);
    expect(validateBootstrapResult({ ...bootstrapResult, status: "pending" }).ok).toBe(false);
    expect(validateBootstrapResult({ ...bootstrapResult, origin: "http://192.168.1.9:10100" }).ok).toBe(false);
    expect(validateStatusResult({ ...statusConflict, token: "secret" }).ok).toBe(false);
    expect(validateServiceState({ ...SERVICE_ABSENT, path: "/tmp" }).ok).toBe(false);
    expect(validateAllowedMutations(["stop", "launch"]).ok).toBe(false);
    expect(validateAllowedMutations(["stop", "stop"]).ok).toBe(false);
    expect(validateAllowedMutations(["status", "stop"]).ok).toBe(true);
    expect(validateBootstrapResult({ ...bootstrapResult, owner: "unknown/conflict", allowedMutations: [] }).ok).toBe(false);
    expect(validateStatusResult({ ...statusConflict, allowedMutations: ["stop"] }).ok).toBe(false);
    expect(validateStatusResult({ ...statusConflict, status: "ready" }).ok).toBe(false);
  });

  test("stop transaction success is exact and restore-failed cannot be ok", () => {
    const success = {
      ok: true,
      code: "stopped",
      serviceStopped: true,
      proxyStopped: true,
      proxyAbsent: true,
      restoreStatus: "restored",
      grokStatus: "not-needed",
    };
    expect(validateStopSuccessResult(success).ok).toBe(true);
    expect(validateStopTransactionResult(success).ok).toBe(true);
    expect(validateResult("stop", success).ok).toBe(true);
    expect(validateStopSuccessResult({ ...success, restoreStatus: "failed" }).ok).toBe(false);
    expect(validateStopSuccessResult({ ...success, proxyAbsent: false }).ok).toBe(false);
    expect(validateStopSuccessResult({ ...success, extra: 1 }).ok).toBe(false);
  });

  test("stop transaction failure is closed and maps to envelope error fields", () => {
    const failure = {
      ok: false,
      code: "restore_failed",
      proxyAbsent: true,
      retryable: false,
      message: "restore failed",
    } as const;
    expect(validateStopFailureResult(failure).ok).toBe(true);
    expect(validateStopTransactionResult(failure).ok).toBe(true);
    expect(validateResult("stop", failure).ok).toBe(false);
    expect(stopFailureToError(failure)).toEqual({
      code: "restore_failed",
      message: "restore failed",
      retryable: false,
    });
    expect(validateStopFailureResult({ ...failure, extra: 1 }).ok).toBe(false);
    expect(validateStopFailureResult({ ...failure, code: "protocol_mismatch" }).ok).toBe(false);
  });

  test("projects internal stop diagnostics onto the closed wire result", () => {
    const internalSuccess = {
      ok: true,
      code: "stopped",
      serviceStopped: true,
      proxyStopped: true,
      proxyAbsent: true,
      restoreStatus: "restored",
      grokStatus: "not-needed",
      events: [{ type: "proxy_stopped", pid: 12 }],
    };
    expect(projectStopTransactionResult(internalSuccess)).toEqual({
      ok: true,
      value: {
        ok: true,
        code: "stopped",
        serviceStopped: true,
        proxyStopped: true,
        proxyAbsent: true,
        restoreStatus: "restored",
        grokStatus: "not-needed",
      },
    });
    const internalFailure = {
      ok: false,
      code: "stop_failed",
      retryable: true,
      message: "stop failed",
      proxyAbsent: false,
      serviceStopped: false,
      proxyStopped: false,
      restoreStatus: "not-needed",
      grokStatus: "not-needed",
      events: [{ type: "service_stop_failed", message: "detail" }],
    };
    expect(projectStopTransactionResult(internalFailure)).toEqual({
      ok: true,
      value: {
        ok: false,
        code: "stop_failed",
        retryable: true,
        message: "stop failed",
        proxyAbsent: false,
      },
    });
  });

  test("service mutation and tray results reject unknown fields", () => {
    const serviceResult = {
      changed: true,
      service: { installed: true, startable: true, stateCode: "running" },
      proxyStatus: "ready",
    };
    expect(validateServiceMutationResult(serviceResult).ok).toBe(true);
    expect(validateResult("service-install", serviceResult).ok).toBe(true);
    expect(validateResult("service-start", serviceResult).ok).toBe(true);
    expect(validateResult("service-repair", serviceResult).ok).toBe(true);
    expect(validateResult("service-uninstall", serviceResult).ok).toBe(true);
    expect(validateServiceMutationResult({ ...serviceResult, bunPath: "/abs" }).ok).toBe(false);
    expect(validateLegacyTrayUninstallResult({ changed: false }).ok).toBe(true);
    expect(validateResult("legacy-tray-uninstall", { changed: true }).ok).toBe(true);
    expect(validateLegacyTrayUninstallResult({ changed: true, extra: 1 }).ok).toBe(false);
  });
});

describe("envelopes", () => {
  test("success envelope requires result and rejects error", () => {
    const envelope = buildSuccessEnvelope(ULID, "status", {
      status: "stopped",
      origin: null,
      pid: null,
      version: null,
      owner: "existing-external",
      service: SERVICE_ABSENT,
      allowedMutations: [],
    });
    const validated = validateEnvelope(envelope);
    expect(validated.ok).toBe(true);
    expect(exitCodeForEnvelope(envelope)).toBe(0);
    expect(
      validateEnvelope({ ...envelope, error: protocolMismatch("nope") }).ok,
    ).toBe(false);
  });

  test("failure envelope requires error and rejects result", () => {
    const envelope = buildFailureEnvelope(ULID, "stop", {
      code: "ownership_conflict",
      message: "ownership conflict",
      retryable: false,
    });
    const validated = validateEnvelope(envelope);
    expect(validated.ok).toBe(true);
    if (validated.ok && !validated.value.ok) {
      expect(validated.value.error.code).toBe("ownership_conflict");
    }
    expect(exitCodeForEnvelope(envelope)).toBe(1);
    expect(exitCodeForEnvelope(buildFailureEnvelope(ULID, "status", protocolMismatch("bad")))).toBe(2);
    expect(validateEnvelope({ ...envelope, result: { changed: true } }).ok).toBe(false);
  });

  test("deadline_exceeded errors are closed and include reconciliation metadata", () => {
    const okErr = validateBridgeError({
      code: "deadline_exceeded",
      message: "operation deadline exceeded; outcome unknown; reconcile with status; blind retry forbidden",
      retryable: false,
      reconciliation: {
        outcome: "unknown",
        followUpOperation: "status",
        blindRetry: false,
      },
    });
    expect(okErr.ok).toBe(true);
    expect(
      validateBridgeError({
        code: "deadline_exceeded",
        message: "status deadline exceeded",
        retryable: true,
        extra: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateBridgeError({
        code: "stop_failed",
        message: "stop failed",
        retryable: false,
        reconciliation: { outcome: "unknown", followUpOperation: "status", blindRetry: false },
      }).ok,
    ).toBe(false);
    expect(
      validateBridgeError({
        code: "deadline_exceeded",
        message: "operation deadline exceeded; outcome unknown; reconcile with status; blind retry forbidden",
        retryable: true,
        reconciliation: { outcome: "unknown", followUpOperation: "status", blindRetry: false },
      }).ok,
    ).toBe(false);
  });

  test("unknown envelope fields, versions, and codes are rejected", () => {
    expect(
      validateEnvelope({
        schemaVersion: 1,
        requestId: ULID,
        ok: true,
        operation: "status",
        result: {
          status: "stopped",
          origin: null,
          pid: null,
          version: null,
          owner: "existing-external",
          service: SERVICE_ABSENT,
          allowedMutations: [],
        },
        extra: true,
      }).ok,
    ).toBe(false);
    expect(
      validateEnvelope({
        schemaVersion: 2,
        requestId: ULID,
        ok: false,
        operation: "status",
        error: protocolMismatch("bad"),
      }).ok,
    ).toBe(false);
    expect(
      validateBridgeError({ code: "bridge_protocol_error", message: "x", retryable: false }).ok,
    ).toBe(false);
  });
});
