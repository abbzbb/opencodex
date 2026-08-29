mod bridge;
mod codec;
mod lifecycle;
mod navigation;
mod origin;
mod packaging;
mod protocol;
mod tray;

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::bridge::{default_bridge_spec, invoke_bridge, BridgeSpec};
use crate::lifecycle::{quit_decision_from_stop, QuitDecision, QuitPhase};
use crate::navigation::{init_plugin as navigation_plugin, set_allowed_origin, NavigationPolicy};
use crate::protocol::{bootstrap_request, status_request, stop_request, StopReason};
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

fn bootstrap_and_attach(app: &AppHandle) {
    let spec = match default_bridge_spec(app) {
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
    match invoke_bridge(&spec, &bootstrap_request()) {
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
    fn deep_link_integration_is_not_configured() {
        let cargo = include_str!("../Cargo.toml");
        assert!(!cargo.contains("deep-link-phase"));
        assert!(!cargo.contains("tauri-plugin-deep-link ="));
    }
}
