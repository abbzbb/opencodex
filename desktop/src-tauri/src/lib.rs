mod attachment;
mod bridge;
mod codec;
mod lifecycle;
mod navigation;
mod origin;
mod packaging;
mod protocol;
mod staging;
mod transition;
mod tray;

use std::fs::symlink_metadata;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::attachment::{
    abort_pending_attach, attachment_from_ready_result, begin_ack_attempt, begin_pending_attach,
    commit_attach_if_running, commit_shell_ack, decide_open, eval_ready_shell, fail_pending_shell,
    fail_reloading_generation, observe_status_envelope, plan_canonical_finished, plan_shell_reveal,
    resolve_ack_attempt_failure, rollback_attach_if_not_running, sync_policy_from_ledger,
    timeout_window_action, AckAttemptDecision, AttachError, CanonicalFinished, OpenDecision,
    PendingShellCopy, ProxyObservation, ReadyShellEval, ShellSession, ShellSurface,
    TimeoutWindowAction,
};
use crate::bridge::{
    bridge_spec_from_layout, default_bridge_spec, invoke_bridge, BridgeClientError, BridgeSpec,
};
use crate::lifecycle::{
    phase_allows_bridge_work, quit_decision_from_stop, QuitDecision, QuitPhase,
};
use crate::navigation::{
    apply_new_window_policy, canonical_app_local_reload_url, canonical_app_local_url,
    classify_canonical_page_url, init_plugin as navigation_plugin, is_canonical_app_local_url,
    lock_policy, CanonicalPageUrl, NavigationPolicy,
};
use crate::packaging::{
    layout_from_app, read_current_pointer, BridgeLayout, CurrentPointer, CURRENT_POINTER_NAME,
};
use crate::protocol::{
    bootstrap_request, runtime_activate_request, status_request, stop_request, StopReason,
};
use crate::staging::{install_packaged_runtime, StagingSuccess};
use crate::transition::{
    complete_canonical_pageload, quit_with_locked_spec, run_ack_attempt_handoff,
    status_with_locked_spec,
};
use crate::tray::{install_tray, show_main_window, TRAY_OPEN, TRAY_QUIT, TRAY_STATUS};

pub struct AppState {
    pub navigation: Arc<Mutex<NavigationPolicy>>,
    pub phase: Arc<Mutex<QuitPhase>>,
    session: Arc<Mutex<ShellSession>>,
    transition: Arc<Mutex<()>>,
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

fn lock_transition(state: &AppState) -> std::sync::MutexGuard<'_, ()> {
    crate::transition::lock_exclusive(&state.transition)
}

fn lock_session(state: &AppState) -> std::sync::MutexGuard<'_, ShellSession> {
    state
        .session
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

const SHELL_ACK_TIMEOUT: Duration = Duration::from_millis(1500);
const SHELL_RELOAD_WATCHDOG: Duration = Duration::from_millis(1500);

fn eval_shell_copy<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    copy: &PendingShellCopy,
) -> Result<(), String> {
    let attempt = copy
        .attempt
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing attempt".to_string())?;
    let script = format!(
        r#"
            (() => {{
              const helper = window.__ocxApplyAndAckShell;
              if (typeof helper !== "function") return;
              helper({title}, {message}, {detail}, {marker}, {epoch}, {attempt});
            }})();
            "#,
        title = json_string(&copy.title),
        message = json_string(&copy.message),
        detail = json_string(&copy.detail),
        marker = json_string(&copy.marker),
        epoch = copy.epoch,
        attempt = json_string(attempt),
    );
    window.eval(&script).map_err(|err| err.to_string())
}

fn spawn_ack_attempt_handoff(
    app: AppHandle,
    marker: String,
    epoch: u64,
    attempt: String,
    delay: Duration,
) {
    thread::spawn(move || {
        if !delay.is_zero() {
            thread::sleep(delay);
        }
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        run_ack_attempt_handoff(
            &state.transition,
            || {
                let phase = lock_phase(&state);
                if !phase_allows_bridge_work(*phase) {
                    AckAttemptDecision::Ignore
                } else {
                    let mut session = lock_session(&state);
                    resolve_ack_attempt_failure(true, &mut session, &marker, epoch, &attempt)
                }
            },
            |decision| {
                apply_ack_attempt_window(&app, &state, decision);
            },
        );
    });
}

fn give_up_reload_if_current(state: &AppState, epoch: u64, generation: &str) -> bool {
    let phase = lock_phase(state);
    if !phase_allows_bridge_work(*phase) {
        return false;
    }
    let mut session = lock_session(state);
    fail_reloading_generation(true, &mut session, epoch, generation)
}

fn apply_ack_attempt_window(app: &AppHandle, state: &AppState, decision: AckAttemptDecision) {
    match timeout_window_action(decision) {
        TimeoutWindowAction::Noop => {}
        TimeoutWindowAction::Hide => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        TimeoutWindowAction::HideAndNavigate { epoch, generation } => {
            let Some(window) = app.get_webview_window("main") else {
                let _ = give_up_reload_if_current(state, epoch, &generation);
                return;
            };
            let _ = window.hide();
            let Some(url) = canonical_app_local_reload_url(&generation) else {
                let _ = give_up_reload_if_current(state, epoch, &generation);
                return;
            };
            if window.navigate(url).is_err() {
                let _ = give_up_reload_if_current(state, epoch, &generation);
                return;
            }
            schedule_reload_watchdog(app.clone(), epoch, generation);
        }
    }
}

fn schedule_reload_watchdog(app: AppHandle, epoch: u64, generation: String) {
    thread::spawn(move || {
        thread::sleep(SHELL_RELOAD_WATCHDOG);
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        run_ack_attempt_handoff(
            &state.transition,
            || {
                if give_up_reload_if_current(&state, epoch, &generation) {
                    AckAttemptDecision::GiveUp
                } else {
                    AckAttemptDecision::Ignore
                }
            },
            |decision| {
                apply_ack_attempt_window(&app, &state, decision);
            },
        );
    });
}

fn schedule_delayed_ack_timeout(app: AppHandle, marker: String, epoch: u64, attempt: String) {
    spawn_ack_attempt_handoff(app, marker, epoch, attempt, SHELL_ACK_TIMEOUT);
}

fn enqueue_immediate_ack_failure(app: AppHandle, marker: String, epoch: u64, attempt: String) {
    spawn_ack_attempt_handoff(app, marker, epoch, attempt, Duration::ZERO);
}

#[tauri::command]
fn ack_shell_render(
    app: AppHandle,
    window: tauri::WebviewWindow,
    marker: String,
    epoch: u64,
    attempt: String,
) -> Result<(), String> {
    let url = window.url().map_err(|err| err.to_string())?;
    if !is_canonical_app_local_url(&url) {
        return Err("ack rejected".to_string());
    }
    let Some(state) = app.try_state::<AppState>() else {
        return Err("ack rejected".to_string());
    };
    let committed = {
        let phase = lock_phase(&state);
        let mut session = lock_session(&state);
        let committed = commit_shell_ack(
            phase_allows_bridge_work(*phase),
            &mut session,
            true,
            &marker,
            epoch,
            &attempt,
        );
        if committed {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        committed
    };
    if !committed {
        return Err("ack rejected".to_string());
    }
    Ok(())
}

fn current_attachment(app: &AppHandle) -> Option<crate::navigation::DashboardAttachment> {
    app.try_state::<AppState>()
        .and_then(|state| lock_session(&state).ledger.attachment().cloned())
}

fn show_main_if_not_pending(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let phase = lock_phase(&state);
    if !phase_allows_bridge_work(*phase) {
        return;
    }
    let session = lock_session(&state);
    if matches!(
        session.surface,
        ShellSurface::LoadingShell
            | ShellSurface::PendingShell { .. }
            | ShellSurface::ReloadingShell { .. }
            | ShellSurface::PendingAttach { .. }
            | ShellSurface::Hidden
    ) {
        return;
    }
    show_main_window(app);
}

fn reveal_shell(app: &AppHandle, title: &str, message: &str, detail: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let (command, copy) = {
        let phase = lock_phase(&state);
        if !phase_allows_bridge_work(*phase) {
            return;
        }
        let mut session = lock_session(&state);
        let command = plan_shell_reveal(&session.surface);
        if command.hide {
            let _ = window.hide();
        }
        let snapshot = session.ledger.begin();
        if command.revoke {
            let _ = session.ledger.revoke_if_current(&snapshot);
        }
        sync_policy_from_ledger(&mut lock_policy(&state.navigation), &session.ledger);
        let copy = PendingShellCopy::new(title, message, detail, snapshot.epoch.0);
        if command.queue_pending {
            session.pending = Some(copy.clone());
            session.surface = ShellSurface::PendingShell { epoch: copy.epoch };
        }
        if command.eval_now {
            drop(session);
            drop(phase);
            if !phase_allows_bridge_work(*lock_phase(&state)) {
                return;
            }
            let decision = eval_ready_shell(&mut lock_session(&state), copy.clone(), |c| {
                eval_shell_copy(&window, c)
            });
            match decision {
                ReadyShellEval::WaitForAck { attempt } => {
                    schedule_delayed_ack_timeout(app.clone(), copy.marker, copy.epoch, attempt);
                }
                ReadyShellEval::DispatchFailed { attempt } => {
                    enqueue_immediate_ack_failure(app.clone(), copy.marker, copy.epoch, attempt);
                }
            }
            return;
        }
        (command, copy)
    };
    if command.navigate_local && window.navigate(canonical_app_local_url()).is_err() {
        let _phase = lock_phase(&state);
        let mut session = lock_session(&state);
        fail_pending_shell(&mut session, &copy);
    }
}

fn reveal_untrusted_shell(app: &AppHandle, title: &str, message: &str, detail: &str) {
    reveal_shell(app, title, message, detail);
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

fn attach_dashboard(
    app: &AppHandle,
    candidate: crate::navigation::DashboardAttachment,
) -> Result<(), AttachError> {
    let window = app
        .get_webview_window("main")
        .ok_or(AttachError::MissingWindow)?;
    let Some(state) = app.try_state::<AppState>() else {
        return Err(AttachError::MissingWindow);
    };
    let url = candidate
        .origin
        .parse::<tauri::Url>()
        .map_err(|_| AttachError::InvalidOrigin)?;
    let snapshot = {
        let phase = lock_phase(&state);
        if !phase_allows_bridge_work(*phase) {
            return Err(AttachError::NavigationFailed);
        }
        let mut session = lock_session(&state);
        let snapshot = begin_pending_attach(&mut session, candidate.clone())
            .ok_or(AttachError::NavigationFailed)?;
        sync_policy_from_ledger(&mut lock_policy(&state.navigation), &session.ledger);
        snapshot
    };
    if window.navigate(url).is_err() {
        let _phase = lock_phase(&state);
        let mut session = lock_session(&state);
        if session.ledger.rollback_if_current(&snapshot) {
            sync_policy_from_ledger(&mut lock_policy(&state.navigation), &session.ledger);
        }
        abort_pending_attach(&mut session, &snapshot);
        return Err(AttachError::NavigationFailed);
    }
    {
        let phase = lock_phase(&state);
        let mut session = lock_session(&state);
        if rollback_attach_if_not_running(
            phase_allows_bridge_work(*phase),
            &mut session,
            &mut lock_policy(&state.navigation),
            &snapshot,
        ) {
            let _ = window.hide();
            return Err(AttachError::NavigationFailed);
        }
        if !commit_attach_if_running(
            phase_allows_bridge_work(*phase),
            &mut session,
            &mut lock_policy(&state.navigation),
            &snapshot,
            candidate,
        ) {
            return Err(AttachError::NavigationFailed);
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

fn attach_ready_result(app: &AppHandle, result: &Value) -> Result<(), AttachError> {
    let candidate = attachment_from_ready_result(result)?;
    attach_dashboard(app, candidate)
}

fn create_main_window(app: &AppHandle, policy: Arc<Mutex<NavigationPolicy>>) -> tauri::Result<()> {
    let opener_app = app.clone();
    // Tauri 2.11.5 defaults use_https_scheme=false, so Windows/Android serve
    // http://tauri.localhost/. Do not opt into HTTPS; canonical recognition is
    // platform-specific and must match that default.
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("OpenCodex")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .visible(false)
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let page = classify_canonical_page_url(payload.url());
            if matches!(page, CanonicalPageUrl::NotAppLocal) {
                return;
            }
            let Some(state) = webview.app_handle().try_state::<AppState>() else {
                return;
            };
            // Classify payload.url() only. Phase then session (never transition).
            let to_eval = {
                let phase = lock_phase(&state);
                complete_canonical_pageload(
                    &state.session,
                    |session| match plan_canonical_finished(
                        phase_allows_bridge_work(*phase),
                        session,
                        &page,
                    ) {
                        CanonicalFinished::DispatchEval => begin_ack_attempt(session),
                        CanonicalFinished::ReadyHidden | CanonicalFinished::Ignore => None,
                    },
                )
            };
            if let Some(copy) = to_eval {
                match eval_shell_copy(&webview, &copy) {
                    Ok(()) => {
                        if let Some(attempt) = copy.attempt.clone() {
                            schedule_delayed_ack_timeout(
                                webview.app_handle().clone(),
                                copy.marker,
                                copy.epoch,
                                attempt,
                            );
                        }
                    }
                    Err(_) => {
                        if let Some(attempt) = copy.attempt.clone() {
                            enqueue_immediate_ack_failure(
                                webview.app_handle().clone(),
                                copy.marker,
                                copy.epoch,
                                attempt,
                            );
                        }
                    }
                }
            }
        })
        .on_new_window(move |url, _features| apply_new_window_policy(&opener_app, &policy, &url))
        .build()?;
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
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let _transition = lock_transition(&state);
    if !phase_allows_bridge_work(*lock_phase(&state)) {
        return;
    }
    let layout = match layout_from_app(app) {
        Ok(layout) => layout,
        Err(err) => {
            reveal_shell(
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
                reveal_shell(
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
                reveal_shell(
                    app,
                    "OpenCodex could not start",
                    "The current runtime could not be reconciled before installation.",
                    &error_message(Ok(&envelope)),
                );
                return;
            }
            Err(err) => {
                reveal_shell(
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
            reveal_shell(
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
            reveal_shell(
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
                    reveal_shell(
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
                        reveal_shell(
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
                            reveal_shell(
                                app,
                                "OpenCodex could not start",
                                "The new runtime was not activated; the previous runtime is verified ready.",
                                &detail,
                            );
                            return;
                        }
                        ActivationReconciliation::Unknown => {
                            reveal_shell(
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
                        reveal_shell(
                            app,
                            "OpenCodex could not start",
                            "The activated runtime pointer could not be verified.",
                            &format!("{}: {}", err.code(), err.message()),
                        );
                        return;
                    }
                };
                if !activation_pointer_matches(staged, &observed) {
                    reveal_shell(
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
                reveal_shell(
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
            reveal_shell(
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
            if let Err(err) = attach_ready_result(app, &envelope["result"]) {
                reveal_untrusted_shell(
                    app,
                    "OpenCodex could not start",
                    "The desktop shell could not open the ready local dashboard.",
                    err.message(),
                );
            }
        }
        Ok(envelope) => {
            reveal_untrusted_shell(
                app,
                "OpenCodex could not start",
                "Bootstrap did not return a ready loopback origin.",
                &error_message(Ok(&envelope)),
            );
        }
        Err(err) => {
            reveal_untrusted_shell(
                app,
                "OpenCodex could not start",
                "The desktop shell could not complete the bootstrap bridge request.",
                &format!("{}: {}", err.code(), err.message()),
            );
        }
    }
}

fn apply_open_decision(app: &AppHandle, decision: OpenDecision) {
    match decision {
        OpenDecision::ShowAttached => show_main_if_not_pending(app),
        OpenDecision::Attach(identity) => {
            if let Err(err) = attach_dashboard(app, identity) {
                reveal_untrusted_shell(
                    app,
                    "OpenCodex could not attach",
                    "The ready proxy identity could not be bound to the window.",
                    err.message(),
                );
            }
        }
        OpenDecision::ShowStopped => reveal_untrusted_shell(
            app,
            "Proxy stopped",
            "The dashboard is no longer available. Use the tray to check status or quit. The app will not restart the proxy by itself.",
            "status=stopped",
        ),
        OpenDecision::ShowFailed => reveal_untrusted_shell(
            app,
            "Proxy unavailable",
            "The desktop shell could not confirm a ready local dashboard. The app will not restart the proxy by itself.",
            "status=failed",
        ),
    }
}

fn reconcile_open(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let _transition = lock_transition(&state);
    if !phase_allows_bridge_work(*lock_phase(&state)) {
        return;
    }
    let observation = match default_bridge_spec(app) {
        Ok(spec) => match invoke_bridge(&spec, &status_request()) {
            Ok(envelope) => observe_status_envelope(&envelope),
            Err(_) => ProxyObservation::Unavailable,
        },
        Err(_) => ProxyObservation::Unavailable,
    };
    let current = current_attachment(app);
    apply_open_decision(app, decide_open(current.as_ref(), observation));
}

fn request_open(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        reconcile_open(&app);
    });
}

fn refresh_status(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let transition = state.transition.clone();
    status_with_locked_spec(
        &transition,
        || {
            if !phase_allows_bridge_work(*lock_phase(&state)) {
                return None;
            }
            Some(default_bridge_spec(app))
        },
        |resolved| {
            let Some(resolved) = resolved else {
                return;
            };
            match resolved {
                Ok(spec) => match invoke_bridge(spec, &status_request()) {
                    Ok(envelope) => match observe_status_envelope(&envelope) {
                        ProxyObservation::Ready(identity) => {
                            let current = current_attachment(app);
                            if current.as_ref() != Some(&identity) {
                                if let Err(err) = attach_dashboard(app, identity.clone()) {
                                    reveal_untrusted_shell(
                                        app,
                                        "Status unavailable",
                                        "A ready proxy was observed but the window could not be rebound.",
                                        err.message(),
                                    );
                                    return;
                                }
                            }
                            show_main_if_not_pending(app);
                        }
                        ProxyObservation::Stopped => reveal_untrusted_shell(
                            app,
                            "OpenCodex status",
                            "status=stopped",
                            "The proxy is absent. The app will not restart it by itself.",
                        ),
                        ProxyObservation::Failed | ProxyObservation::Unavailable => {
                            let result = &envelope["result"];
                            let status = result["status"].as_str().unwrap_or("unknown");
                            let owner = result["owner"].as_str().unwrap_or("unknown");
                            reveal_untrusted_shell(
                                app,
                                "OpenCodex status",
                                &format!("status={status} owner={owner}"),
                                &error_message(Ok(&envelope)),
                            );
                        }
                    },
                    Err(err) => {
                        reveal_untrusted_shell(
                            app,
                            "Status unavailable",
                            "The status bridge request failed.",
                            &format!("{}: {}", err.code(), err.message()),
                        );
                    }
                },
                Err(err) => {
                    reveal_shell(
                        app,
                        "Status unavailable",
                        "The short-lived runtime bridge is not available.",
                        &format!("{}: {}", err.code(), err.message()),
                    );
                }
            }
        },
    );
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
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let transition = state.transition.clone();
        quit_with_locked_spec(
            &transition,
            || {
                default_bridge_spec(&app).map_err(|err| QuitDecision::StayVisible {
                    message: format!("{}: {}", err.code(), err.message()),
                })
            },
            |spec| {
                let result = invoke_bridge(spec, &stop_request(StopReason::AppExit));
                quit_decision_from_stop(result.as_ref())
            },
            |decision| match decision {
                QuitDecision::Exit => {
                    *lock_phase(&state) = QuitPhase::Exiting;
                    app.exit(0);
                }
                QuitDecision::StayVisible { message } => {
                    *lock_phase(&state) = QuitPhase::Running;
                    reveal_shell(
                        &app,
                        "Quit did not finish",
                        "The stop transaction failed or could not be confirmed. The app stays open.",
                        &message,
                    );
                }
            },
        );
    });
}

fn handle_tray_event(app: &AppHandle, id: &str) {
    match id {
        TRAY_OPEN => request_open(app),
        TRAY_STATUS => {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                refresh_status(&app);
            });
        }
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
        session: Arc::new(Mutex::new(ShellSession::default())),
        transition: Arc::new(Mutex::new(())),
    };

    // Official Tauri v2 contract: single-instance is registered first.
    // Deep-link integration is a later-phase placeholder and is not registered
    // here. When enabled, register it immediately after single-instance (with
    // the single-instance `deep-link` feature) and before opener.
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            request_open(app);
        }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_plugin(navigation))
        .invoke_handler(tauri::generate_handler![ack_shell_render])
        .manage(state)
        .setup(|app| {
            let policy = app.state::<AppState>().navigation.clone();
            create_main_window(app.handle(), policy)?;
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
        assert_eq!(
            permissions,
            &vec![Value::String("allow-ack-shell-render".to_string())]
        );
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
        assert_eq!(value["app"]["windows"], serde_json::json!([]));
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
    fn tray_open_and_single_instance_reconcile_instead_of_showing_blindly() {
        let source = include_str!("lib.rs");
        let tray = source
            .find("fn handle_tray_event")
            .expect("handle_tray_event");
        let run = source.find("pub fn run").expect("run");
        let tray_body = &source[tray..run];
        assert!(tray_body.contains("TRAY_OPEN => request_open(app)"));
        assert!(!tray_body.contains("show_main_window(app)"));
        let single = source
            .find("tauri_plugin_single_instance::init")
            .expect("single-instance");
        assert!(source[single..].contains("request_open(app)"));
    }

    #[test]
    fn main_window_registers_new_window_and_page_load_hooks() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn create_main_window")
            .expect("create_main_window");
        let body = &source[start
            ..source
                .find("fn has_published_runtime")
                .expect("has_published_runtime")];
        assert!(body.contains("on_new_window"));
        assert!(body.contains("apply_new_window_policy"));
        assert!(body.contains("on_page_load"));
        assert!(body.contains("classify_canonical_page_url"));
        assert!(body.contains("payload.url()"));
        assert!(body.contains("use_https_scheme=false"));
        assert!(!body.contains("use_https_scheme(true)"));
        let setup = source.find(".setup(|app|").expect("setup");
        let create = source[setup..]
            .find("create_main_window")
            .expect("setup creates window");
        let tray = source[setup..].find("install_tray").expect("tray");
        assert!(create < tray);
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

    #[test]
    fn explicit_quit_acquires_transition_before_spec_and_holds_through_stop() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn request_explicit_quit")
            .expect("request_explicit_quit");
        let end = source
            .find("fn handle_tray_event")
            .expect("handle_tray_event");
        let body = &source[start..end];
        let adapter = body
            .find("quit_with_locked_spec")
            .expect("quit uses the exclusive adapter");
        let spec = body
            .find("default_bridge_spec")
            .expect("quit resolves the spec");
        let stop = body.find("stop_request").expect("quit invokes stop");
        assert!(adapter < spec && spec < stop);
        assert!(body[stop..].contains("QuitPhase::Exiting"));
        assert!(body[stop..].contains("*lock_phase(&state) = QuitPhase::Running"));
        assert!(body[stop..].contains("reveal_shell"));
        assert!(!body.contains("lock_transition"));
    }

    #[test]
    fn tray_status_resolves_default_bridge_spec_only_after_the_transition_lock() {
        let source = include_str!("lib.rs");
        let tray_start = source
            .find("fn handle_tray_event")
            .expect("handle_tray_event");
        let run = source.find("pub fn run").expect("run");
        let tray_body = &source[tray_start..run];
        let status_arm = tray_body.find("TRAY_STATUS").expect("TRAY_STATUS");
        let quit_arm = tray_body.find("TRAY_QUIT").expect("TRAY_QUIT");
        assert!(tray_body[status_arm..quit_arm].contains("refresh_status(&app)"));
        assert!(!tray_body[status_arm..quit_arm].contains("default_bridge_spec"));

        let refresh_start = source.find("fn refresh_status").expect("refresh_status");
        let refresh_end = source
            .find("fn request_explicit_quit")
            .expect("request_explicit_quit");
        let refresh = &source[refresh_start..refresh_end];
        let adapter = refresh
            .find("status_with_locked_spec")
            .expect("status uses the exclusive adapter");
        let spec = refresh
            .find("default_bridge_spec")
            .expect("status resolves the spec");
        assert!(adapter < spec);
    }

    #[test]
    fn attach_stale_commit_syncs_from_the_held_ledger_without_relocking() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn attach_dashboard")
            .expect("attach_dashboard");
        let end = source
            .find("fn attach_ready_result")
            .expect("attach_ready_result");
        let body = &source[start..end];
        assert!(body.contains("commit_attach_if_running"));
        assert!(body.contains("rollback_attach_if_not_running"));
        assert!(body.contains("begin_pending_attach"));
        assert!(!body.contains("sync_policy(&state)"));
        assert!(!body.contains("fn sync_policy"));
    }

    #[test]
    fn canonical_pageload_uses_the_session_coordinator_before_eval_not_show() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn create_main_window")
            .expect("create_main_window");
        let body = &source[start
            ..source
                .find("fn has_published_runtime")
                .expect("has_published_runtime")];
        let coordinator = body
            .find("complete_canonical_pageload")
            .expect("page-load uses the coordinator");
        let plan = body
            .find("plan_canonical_finished")
            .expect("page-load plans without committing on dispatch");
        assert!(coordinator < plan || plan < coordinator);
        assert!(body.contains("lock_phase"));
        assert!(body[coordinator..].contains("eval_shell_copy"));
        assert!(body.contains("begin_ack_attempt"));
        assert!(body.contains("payload.url()"));
        assert!(body.contains("classify_canonical_page_url"));
        assert!(
            !body.contains("webview.url()"),
            "PageLoad must classify payload.url(), never a sampled webview.url()"
        );
        let eval_at = body.find("eval_shell_copy").expect("eval");
        let ok_at = body.find("Ok(())").expect("eval Ok arm");
        let schedule_at = body
            .find("schedule_delayed_ack_timeout")
            .expect("timer only after eval");
        assert!(
            eval_at < ok_at && ok_at < schedule_at,
            "PageLoad must arm the ack timer only after eval dispatch succeeds"
        );
        let err_at = body.find("Err(_)").expect("eval Err arm");
        assert!(
            body[err_at..].contains("enqueue_immediate_ack_failure"),
            "PageLoad eval Err must only queue the serialized handoff"
        );
        assert!(
            !body[err_at..].contains("window.hide") && !body[err_at..].contains(".navigate("),
            "PageLoad eval Err must not hide or navigate"
        );
        assert!(
            !body.contains("window.show") && !body.contains("show_main_window"),
            "PageLoad must not show; ack CAS is the show path"
        );
        assert!(!body.contains("try_lock"));
        assert!(!body.contains("lock_transition"));
        assert!(!body.contains("run_ack_attempt_handoff"));
        assert!(!body.contains("lock_ledger"));
        assert!(!body.contains("lock_pending_shell"));
    }

    #[test]
    fn eval_dispatches_through_local_helper_including_attempt() {
        let source = include_str!("lib.rs");
        let start = source.find("fn eval_shell_copy").expect("eval_shell_copy");
        let end = source
            .find("fn spawn_ack_attempt_handoff")
            .expect("spawn_ack_attempt_handoff");
        let body = &source[start..end];
        assert!(body.contains("__ocxApplyAndAckShell"));
        assert!(body.contains("attempt"));
        assert!(!body.contains("__TAURI_INTERNALS__"));
        assert!(!body.contains("getElementById"));
    }

    #[test]
    fn ack_shell_render_shows_only_after_cas_under_phase() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn ack_shell_render")
            .expect("ack_shell_render");
        let end = source
            .find("fn current_attachment")
            .expect("current_attachment");
        let body = &source[start..end];
        let phase = body.find("lock_phase").expect("phase");
        let commit = body.find("commit_shell_ack").expect("cas");
        let show = body.find("window.show()").expect("show");
        assert!(phase < commit && commit < show);
        assert!(body.contains("is_canonical_app_local_url"));
        assert!(body.contains("lock_session"));
    }

    #[test]
    fn ready_shell_eval_failure_reloads_canonical_instead_of_keeping_stale() {
        let source = include_str!("lib.rs");
        let start = source.find("fn reveal_shell").expect("reveal_shell");
        let body = &source[start..source.find("fn reveal_untrusted_shell").expect("untrusted")];
        assert!(body.contains("eval_ready_shell"));
        assert!(body.contains("ReadyShellEval::WaitForAck"));
        let wait = body.find("ReadyShellEval::WaitForAck").expect("wait");
        let schedule = body[wait..]
            .find("schedule_delayed_ack_timeout")
            .expect("eval Ok arms one delayed timer");
        let fail = body
            .find("ReadyShellEval::DispatchFailed")
            .expect("dispatch failed");
        assert!(
            wait + schedule < fail,
            "WaitForAck timer is armed before dispatch-failure handoff"
        );
        let fail_arm = &body[fail..fail
            + body[fail..]
                .find("return;")
                .expect("eval_now returns after dispatch")];
        assert!(fail_arm.contains("enqueue_immediate_ack_failure"));
        assert!(
            !fail_arm.contains("window.hide()") && !fail_arm.contains(".navigate("),
            "eval dispatch failure must not hide or navigate in reveal"
        );
        assert!(
            !fail_arm.contains("schedule_delayed_ack_timeout"),
            "eval dispatch failure must not arm a delayed ack timer"
        );
        let navigate = body.rfind("command.navigate_local").expect("navigate");
        assert!(
            !body[navigate..].contains("schedule_delayed_ack_timeout")
                && !body[navigate..].contains("enqueue_immediate_ack_failure"),
            "initial navigate must not independently arm an ack timer or failure handoff"
        );
        assert!(
            !body.contains("window.show") && !body.contains("show_main_window"),
            "reveal must not show on eval dispatch"
        );
        assert!(!body.contains("try_lock"));
    }

    #[test]
    fn ack_attempt_handoff_ignore_is_noop_and_serialized_under_transition() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn spawn_ack_attempt_handoff")
            .expect("spawn_ack_attempt_handoff");
        let end = source
            .find("fn ack_shell_render")
            .expect("ack_shell_render");
        let body = &source[start..end];
        let handoff = body
            .find("run_ack_attempt_handoff")
            .expect("shared serialized handoff");
        let phase = body.find("lock_phase").expect("handoff rechecks phase");
        assert!(handoff < phase);
        assert!(body.contains("resolve_ack_attempt_failure"));
        assert!(body.contains("timeout_window_action"));
        assert!(body.contains("TimeoutWindowAction::Noop"));
        assert!(body.contains("TimeoutWindowAction::HideAndNavigate"));
        assert!(body.contains("canonical_app_local_reload_url"));
        assert!(body.contains("let Some(url) = canonical_app_local_reload_url"));
        assert!(body.contains("schedule_reload_watchdog"));
        assert!(
            body.contains("fail_reloading_generation")
                || body.contains("give_up_reload_if_current")
        );
        let hide_nav = body
            .find("TimeoutWindowAction::HideAndNavigate")
            .expect("reload effect");
        let hide_at = body[hide_nav..].find("window.hide()").expect("hide first");
        let nav_at = body[hide_nav..].find(".navigate(").expect("then navigate");
        assert!(
            hide_at < nav_at,
            "HideAndNavigate must hide before generation-bound navigate"
        );
        let noop = body.find("TimeoutWindowAction::Noop").expect("noop");
        let hide_arm = body[noop..]
            .find("TimeoutWindowAction::Hide")
            .expect("hide");
        assert!(
            !body[noop..noop + hide_arm].contains("window.hide"),
            "Ignore must not hide"
        );
        assert!(body.contains("AckAttemptDecision::Ignore"));
        assert!(!body.contains("AckTimeoutDecision"));
        assert!(body.contains("SHELL_ACK_TIMEOUT"));
        assert!(body.contains("Duration::ZERO"));
    }

    #[test]
    fn bootstrap_open_and_status_require_running_phase_before_bridge_work() {
        let source = include_str!("lib.rs");
        let slices = [
            (
                "fn bootstrap_and_attach",
                "fn apply_open_decision",
                "layout_from_app",
            ),
            (
                "fn reconcile_open",
                "fn request_open",
                "default_bridge_spec",
            ),
            (
                "fn refresh_status",
                "fn request_explicit_quit",
                "default_bridge_spec",
            ),
        ];
        for (start_name, end_name, work) in slices {
            let start = source
                .find(start_name)
                .unwrap_or_else(|| panic!("{start_name}"));
            let end = source
                .find(end_name)
                .unwrap_or_else(|| panic!("{end_name}"));
            let body = &source[start..end];
            let gate = body
                .find("phase_allows_bridge_work")
                .unwrap_or_else(|| panic!("{start_name} must gate on Running"));
            let work_at = body
                .find(work)
                .unwrap_or_else(|| panic!("{start_name} must perform {work}"));
            assert!(
                gate < work_at,
                "{start_name} must reject QuitInProgress/Exiting before {work}"
            );
        }
    }
}
