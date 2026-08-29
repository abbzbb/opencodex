use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::codec::{decode_stdout_object, MAX_IO_BYTES};
use crate::packaging::{
    is_target_triple, parse_version_pointer, read_current_pointer, resolve_bridge_program,
    resolve_packaged_runtime_source, should_run_packaged_staging, validate_installer_spawn_paths,
    BridgeLayout, CurrentPointer, ResolveError, VersionPointer, DEBUG_BRIDGE_BIN_ENV,
    DEBUG_RUNTIME_ROOT_ENV, INSTALL_SCRIPT_REL,
};

pub const INSTALL_DEADLINE_MS: u64 = 180_000;
pub const INSTALL_SCRIPT_ARGV: [&str; 1] = [INSTALL_SCRIPT_REL];
const MAX_STABLE_ROOT_BYTES: usize = 4096;
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
pub struct StagingSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub stable_root: PathBuf,
    pub target: String,
}

impl StagingSpec {
    pub fn new(program: PathBuf, cwd: PathBuf, stable_root: PathBuf, target: String) -> Self {
        Self {
            program,
            args: INSTALL_SCRIPT_ARGV
                .iter()
                .map(|arg| (*arg).to_string())
                .collect(),
            cwd,
            stable_root,
            target,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagingProcessOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagingSuccess {
    pub current: VersionPointer,
    pub previous: Option<VersionPointer>,
    pub staged: VersionPointer,
    pub reused: bool,
    pub published: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StagingClientError {
    Protocol,
    Spawn,
    Runtime { retryable: bool },
    DeadlineExceeded,
}

impl StagingClientError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::Protocol | Self::Spawn | Self::Runtime { .. } => "runtime_integrity_failed",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::DeadlineExceeded => "packaged runtime installation deadline exceeded",
            Self::Protocol => "packaged runtime installer returned an invalid response",
            Self::Spawn => "packaged runtime installer could not start",
            Self::Runtime { .. } => "packaged runtime installation failed",
        }
    }
}

impl From<ResolveError> for StagingClientError {
    fn from(_: ResolveError) -> Self {
        Self::Runtime { retryable: false }
    }
}

fn exact_keys(value: &Map<String, Value>, expected: &[&str]) -> bool {
    value.len() == expected.len()
        && expected.iter().all(|key| value.contains_key(*key))
        && value.keys().all(|key| expected.contains(&key.as_str()))
}

fn object(value: &Value) -> Result<&Map<String, Value>, StagingClientError> {
    match value {
        Value::Object(map)
            if !map.contains_key("__proto__")
                && !map.contains_key("constructor")
                && !map.contains_key("prototype") =>
        {
            Ok(map)
        }
        _ => Err(StagingClientError::Protocol),
    }
}

fn parse_success(
    value: &Value,
    expected_target: &str,
) -> Result<StagingSuccess, StagingClientError> {
    let result = object(value)?;
    if !exact_keys(
        result,
        &["current", "previous", "staged", "reused", "published"],
    ) {
        return Err(StagingClientError::Protocol);
    }
    let current =
        parse_version_pointer(&result["current"]).map_err(|_| StagingClientError::Protocol)?;
    let previous = if result["previous"].is_null() {
        None
    } else {
        Some(parse_version_pointer(&result["previous"]).map_err(|_| StagingClientError::Protocol)?)
    };
    let staged =
        parse_version_pointer(&result["staged"]).map_err(|_| StagingClientError::Protocol)?;
    let reused = result["reused"]
        .as_bool()
        .ok_or(StagingClientError::Protocol)?;
    let published = result["published"]
        .as_bool()
        .ok_or(StagingClientError::Protocol)?;
    if current.target != expected_target
        || staged.target != expected_target
        || previous
            .as_ref()
            .is_some_and(|pointer| pointer.target != expected_target)
        || previous
            .as_ref()
            .is_some_and(|pointer| pointer.version == current.version)
        || (published && (current != staged || previous.is_some()))
        || (!published && current == staged && !reused)
    {
        return Err(StagingClientError::Protocol);
    }
    Ok(StagingSuccess {
        current,
        previous,
        staged,
        reused,
        published,
    })
}

pub fn interpret_staging_output(
    expected_target: &str,
    output: &StagingProcessOutput,
) -> Result<StagingSuccess, StagingClientError> {
    if !is_target_triple(expected_target) {
        return Err(StagingClientError::Protocol);
    }
    let parsed = decode_stdout_object(&output.stdout).map_err(|_| StagingClientError::Protocol)?;
    let envelope = object(&parsed)?;
    if envelope.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(StagingClientError::Protocol);
    }
    match envelope.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            if !exact_keys(envelope, &["schemaVersion", "ok", "result"]) || output.exit_code != 0 {
                return Err(StagingClientError::Protocol);
            }
            parse_success(&envelope["result"], expected_target)
        }
        Some(false) => {
            if !exact_keys(envelope, &["schemaVersion", "ok", "error"])
                || !matches!(output.exit_code, 1 | 2)
            {
                return Err(StagingClientError::Protocol);
            }
            let error = object(&envelope["error"])?;
            if !exact_keys(error, &["code", "message", "retryable"]) {
                return Err(StagingClientError::Protocol);
            }
            let code = error["code"].as_str().ok_or(StagingClientError::Protocol)?;
            let message = error["message"]
                .as_str()
                .ok_or(StagingClientError::Protocol)?;
            let retryable = error["retryable"]
                .as_bool()
                .ok_or(StagingClientError::Protocol)?;
            let expected_exit = if code == "protocol_mismatch" { 2 } else { 1 };
            let expected_message = if code == "protocol_mismatch" {
                if retryable {
                    return Err(StagingClientError::Protocol);
                }
                "runtime install request is invalid"
            } else if code == "runtime_integrity_failed" {
                "packaged runtime installation failed"
            } else {
                return Err(StagingClientError::Protocol);
            };
            if output.exit_code != expected_exit || message != expected_message {
                return Err(StagingClientError::Protocol);
            }
            Err(StagingClientError::Runtime { retryable })
        }
        None => Err(StagingClientError::Protocol),
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
) -> Result<std::process::ExitStatus, StagingClientError> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() >= timeout => {
                terminate_child(child);
                return Err(StagingClientError::DeadlineExceeded);
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                terminate_child(child);
                return Err(StagingClientError::Spawn);
            }
        }
    }
}

fn expected_args() -> Vec<String> {
    INSTALL_SCRIPT_ARGV
        .iter()
        .map(|arg| (*arg).to_string())
        .collect()
}

fn encode_request(spec: &StagingSpec) -> Result<String, StagingClientError> {
    if !is_target_triple(&spec.target) || !spec.stable_root.is_absolute() {
        return Err(StagingClientError::Protocol);
    }
    let stable_root = spec
        .stable_root
        .to_str()
        .ok_or(StagingClientError::Protocol)?;
    if stable_root.len() > MAX_STABLE_ROOT_BYTES || stable_root.chars().any(char::is_control) {
        return Err(StagingClientError::Protocol);
    }
    serde_json::to_string(&serde_json::json!({
        "schemaVersion": 1,
        "target": spec.target,
        "stableRoot": stable_root,
    }))
    .map(|json| format!("{json}\n"))
    .map_err(|_| StagingClientError::Protocol)
}

pub fn invoke_staging(spec: &StagingSpec) -> Result<StagingSuccess, StagingClientError> {
    if spec.args != expected_args() {
        return Err(StagingClientError::Protocol);
    }
    validate_installer_spawn_paths(&spec.program, &spec.cwd)?;
    let request = encode_request(spec)?;
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
    let mut child = command.spawn().map_err(|_| StagingClientError::Spawn)?;
    let write_result = child
        .stdin
        .take()
        .ok_or(StagingClientError::Spawn)
        .and_then(|mut stdin| {
            stdin
                .write_all(request.as_bytes())
                .map_err(|_| StagingClientError::Spawn)
        });
    if let Err(error) = write_result {
        terminate_child(&mut child);
        return Err(error);
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
    let status = wait_with_timeout(&mut child, Duration::from_millis(INSTALL_DEADLINE_MS));
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    let status = status?;
    let _ = stderr;
    interpret_staging_output(
        &spec.target,
        &StagingProcessOutput {
            stdout,
            stderr: Vec::new(),
            exit_code: status.code().unwrap_or(1),
        },
    )
}

pub fn staging_spec_from_layout(
    layout: &BridgeLayout,
) -> Result<Option<StagingSpec>, StagingClientError> {
    if !should_run_packaged_staging(layout) {
        return Ok(None);
    }
    let program = resolve_bridge_program(layout)?;
    let cwd = resolve_packaged_runtime_source(layout)?;
    validate_installer_spawn_paths(&program, &cwd)?;
    Ok(Some(StagingSpec::new(
        program,
        cwd,
        layout.stable_root.clone(),
        layout.target_triple.clone(),
    )))
}

pub fn install_packaged_runtime(layout: &BridgeLayout) -> Result<(), StagingClientError> {
    let Some(spec) = staging_spec_from_layout(layout)? else {
        return Ok(());
    };
    let success = invoke_staging(&spec)?;
    let current = read_current_pointer(&spec.stable_root)?;
    if current
        != (CurrentPointer {
            current: success.current,
            previous: success.previous,
        })
    {
        return Err(StagingClientError::Protocol);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: &str = "x86_64-unknown-linux-gnu";

    fn pointer(version: &str) -> Value {
        serde_json::json!({
            "id": format!("ocx-runtime-{version}-{TARGET}"),
            "version": version,
            "target": TARGET,
            "relPath": format!("versions/{version}")
        })
    }

    fn success_output() -> StagingProcessOutput {
        StagingProcessOutput {
            stdout: format!(
                "{}\n",
                serde_json::json!({
                    "schemaVersion": 1,
                    "ok": true,
                    "result": {
                        "current": pointer("2.36.0"),
                        "previous": null,
                        "staged": pointer("2.36.0"),
                        "reused": false,
                        "published": true
                    }
                })
            )
            .into_bytes(),
            stderr: b"ignored diagnostics".to_vec(),
            exit_code: 0,
        }
    }

    #[test]
    fn installer_argv_is_fixed_and_separate_from_bridge_operations() {
        let spec = StagingSpec::new(
            PathBuf::from("ocx-runtime"),
            PathBuf::from("resource-runtime"),
            PathBuf::from("/stable/runtime"),
            TARGET.to_string(),
        );
        assert_eq!(spec.args, ["desktop/runtime/install.ts"]);
        for operation in crate::protocol::OPERATIONS {
            assert_ne!(spec.args[0], operation);
        }
        assert_eq!(INSTALL_DEADLINE_MS, 180_000);
    }

    #[test]
    fn accepts_exact_success_and_rejects_pollution_or_exit_mismatch() {
        let success = interpret_staging_output(TARGET, &success_output()).unwrap();
        assert_eq!(success.current.version, "2.36.0");
        assert!(success.published);

        let mut polluted = success_output();
        polluted.stdout.extend_from_slice(b"progress\n");
        assert_eq!(
            interpret_staging_output(TARGET, &polluted).unwrap_err(),
            StagingClientError::Protocol
        );

        let mut wrong_exit = success_output();
        wrong_exit.exit_code = 1;
        assert_eq!(
            interpret_staging_output(TARGET, &wrong_exit).unwrap_err(),
            StagingClientError::Protocol
        );
    }

    #[test]
    fn rejects_wrong_target_unknown_fields_and_invalid_publish_claim() {
        let mut wrong_target = success_output();
        let mut value: Value = serde_json::from_slice(&wrong_target.stdout).unwrap();
        value["result"]["staged"]["target"] = Value::String("aarch64-unknown-linux-gnu".into());
        wrong_target.stdout = format!("{value}\n").into_bytes();
        assert_eq!(
            interpret_staging_output(TARGET, &wrong_target).unwrap_err(),
            StagingClientError::Protocol
        );

        let mut extra = success_output();
        let mut value: Value = serde_json::from_slice(&extra.stdout).unwrap();
        value["extra"] = Value::Bool(true);
        extra.stdout = format!("{value}\n").into_bytes();
        assert_eq!(
            interpret_staging_output(TARGET, &extra).unwrap_err(),
            StagingClientError::Protocol
        );

        let mut inconsistent = success_output();
        let mut value: Value = serde_json::from_slice(&inconsistent.stdout).unwrap();
        value["result"]["staged"] = pointer("2.37.0");
        inconsistent.stdout = format!("{value}\n").into_bytes();
        assert_eq!(
            interpret_staging_output(TARGET, &inconsistent).unwrap_err(),
            StagingClientError::Protocol
        );

        let mut published_with_previous = success_output();
        let mut value: Value = serde_json::from_slice(&published_with_previous.stdout).unwrap();
        value["result"]["previous"] = pointer("2.35.0");
        published_with_previous.stdout = format!("{value}\n").into_bytes();
        assert_eq!(
            interpret_staging_output(TARGET, &published_with_previous).unwrap_err(),
            StagingClientError::Protocol
        );

        let mut unchanged_without_reuse = success_output();
        let mut value: Value = serde_json::from_slice(&unchanged_without_reuse.stdout).unwrap();
        value["result"]["published"] = Value::Bool(false);
        value["result"]["reused"] = Value::Bool(false);
        unchanged_without_reuse.stdout = format!("{value}\n").into_bytes();
        assert_eq!(
            interpret_staging_output(TARGET, &unchanged_without_reuse).unwrap_err(),
            StagingClientError::Protocol
        );
    }

    #[test]
    fn accepts_only_closed_failure_envelopes() {
        let runtime = StagingProcessOutput {
            stdout: b"{\"schemaVersion\":1,\"ok\":false,\"error\":{\"code\":\"runtime_integrity_failed\",\"message\":\"packaged runtime installation failed\",\"retryable\":true}}\n".to_vec(),
            stderr: Vec::new(),
            exit_code: 1,
        };
        assert_eq!(
            interpret_staging_output(TARGET, &runtime).unwrap_err(),
            StagingClientError::Runtime { retryable: true }
        );

        let mut wrong_exit = runtime;
        wrong_exit.exit_code = 2;
        assert_eq!(
            interpret_staging_output(TARGET, &wrong_exit).unwrap_err(),
            StagingClientError::Protocol
        );
    }
}
