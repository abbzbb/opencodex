use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::codec::{decode_stdout_object, MAX_IO_BYTES};
use crate::packaging::{
    layout_from_app, resolve_bridge_cwd, resolve_bridge_program, validate_spawn_paths,
    BridgeLayout, ResolveError, BRIDGE_SCRIPT_REL, DEBUG_BRIDGE_BIN_ENV, DEBUG_RUNTIME_ROOT_ENV,
};
use crate::protocol::{exit_code_for_envelope, validate_envelope, IssuedRequest};

/// Sidecar argv is closed. Operation, request JSON, and tokens never appear here.
pub const BRIDGE_SCRIPT_ARGV: [&str; 1] = [BRIDGE_SCRIPT_REL];
const BLOCKED_CHILD_ENV: [&str; 10] = [
    "BUN_INSPECT",
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "OPENSSL_CONF",
    "DOTENV_CONFIG_PATH",
    "WIN_DLL",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

impl BridgeSpec {
    pub fn new(program: PathBuf, cwd: PathBuf) -> Self {
        Self {
            program,
            args: BRIDGE_SCRIPT_ARGV
                .iter()
                .map(|arg| (*arg).to_string())
                .collect(),
            cwd,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeProcessOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeClientError {
    Protocol { message: String },
    Spawn { message: String },
    Runtime { message: String },
    DeadlineExceeded { operation: &'static str },
}

impl BridgeClientError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Protocol { .. } => "bridge_protocol_error",
            Self::Spawn { .. } => "bridge_protocol_error",
            Self::Runtime { .. } => "runtime_integrity_failed",
            Self::DeadlineExceeded { .. } => "deadline_exceeded",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Protocol { message } | Self::Spawn { message } | Self::Runtime { message } => {
                message.clone()
            }
            Self::DeadlineExceeded { operation } => {
                format!("{operation} deadline exceeded")
            }
        }
    }
}

impl From<ResolveError> for BridgeClientError {
    fn from(err: ResolveError) -> Self {
        let _ = err.code();
        Self::Runtime {
            message: err.message().to_string(),
        }
    }
}

/// Interpret one bridge process result. Stderr is never used to infer success.
pub fn interpret_bridge_output(
    request: &IssuedRequest,
    output: &BridgeProcessOutput,
) -> Result<Value, BridgeClientError> {
    let parsed = decode_stdout_object(&output.stdout)
        .map_err(|message| BridgeClientError::Protocol { message })?;
    let envelope = validate_envelope(&parsed).map_err(|err| BridgeClientError::Protocol {
        message: err.message,
    })?;
    if envelope["requestId"].as_str() != Some(request.request_id()) {
        return Err(BridgeClientError::Protocol {
            message: "requestId mismatch".to_string(),
        });
    }
    let reported_op = envelope["operation"].as_str().unwrap_or_default();
    if envelope["ok"] == Value::Bool(true) && reported_op != request.operation().as_str() {
        return Err(BridgeClientError::Protocol {
            message: "operation mismatch".to_string(),
        });
    }
    if envelope["ok"] == Value::Bool(false)
        && envelope["error"]["code"].as_str() != Some("protocol_mismatch")
        && reported_op != request.operation().as_str()
    {
        return Err(BridgeClientError::Protocol {
            message: "operation mismatch".to_string(),
        });
    }
    let expected_exit = exit_code_for_envelope(&envelope);
    if output.exit_code != expected_exit {
        return Err(BridgeClientError::Protocol {
            message: format!(
                "exit code {} does not match envelope (expected {expected_exit})",
                output.exit_code
            ),
        });
    }
    let _ = truncate_log(&output.stderr);
    Ok(envelope)
}

fn truncate_log(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() <= MAX_IO_BYTES {
        bytes.to_vec()
    } else {
        bytes[..MAX_IO_BYTES].to_vec()
    }
}

fn bounded_read(reader: &mut impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut captured = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        if remaining > 0 {
            captured.extend_from_slice(&chunk[..n.min(remaining)]);
        }
    }
    Ok(captured)
}

fn terminate_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
    operation: &'static str,
) -> Result<std::process::ExitStatus, BridgeClientError> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() >= timeout => {
                terminate_child(child);
                return Err(BridgeClientError::DeadlineExceeded { operation });
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                terminate_child(child);
                return Err(BridgeClientError::Spawn {
                    message: "failed to start the runtime bridge".to_string(),
                });
            }
        }
    }
}

fn expected_bridge_args() -> Vec<String> {
    BRIDGE_SCRIPT_ARGV
        .iter()
        .map(|arg| (*arg).to_string())
        .collect()
}

/// Spawn a short-lived std process. The long-running proxy is never retained
/// as a tauri-plugin-shell child; this crate does not depend on that plugin.
pub fn invoke_bridge(
    spec: &BridgeSpec,
    request: &IssuedRequest,
) -> Result<Value, BridgeClientError> {
    if spec.args != expected_bridge_args() {
        return Err(BridgeClientError::Protocol {
            message: "bridge argv must be the fixed bootstrap script path".to_string(),
        });
    }
    validate_spawn_paths(&spec.program, &spec.cwd)?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove(DEBUG_BRIDGE_BIN_ENV)
        .env_remove(DEBUG_RUNTIME_ROOT_ENV);
    for key in BLOCKED_CHILD_ENV {
        command.env_remove(key);
    }
    let mut child = command.spawn().map_err(|_| BridgeClientError::Spawn {
        message: "failed to start the runtime bridge".to_string(),
    })?;
    let write_failed = match child.stdin.take() {
        Some(mut stdin) => stdin.write_all(request.encode().as_bytes()).is_err(),
        None => true,
    };
    if write_failed {
        terminate_child(&mut child);
        return Err(BridgeClientError::Spawn {
            message: "failed to start the runtime bridge".to_string(),
        });
    }
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = thread::spawn(move || match stdout_pipe {
        Some(mut pipe) => bounded_read(&mut pipe, MAX_IO_BYTES + 1).unwrap_or_default(),
        None => Vec::new(),
    });
    let stderr_handle = thread::spawn(move || match stderr_pipe {
        Some(mut pipe) => bounded_read(&mut pipe, MAX_IO_BYTES).unwrap_or_default(),
        None => Vec::new(),
    });
    let timeout = Duration::from_millis(request.operation().deadline_ms());
    let status = wait_with_timeout(&mut child, timeout, request.operation().as_str());
    let stdout = stdout_handle.join().unwrap_or_else(|_| Vec::new());
    let stderr = stderr_handle.join().unwrap_or_else(|_| Vec::new());
    let status = status?;
    let exit_code = status.code().unwrap_or(1);
    interpret_bridge_output(
        request,
        &BridgeProcessOutput {
            stdout,
            stderr,
            exit_code,
        },
    )
}

pub fn default_bridge_spec<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<BridgeSpec, BridgeClientError> {
    let layout = layout_from_app(app)?;
    bridge_spec_from_layout(&layout)
}

pub fn bridge_spec_from_layout(layout: &BridgeLayout) -> Result<BridgeSpec, BridgeClientError> {
    let program = resolve_bridge_program(layout)?;
    let cwd = resolve_bridge_cwd(layout)?;
    validate_spawn_paths(&program, &cwd)?;
    Ok(BridgeSpec::new(program, cwd))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{bootstrap_request, IssuedRequest, Operation, StopReason};

    fn issued_status() -> IssuedRequest {
        IssuedRequest::Empty {
            operation: Operation::Status,
            request_id: "01JABCDEFGHJKMNPQRSTVWXYZ1".to_string(),
        }
    }

    fn success_status_envelope(request_id: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "ok": true,
                "operation": "status",
                "result": {
                    "status": "ready",
                    "origin": "http://localhost:10100",
                    "pid": 9,
                    "version": "2.35.0",
                    "owner": "desktop-direct",
                    "service": { "installed": false, "startable": false, "stateCode": "absent" },
                    "allowedMutations": ["stop"]
                }
            })
        )
    }

    #[test]
    fn argv_is_fixed_and_excludes_operations() {
        let spec = BridgeSpec::new(PathBuf::from("ocx-runtime"), PathBuf::from("/tmp"));
        assert_eq!(spec.args, ["desktop/runtime/bootstrap.ts"]);
        for op in crate::protocol::OPERATIONS {
            assert_ne!(spec.args[0], op);
        }
        let req = bootstrap_request();
        assert!(!spec.args.iter().any(|arg| arg == req.request_id()));
        assert!(!spec.program.as_os_str().is_empty());
        for key in ["NODE_OPTIONS", "BUN_INSPECT", "LD_PRELOAD"] {
            assert!(BLOCKED_CHILD_ENV.contains(&key));
        }
    }

    #[test]
    fn invoke_rejects_unsafe_paths_without_leaking_them() {
        let spec = BridgeSpec::new(
            PathBuf::from("/tmp/ocx-missing-bridge"),
            PathBuf::from("/tmp/ocx-missing-runtime"),
        );
        let err = invoke_bridge(&spec, &issued_status()).unwrap_err();
        assert_eq!(err.code(), "runtime_integrity_failed");
        assert!(!err.message().contains("/tmp"));
        assert!(!err.message().contains("ocx-missing-bridge"));
        assert!(!err.message().contains("ocx-missing-runtime"));
    }

    #[test]
    fn protocol_mismatch_on_stdout_pollution_and_exit_disagreement() {
        let request = issued_status();
        let polluted = BridgeProcessOutput {
            stdout: b"{\"ok\":true}\nprogress\n".to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        };
        let err = interpret_bridge_output(&request, &polluted).unwrap_err();
        assert_eq!(err.code(), "bridge_protocol_error");

        let valid = success_status_envelope(request.request_id());
        let wrong_exit = BridgeProcessOutput {
            stdout: valid.into_bytes(),
            stderr: b"human log".to_vec(),
            exit_code: 1,
        };
        let err = interpret_bridge_output(&request, &wrong_exit).unwrap_err();
        assert_eq!(err.code(), "bridge_protocol_error");
        assert!(err.message().contains("exit code"));
    }

    #[test]
    fn request_id_and_schema_mismatch_are_protocol_errors() {
        let request = issued_status();
        let wrong_id = format!(
            "{}\n",
            serde_json::json!({
                "schemaVersion": 1,
                "requestId": "01JABCDEFGHJKMNPQRSTVWXYZ2",
                "ok": true,
                "operation": "status",
                "result": {
                    "status": "stopped",
                    "origin": null,
                    "pid": null,
                    "version": null,
                    "owner": "existing-external",
                    "service": { "installed": false, "startable": false, "stateCode": "absent" },
                    "allowedMutations": []
                }
            })
        );
        let err = interpret_bridge_output(
            &request,
            &BridgeProcessOutput {
                stdout: wrong_id.into_bytes(),
                stderr: Vec::new(),
                exit_code: 0,
            },
        )
        .unwrap_err();
        assert_eq!(err.message(), "requestId mismatch");

        let bad_schema = format!(
            "{}\n",
            serde_json::json!({
                "schemaVersion": 2,
                "requestId": request.request_id(),
                "ok": false,
                "operation": "status",
                "error": { "code": "protocol_mismatch", "message": "bad", "retryable": false }
            })
        );
        let err = interpret_bridge_output(
            &request,
            &BridgeProcessOutput {
                stdout: bad_schema.into_bytes(),
                stderr: Vec::new(),
                exit_code: 2,
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "bridge_protocol_error");
    }

    #[test]
    fn valid_success_and_operation_failure_envelopes() {
        let request = issued_status();
        let ok = interpret_bridge_output(
            &request,
            &BridgeProcessOutput {
                stdout: success_status_envelope(request.request_id()).into_bytes(),
                stderr: b"ignored".to_vec(),
                exit_code: 0,
            },
        )
        .unwrap();
        assert_eq!(ok["ok"], true);

        let stop = IssuedRequest::Stop {
            request_id: "01JABCDEFGHJKMNPQRSTVWXYZ1".to_string(),
            reason: StopReason::AppExit,
        };
        let failed = format!(
            "{}\n",
            serde_json::json!({
                "schemaVersion": 1,
                "requestId": stop.request_id(),
                "ok": false,
                "operation": "stop",
                "error": {
                    "code": "stop_failed",
                    "message": "stop failed",
                    "retryable": true
                }
            })
        );
        let envelope = interpret_bridge_output(
            &stop,
            &BridgeProcessOutput {
                stdout: failed.into_bytes(),
                stderr: Vec::new(),
                exit_code: 1,
            },
        )
        .unwrap();
        assert_eq!(envelope["error"]["code"], "stop_failed");
    }

    #[test]
    fn stderr_is_not_parsed_for_success() {
        let request = issued_status();
        let stdout = success_status_envelope(request.request_id());
        let output = BridgeProcessOutput {
            stdout: stdout.into_bytes(),
            stderr: b"{\"ok\":false,\"error\":\"nope\"}\n".to_vec(),
            exit_code: 0,
        };
        assert!(interpret_bridge_output(&request, &output).is_ok());
    }
}
