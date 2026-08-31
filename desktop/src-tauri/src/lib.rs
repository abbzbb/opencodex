mod bridge;
mod codec;
mod lifecycle;
mod navigation;
mod origin;
mod packaging;
mod protocol;
mod staging;
mod tray;

use std::fs::symlink_metadata;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::bridge::{
    bridge_spec_from_layout, default_bridge_spec, invoke_bridge, BridgeClientError, BridgeSpec,
};
use crate::lifecycle::{quit_decision_from_stop, QuitDecision, QuitPhase};
use crate::navigation::{init_plugin as navigation_plugin, set_allowed_origin, NavigationPolicy};
use crate::packaging::{
    layout_from_app, read_current_pointer, BridgeLayout, CurrentPointer, CURRENT_POINTER_NAME,
};
use crate::protocol::{
    bootstrap_request, runtime_activate_request, status_request, stop_request, StopReason,
};
use crate::staging::{install_packaged_runtime, StagingSuccess};
use crate::tray::{install_tray, show_main_window, TRAY_OPEN, TRAY_QUIT, TRAY_STATUS};

pub struct AppState {
    pub navigation: Arc<Mutex<NavigationPolicy>>,
    pub phase: Arc<Mutex<QuitPhase>>,
}

fn lock_phase(state: &AppState) -> std::sync::MutexGuard<'_, QuitPhase> {
    state
        .phase
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn plugin_registration_order(deep_link_enabled: bool) -> Vec<&'static str> {
    let mut names = vec!["single-instance"];
    if deep_link_enabled {
        names.push("deep-link");
    }
    names.push("opener");
    names.push("opencodex-navigation");
    names
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn set_shell_copy(app: &AppHandle, title: &str, message: &str, detail: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            r#"
            (() => {{
              const title = document.getElementById("title");
              const message = document.getElementById("message");
              const detail = document.getElementById("detail");
              if (title) title.textContent = {title};
              if (message) message.textContent = {message};
              if (detail) detail.textContent = {detail};
            }})();
            "#,
            title = json_string(title),
            message = json_string(message),
            detail = json_string(detail),
        );
        let _ = window.eval(&script);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn error_message(envelope_or_client: Result<&Value, String>) -> String {
    match envelope_or_client {
        Ok(value) if value["ok"] == Value::Bool(false) => format!(
            "{}: {}",
            value["error"]["code"].as_str().unwrap_or("error"),
            value["error"]["message"].as_str().unwrap_or("failed")
        ),
        Ok(value) => value.to_string(),
        Err(message) => message,
    }
}

fn attach_dashboard(app: &AppHandle, origin: &str) -> Result<(), &'static str> {
    let url = origin
        .parse::<tauri::Url>()
        .map_err(|_| "bridge returned an invalid dashboard origin")?;
    let window = app
        .get_webview_window("main")
        .ok_or("main window is unavailable")?;
    window
        .navigate(url)
        .map_err(|_| "dashboard navigation failed")?;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

fn has_published_runtime(layout: &BridgeLayout) -> bool {
    match symlink_metadata(layout.stable_root.join(CURRENT_POINTER_NAME)) {
        Ok(_) => true,
        Err(err) => err.kind() != std::io::ErrorKind::NotFound,
    }
}

fn bootstrap_with_reconciliation(spec: &BridgeSpec) -> Result<Value, BridgeClientError> {
    let initial = invoke_bridge(spec, &bootstrap_request())?;
    if initial["ok"] == Value::Bool(true) || initial["error"]["retryable"] != Value::Bool(true) {
        return Ok(initial);
    }
    let status = match invoke_bridge(spec, &status_request()) {
        Ok(status) => status,
        Err(_) => return Ok(initial),
    };
    if status["ok"] != Value::Bool(true) || status["result"]["status"] == "pending" {
        return Ok(initial);
    }
    invoke_bridge(spec, &bootstrap_request())
}

fn staged_activation_required(staged: &StagingSuccess) -> bool {
    !staged.published && staged.current != staged.staged
}

fn activation_pointer_matches(staged: &StagingSuccess, observed: &CurrentPointer) -> bool {
    observed.current == staged.staged && observed.previous.as_ref() == Some(&staged.current)
}

fn previous_pointer_matches(staged: &StagingSuccess, observed: &CurrentPointer) -> bool {
    observed.current == staged.current && observed.previous == staged.previous
}

fn activation_result_ready(envelope: &Value) -> bool {
    envelope["ok"] == Value::Bool(true)
        && envelope["result"]["changed"] == Value::Bool(true)
        && envelope["result"]["proxyStatus"] == "ready"
}

fn status_confirms_direct_ready(envelope: &Value, expected_version: &str) -> bool {
    envelope["ok"] == Value::Bool(true)
        && envelope["result"]["status"] == "ready"
        && envelope["result"]["owner"] == "desktop-direct"
        && envelope["result"]["version"] == expected_version
}

fn bootstrap_allows_runtime_activation(envelope: &Value) -> bool {
    envelope["result"]["allowedMutations"]
        .as_array()
        .is_some_and(|mutations| mutations.iter().any(|value| value == "runtime-activate"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivationReconciliation {
    CandidateReady,
    PreviousReady,
    Unknown,
}

fn reconcile_runtime_activation(
    layout: &BridgeLayout,
    staged: &StagingSuccess,
) -> ActivationReconciliation {
    let before = match read_current_pointer(&layout.stable_root) {
        Ok(pointer) => pointer,
        Err(_) => return ActivationReconciliation::Unknown,
    };
    let (state, expected_version) = if activation_pointer_matches(staged, &before) {
        (
            ActivationReconciliation::CandidateReady,
            staged.staged.version.as_str(),
        )
    } else if previous_pointer_matches(staged, &before) {
        (
            ActivationReconciliation::PreviousReady,
            staged.current.version.as_str(),
        )
    } else {
        return ActivationReconciliation::Unknown;
    };
    let spec = match bridge_spec_from_layout(layout) {
        Ok(spec) => spec,
        Err(_) => return ActivationReconciliation::Unknown,
    };
    let status = match invoke_bridge(&spec, &status_request()) {
        Ok(status) => status,
        Err(_) => return ActivationReconciliation::Unknown,
    };
    if !status_confirms_direct_ready(&status, expected_version) {
        return ActivationReconciliation::Unknown;
    }
    match read_current_pointer(&layout.stable_root) {
        Ok(after) if after == before => state,
        _ => ActivationReconciliation::Unknown,
    }
}

fn bootstrap_and_attach(app: &AppHandle) {
    let layout = match layout_from_app(app) {
        Ok(layout) => layout,
        Err(err) => {
            set_shell_copy(
                app,
                "OpenCodex could not start",
                "The packaged runtime layout is not available.",
                &format!("{}: {}", err.code(), err.message()),
            );
            return;
        }
    };
    let preflight = if has_published_runtime(&layout) {
        let spec = match bridge_spec_from_layout(&layout) {
            Ok(spec) => spec,
            Err(err) => {
                set_shell_copy(
                    app,
                    "OpenCodex could not start",
                    "The published runtime could not be verified before installation.",
                    &format!("{}: {}", err.code(), err.message()),
                );
                return;
            }
        };
        match bootstrap_with_reconciliation(&spec) {
            Ok(envelope) if envelope["ok"] == Value::Bool(true) => Some((spec, envelope)),
            Ok(envelope) => {
                set_shell_copy(
                    app,
                    "OpenCodex could not start",
                    "The current runtime could not be reconciled before installation.",
                    &error_message(Ok(&envelope)),
                );
                return;
            }
            Err(err) => {
                set_shell_copy(
                    app,
                    "OpenCodex could not start",
                    "The current runtime bootstrap request failed before installation.",
                    &format!("{}: {}", err.code(), err.message()),
                );
                return;
            }
        }
    } else {
        None
    };

    let staged = match install_packaged_runtime(&layout) {
        Ok(staged) => staged,
        Err(err) => {
            set_shell_copy(
                app,
                "OpenCodex could not start",
                "The packaged runtime could not be installed safely.",
                &format!("{}: {}", err.code(), err.message()),
            );
            return;
        }
    };

    if let Some(staged) = staged
        .as_ref()
        .filter(|value| staged_activation_required(value))
    {
        let Some((spec, bootstrap)) = preflight.as_ref() else {
            set_shell_copy(
                app,
                "OpenCodex could not start",
                "The staged runtime cannot replace an unverified current runtime.",
                "runtime_integrity_failed: activation preflight is unavailable",
            );
            return;
        };
        match bootstrap["result"]["owner"].as_str() {
            Some("desktop-direct") => {
                if !bootstrap_allows_runtime_activation(bootstrap) {
                    set_shell_copy(
                        app,
                        "OpenCodex could not start",
                        "The current runtime does not advertise safe runtime activation.",
                        "unsupported_operation: runtime-activate capability is unavailable",
                    );
                    return;
                }
                let request = match runtime_activate_request(&staged.staged.id) {
                    Ok(request) => request,
                    Err(_) => {
                        set_shell_copy(
                            app,
                            "OpenCodex could not start",
                            "The staged runtime identity is invalid.",
                            "runtime_integrity_failed: activation request is invalid",
                        );
                        return;
                    }
                };
                let failure_detail = match invoke_bridge(spec, &request) {
                    Ok(envelope) if activation_result_ready(&envelope) => None,
                    Ok(envelope) => Some(error_message(Ok(&envelope))),
                    Err(err) => Some(format!("{}: {}", err.code(), err.message())),
                };
                if let Some(detail) = failure_detail {
                    match reconcile_runtime_activation(&layout, staged) {
                        ActivationReconciliation::CandidateReady => {}
                        ActivationReconciliation::PreviousReady => {
                            set_shell_copy(
                                app,
                                "OpenCodex could not start",
                                "The new runtime was not activated; the previous runtime is verified ready.",
                                &detail,
                            );
                            return;
                        }
                        ActivationReconciliation::Unknown => {
                            set_shell_copy(
                                app,
                                "OpenCodex could not start",
                                "The runtime activation outcome is unresolved; recovery is required before retrying.",
                                &detail,
                            );
                            return;
                        }
                    }
                }
                let observed = match read_current_pointer(&layout.stable_root) {
                    Ok(pointer) => pointer,
                    Err(err) => {
                        set_shell_copy(
                            app,
                            "OpenCodex could not start",
                            "The activated runtime pointer could not be verified.",
                            &format!("{}: {}", err.code(), err.message()),
                        );
                        return;
                    }
                };
                if !activation_pointer_matches(staged, &observed) {
                    set_shell_copy(
                        app,
                        "OpenCodex could not start",
                        "The activated runtime pointer does not match the staged runtime.",
                        "runtime_integrity_failed: activation pointer mismatch",
                    );
                    return;
                }
            }
            Some("existing-external" | "desktop-service") => {}
            _ => {
                set_shell_copy(
                    app,
                    "OpenCodex could not start",
                    "The staged runtime cannot replace a conflicting runtime owner.",
                    "ownership_conflict: runtime activation is not permitted",
                );
                return;
            }
        }
    }

    let spec = match bridge_spec_from_layout(&layout) {
        Ok(spec) => spec,
        Err(err) => {
            set_shell_copy(
                app,
                "OpenCodex could not start",
                "The short-lived runtime bridge is not available.",
                &format!("{}: {}", err.code(), err.message()),
            );
            return;
        }
    };
    match bootstrap_with_reconciliation(&spec) {
        Ok(envelope) if envelope["ok"] == Value::Bool(true) => {
            if let Some(origin) = envelope["result"]["origin"].as_str() {
                if let Some(state) = app.try_state::<AppState>() {
                    set_allowed_origin(&state.navigation, Some(origin.to_string()));
                }
                if let Err(message) = attach_dashboard(app, origin) {
                    set_shell_copy(
                        app,
                        "OpenCodex could not start",
                        "The desktop shell could not open the ready local dashboard.",
                        message,
                    );
                }
            }
        }
        Ok(envelope) => {
            set_shell_copy(
                app,
                "OpenCodex could not start",
                "Bootstrap did not return a ready loopback origin.",
                &error_message(Ok(&envelope)),
            );
        }
        Err(err) => {
            set_shell_copy(
                app,
                "OpenCodex could not start",
                "The desktop shell could not complete the bootstrap bridge request.",
                &format!("{}: {}", err.code(), err.message()),
            );
        }
    }
}

fn refresh_status(app: &AppHandle, spec: &BridgeSpec) {
    match invoke_bridge(spec, &status_request()) {
        Ok(envelope) if envelope["ok"] == Value::Bool(true) => {
            let result = &envelope["result"];
            let status = result["status"].as_str().unwrap_or("unknown");
            let owner = result["owner"].as_str().unwrap_or("unknown");
            let origin = result["origin"].as_str().unwrap_or("-");
            let version = result["version"].as_str().unwrap_or("-");
            if status == "stopped" || status == "failed" {
                if let Some(state) = app.try_state::<AppState>() {
                    set_allowed_origin(&state.navigation, None);
                }
            }
            set_shell_copy(
                app,
                "OpenCodex status",
                &format!("status={status} owner={owner}"),
                &format!("origin={origin}\nversion={version}"),
            );
        }
        Ok(envelope) => {
            set_shell_copy(
                app,
                "Status unavailable",
                "The status request returned an error envelope.",
                &error_message(Ok(&envelope)),
            );
        }
        Err(err) => {
            set_shell_copy(
                app,
                "Status unavailable",
                "The status bridge request failed.",
                &format!("{}: {}", err.code(), err.message()),
            );
        }
    }
}

fn request_explicit_quit(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    {
        let mut phase = lock_phase(&state);
        if *phase != QuitPhase::Running {
            return;
        }
        *phase = QuitPhase::QuitInProgress;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let decision = match default_bridge_spec(&app) {
            Ok(spec) => {
                let result = invoke_bridge(&spec, &stop_request(StopReason::AppExit));
                quit_decision_from_stop(result.as_ref())
            }
            Err(err) => QuitDecision::StayVisible {
                message: format!("{}: {}", err.code(), err.message()),
            },
        };
        match decision {
            QuitDecision::Exit => {
                if let Some(state) = app.try_state::<AppState>() {
                    *lock_phase(&state) = QuitPhase::Exiting;
                }
                app.exit(0);
            }
            QuitDecision::StayVisible { message } => {
                if let Some(state) = app.try_state::<AppState>() {
                    *lock_phase(&state) = QuitPhase::Running;
                }
                set_shell_copy(
                    &app,
                    "Quit did not finish",
                    "The stop transaction failed or could not be confirmed. The app stays open.",
                    &message,
                );
            }
        }
    });
}

fn handle_tray_event(app: &AppHandle, id: &str) {
    match id {
        TRAY_OPEN => show_main_window(app),
        TRAY_STATUS => match default_bridge_spec(app) {
            Ok(spec) => refresh_status(app, &spec),
            Err(err) => set_shell_copy(
                app,
                "Status unavailable",
                "The short-lived runtime bridge is not available.",
                &format!("{}: {}", err.code(), err.message()),
            ),
        },
        TRAY_QUIT => request_explicit_quit(app),
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let navigation = Arc::new(Mutex::new(NavigationPolicy::default()));
    let phase = Arc::new(Mutex::new(QuitPhase::Running));
    let state = AppState {
        navigation: navigation.clone(),
        phase,
    };

    // Official Tauri v2 contract: single-instance is registered first.
    // Deep-link integration is a later-phase placeholder and is not registered
    // here. When enabled, register it immediately after single-instance (with
    // the single-instance `deep-link` feature) and before opener.
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_plugin(navigation))
        .manage(state)
        .setup(|app| {
            install_tray(app.handle(), handle_tray_event)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                bootstrap_and_attach(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if crate::lifecycle::should_prevent_window_close() {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building OpenCodex desktop")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                let phase = app
                    .try_state::<AppState>()
                    .map(|state| *lock_phase(&state))
                    .unwrap_or(QuitPhase::Running);
                match phase {
                    QuitPhase::Exiting => {}
                    QuitPhase::QuitInProgress => api.prevent_exit(),
                    QuitPhase::Running => {
                        api.prevent_exit();
                        request_explicit_quit(app);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_instance_is_registered_first() {
        let disabled = plugin_registration_order(false);
        assert_eq!(disabled[0], "single-instance");
        assert!(!disabled.contains(&"deep-link"));
        assert_eq!(disabled[1], "opener");

        let enabled = plugin_registration_order(true);
        assert_eq!(enabled[0], "single-instance");
        assert_eq!(enabled[1], "deep-link");
        assert_eq!(enabled[2], "opener");
    }

    #[test]
    fn desktop_versions_match_the_runtime_package() {
        let root: Value = serde_json::from_str(include_str!("../../../package.json")).unwrap();
        let desktop: Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
        let tauri: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(root["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(desktop["version"], root["version"]);
        assert_eq!(tauri["version"], root["version"]);
    }

    #[test]
    fn capabilities_are_least_privilege_and_have_no_remote_ipc() {
        let raw = include_str!("../capabilities/main.json");
        let value: Value = serde_json::from_str(raw).unwrap();
        let permissions = value["permissions"].as_array().expect("permissions");
        assert!(permissions.is_empty());
        assert!(value.get("remote").is_none());
        for permission in permissions {
            let text = permission.as_str().unwrap_or_default();
            assert!(!text.contains("shell:"), "{text}");
            assert!(!text.contains("fs:"), "{text}");
            assert!(!text.contains("updater"), "{text}");
            assert!(!text.contains("opener:"), "{text}");
            assert!(!text.contains("allow-execute"), "{text}");
            assert!(!text.contains("allow-spawn"), "{text}");
        }
    }

    #[test]
    fn updater_is_not_configured() {
        let raw = include_str!("../tauri.conf.json");
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(value["bundle"]["createUpdaterArtifacts"], false);
        assert!(value["plugins"].get("updater").is_none());
        assert!(!raw.contains("pubkey"));
        assert!(!raw.contains("TAURI_SIGNING_PRIVATE_KEY"));
        let cargo = include_str!("../Cargo.toml");
        assert!(!cargo.contains("tauri-plugin-updater"));
        assert!(!cargo.contains("tauri-plugin-shell"));
        assert!(cargo.contains("tauri-plugin-single-instance"));
    }

    #[test]
    fn release_build_requires_a_real_manifested_runtime() {
        let build = include_str!("../build.rs");
        assert!(build.contains("PROFILE"));
        assert!(build.contains("release build requires a real target runtime payload"));
        assert!(build.contains("resources/runtime/runtime-manifest.json"));
        assert!(build.contains("binary_matches_target"));
    }

    #[test]
    fn packaged_runtime_uses_external_bin_and_resource_resolver() {
        let raw = include_str!("../tauri.conf.json");
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(
            value["bundle"]["externalBin"],
            serde_json::json!(["binaries/ocx-runtime"])
        );
        assert_eq!(
            crate::packaging::tauri_external_bin_entry(),
            "binaries/ocx-runtime"
        );
        let resources = value["bundle"]["resources"].as_array().expect("resources");
        assert!(resources
            .iter()
            .any(|entry| entry.as_str() == Some("resources/runtime")));
        assert_eq!(value["app"]["withGlobalTauri"], false);
        assert_eq!(value["app"]["security"]["assetProtocol"]["enable"], false);
        let csp = value["app"]["security"]["csp"].as_str().unwrap_or_default();
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp.contains("*"));
        assert!(!raw.contains("OCX_DESKTOP_BRIDGE_BIN"));
        assert!(!raw.contains("OCX_DESKTOP_RUNTIME_ROOT"));
    }

    #[test]
    fn bootstrap_recovers_before_staging_and_reloads_the_stable_bridge() {
        let source = include_str!("lib.rs");
        let start = source.find("fn bootstrap_and_attach").unwrap();
        let body = &source[start..source.find("fn refresh_status").unwrap()];
        let preflight = body.find("bootstrap_with_reconciliation(&spec)").unwrap();
        let stage = body.find("install_packaged_runtime(&layout)").unwrap();
        let activate = body
            .find("runtime_activate_request(&staged.staged.id)")
            .unwrap();
        let final_bridge = body.rfind("bridge_spec_from_layout(&layout)").unwrap();
        assert!(preflight < stage && stage < activate && activate < final_bridge);
    }

    fn version_pointer(version: &str) -> crate::packaging::VersionPointer {
        crate::packaging::VersionPointer {
            id: format!("ocx-runtime-{version}"),
            version: version.to_string(),
            target: "x86_64-unknown-linux-gnu".to_string(),
            rel_path: format!("versions/{version}"),
        }
    }

    #[test]
    fn staged_activation_requires_a_distinct_unpublished_candidate() {
        let old = version_pointer("2.35.0");
        let next = version_pointer("2.36.0");
        let staged = StagingSuccess {
            current: old.clone(),
            previous: None,
            staged: next.clone(),
            reused: false,
            published: false,
        };
        assert!(staged_activation_required(&staged));
        assert!(activation_pointer_matches(
            &staged,
            &CurrentPointer {
                current: next,
                previous: Some(old),
            }
        ));
        assert!(previous_pointer_matches(
            &staged,
            &CurrentPointer {
                current: staged.current.clone(),
                previous: staged.previous.clone(),
            }
        ));

        let reused = StagingSuccess {
            current: version_pointer("2.36.0"),
            previous: None,
            staged: version_pointer("2.36.0"),
            reused: true,
            published: false,
        };
        assert!(!staged_activation_required(&reused));
    }

    #[test]
    fn activation_result_must_report_a_ready_changed_runtime() {
        let ready = serde_json::json!({
            "ok": true,
            "result": { "changed": true, "proxyStatus": "ready" }
        });
        assert!(activation_result_ready(&ready));
        assert!(!activation_result_ready(&serde_json::json!({
            "ok": true,
            "result": { "changed": false, "proxyStatus": "ready" }
        })));
        assert!(!activation_result_ready(&serde_json::json!({
            "ok": false,
            "error": { "code": "restore_failed" }
        })));

        let status = serde_json::json!({
            "ok": true,
            "result": { "status": "ready", "owner": "desktop-direct", "version": "2.36.0" }
        });
        assert!(status_confirms_direct_ready(&status, "2.36.0"));
        assert!(!status_confirms_direct_ready(
            &serde_json::json!({
                "ok": true,
                "result": { "status": "pending", "owner": "desktop-direct", "version": "2.36.0" }
            }),
            "2.36.0"
        ));
        assert!(!status_confirms_direct_ready(
            &serde_json::json!({
                "ok": true,
                "result": { "status": "ready", "owner": "existing-external", "version": "2.36.0" }
            }),
            "2.36.0"
        ));
        assert!(!status_confirms_direct_ready(
            &serde_json::json!({
                "ok": true,
                "result": { "status": "ready", "owner": "desktop-direct", "version": "2.35.0" }
            }),
            "2.36.0"
        ));

        assert!(bootstrap_allows_runtime_activation(&serde_json::json!({
            "result": { "allowedMutations": ["stop", "runtime-activate"] }
        })));
        assert!(!bootstrap_allows_runtime_activation(&serde_json::json!({
            "result": { "allowedMutations": ["stop"] }
        })));
    }

    #[test]
    fn deep_link_integration_is_not_configured() {
        let cargo = include_str!("../Cargo.toml");
        assert!(!cargo.contains("deep-link-phase"));
        assert!(!cargo.contains("tauri-plugin-deep-link ="));
    }
}
