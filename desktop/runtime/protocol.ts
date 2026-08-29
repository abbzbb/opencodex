import { isLoopbackOrigin, normalizeLoopbackOrigin } from "./origin";

export const PROTOCOL_SCHEMA_VERSION = 1 as const;
export const MAX_REQUEST_ID_LENGTH = 64;
export const MAX_ERROR_MESSAGE_LENGTH = 4096;

export const EXIT_SUCCESS = 0;
export const EXIT_OPERATION_FAILURE = 1;
export const EXIT_PROTOCOL_FAILURE = 2;

export const OPERATIONS = [
  "bootstrap",
  "status",
  "stop",
  "service-install",
  "service-start",
  "service-repair",
  "service-uninstall",
  "legacy-tray-uninstall",
] as const;

export type Operation = (typeof OPERATIONS)[number];

export const EMPTY_PAYLOAD_OPERATIONS = [
  "bootstrap",
  "status",
  "service-start",
  "service-uninstall",
  "legacy-tray-uninstall",
] as const;

export type EmptyPayloadOperation = (typeof EMPTY_PAYLOAD_OPERATIONS)[number];

export const ERROR_CODES = [
  "protocol_mismatch",
  "unsupported_operation",
  "deadline_exceeded",
  "service_not_startable",
  "ownership_conflict",
  "proxy_not_ready",
  "stop_failed",
  "restore_failed",
  "runtime_integrity_failed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const OWNERS = [
  "existing-external",
  "desktop-direct",
  "desktop-service",
  "unknown/conflict",
] as const;

export type Owner = (typeof OWNERS)[number];

export const PROXY_STATUSES = ["ready", "pending", "stopped", "failed"] as const;
export type ProxyStatus = (typeof PROXY_STATUSES)[number];

export const STOP_REASONS = ["app-exit", "update", "uninstall"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const SERVICE_INSTALL_BACKENDS = ["platform-default", "windows-native"] as const;
export type ServiceInstallBackend = (typeof SERVICE_INSTALL_BACKENDS)[number];

export const RESTORE_STATUSES = ["restored", "not-needed", "failed"] as const;
export type RestoreStatus = (typeof RESTORE_STATUSES)[number];

export const STOP_SUCCESS_RESTORE_STATUSES = ["restored", "not-needed"] as const;
export type StopSuccessRestoreStatus = (typeof STOP_SUCCESS_RESTORE_STATUSES)[number];

export type EmptyPayload = Record<string, never>;

export type StopPayload = {
  reason: StopReason;
};

export type ServiceInstallPayload = {
  backend: ServiceInstallBackend;
  runtimeManifestId: string;
};

export type ServiceRepairPayload = {
  runtimeManifestId: string;
};

export type BridgePayload =
  | EmptyPayload
  | StopPayload
  | ServiceInstallPayload
  | ServiceRepairPayload;

export type BridgeRequest =
  | { schemaVersion: 1; requestId: string; operation: EmptyPayloadOperation; payload: EmptyPayload }
  | { schemaVersion: 1; requestId: string; operation: "stop"; payload: StopPayload }
  | { schemaVersion: 1; requestId: string; operation: "service-install"; payload: ServiceInstallPayload }
  | { schemaVersion: 1; requestId: string; operation: "service-repair"; payload: ServiceRepairPayload };

export type ServiceState = {
  installed: boolean;
  startable: boolean;
  stateCode: string;
};

export type BootstrapResult = {
  status: "ready";
  origin: string;
  pid: number;
  version: string;
  owner: Owner;
  service: ServiceState;
  allowedMutations: Operation[];
};

export type StatusResult = {
  status: ProxyStatus;
  origin: string | null;
  pid: number | null;
  version: string | null;
  owner: Owner;
  service: ServiceState;
  allowedMutations: Operation[];
};

export type StopSuccessResult = {
  ok: true;
  code: "stopped";
  serviceStopped: boolean;
  proxyStopped: boolean;
  proxyAbsent: true;
  restoreStatus: StopSuccessRestoreStatus;
  grokStatus: StopSuccessRestoreStatus;
};

export type StopFailureResult = {
  ok: false;
  code: "ownership_conflict" | "stop_failed" | "restore_failed";
  proxyAbsent: boolean;
  retryable: boolean;
  message: string;
};

export type StopTransactionResult = StopSuccessResult | StopFailureResult;

export type ServiceMutationResult = {
  changed: boolean;
  service: ServiceState;
  proxyStatus: ProxyStatus;
};

export type LegacyTrayUninstallResult = {
  changed: boolean;
};

export type OperationResult = {
  bootstrap: BootstrapResult;
  status: StatusResult;
  stop: StopSuccessResult;
  "service-install": ServiceMutationResult;
  "service-start": ServiceMutationResult;
  "service-repair": ServiceMutationResult;
  "service-uninstall": ServiceMutationResult;
  "legacy-tray-uninstall": LegacyTrayUninstallResult;
};

export type BridgeResult = OperationResult[Operation];

export type MutationTimeoutReconciliation = {
  outcome: "unknown";
  followUpOperation: "status";
  blindRetry: false;
};

export type DeadlineExceededErrorBody = {
  code: "deadline_exceeded";
  message: string;
  retryable: boolean;
  reconciliation: MutationTimeoutReconciliation | null;
};

export type GenericBridgeError = {
  code: Exclude<ErrorCode, "deadline_exceeded">;
  message: string;
  retryable: boolean;
};

export type BridgeError = DeadlineExceededErrorBody | GenericBridgeError;

export type SuccessEnvelope<Op extends Operation = Operation> = {
  schemaVersion: 1;
  requestId: string;
  ok: true;
  operation: Op;
  result: OperationResult[Op];
};

export type FailureEnvelope = {
  schemaVersion: 1;
  requestId: string;
  ok: false;
  operation: string;
  error: BridgeError;
};

export type BridgeEnvelope = SuccessEnvelope | FailureEnvelope;

export type ValidationOk<T> = { ok: true; value: T };
export type ValidationErr = { ok: false; message: string };
export type Validation<T> = ValidationOk<T> | ValidationErr;

export type RequestParse =
  | { ok: true; request: BridgeRequest }
  | {
      ok: false;
      error: GenericBridgeError;
      requestId: string;
      operation: string;
    };

export type HandlerOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: BridgeError };

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]+$/;
const STATE_CODE_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const MANIFEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const ASCII_PRINTABLE_RE = /^[\x20-\x7E]*$/;

const REQUEST_KEYS = ["schemaVersion", "requestId", "operation", "payload"] as const;
const SUCCESS_ENVELOPE_KEYS = ["schemaVersion", "requestId", "ok", "operation", "result"] as const;
const FAILURE_ENVELOPE_KEYS = ["schemaVersion", "requestId", "ok", "operation", "error"] as const;
const SERVICE_STATE_KEYS = ["installed", "startable", "stateCode"] as const;
const BOOTSTRAP_RESULT_KEYS = [
  "status",
  "origin",
  "pid",
  "version",
  "owner",
  "service",
  "allowedMutations",
] as const;
const STATUS_RESULT_KEYS = BOOTSTRAP_RESULT_KEYS;
const STOP_SUCCESS_KEYS = [
  "ok",
  "code",
  "serviceStopped",
  "proxyStopped",
  "proxyAbsent",
  "restoreStatus",
  "grokStatus",
] as const;
const STOP_FAILURE_KEYS = ["ok", "code", "proxyAbsent", "retryable", "message"] as const;
const SERVICE_MUTATION_KEYS = ["changed", "service", "proxyStatus"] as const;
const TRAY_RESULT_KEYS = ["changed"] as const;
const GENERIC_ERROR_KEYS = ["code", "message", "retryable"] as const;
const DEADLINE_ERROR_KEYS = ["code", "message", "retryable", "reconciliation"] as const;
const RECONCILIATION_KEYS = ["outcome", "followUpOperation", "blindRetry"] as const;
const STOP_PAYLOAD_KEYS = ["reason"] as const;
const SERVICE_INSTALL_KEYS = ["backend", "runtimeManifestId"] as const;
const SERVICE_REPAIR_KEYS = ["runtimeManifestId"] as const;

function fail(message: string): ValidationErr {
  return { ok: false, message };
}

function ok<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): Validation<void> {
  const keys = ownKeys(value);
  if (keys.length !== expected.length) {
    const extra = keys.filter((key) => !expected.includes(key));
    if (extra.length > 0) {
      return fail(`unknown field: ${extra[0]}`);
    }
    const missing = expected.filter((key) => !keys.includes(key));
    return fail(`missing field: ${missing[0]}`);
  }
  for (const key of keys) {
    if (!expected.includes(key)) {
      return fail(`unknown field: ${key}`);
    }
  }
  for (const key of expected) {
    if (!keys.includes(key)) {
      return fail(`missing field: ${key}`);
    }
  }
  return ok(undefined);
}

function copyObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    out[key] = value[key];
  }
  return out;
}

function asObject(value: unknown, label: string): Validation<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    return fail(`${label} must be an object`);
  }
  const copied = copyObject(value);
  if (!copied) {
    return fail(`${label} contains a forbidden field`);
  }
  return ok(copied);
}

export function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && (OPERATIONS as readonly string[]).includes(value);
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export function isOwner(value: unknown): value is Owner {
  return typeof value === "string" && (OWNERS as readonly string[]).includes(value);
}

export function isProxyStatus(value: unknown): value is ProxyStatus {
  return typeof value === "string" && (PROXY_STATUSES as readonly string[]).includes(value);
}

export function isEmptyPayloadOperation(value: unknown): value is EmptyPayloadOperation {
  return typeof value === "string" && (EMPTY_PAYLOAD_OPERATIONS as readonly string[]).includes(value);
}

export function isRequestId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length < 1 || value.length > MAX_REQUEST_ID_LENGTH) {
    return false;
  }
  if (UUID_RE.test(value)) {
    return true;
  }
  const compact = value.replace(/-/g, "");
  if (compact.length < 26 || compact.length > MAX_REQUEST_ID_LENGTH) {
    return false;
  }
  return CROCKFORD_RE.test(compact);
}

export function echoRequestId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length > MAX_REQUEST_ID_LENGTH) {
    return "";
  }
  if (!/^[\x20-\x7E]*$/.test(value)) {
    return "";
  }
  return value;
}

export function echoOperation(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length > MAX_REQUEST_ID_LENGTH) {
    return "";
  }
  if (!/^[\x20-\x7E]*$/.test(value)) {
    return "";
  }
  return value;
}

export function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2147483647;
}

export function isRuntimeManifestId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length < 1 || value.length > 128) {
    return false;
  }
  if (value.includes("..") || value.includes("/") || value.includes("\\") || value.includes(":")) {
    return false;
  }
  return MANIFEST_ID_RE.test(value);
}

function isStateCode(value: unknown): value is string {
  return typeof value === "string" && STATE_CODE_RE.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_RE.test(value);
}

function isErrorMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ERROR_MESSAGE_LENGTH &&
    ASCII_PRINTABLE_RE.test(value) &&
    !value.includes("\u0000")
  );
}

export function protocolMismatch(message: string): GenericBridgeError {
  return {
    code: "protocol_mismatch",
    message,
    retryable: false,
  };
}

function validateEmptyPayload(value: unknown): Validation<EmptyPayload> {
  const obj = asObject(value, "payload");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, []);
  if (!keys.ok) {
    return keys;
  }
  return ok(Object.create(null) as EmptyPayload);
}

function validateStopPayload(value: unknown): Validation<StopPayload> {
  const obj = asObject(value, "payload");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, STOP_PAYLOAD_KEYS);
  if (!keys.ok) {
    return keys;
  }
  const reason = obj.value.reason;
  if (typeof reason !== "string" || !(STOP_REASONS as readonly string[]).includes(reason)) {
    return fail("invalid payload");
  }
  return ok({ reason: reason as StopReason });
}

function validateServiceInstallPayload(value: unknown): Validation<ServiceInstallPayload> {
  const obj = asObject(value, "payload");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, SERVICE_INSTALL_KEYS);
  if (!keys.ok) {
    return keys;
  }
  const backend = obj.value.backend;
  if (
    typeof backend !== "string" ||
    !(SERVICE_INSTALL_BACKENDS as readonly string[]).includes(backend)
  ) {
    return fail("invalid payload");
  }
  if (!isRuntimeManifestId(obj.value.runtimeManifestId)) {
    return fail("invalid payload");
  }
  return ok({
    backend: backend as ServiceInstallBackend,
    runtimeManifestId: obj.value.runtimeManifestId,
  });
}

function validateServiceRepairPayload(value: unknown): Validation<ServiceRepairPayload> {
  const obj = asObject(value, "payload");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, SERVICE_REPAIR_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (!isRuntimeManifestId(obj.value.runtimeManifestId)) {
    return fail("invalid payload");
  }
  return ok({ runtimeManifestId: obj.value.runtimeManifestId });
}

export function validatePayload(operation: Operation, payload: unknown): Validation<BridgePayload> {
  if (isEmptyPayloadOperation(operation)) {
    return validateEmptyPayload(payload);
  }
  if (operation === "stop") {
    return validateStopPayload(payload);
  }
  if (operation === "service-install") {
    return validateServiceInstallPayload(payload);
  }
  return validateServiceRepairPayload(payload);
}

export function parseBridgeRequest(input: unknown): RequestParse {
  const obj = asObject(input, "request");
  if (!obj.ok) {
    return {
      ok: false,
      error: protocolMismatch("expected a JSON object"),
      requestId: "",
      operation: "",
    };
  }
  const requestId = echoRequestId(obj.value.requestId);
  const operation = echoOperation(obj.value.operation);
  const keys = exactKeys(obj.value, REQUEST_KEYS);
  if (!keys.ok) {
    return { ok: false, error: protocolMismatch(keys.message), requestId, operation };
  }
  if (!Object.is(obj.value.schemaVersion, 1) || !Number.isInteger(obj.value.schemaVersion)) {
    return {
      ok: false,
      error: protocolMismatch("unsupported schemaVersion"),
      requestId,
      operation,
    };
  }
  if (!isRequestId(obj.value.requestId)) {
    return { ok: false, error: protocolMismatch("invalid requestId"), requestId, operation };
  }
  if (!isOperation(obj.value.operation)) {
    return { ok: false, error: protocolMismatch("unknown operation"), requestId, operation };
  }
  const payload = validatePayload(obj.value.operation, obj.value.payload);
  if (!payload.ok) {
    return { ok: false, error: protocolMismatch(payload.message), requestId, operation: obj.value.operation };
  }
  return {
    ok: true,
    request: {
      schemaVersion: 1,
      requestId: obj.value.requestId,
      operation: obj.value.operation,
      payload: payload.value,
    } as BridgeRequest,
  };
}

export function validateServiceState(value: unknown): Validation<ServiceState> {
  const obj = asObject(value, "service");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, SERVICE_STATE_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (typeof obj.value.installed !== "boolean") {
    return fail("invalid service.installed");
  }
  if (typeof obj.value.startable !== "boolean") {
    return fail("invalid service.startable");
  }
  if (!isStateCode(obj.value.stateCode)) {
    return fail("invalid service.stateCode");
  }
  return ok({
    installed: obj.value.installed,
    startable: obj.value.startable,
    stateCode: obj.value.stateCode,
  });
}

export function validateAllowedMutations(value: unknown): Validation<Operation[]> {
  if (!Array.isArray(value)) {
    return fail("allowedMutations must be an array");
  }
  const seen = new Set<string>();
  const out: Operation[] = [];
  for (const item of value) {
    if (!isOperation(item)) {
      return fail("invalid allowedMutations entry");
    }
    if (seen.has(item)) {
      return fail("duplicate allowedMutations entry");
    }
    seen.add(item);
    out.push(item);
  }
  return ok(out);
}

function validateOriginValue(value: unknown, required: true): Validation<string>;
function validateOriginValue(value: unknown, required: false): Validation<string | null>;
function validateOriginValue(value: unknown, required: boolean): Validation<string | null> {
  if (value === null) {
    if (required) {
      return fail("origin is required");
    }
    return ok(null);
  }
  const origin = normalizeLoopbackOrigin(value);
  if (!origin || !isLoopbackOrigin(origin)) {
    return fail("origin must be a loopback origin");
  }
  return ok(origin);
}

function validateOptionalPid(value: unknown, required: boolean): Validation<number | null> {
  if (value === null) {
    if (required) {
      return fail("pid is required");
    }
    return ok(null);
  }
  if (!isPid(value)) {
    return fail("invalid pid");
  }
  return ok(value);
}

function validateOptionalVersion(value: unknown, required: boolean): Validation<string | null> {
  if (value === null) {
    if (required) {
      return fail("version is required");
    }
    return ok(null);
  }
  if (!isVersion(value)) {
    return fail("invalid version");
  }
  return ok(value);
}

export function validateBootstrapResult(value: unknown): Validation<BootstrapResult> {
  const obj = asObject(value, "result");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, BOOTSTRAP_RESULT_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (obj.value.status !== "ready") {
    return fail("bootstrap result.status must be ready");
  }
  const origin = validateOriginValue(obj.value.origin, true);
  if (!origin.ok) {
    return origin;
  }
  const pid = validateOptionalPid(obj.value.pid, true);
  if (!pid.ok) {
    return pid;
  }
  const version = validateOptionalVersion(obj.value.version, true);
  if (!version.ok) {
    return version;
  }
  if (!isOwner(obj.value.owner)) {
    return fail("invalid owner");
  }
  if (obj.value.owner === "unknown/conflict") {
    return fail("bootstrap cannot succeed with conflicting ownership");
  }
  const service = validateServiceState(obj.value.service);
  if (!service.ok) {
    return service;
  }
  const allowed = validateAllowedMutations(obj.value.allowedMutations);
  if (!allowed.ok) {
    return allowed;
  }
  return ok({
    status: "ready",
    origin: origin.value,
    pid: pid.value as number,
    version: version.value as string,
    owner: obj.value.owner,
    service: service.value,
    allowedMutations: allowed.value,
  });
}

export function validateStatusResult(value: unknown): Validation<StatusResult> {
  const obj = asObject(value, "result");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, STATUS_RESULT_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (!isProxyStatus(obj.value.status)) {
    return fail("invalid status");
  }
  const origin = validateOriginValue(obj.value.origin, false);
  if (!origin.ok) {
    return origin;
  }
  const pid = validateOptionalPid(obj.value.pid, false);
  if (!pid.ok) {
    return pid;
  }
  const version = validateOptionalVersion(obj.value.version, false);
  if (!version.ok) {
    return version;
  }
  if (!isOwner(obj.value.owner)) {
    return fail("invalid owner");
  }
  const service = validateServiceState(obj.value.service);
  if (!service.ok) {
    return service;
  }
  const allowed = validateAllowedMutations(obj.value.allowedMutations);
  if (!allowed.ok) {
    return allowed;
  }
  if (obj.value.owner === "unknown/conflict" && allowed.value.length !== 0) {
    return fail("conflicting ownership must not allow mutations");
  }
  if (obj.value.status === "ready" && (origin.value === null || pid.value === null || version.value === null)) {
    return fail("ready status requires origin, pid, and version");
  }
  return ok({
    status: obj.value.status,
    origin: origin.value,
    pid: pid.value,
    version: version.value,
    owner: obj.value.owner,
    service: service.value,
    allowedMutations: allowed.value,
  });
}

export function validateStopSuccessResult(value: unknown): Validation<StopSuccessResult> {
  const obj = asObject(value, "result");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, STOP_SUCCESS_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (obj.value.ok !== true) {
    return fail("stop success result.ok must be true");
  }
  if (obj.value.code !== "stopped") {
    return fail("stop success result.code must be stopped");
  }
  if (typeof obj.value.serviceStopped !== "boolean") {
    return fail("invalid serviceStopped");
  }
  if (typeof obj.value.proxyStopped !== "boolean") {
    return fail("invalid proxyStopped");
  }
  if (obj.value.proxyAbsent !== true) {
    return fail("stop success result.proxyAbsent must be true");
  }
  if (
    obj.value.restoreStatus !== "restored" &&
    obj.value.restoreStatus !== "not-needed"
  ) {
    return fail("invalid restoreStatus");
  }
  if (obj.value.grokStatus !== "restored" && obj.value.grokStatus !== "not-needed") {
    return fail("invalid grokStatus");
  }
  return ok({
    ok: true,
    code: "stopped",
    serviceStopped: obj.value.serviceStopped,
    proxyStopped: obj.value.proxyStopped,
    proxyAbsent: true,
    restoreStatus: obj.value.restoreStatus,
    grokStatus: obj.value.grokStatus,
  });
}

export function validateStopFailureResult(value: unknown): Validation<StopFailureResult> {
  const obj = asObject(value, "result");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, STOP_FAILURE_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (obj.value.ok !== false) {
    return fail("stop failure result.ok must be false");
  }
  if (
    obj.value.code !== "ownership_conflict" &&
    obj.value.code !== "stop_failed" &&
    obj.value.code !== "restore_failed"
  ) {
    return fail("invalid stop failure code");
  }
  if (typeof obj.value.proxyAbsent !== "boolean") {
    return fail("invalid proxyAbsent");
  }
  if (typeof obj.value.retryable !== "boolean") {
    return fail("invalid retryable");
  }
  if (!isErrorMessage(obj.value.message)) {
    return fail("invalid message");
  }
  return ok({
    ok: false,
    code: obj.value.code,
    proxyAbsent: obj.value.proxyAbsent,
    retryable: obj.value.retryable,
    message: obj.value.message,
  });
}

export function validateStopTransactionResult(value: unknown): Validation<StopTransactionResult> {
  if (!isPlainObject(value)) {
    return fail("result must be an object");
  }
  if (value.ok === true) {
    return validateStopSuccessResult(value);
  }
  if (value.ok === false) {
    return validateStopFailureResult(value);
  }
  return fail("stop transaction result.ok must be boolean");
}

/**
 * Project the shared core transaction onto the closed Desktop wire shape.
 * Internal diagnostic events are deliberately not serialized.
 */
export function projectStopTransactionResult(value: unknown): Validation<StopTransactionResult> {
  const obj = asObject(value, "stop transaction result");
  if (!obj.ok) return obj;
  if (obj.value.ok === true) {
    return validateStopSuccessResult({
      ok: obj.value.ok,
      code: obj.value.code,
      serviceStopped: obj.value.serviceStopped,
      proxyStopped: obj.value.proxyStopped,
      proxyAbsent: obj.value.proxyAbsent,
      restoreStatus: obj.value.restoreStatus,
      grokStatus: obj.value.grokStatus,
    });
  }
  if (obj.value.ok === false) {
    return validateStopFailureResult({
      ok: obj.value.ok,
      code: obj.value.code,
      proxyAbsent: obj.value.proxyAbsent,
      retryable: obj.value.retryable,
      message: obj.value.message,
    });
  }
  return fail("stop transaction result.ok must be boolean");
}

export function validateServiceMutationResult(value: unknown): Validation<ServiceMutationResult> {
  const obj = asObject(value, "result");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, SERVICE_MUTATION_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (typeof obj.value.changed !== "boolean") {
    return fail("invalid changed");
  }
  const service = validateServiceState(obj.value.service);
  if (!service.ok) {
    return service;
  }
  if (!isProxyStatus(obj.value.proxyStatus)) {
    return fail("invalid proxyStatus");
  }
  return ok({
    changed: obj.value.changed,
    service: service.value,
    proxyStatus: obj.value.proxyStatus,
  });
}

export function validateLegacyTrayUninstallResult(
  value: unknown,
): Validation<LegacyTrayUninstallResult> {
  const obj = asObject(value, "result");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, TRAY_RESULT_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (typeof obj.value.changed !== "boolean") {
    return fail("invalid changed");
  }
  return ok({ changed: obj.value.changed });
}

export function validateResult(operation: Operation, value: unknown): Validation<BridgeResult> {
  switch (operation) {
    case "bootstrap":
      return validateBootstrapResult(value);
    case "status":
      return validateStatusResult(value);
    case "stop":
      return validateStopSuccessResult(value);
    case "service-install":
    case "service-start":
    case "service-repair":
    case "service-uninstall":
      return validateServiceMutationResult(value);
    case "legacy-tray-uninstall":
      return validateLegacyTrayUninstallResult(value);
    default:
      return fail("unknown operation");
  }
}

function validateReconciliation(value: unknown): Validation<MutationTimeoutReconciliation | null> {
  if (value === null) {
    return ok(null);
  }
  const obj = asObject(value, "reconciliation");
  if (!obj.ok) {
    return obj;
  }
  const keys = exactKeys(obj.value, RECONCILIATION_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (obj.value.outcome !== "unknown") {
    return fail("reconciliation.outcome must be unknown");
  }
  if (obj.value.followUpOperation !== "status") {
    return fail("reconciliation.followUpOperation must be status");
  }
  if (obj.value.blindRetry !== false) {
    return fail("reconciliation.blindRetry must be false");
  }
  return ok({
    outcome: "unknown",
    followUpOperation: "status",
    blindRetry: false,
  });
}

export function validateBridgeError(value: unknown): Validation<BridgeError> {
  const obj = asObject(value, "error");
  if (!obj.ok) {
    return obj;
  }
  if (!isErrorCode(obj.value.code)) {
    return fail("invalid error code");
  }
  if (obj.value.code === "deadline_exceeded") {
    const keys = exactKeys(obj.value, DEADLINE_ERROR_KEYS);
    if (!keys.ok) {
      return keys;
    }
    if (!isErrorMessage(obj.value.message)) {
      return fail("invalid message");
    }
    if (typeof obj.value.retryable !== "boolean") {
      return fail("invalid retryable");
    }
    const reconciliation = validateReconciliation(obj.value.reconciliation);
    if (!reconciliation.ok) {
      return reconciliation;
    }
    if (reconciliation.value !== null && obj.value.retryable !== false) {
      return fail("mutation deadline errors are not retryable");
    }
    return ok({
      code: "deadline_exceeded",
      message: obj.value.message,
      retryable: obj.value.retryable,
      reconciliation: reconciliation.value,
    });
  }
  const keys = exactKeys(obj.value, GENERIC_ERROR_KEYS);
  if (!keys.ok) {
    return keys;
  }
  if (!isErrorMessage(obj.value.message)) {
    return fail("invalid message");
  }
  if (typeof obj.value.retryable !== "boolean") {
    return fail("invalid retryable");
  }
  return ok({
    code: obj.value.code,
    message: obj.value.message,
    retryable: obj.value.retryable,
  });
}

export function validateEnvelope(value: unknown): Validation<BridgeEnvelope> {
  const obj = asObject(value, "envelope");
  if (!obj.ok) {
    return obj;
  }
  if (obj.value.ok === true) {
    const keys = exactKeys(obj.value, SUCCESS_ENVELOPE_KEYS);
    if (!keys.ok) {
      return keys;
    }
    if ("error" in obj.value) {
      return fail("success envelope must not include error");
    }
    if (!Object.is(obj.value.schemaVersion, 1)) {
      return fail("unsupported schemaVersion");
    }
    if (!isRequestId(obj.value.requestId)) {
      return fail("invalid requestId");
    }
    if (!isOperation(obj.value.operation)) {
      return fail("unknown operation");
    }
    const result = validateResult(obj.value.operation, obj.value.result);
    if (!result.ok) {
      return result;
    }
    return ok({
      schemaVersion: 1,
      requestId: obj.value.requestId,
      ok: true,
      operation: obj.value.operation,
      result: result.value,
    } as SuccessEnvelope);
  }
  if (obj.value.ok === false) {
    const keys = exactKeys(obj.value, FAILURE_ENVELOPE_KEYS);
    if (!keys.ok) {
      return keys;
    }
    if ("result" in obj.value) {
      return fail("failure envelope must not include result");
    }
    if (!Object.is(obj.value.schemaVersion, 1)) {
      return fail("unsupported schemaVersion");
    }
    const requestId = echoRequestId(obj.value.requestId);
    if (typeof obj.value.requestId !== "string" || obj.value.requestId !== requestId) {
      return fail("invalid requestId");
    }
    if (typeof obj.value.operation !== "string") {
      return fail("invalid operation");
    }
    const operation = echoOperation(obj.value.operation);
    if (obj.value.operation !== operation) {
      return fail("invalid operation");
    }
    const error = validateBridgeError(obj.value.error);
    if (!error.ok) {
      return error;
    }
    if (error.value.code !== "protocol_mismatch" && !isOperation(operation)) {
      return fail("operation is required");
    }
    return ok({
      schemaVersion: 1,
      requestId,
      ok: false,
      operation,
      error: error.value,
    });
  }
  return fail("envelope.ok must be boolean");
}

export function buildSuccessEnvelope(
  requestId: string,
  operation: Operation,
  result: BridgeResult,
): SuccessEnvelope {
  return {
    schemaVersion: 1,
    requestId,
    ok: true,
    operation,
    result,
  } as SuccessEnvelope;
}

export function buildFailureEnvelope(
  requestId: string,
  operation: string,
  error: BridgeError,
): FailureEnvelope {
  return {
    schemaVersion: 1,
    requestId,
    ok: false,
    operation,
    error,
  };
}

export function isStopFailureResult(value: unknown): value is StopFailureResult {
  return validateStopFailureResult(value).ok;
}

export function stopFailureToError(result: StopFailureResult): GenericBridgeError {
  return {
    code: result.code,
    message: result.message,
    retryable: result.retryable,
  };
}

export function exitCodeForEnvelope(envelope: BridgeEnvelope): number {
  if (envelope.ok) {
    return EXIT_SUCCESS;
  }
  if (envelope.error.code === "protocol_mismatch") {
    return EXIT_PROTOCOL_FAILURE;
  }
  return EXIT_OPERATION_FAILURE;
}
