use serde_json::{Map, Value};

use crate::origin::normalize_loopback_origin;

pub const PROTOCOL_SCHEMA_VERSION: u64 = 1;
pub const MAX_REQUEST_ID_LENGTH: usize = 64;
pub const MAX_ERROR_MESSAGE_LENGTH: usize = 4096;
pub const EXIT_SUCCESS: i32 = 0;
pub const EXIT_OPERATION_FAILURE: i32 = 1;
pub const EXIT_PROTOCOL_FAILURE: i32 = 2;
pub const RUNTIME_ACTIVATE_WATCHDOG_MS: u64 = 135_000;

pub const OPERATIONS: [&str; 9] = [
    "bootstrap",
    "status",
    "stop",
    "runtime-activate",
    "service-install",
    "service-start",
    "service-repair",
    "service-uninstall",
    "legacy-tray-uninstall",
];

pub const EMPTY_PAYLOAD_OPERATIONS: [&str; 5] = [
    "bootstrap",
    "status",
    "service-start",
    "service-uninstall",
    "legacy-tray-uninstall",
];

pub const ERROR_CODES: [&str; 9] = [
    "protocol_mismatch",
    "unsupported_operation",
    "deadline_exceeded",
    "service_not_startable",
    "ownership_conflict",
    "proxy_not_ready",
    "stop_failed",
    "restore_failed",
    "runtime_integrity_failed",
];

pub const OWNERS: [&str; 4] = [
    "existing-external",
    "desktop-direct",
    "desktop-service",
    "unknown/conflict",
];

pub const PROXY_STATUSES: [&str; 4] = ["ready", "pending", "stopped", "failed"];
pub const STOP_REASONS: [&str; 3] = ["app-exit", "update", "uninstall"];
pub const SERVICE_INSTALL_BACKENDS: [&str; 2] = ["platform-default", "windows-native"];
pub const STOP_SUCCESS_RESTORE_STATUSES: [&str; 2] = ["restored", "not-needed"];

const REQUEST_KEYS: [&str; 4] = ["schemaVersion", "requestId", "operation", "payload"];
const SUCCESS_ENVELOPE_KEYS: [&str; 5] =
    ["schemaVersion", "requestId", "ok", "operation", "result"];
const FAILURE_ENVELOPE_KEYS: [&str; 5] = ["schemaVersion", "requestId", "ok", "operation", "error"];
const SERVICE_STATE_KEYS: [&str; 3] = ["installed", "startable", "stateCode"];
const BOOTSTRAP_RESULT_KEYS: [&str; 7] = [
    "status",
    "origin",
    "pid",
    "version",
    "owner",
    "service",
    "allowedMutations",
];
const STOP_SUCCESS_KEYS: [&str; 7] = [
    "ok",
    "code",
    "serviceStopped",
    "proxyStopped",
    "proxyAbsent",
    "restoreStatus",
    "grokStatus",
];
const GENERIC_ERROR_KEYS: [&str; 3] = ["code", "message", "retryable"];
const DEADLINE_ERROR_KEYS: [&str; 4] = ["code", "message", "retryable", "reconciliation"];
const RECONCILIATION_KEYS: [&str; 3] = ["outcome", "followUpOperation", "blindRetry"];
const STOP_PAYLOAD_KEYS: [&str; 1] = ["reason"];
const SERVICE_INSTALL_KEYS: [&str; 2] = ["backend", "runtimeManifestId"];
const SERVICE_REPAIR_KEYS: [&str; 1] = ["runtimeManifestId"];
const SERVICE_MUTATION_KEYS: [&str; 3] = ["changed", "service", "proxyStatus"];
const TRAY_RESULT_KEYS: [&str; 1] = ["changed"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationErr {
    pub message: String,
}

fn fail<T>(message: &str) -> Result<T, ValidationErr> {
    Err(ValidationErr {
        message: message.to_string(),
    })
}

fn as_object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, ValidationErr> {
    match value {
        Value::Object(map) => {
            if map.contains_key("__proto__")
                || map.contains_key("constructor")
                || map.contains_key("prototype")
            {
                return fail(&format!("{label} contains a forbidden field"));
            }
            Ok(map)
        }
        _ => fail(&format!("{label} must be an object")),
    }
}

fn exact_keys(value: &Map<String, Value>, expected: &[&str]) -> Result<(), ValidationErr> {
    let keys: Vec<&String> = value.keys().collect();
    if keys.len() != expected.len() {
        if let Some(extra) = keys.iter().find(|key| !expected.contains(&key.as_str())) {
            return fail(&format!("unknown field: {extra}"));
        }
        if let Some(missing) = expected.iter().find(|key| !value.contains_key(**key)) {
            return fail(&format!("missing field: {missing}"));
        }
    }
    for key in &keys {
        if !expected.contains(&key.as_str()) {
            return fail(&format!("unknown field: {key}"));
        }
    }
    for key in expected {
        if !value.contains_key(*key) {
            return fail(&format!("missing field: {key}"));
        }
    }
    Ok(())
}

pub fn is_operation(value: &str) -> bool {
    OPERATIONS.contains(&value)
}

pub fn is_error_code(value: &str) -> bool {
    ERROR_CODES.contains(&value)
}

pub fn is_owner(value: &str) -> bool {
    OWNERS.contains(&value)
}

pub fn is_proxy_status(value: &str) -> bool {
    PROXY_STATUSES.contains(&value)
}

pub fn is_empty_payload_operation(value: &str) -> bool {
    EMPTY_PAYLOAD_OPERATIONS.contains(&value)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let is_hex = |b: u8| b.is_ascii_hexdigit();
    for (i, b) in bytes.iter().copied().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            if b != b'-' {
                return false;
            }
        } else if !is_hex(b) {
            return false;
        }
    }
    true
}

fn is_crockford(value: &str) -> bool {
    value.chars().all(|c| {
        matches!(
            c,
            '0'..='9'
                | 'A'..='H'
                | 'J'..='N'
                | 'P'..='T'
                | 'V'..='Z'
                | 'a'..='h'
                | 'j'..='n'
                | 'p'..='t'
                | 'v'..='z'
        )
    })
}

pub fn is_request_id(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_REQUEST_ID_LENGTH {
        return false;
    }
    if is_uuid(value) {
        return true;
    }
    let compact: String = value.chars().filter(|c| *c != '-').collect();
    (26..=MAX_REQUEST_ID_LENGTH).contains(&compact.len()) && is_crockford(&compact)
}

pub fn echo_request_id(value: &Value) -> String {
    let Some(text) = value.as_str() else {
        return String::new();
    };
    if text.len() > MAX_REQUEST_ID_LENGTH {
        return String::new();
    }
    if !text.chars().all(|c| (' '..='~').contains(&c)) {
        return String::new();
    }
    text.to_string()
}

pub fn echo_operation(value: &Value) -> String {
    echo_request_id(value)
}

pub fn is_pid(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|n| (1..=2_147_483_647).contains(&n))
}

pub fn is_runtime_manifest_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    if value.contains("..") || value.contains('/') || value.contains('\\') || value.contains(':') {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

fn is_state_code(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

fn is_version(value: &str) -> bool {
    is_state_code(value)
}

fn is_error_message(value: &str) -> bool {
    (1..=MAX_ERROR_MESSAGE_LENGTH).contains(&value.len())
        && value.chars().all(|c| (' '..='~').contains(&c))
        && !value.contains('\0')
}

fn is_schema_version_1(value: &Value) -> bool {
    value.as_u64() == Some(PROTOCOL_SCHEMA_VERSION)
}

#[allow(dead_code)]
pub fn protocol_mismatch(message: &str) -> Value {
    serde_json::json!({
        "code": "protocol_mismatch",
        "message": message,
        "retryable": false,
    })
}

fn validate_empty_payload(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "payload")?;
    exact_keys(obj, &[])?;
    Ok(serde_json::json!({}))
}

fn validate_stop_payload(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "payload")?;
    exact_keys(obj, &STOP_PAYLOAD_KEYS)?;
    let reason = obj
        .get("reason")
        .and_then(Value::as_str)
        .ok_or_else(|| ValidationErr {
            message: "invalid payload".to_string(),
        })?;
    if !STOP_REASONS.contains(&reason) {
        return fail("invalid payload");
    }
    Ok(serde_json::json!({ "reason": reason }))
}

fn validate_service_install_payload(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "payload")?;
    exact_keys(obj, &SERVICE_INSTALL_KEYS)?;
    let backend = obj
        .get("backend")
        .and_then(Value::as_str)
        .ok_or_else(|| ValidationErr {
            message: "invalid payload".to_string(),
        })?;
    if !SERVICE_INSTALL_BACKENDS.contains(&backend) {
        return fail("invalid payload");
    }
    let manifest = obj
        .get("runtimeManifestId")
        .and_then(Value::as_str)
        .ok_or_else(|| ValidationErr {
            message: "invalid payload".to_string(),
        })?;
    if !is_runtime_manifest_id(manifest) {
        return fail("invalid payload");
    }
    Ok(serde_json::json!({
        "backend": backend,
        "runtimeManifestId": manifest,
    }))
}

fn validate_service_repair_payload(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "payload")?;
    exact_keys(obj, &SERVICE_REPAIR_KEYS)?;
    let manifest = obj
        .get("runtimeManifestId")
        .and_then(Value::as_str)
        .ok_or_else(|| ValidationErr {
            message: "invalid payload".to_string(),
        })?;
    if !is_runtime_manifest_id(manifest) {
        return fail("invalid payload");
    }
    Ok(serde_json::json!({ "runtimeManifestId": manifest }))
}

pub fn validate_payload(operation: &str, payload: &Value) -> Result<Value, ValidationErr> {
    if is_empty_payload_operation(operation) {
        validate_empty_payload(payload)
    } else if operation == "stop" {
        validate_stop_payload(payload)
    } else if operation == "service-install" {
        validate_service_install_payload(payload)
    } else if operation == "service-repair" || operation == "runtime-activate" {
        validate_service_repair_payload(payload)
    } else {
        fail("unknown operation")
    }
}

pub fn parse_bridge_request(input: &Value) -> Result<Value, (ValidationErr, String, String)> {
    let obj = match as_object(input, "request") {
        Ok(obj) => obj,
        Err(_) => {
            return Err((
                ValidationErr {
                    message: "expected a JSON object".to_string(),
                },
                String::new(),
                String::new(),
            ));
        }
    };
    let request_id = echo_request_id(obj.get("requestId").unwrap_or(&Value::Null));
    let operation = echo_operation(obj.get("operation").unwrap_or(&Value::Null));
    if let Err(err) = exact_keys(obj, &REQUEST_KEYS) {
        return Err((err, request_id, operation));
    }
    if !is_schema_version_1(&obj["schemaVersion"]) {
        return Err((
            ValidationErr {
                message: "unsupported schemaVersion".to_string(),
            },
            request_id,
            operation,
        ));
    }
    let raw_id = obj["requestId"].as_str().unwrap_or_default();
    if !is_request_id(raw_id) {
        return Err((
            ValidationErr {
                message: "invalid requestId".to_string(),
            },
            request_id,
            operation,
        ));
    }
    let raw_op = obj["operation"].as_str().unwrap_or_default();
    if !is_operation(raw_op) {
        return Err((
            ValidationErr {
                message: "unknown operation".to_string(),
            },
            request_id,
            operation,
        ));
    }
    match validate_payload(raw_op, &obj["payload"]) {
        Ok(payload) => Ok(serde_json::json!({
            "schemaVersion": 1,
            "requestId": raw_id,
            "operation": raw_op,
            "payload": payload,
        })),
        Err(err) => Err((err, request_id, raw_op.to_string())),
    }
}

pub fn validate_service_state(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "service")?;
    exact_keys(obj, &SERVICE_STATE_KEYS)?;
    if !obj["installed"].is_boolean() {
        return fail("invalid service.installed");
    }
    if !obj["startable"].is_boolean() {
        return fail("invalid service.startable");
    }
    let state_code = obj["stateCode"].as_str().unwrap_or_default();
    if !is_state_code(state_code) {
        return fail("invalid service.stateCode");
    }
    Ok(serde_json::json!({
        "installed": obj["installed"],
        "startable": obj["startable"],
        "stateCode": state_code,
    }))
}

pub fn validate_allowed_mutations(value: &Value) -> Result<Vec<String>, ValidationErr> {
    let Some(items) = value.as_array() else {
        return fail("allowedMutations must be an array");
    };
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for item in items {
        let Some(op) = item.as_str() else {
            return fail("invalid allowedMutations entry");
        };
        if !is_operation(op) {
            return fail("invalid allowedMutations entry");
        }
        if seen.contains(&op) {
            return fail("duplicate allowedMutations entry");
        }
        seen.push(op);
        out.push(op.to_string());
    }
    Ok(out)
}

fn validate_origin_value(value: &Value, required: bool) -> Result<Value, ValidationErr> {
    if value.is_null() {
        if required {
            return fail("origin is required");
        }
        return Ok(Value::Null);
    }
    let Some(text) = value.as_str() else {
        return fail("origin must be a loopback origin");
    };
    match normalize_loopback_origin(text) {
        Some(origin) => Ok(Value::String(origin)),
        None => fail("origin must be a loopback origin"),
    }
}

fn validate_optional_pid(value: &Value, required: bool) -> Result<Value, ValidationErr> {
    if value.is_null() {
        if required {
            return fail("pid is required");
        }
        return Ok(Value::Null);
    }
    if !is_pid(value) {
        return fail("invalid pid");
    }
    Ok(value.clone())
}

fn validate_optional_version(value: &Value, required: bool) -> Result<Value, ValidationErr> {
    if value.is_null() {
        if required {
            return fail("version is required");
        }
        return Ok(Value::Null);
    }
    let Some(text) = value.as_str() else {
        return fail("invalid version");
    };
    if !is_version(text) {
        return fail("invalid version");
    }
    Ok(Value::String(text.to_string()))
}

pub fn validate_bootstrap_result(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "result")?;
    exact_keys(obj, &BOOTSTRAP_RESULT_KEYS)?;
    if obj["status"].as_str() != Some("ready") {
        return fail("bootstrap result.status must be ready");
    }
    let origin = validate_origin_value(&obj["origin"], true)?;
    let pid = validate_optional_pid(&obj["pid"], true)?;
    let version = validate_optional_version(&obj["version"], true)?;
    let owner = obj["owner"].as_str().unwrap_or_default();
    if !is_owner(owner) {
        return fail("invalid owner");
    }
    if owner == "unknown/conflict" {
        return fail("bootstrap cannot succeed with conflicting ownership");
    }
    let service = validate_service_state(&obj["service"])?;
    let allowed = validate_allowed_mutations(&obj["allowedMutations"])?;
    Ok(serde_json::json!({
        "status": "ready",
        "origin": origin,
        "pid": pid,
        "version": version,
        "owner": owner,
        "service": service,
        "allowedMutations": allowed,
    }))
}

pub fn validate_status_result(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "result")?;
    exact_keys(obj, &BOOTSTRAP_RESULT_KEYS)?;
    let status = obj["status"].as_str().unwrap_or_default();
    if !is_proxy_status(status) {
        return fail("invalid status");
    }
    let origin = validate_origin_value(&obj["origin"], false)?;
    let pid = validate_optional_pid(&obj["pid"], false)?;
    let version = validate_optional_version(&obj["version"], false)?;
    let owner = obj["owner"].as_str().unwrap_or_default();
    if !is_owner(owner) {
        return fail("invalid owner");
    }
    let service = validate_service_state(&obj["service"])?;
    let allowed = validate_allowed_mutations(&obj["allowedMutations"])?;
    if owner == "unknown/conflict" && !allowed.is_empty() {
        return fail("conflicting ownership must not allow mutations");
    }
    if status == "ready" && (origin.is_null() || pid.is_null() || version.is_null()) {
        return fail("ready status requires origin, pid, and version");
    }
    Ok(serde_json::json!({
        "status": status,
        "origin": origin,
        "pid": pid,
        "version": version,
        "owner": owner,
        "service": service,
        "allowedMutations": allowed,
    }))
}

pub fn validate_stop_success_result(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "result")?;
    exact_keys(obj, &STOP_SUCCESS_KEYS)?;
    if obj["ok"] != Value::Bool(true) {
        return fail("stop success result.ok must be true");
    }
    if obj["code"].as_str() != Some("stopped") {
        return fail("stop success result.code must be stopped");
    }
    if !obj["serviceStopped"].is_boolean() {
        return fail("invalid serviceStopped");
    }
    if !obj["proxyStopped"].is_boolean() {
        return fail("invalid proxyStopped");
    }
    if obj["proxyAbsent"] != Value::Bool(true) {
        return fail("stop success result.proxyAbsent must be true");
    }
    let restore = obj["restoreStatus"].as_str().unwrap_or_default();
    if !STOP_SUCCESS_RESTORE_STATUSES.contains(&restore) {
        return fail("invalid restoreStatus");
    }
    let grok = obj["grokStatus"].as_str().unwrap_or_default();
    if !STOP_SUCCESS_RESTORE_STATUSES.contains(&grok) {
        return fail("invalid grokStatus");
    }
    Ok(serde_json::json!({
        "ok": true,
        "code": "stopped",
        "serviceStopped": obj["serviceStopped"],
        "proxyStopped": obj["proxyStopped"],
        "proxyAbsent": true,
        "restoreStatus": restore,
        "grokStatus": grok,
    }))
}

pub fn validate_service_mutation_result(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "result")?;
    exact_keys(obj, &SERVICE_MUTATION_KEYS)?;
    if !obj["changed"].is_boolean() {
        return fail("invalid changed");
    }
    let service = validate_service_state(&obj["service"])?;
    let proxy_status = obj["proxyStatus"].as_str().unwrap_or_default();
    if !is_proxy_status(proxy_status) {
        return fail("invalid proxyStatus");
    }
    Ok(serde_json::json!({
        "changed": obj["changed"],
        "service": service,
        "proxyStatus": proxy_status,
    }))
}

pub fn validate_legacy_tray_uninstall_result(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "result")?;
    exact_keys(obj, &TRAY_RESULT_KEYS)?;
    if !obj["changed"].is_boolean() {
        return fail("invalid changed");
    }
    Ok(serde_json::json!({ "changed": obj["changed"] }))
}

pub fn validate_result(operation: &str, value: &Value) -> Result<Value, ValidationErr> {
    match operation {
        "bootstrap" => validate_bootstrap_result(value),
        "status" => validate_status_result(value),
        "stop" => validate_stop_success_result(value),
        "runtime-activate" | "service-install" | "service-start" | "service-repair"
        | "service-uninstall" => validate_service_mutation_result(value),
        "legacy-tray-uninstall" => validate_legacy_tray_uninstall_result(value),
        _ => fail("unknown operation"),
    }
}

fn validate_reconciliation(value: &Value) -> Result<Value, ValidationErr> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let obj = as_object(value, "reconciliation")?;
    exact_keys(obj, &RECONCILIATION_KEYS)?;
    if obj["outcome"].as_str() != Some("unknown") {
        return fail("reconciliation.outcome must be unknown");
    }
    if obj["followUpOperation"].as_str() != Some("status") {
        return fail("reconciliation.followUpOperation must be status");
    }
    if obj["blindRetry"] != Value::Bool(false) {
        return fail("reconciliation.blindRetry must be false");
    }
    Ok(serde_json::json!({
        "outcome": "unknown",
        "followUpOperation": "status",
        "blindRetry": false,
    }))
}

pub fn validate_bridge_error(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "error")?;
    let code = obj.get("code").and_then(Value::as_str).unwrap_or_default();
    if !is_error_code(code) {
        return fail("invalid error code");
    }
    if code == "deadline_exceeded" {
        exact_keys(obj, &DEADLINE_ERROR_KEYS)?;
        let message = obj["message"].as_str().unwrap_or_default();
        if !is_error_message(message) {
            return fail("invalid message");
        }
        if !obj["retryable"].is_boolean() {
            return fail("invalid retryable");
        }
        let reconciliation = validate_reconciliation(&obj["reconciliation"])?;
        if !reconciliation.is_null() && obj["retryable"] != Value::Bool(false) {
            return fail("mutation deadline errors are not retryable");
        }
        return Ok(serde_json::json!({
            "code": "deadline_exceeded",
            "message": message,
            "retryable": obj["retryable"],
            "reconciliation": reconciliation,
        }));
    }
    exact_keys(obj, &GENERIC_ERROR_KEYS)?;
    let message = obj["message"].as_str().unwrap_or_default();
    if !is_error_message(message) {
        return fail("invalid message");
    }
    if !obj["retryable"].is_boolean() {
        return fail("invalid retryable");
    }
    Ok(serde_json::json!({
        "code": code,
        "message": message,
        "retryable": obj["retryable"],
    }))
}

pub fn validate_envelope(value: &Value) -> Result<Value, ValidationErr> {
    let obj = as_object(value, "envelope")?;
    if obj.get("ok") == Some(&Value::Bool(true)) {
        exact_keys(obj, &SUCCESS_ENVELOPE_KEYS)?;
        if obj.contains_key("error") {
            return fail("success envelope must not include error");
        }
        if !is_schema_version_1(&obj["schemaVersion"]) {
            return fail("unsupported schemaVersion");
        }
        let request_id = obj["requestId"].as_str().unwrap_or_default();
        if !is_request_id(request_id) {
            return fail("invalid requestId");
        }
        let operation = obj["operation"].as_str().unwrap_or_default();
        if !is_operation(operation) {
            return fail("unknown operation");
        }
        let result = validate_result(operation, &obj["result"])?;
        return Ok(serde_json::json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "ok": true,
            "operation": operation,
            "result": result,
        }));
    }
    if obj.get("ok") == Some(&Value::Bool(false)) {
        exact_keys(obj, &FAILURE_ENVELOPE_KEYS)?;
        if obj.contains_key("result") {
            return fail("failure envelope must not include result");
        }
        if !is_schema_version_1(&obj["schemaVersion"]) {
            return fail("unsupported schemaVersion");
        }
        let request_id = echo_request_id(&obj["requestId"]);
        if obj["requestId"].as_str() != Some(request_id.as_str()) {
            return fail("invalid requestId");
        }
        if !obj["operation"].is_string() {
            return fail("invalid operation");
        }
        let operation = echo_operation(&obj["operation"]);
        if obj["operation"].as_str() != Some(operation.as_str()) {
            return fail("invalid operation");
        }
        let error = validate_bridge_error(&obj["error"])?;
        if error["code"].as_str() != Some("protocol_mismatch") && !is_operation(&operation) {
            return fail("operation is required");
        }
        return Ok(serde_json::json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "ok": false,
            "operation": operation,
            "error": error,
        }));
    }
    fail("envelope.ok must be boolean")
}

pub fn exit_code_for_envelope(envelope: &Value) -> i32 {
    if envelope["ok"] == Value::Bool(true) {
        EXIT_SUCCESS
    } else if envelope["error"]["code"].as_str() == Some("protocol_mismatch") {
        EXIT_PROTOCOL_FAILURE
    } else {
        EXIT_OPERATION_FAILURE
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Operation {
    Bootstrap,
    Status,
    Stop,
    RuntimeActivate,
    ServiceInstall,
    ServiceStart,
    ServiceRepair,
    ServiceUninstall,
    LegacyTrayUninstall,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::Status => "status",
            Self::Stop => "stop",
            Self::RuntimeActivate => "runtime-activate",
            Self::ServiceInstall => "service-install",
            Self::ServiceStart => "service-start",
            Self::ServiceRepair => "service-repair",
            Self::ServiceUninstall => "service-uninstall",
            Self::LegacyTrayUninstall => "legacy-tray-uninstall",
        }
    }

    pub fn deadline_ms(self) -> u64 {
        match self {
            Self::Status => 10_000,
            Self::Bootstrap | Self::Stop => 90_000,
            Self::RuntimeActivate => RUNTIME_ACTIVATE_WATCHDOG_MS,
            Self::ServiceInstall
            | Self::ServiceStart
            | Self::ServiceRepair
            | Self::ServiceUninstall
            | Self::LegacyTrayUninstall => 120_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum StopReason {
    AppExit,
    Update,
    Uninstall,
}

impl StopReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AppExit => "app-exit",
            Self::Update => "update",
            Self::Uninstall => "uninstall",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssuedRequest {
    Empty {
        operation: Operation,
        request_id: String,
    },
    Stop {
        request_id: String,
        reason: StopReason,
    },
    RuntimeActivate {
        request_id: String,
        runtime_manifest_id: String,
    },
}

impl IssuedRequest {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Empty { request_id, .. }
            | Self::Stop { request_id, .. }
            | Self::RuntimeActivate { request_id, .. } => request_id,
        }
    }

    pub fn operation(&self) -> Operation {
        match self {
            Self::Empty { operation, .. } => *operation,
            Self::Stop { .. } => Operation::Stop,
            Self::RuntimeActivate { .. } => Operation::RuntimeActivate,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Empty {
                operation,
                request_id,
            } => serde_json::json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "operation": operation.as_str(),
                "payload": {},
            }),
            Self::Stop { request_id, reason } => serde_json::json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "operation": "stop",
                "payload": { "reason": reason.as_str() },
            }),
            Self::RuntimeActivate {
                request_id,
                runtime_manifest_id,
            } => serde_json::json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "operation": "runtime-activate",
                "payload": { "runtimeManifestId": runtime_manifest_id },
            }),
        }
    }

    pub fn encode(&self) -> String {
        let json = self.to_json();
        debug_assert!(
            parse_bridge_request(&json).is_ok(),
            "desktop-owned requests must satisfy the v1 bridge request schema"
        );
        format!("{json}\n")
    }
}

pub fn new_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn bootstrap_request() -> IssuedRequest {
    IssuedRequest::Empty {
        operation: Operation::Bootstrap,
        request_id: new_request_id(),
    }
}

pub fn status_request() -> IssuedRequest {
    IssuedRequest::Empty {
        operation: Operation::Status,
        request_id: new_request_id(),
    }
}

pub fn stop_request(reason: StopReason) -> IssuedRequest {
    IssuedRequest::Stop {
        request_id: new_request_id(),
        reason,
    }
}

pub fn runtime_activate_request(runtime_manifest_id: &str) -> Result<IssuedRequest, ValidationErr> {
    if !is_runtime_manifest_id(runtime_manifest_id) {
        return fail("invalid runtimeManifestId");
    }
    Ok(IssuedRequest::RuntimeActivate {
        request_id: new_request_id(),
        runtime_manifest_id: runtime_manifest_id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ULID: &str = "01JABCDEFGHJKMNPQRSTVWXYZ1";

    #[test]
    fn closed_enumerations_match_plan() {
        assert_eq!(
            OPERATIONS,
            [
                "bootstrap",
                "status",
                "stop",
                "runtime-activate",
                "service-install",
                "service-start",
                "service-repair",
                "service-uninstall",
                "legacy-tray-uninstall",
            ]
        );
        assert_eq!(EXIT_SUCCESS, 0);
        assert_eq!(EXIT_OPERATION_FAILURE, 1);
        assert_eq!(EXIT_PROTOCOL_FAILURE, 2);
        assert_eq!(Operation::RuntimeActivate.deadline_ms(), 135_000);
        assert_eq!(RUNTIME_ACTIVATE_WATCHDOG_MS, 135_000);
    }

    #[test]
    fn request_id_accepts_uuid_and_ulid() {
        assert!(is_request_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_request_id(ULID));
        assert!(!is_request_id(""));
        assert!(!is_request_id("bad"));
        assert!(!is_request_id(&"a".repeat(65)));
    }

    #[test]
    fn unknown_fields_and_versions_are_protocol_mismatch() {
        let bad = serde_json::json!({
            "schemaVersion": 2,
            "requestId": ULID,
            "operation": "status",
            "payload": {},
        });
        let err = parse_bridge_request(&bad).unwrap_err();
        assert_eq!(err.0.message, "unsupported schemaVersion");

        let extra = serde_json::json!({
            "schemaVersion": 1,
            "requestId": ULID,
            "operation": "status",
            "payload": {},
            "extra": 1,
        });
        let err = parse_bridge_request(&extra).unwrap_err();
        assert_eq!(err.0.message, "unknown field: extra");

        let unknown_op = serde_json::json!({
            "schemaVersion": 1,
            "requestId": ULID,
            "operation": "launch",
            "payload": {},
        });
        let err = parse_bridge_request(&unknown_op).unwrap_err();
        assert_eq!(err.0.message, "unknown operation");
    }

    #[test]
    fn issued_requests_are_closed_json_objects() {
        let req = IssuedRequest::Empty {
            operation: Operation::Bootstrap,
            request_id: ULID.to_string(),
        };
        let json = req.to_json();
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 4);
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["operation"], "bootstrap");
        assert_eq!(json["payload"], serde_json::json!({}));
        assert!(obj.contains_key("requestId"));
        assert!(!req.encode().contains("argv"));

        let activate = runtime_activate_request("ocx-runtime-2.36.0-linux").unwrap();
        let json = activate.to_json();
        assert_eq!(json["operation"], "runtime-activate");
        assert_eq!(
            json["payload"],
            serde_json::json!({ "runtimeManifestId": "ocx-runtime-2.36.0-linux" })
        );
        assert!(parse_bridge_request(&json).is_ok());
        assert!(runtime_activate_request("../runtime").is_err());
    }

    #[test]
    fn bootstrap_result_rejects_non_loopback_and_conflict_owner() {
        let ok = serde_json::json!({
            "status": "ready",
            "origin": "http://127.0.0.1:10100",
            "pid": 1234,
            "version": "2.35.0",
            "owner": "desktop-direct",
            "service": { "installed": false, "startable": false, "stateCode": "absent" },
            "allowedMutations": ["stop"],
        });
        assert!(validate_bootstrap_result(&ok).is_ok());
        let lan = serde_json::json!({
            "status": "ready",
            "origin": "http://192.168.1.9:10100",
            "pid": 1234,
            "version": "2.35.0",
            "owner": "desktop-direct",
            "service": { "installed": false, "startable": false, "stateCode": "absent" },
            "allowedMutations": ["stop"],
        });
        assert!(validate_bootstrap_result(&lan).is_err());
        let conflict = serde_json::json!({
            "status": "ready",
            "origin": "http://127.0.0.1:10100",
            "pid": 1234,
            "version": "2.35.0",
            "owner": "unknown/conflict",
            "service": { "installed": false, "startable": false, "stateCode": "absent" },
            "allowedMutations": [],
        });
        assert!(validate_bootstrap_result(&conflict).is_err());
    }
}
