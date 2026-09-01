use serde_json::Value;

use crate::navigation::{CanonicalPageUrl, DashboardAttachment, NavigationPolicy};
use crate::origin::parse_loopback_origin;
use crate::protocol::{is_owner, is_pid};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachError {
    InvalidOrigin,
    InvalidIdentity,
    MissingWindow,
    NavigationFailed,
}

impl AttachError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidOrigin => {
                "proxy_not_ready: bind must be localhost, 127.0.0.1, or ::1; the app will not inject an admin token"
            }
            Self::InvalidIdentity => "bridge returned an incomplete dashboard identity",
            Self::MissingWindow => "main window is unavailable",
            Self::NavigationFailed => "dashboard navigation failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyObservation {
    Ready(DashboardAttachment),
    Stopped,
    Failed,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenDecision {
    ShowAttached,
    Attach(DashboardAttachment),
    ShowStopped,
    ShowFailed,
}

fn is_attachable_owner(owner: &str) -> bool {
    is_owner(owner) && owner != "unknown/conflict"
}

fn is_attachable_version(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

pub fn dashboard_attachment(
    origin: &str,
    pid: u32,
    owner: &str,
    version: &str,
) -> Result<DashboardAttachment, AttachError> {
    if pid == 0 || !is_attachable_owner(owner) || !is_attachable_version(version) {
        return Err(AttachError::InvalidIdentity);
    }
    let parsed = parse_loopback_origin(origin).map_err(|_| AttachError::InvalidOrigin)?;
    Ok(DashboardAttachment {
        origin: parsed.origin,
        pid,
        owner: owner.to_string(),
        version: version.to_string(),
    })
}

pub fn attachment_from_ready_result(result: &Value) -> Result<DashboardAttachment, AttachError> {
    if result["status"].as_str() != Some("ready") {
        return Err(AttachError::InvalidIdentity);
    }
    let origin = result["origin"]
        .as_str()
        .ok_or(AttachError::InvalidIdentity)?;
    if !is_pid(&result["pid"]) {
        return Err(AttachError::InvalidIdentity);
    }
    let pid = result["pid"].as_u64().ok_or(AttachError::InvalidIdentity)? as u32;
    let owner = result["owner"]
        .as_str()
        .ok_or(AttachError::InvalidIdentity)?;
    let version = result["version"]
        .as_str()
        .ok_or(AttachError::InvalidIdentity)?;
    dashboard_attachment(origin, pid, owner, version)
}

pub fn observe_status_envelope(envelope: &Value) -> ProxyObservation {
    if envelope["ok"] != Value::Bool(true) {
        return ProxyObservation::Unavailable;
    }
    match envelope["result"]["status"].as_str() {
        Some("ready") => match attachment_from_ready_result(&envelope["result"]) {
            Ok(attachment) => ProxyObservation::Ready(attachment),
            Err(_) => ProxyObservation::Unavailable,
        },
        Some("stopped") => ProxyObservation::Stopped,
        Some("failed") | Some("pending") => ProxyObservation::Failed,
        _ => ProxyObservation::Unavailable,
    }
}

pub fn decide_open(
    current: Option<&DashboardAttachment>,
    observed: ProxyObservation,
) -> OpenDecision {
    match observed {
        ProxyObservation::Ready(identity) => {
            if current == Some(&identity) {
                OpenDecision::ShowAttached
            } else {
                OpenDecision::Attach(identity)
            }
        }
        ProxyObservation::Stopped => OpenDecision::ShowStopped,
        ProxyObservation::Failed | ProxyObservation::Unavailable => OpenDecision::ShowFailed,
    }
}

#[cfg(test)]
fn install_attachment(
    policy: &mut NavigationPolicy,
    candidate: DashboardAttachment,
) -> Option<DashboardAttachment> {
    let previous = policy.attachment.clone();
    policy.attachment = Some(candidate);
    previous
}

#[cfg(test)]
fn restore_attachment(policy: &mut NavigationPolicy, previous: Option<DashboardAttachment>) {
    policy.attachment = previous;
}

/// Speculatively trust `candidate` so same-webview navigation can proceed, then
/// commit only if `navigate` succeeds. Any failure restores `previous`.
/// Production attach drops the policy lock before `WebView::navigate` to avoid
/// deadlocking `on_navigation`; tests use this combined adapter.
#[cfg(test)]
pub fn attach_with_navigator<E>(
    policy: &mut NavigationPolicy,
    candidate: DashboardAttachment,
    navigate: impl FnOnce(&str) -> Result<(), E>,
) -> Result<(), E> {
    let origin = candidate.origin.clone();
    let previous = install_attachment(policy, candidate);
    match navigate(&origin) {
        Ok(()) => Ok(()),
        Err(err) => {
            restore_attachment(policy, previous);
            Err(err)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustEpoch(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustSnapshot {
    pub epoch: TrustEpoch,
    pub attachment: Option<DashboardAttachment>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrustLedger {
    epoch: u64,
    attachment: Option<DashboardAttachment>,
}

impl TrustLedger {
    pub fn epoch(&self) -> TrustEpoch {
        TrustEpoch(self.epoch)
    }

    pub fn attachment(&self) -> Option<&DashboardAttachment> {
        self.attachment.as_ref()
    }

    pub fn begin(&mut self) -> TrustSnapshot {
        self.epoch = self.epoch.saturating_add(1);
        TrustSnapshot {
            epoch: TrustEpoch(self.epoch),
            attachment: self.attachment.clone(),
        }
    }

    pub fn is_current(&self, snapshot: &TrustSnapshot) -> bool {
        self.epoch == snapshot.epoch.0
    }

    pub fn install_if_current(
        &mut self,
        snapshot: &TrustSnapshot,
        candidate: DashboardAttachment,
    ) -> bool {
        if !self.is_current(snapshot) {
            return false;
        }
        self.attachment = Some(candidate);
        true
    }

    pub fn commit_if_current(
        &mut self,
        snapshot: &TrustSnapshot,
        next: Option<DashboardAttachment>,
    ) -> bool {
        if !self.is_current(snapshot) {
            return false;
        }
        self.attachment = next;
        true
    }

    pub fn rollback_if_current(&mut self, snapshot: &TrustSnapshot) -> bool {
        if !self.is_current(snapshot) {
            return false;
        }
        self.attachment = snapshot.attachment.clone();
        true
    }

    pub fn revoke_if_current(&mut self, snapshot: &TrustSnapshot) -> bool {
        self.commit_if_current(snapshot, None)
    }
}

pub fn sync_policy_from_ledger(policy: &mut NavigationPolicy, ledger: &TrustLedger) {
    policy.attachment = ledger.attachment.clone();
}

/// Commit `candidate` if `snapshot` is still current, then always sync policy
/// from this ledger object. Callers must already hold the ledger mutex; this
/// must not re-lock it (std `Mutex` is not recursive).
pub fn commit_attach_from_ledger(
    ledger: &mut TrustLedger,
    policy: &mut NavigationPolicy,
    snapshot: &TrustSnapshot,
    candidate: DashboardAttachment,
) -> bool {
    let committed = ledger.commit_if_current(snapshot, Some(candidate));
    sync_policy_from_ledger(policy, ledger);
    committed
}

pub const MAX_SHELL_ACK_RETRIES: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingShellCopy {
    pub title: String,
    pub message: String,
    pub detail: String,
    pub epoch: u64,
    pub marker: String,
    /// Per-eval-dispatch token. `None` means no active ack timer. A timeout
    /// CAS-invalidates this before releasing session locks so a late ack cannot
    /// win the same attempt.
    pub attempt: Option<String>,
    pub retries: u8,
}

impl PendingShellCopy {
    pub fn new(title: &str, message: &str, detail: &str, epoch: u64) -> Self {
        Self {
            title: title.to_string(),
            message: message.to_string(),
            detail: detail.to_string(),
            epoch,
            marker: uuid::Uuid::new_v4().to_string(),
            attempt: None,
            retries: 0,
        }
    }

    pub fn arm_attempt(&mut self) -> &str {
        self.attempt = Some(uuid::Uuid::new_v4().to_string());
        self.attempt.as_deref().expect("attempt armed")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShellSession {
    pub ledger: TrustLedger,
    pub surface: ShellSurface,
    pub pending: Option<PendingShellCopy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ShellSurface {
    #[default]
    LoadingShell,
    PendingShell {
        epoch: u64,
    },
    /// Effect-owned reload. Not dispatchable: `begin_ack_attempt` and ack
    /// reject until a PageLoad event URL carries this exact generation.
    ReloadingShell {
        epoch: u64,
        generation: String,
    },
    PendingAttach {
        epoch: u64,
    },
    Attached,
    Hidden,
    Shell,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub hide: bool,
    pub revoke: bool,
    pub navigate_local: bool,
    pub queue_pending: bool,
    pub eval_now: bool,
    pub show: bool,
}

pub fn plan_shell_reveal(surface: &ShellSurface) -> ShellCommand {
    match surface {
        ShellSurface::LoadingShell => ShellCommand {
            hide: true,
            revoke: true,
            navigate_local: false,
            queue_pending: true,
            eval_now: false,
            show: false,
        },
        ShellSurface::Attached
        | ShellSurface::Hidden
        | ShellSurface::PendingShell { .. }
        | ShellSurface::ReloadingShell { .. }
        | ShellSurface::PendingAttach { .. } => ShellCommand {
            hide: true,
            revoke: true,
            navigate_local: true,
            queue_pending: true,
            eval_now: false,
            show: false,
        },
        ShellSurface::Shell => ShellCommand {
            hide: true,
            revoke: true,
            navigate_local: false,
            queue_pending: true,
            eval_now: true,
            show: false,
        },
    }
}

pub fn complete_pending_shell(
    surface: &mut ShellSurface,
    pending_epoch: u64,
    current_epoch: u64,
    url_is_canonical: bool,
) -> bool {
    if pending_epoch != current_epoch || !url_is_canonical {
        return false;
    }
    if !matches!(surface, ShellSurface::PendingShell { epoch } if *epoch == pending_epoch) {
        return false;
    }
    *surface = ShellSurface::Shell;
    true
}

/// Navigation-failure completion is CAS: only the still-pending exact
/// epoch+marker may become Hidden. A Finished/ack that already committed
/// `Shell` is left alone.
pub fn fail_pending_shell(session: &mut ShellSession, expected: &PendingShellCopy) -> bool {
    if session.ledger.epoch().0 != expected.epoch {
        return false;
    }
    if !matches!(session.surface, ShellSurface::PendingShell { epoch } if epoch == expected.epoch) {
        return false;
    }
    match session.pending.as_ref() {
        Some(copy) if copy.epoch == expected.epoch && copy.marker == expected.marker => {}
        _ => return false,
    }
    session.surface = ShellSurface::Hidden;
    session.pending = None;
    true
}

/// Peek whether a pending diagnostic may be eval'd. Does not consume pending
/// or change the surface — eval must succeed first.
pub fn shell_copy_ready_to_eval(
    current_epoch: u64,
    pending: &Option<PendingShellCopy>,
    surface: &ShellSurface,
    url_is_canonical: bool,
) -> bool {
    if !url_is_canonical {
        return false;
    }
    let Some(copy) = pending.as_ref() else {
        return false;
    };
    copy.epoch == current_epoch
        && matches!(surface, ShellSurface::PendingShell { epoch } if *epoch == copy.epoch)
}

/// The first canonical Finished with no diagnostic: the local document is
/// ready (`Shell`) but must stay hidden so a later reveal can `eval_now`.
/// Must not run for PendingAttach, Hidden, stale PendingShell, or a
/// non-canonical URL.
pub fn mark_loading_document_ready(session: &mut ShellSession, url_is_canonical: bool) -> bool {
    if !url_is_canonical || !matches!(session.surface, ShellSurface::LoadingShell) {
        return false;
    }
    if shell_copy_ready_to_eval(
        session.ledger.epoch().0,
        &session.pending,
        &session.surface,
        true,
    ) {
        return false;
    }
    session.pending = None;
    session.surface = ShellSurface::Shell;
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalFinished {
    Ignore,
    ReadyHidden,
    DispatchEval,
}

/// Complete a generation-bound reload. Only the matching live generation may
/// leave `ReloadingShell` for `PendingShell`. Stale/duplicate/wrong-generation
/// events return false and leave the surface unchanged.
pub fn complete_reload_if_matching(
    running: bool,
    session: &mut ShellSession,
    generation: &str,
) -> bool {
    if !running || generation.is_empty() {
        return false;
    }
    let epoch = session.ledger.epoch().0;
    let matches = matches!(
        &session.surface,
        ShellSurface::ReloadingShell { epoch: e, generation: g }
            if *e == epoch && g == generation
    );
    if !matches {
        return false;
    }
    let pending_ok = session
        .pending
        .as_ref()
        .is_some_and(|copy| copy.epoch == epoch && copy.attempt.is_none());
    if !pending_ok {
        return false;
    }
    session.surface = ShellSurface::PendingShell { epoch };
    true
}

/// Exact-CAS a live reload generation to terminal Hidden. Window absence,
/// navigate dispatch Err, and load-watchdog expiry use this. Matching PageLoad
/// that already left Reloading makes a stale watchdog a no-op.
pub fn fail_reloading_generation(
    running: bool,
    session: &mut ShellSession,
    epoch: u64,
    generation: &str,
) -> bool {
    if !running || generation.is_empty() || session.ledger.epoch().0 != epoch {
        return false;
    }
    let matches = matches!(
        &session.surface,
        ShellSurface::ReloadingShell { epoch: e, generation: g }
            if *e == epoch && g == generation
    );
    if !matches {
        return false;
    }
    session.surface = ShellSurface::Hidden;
    session.pending = None;
    true
}

/// PageLoad Finished planner. Classifies the **event** URL. QuitInProgress/
/// Exiting must not dispatch eval or show. LoadingShell with no valid pending
/// still becomes ready-hidden so a later StayVisible reveal can eval_now.
/// `ReloadingShell` becomes dispatchable only for the exact live generation.
pub fn plan_canonical_finished(
    running: bool,
    session: &mut ShellSession,
    page: &CanonicalPageUrl,
) -> CanonicalFinished {
    match page {
        CanonicalPageUrl::NotAppLocal => CanonicalFinished::Ignore,
        CanonicalPageUrl::Bare => {
            if mark_loading_document_ready(session, true) {
                return CanonicalFinished::ReadyHidden;
            }
            if !running {
                return CanonicalFinished::Ignore;
            }
            if shell_copy_ready_to_eval(
                session.ledger.epoch().0,
                &session.pending,
                &session.surface,
                true,
            ) {
                return CanonicalFinished::DispatchEval;
            }
            CanonicalFinished::Ignore
        }
        CanonicalPageUrl::Reload { generation } => {
            if complete_reload_if_matching(running, session, generation) {
                CanonicalFinished::DispatchEval
            } else {
                CanonicalFinished::Ignore
            }
        }
    }
}

/// DOM-ack CAS. Dispatch acceptance is not enough: pending+marker+epoch+
/// active attempt+PendingShell+Running+canonical must still hold. Attached
/// dashboard URLs fail `url_is_canonical`. A timeout that already invalidated
/// this attempt cannot be completed by a late ack.
pub fn commit_shell_ack(
    running: bool,
    session: &mut ShellSession,
    url_is_canonical: bool,
    marker: &str,
    epoch: u64,
    attempt: &str,
) -> bool {
    if !running || !url_is_canonical || session.ledger.epoch().0 != epoch || attempt.is_empty() {
        return false;
    }
    let Some(copy) = session.pending.as_ref() else {
        return false;
    };
    if copy.marker != marker || copy.epoch != epoch || copy.attempt.as_deref() != Some(attempt) {
        return false;
    }
    if !complete_pending_shell(&mut session.surface, epoch, epoch, true) {
        return false;
    }
    session.pending = None;
    true
}

/// Arm a fresh per-dispatch attempt on the current pending diagnostic so eval
/// and its single timeout share one token. Does not consume pending.
pub fn begin_ack_attempt(session: &mut ShellSession) -> Option<PendingShellCopy> {
    if !shell_copy_ready_to_eval(
        session.ledger.epoch().0,
        &session.pending,
        &session.surface,
        true,
    ) {
        return None;
    }
    let copy = session.pending.as_mut()?;
    copy.arm_attempt();
    Some(copy.clone())
}

pub fn commit_attach_if_running(
    running: bool,
    session: &mut ShellSession,
    policy: &mut NavigationPolicy,
    snapshot: &TrustSnapshot,
    candidate: DashboardAttachment,
) -> bool {
    if !running {
        return false;
    }
    commit_pending_attach(session, policy, snapshot, candidate)
}

pub fn rollback_attach_if_not_running(
    running: bool,
    session: &mut ShellSession,
    policy: &mut NavigationPolicy,
    snapshot: &TrustSnapshot,
) -> bool {
    if running {
        return false;
    }
    if session.ledger.rollback_if_current(snapshot) {
        sync_policy_from_ledger(policy, &session.ledger);
    }
    abort_pending_attach(session, snapshot);
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadyShellEval {
    WaitForAck { attempt: String },
    DispatchFailed { attempt: String },
}

/// Dispatch-only: queue the diagnostic, mint a fresh attempt, and eval.
/// Success does not show or consume pending; the ack CAS does. Dispatch
/// failure **keeps** the active attempt so a background handoff can CAS it.
pub fn eval_ready_shell<E>(
    session: &mut ShellSession,
    mut copy: PendingShellCopy,
    eval: impl FnOnce(&PendingShellCopy) -> Result<(), E>,
) -> ReadyShellEval {
    copy.arm_attempt();
    session.surface = ShellSurface::PendingShell { epoch: copy.epoch };
    session.pending = Some(copy.clone());
    let attempt = copy.attempt.clone().expect("attempt armed before eval");
    match eval(&copy) {
        Ok(()) => ReadyShellEval::WaitForAck { attempt },
        Err(_) => ReadyShellEval::DispatchFailed { attempt },
    }
}

/// Shared reducer outcome for delayed ack timeout and immediate eval-dispatch
/// failure. `Reload` carries the opaque generation bound to the retry URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AckAttemptDecision {
    Ignore,
    Reload { epoch: u64, generation: String },
    GiveUp,
}

/// Window effect for an ack-attempt failure decision. `Ignore` is a strict
/// no-op. Only `GiveUp` hides; only `Reload` hides then navigates to the
/// generation-bound canonical URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeoutWindowAction {
    Noop,
    Hide,
    HideAndNavigate { epoch: u64, generation: String },
}

pub fn timeout_window_action(decision: AckAttemptDecision) -> TimeoutWindowAction {
    match decision {
        AckAttemptDecision::Ignore => TimeoutWindowAction::Noop,
        AckAttemptDecision::GiveUp => TimeoutWindowAction::Hide,
        AckAttemptDecision::Reload { epoch, generation } => {
            TimeoutWindowAction::HideAndNavigate { epoch, generation }
        }
    }
}

/// Shared CAS reducer for delayed ack timeout and immediate eval-dispatch
/// failure. On Reload, enters `ReloadingShell` with a fresh generation so a
/// concurrent PageLoad cannot arm attempt B before HideAndNavigate. Not-Running,
/// wrong marker/epoch/attempt, or a newer surface is `Ignore`.
pub fn resolve_ack_attempt_failure(
    running: bool,
    session: &mut ShellSession,
    marker: &str,
    epoch: u64,
    attempt: &str,
) -> AckAttemptDecision {
    if !running || attempt.is_empty() {
        return AckAttemptDecision::Ignore;
    }
    let Some(copy) = session.pending.as_mut() else {
        return AckAttemptDecision::Ignore;
    };
    if copy.marker != marker || copy.epoch != epoch || session.ledger.epoch().0 != epoch {
        return AckAttemptDecision::Ignore;
    }
    if copy.attempt.as_deref() != Some(attempt) {
        return AckAttemptDecision::Ignore;
    }
    if !matches!(session.surface, ShellSurface::PendingShell { epoch: e } if e == epoch) {
        return AckAttemptDecision::Ignore;
    }
    copy.attempt = None;
    if copy.retries < MAX_SHELL_ACK_RETRIES {
        copy.retries = copy.retries.saturating_add(1);
        let generation = uuid::Uuid::new_v4().to_string();
        session.surface = ShellSurface::ReloadingShell {
            epoch,
            generation: generation.clone(),
        };
        AckAttemptDecision::Reload { epoch, generation }
    } else {
        session.pending = None;
        session.surface = ShellSurface::Hidden;
        AckAttemptDecision::GiveUp
    }
}

/// Old PageLoad consume: uses a sampled epoch and commits before eval.
/// Tests keep this to prove the E-vs-E+1 race the live-epoch eval path forbids.
#[cfg(test)]
pub fn consume_pending_with_sampled_epoch(
    sampled_epoch: u64,
    pending: &mut Option<PendingShellCopy>,
    surface: &mut ShellSurface,
    url_is_canonical: bool,
) -> Option<PendingShellCopy> {
    if !url_is_canonical {
        return None;
    }
    let copy = match pending.as_ref() {
        Some(copy) if copy.epoch == sampled_epoch => pending.take(),
        _ => None,
    }?;
    if complete_pending_shell(surface, copy.epoch, sampled_epoch, true) {
        Some(copy)
    } else {
        None
    }
}

/// Advance the epoch, speculatively trust `candidate`, cancel any pending
/// local-shell reveal, and mark the surface as a pending attach. The session
/// lock must be dropped before `navigate`.
pub fn begin_pending_attach(
    session: &mut ShellSession,
    candidate: DashboardAttachment,
) -> Option<TrustSnapshot> {
    let snapshot = session.ledger.begin();
    if !session.ledger.install_if_current(&snapshot, candidate) {
        return None;
    }
    session.pending = None;
    session.surface = ShellSurface::PendingAttach {
        epoch: snapshot.epoch.0,
    };
    Some(snapshot)
}

pub fn commit_pending_attach(
    session: &mut ShellSession,
    policy: &mut NavigationPolicy,
    snapshot: &TrustSnapshot,
    candidate: DashboardAttachment,
) -> bool {
    let committed = commit_attach_from_ledger(&mut session.ledger, policy, snapshot, candidate);
    if committed {
        session.pending = None;
        session.surface = ShellSurface::Attached;
    }
    committed
}

pub fn abort_pending_attach(session: &mut ShellSession, snapshot: &TrustSnapshot) {
    if matches!(session.surface, ShellSurface::PendingAttach { epoch } if epoch == snapshot.epoch.0)
    {
        session.surface = ShellSurface::Hidden;
        session.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(origin: &str, pid: u32) -> DashboardAttachment {
        dashboard_attachment(origin, pid, "desktop-direct", "2.36.0").expect(origin)
    }

    #[test]
    fn attachment_requires_loopback_origin_and_closed_identity() {
        assert!(
            dashboard_attachment("http://localhost:10100", 7, "desktop-direct", "2.36.0").is_ok()
        );
        assert_eq!(
            dashboard_attachment("http://192.168.1.10:10100", 7, "desktop-direct", "2.36.0"),
            Err(AttachError::InvalidOrigin)
        );
        assert_eq!(
            dashboard_attachment("http://localhost:10100", 0, "desktop-direct", "2.36.0"),
            Err(AttachError::InvalidIdentity)
        );
        assert_eq!(
            dashboard_attachment("http://localhost:10100", 7, "unknown/conflict", "2.36.0"),
            Err(AttachError::InvalidIdentity)
        );
        assert_eq!(
            dashboard_attachment("http://localhost:10100", 7, "desktop-direct", ""),
            Err(AttachError::InvalidIdentity)
        );
    }

    #[test]
    fn attach_rolls_back_previous_trust_when_navigate_or_window_fails() {
        let previous = identity("http://localhost:10100", 11);
        let candidate = identity("http://127.0.0.1:20200", 22);
        let mut policy = NavigationPolicy {
            attachment: Some(previous.clone()),
        };
        let missing = attach_with_navigator(&mut policy, candidate.clone(), |_| {
            Err(AttachError::MissingWindow)
        });
        assert_eq!(missing, Err(AttachError::MissingWindow));
        assert_eq!(policy.attachment.as_ref(), Some(&previous));

        let failed = attach_with_navigator(&mut policy, candidate.clone(), |_| {
            Err(AttachError::NavigationFailed)
        });
        assert_eq!(failed, Err(AttachError::NavigationFailed));
        assert_eq!(policy.attachment.as_ref(), Some(&previous));

        let committed = attach_with_navigator(&mut policy, candidate.clone(), |origin| {
            assert_eq!(origin, "http://127.0.0.1:20200");
            Ok::<(), AttachError>(())
        });
        assert_eq!(committed, Ok(()));
        assert_eq!(policy.attachment.as_ref(), Some(&candidate));
    }

    #[test]
    fn attach_from_unattached_clears_candidate_after_navigation_failure() {
        let candidate = identity("http://localhost:10100", 9);
        let mut policy = NavigationPolicy::default();
        let failed = attach_with_navigator(&mut policy, candidate, |_| {
            Err(AttachError::NavigationFailed)
        });
        assert_eq!(failed, Err(AttachError::NavigationFailed));
        assert_eq!(policy.attachment, None);
    }

    #[test]
    fn open_reconcile_never_starts_a_proxy() {
        let current = identity("http://localhost:10100", 11);
        assert_eq!(
            decide_open(Some(&current), ProxyObservation::Ready(current.clone())),
            OpenDecision::ShowAttached
        );
        let replacement = identity("http://localhost:20200", 99);
        assert_eq!(
            decide_open(Some(&current), ProxyObservation::Ready(replacement.clone())),
            OpenDecision::Attach(replacement.clone())
        );
        assert_eq!(
            decide_open(None, ProxyObservation::Ready(replacement.clone())),
            OpenDecision::Attach(replacement)
        );
        assert_eq!(
            decide_open(Some(&current), ProxyObservation::Stopped),
            OpenDecision::ShowStopped
        );
        assert_eq!(
            decide_open(Some(&current), ProxyObservation::Failed),
            OpenDecision::ShowFailed
        );
        assert_eq!(
            decide_open(Some(&current), ProxyObservation::Unavailable),
            OpenDecision::ShowFailed
        );
        assert_eq!(
            decide_open(None, ProxyObservation::Stopped),
            OpenDecision::ShowStopped
        );
    }

    #[test]
    fn status_envelope_maps_to_observation_without_tokens() {
        let ready = serde_json::json!({
            "ok": true,
            "result": {
                "status": "ready",
                "origin": "http://localhost:10100",
                "pid": 44,
                "version": "2.36.0",
                "owner": "desktop-direct"
            }
        });
        assert_eq!(
            observe_status_envelope(&ready),
            ProxyObservation::Ready(identity("http://localhost:10100", 44))
        );
        let stopped = serde_json::json!({
            "ok": true,
            "result": { "status": "stopped", "origin": null, "pid": null, "version": null, "owner": "desktop-direct" }
        });
        assert_eq!(observe_status_envelope(&stopped), ProxyObservation::Stopped);
        let failed = serde_json::json!({
            "ok": true,
            "result": { "status": "failed", "origin": null, "pid": null, "version": null, "owner": "unknown/conflict" }
        });
        assert_eq!(observe_status_envelope(&failed), ProxyObservation::Failed);
        let error = serde_json::json!({
            "ok": false,
            "error": { "code": "bridge_protocol_error", "message": "failed" }
        });
        assert_eq!(
            observe_status_envelope(&error),
            ProxyObservation::Unavailable
        );
        let lan = serde_json::json!({
            "ok": true,
            "result": {
                "status": "ready",
                "origin": "http://192.168.1.10:10100",
                "pid": 44,
                "version": "2.36.0",
                "owner": "desktop-direct"
            }
        });
        assert_eq!(observe_status_envelope(&lan), ProxyObservation::Unavailable);
    }

    #[test]
    fn failed_older_attach_does_not_overwrite_newer_commit() {
        let mut ledger = TrustLedger::default();
        let older = identity("http://localhost:10100", 11);
        let newer = identity("http://localhost:20200", 22);
        let a = ledger.begin();
        assert!(ledger.install_if_current(&a, older.clone()));
        let b = ledger.begin();
        assert!(ledger.commit_if_current(&b, Some(newer.clone())));
        assert!(!ledger.rollback_if_current(&a));
        assert_eq!(ledger.attachment(), Some(&newer));
        assert!(!ledger.commit_if_current(&a, Some(older)));
        assert_eq!(ledger.attachment(), Some(&newer));
    }

    #[test]
    fn stale_ready_cannot_overwrite_later_stopped_revocation() {
        let mut ledger = TrustLedger::default();
        let ready = identity("http://localhost:10100", 11);
        let ready_snap = ledger.begin();
        let stopped_snap = ledger.begin();
        assert!(ledger.revoke_if_current(&stopped_snap));
        assert_eq!(ledger.attachment(), None);
        assert!(!ledger.commit_if_current(&ready_snap, Some(ready)));
        assert_eq!(ledger.attachment(), None);
    }

    #[test]
    fn stale_stopped_cannot_revoke_later_ready_attach() {
        let mut ledger = TrustLedger::default();
        let ready = identity("http://localhost:10100", 11);
        let stopped_snap = ledger.begin();
        let ready_snap = ledger.begin();
        assert!(ledger.commit_if_current(&ready_snap, Some(ready.clone())));
        assert!(!ledger.revoke_if_current(&stopped_snap));
        assert_eq!(ledger.attachment(), Some(&ready));
    }

    #[test]
    fn shell_plan_hides_attached_dashboard_until_local_page_load() {
        let from_attached = plan_shell_reveal(&ShellSurface::Attached);
        assert!(from_attached.hide);
        assert!(from_attached.revoke);
        assert!(from_attached.navigate_local);
        assert!(from_attached.queue_pending);
        assert!(!from_attached.eval_now);
        assert!(!from_attached.show);
        let from_pending_attach = plan_shell_reveal(&ShellSurface::PendingAttach { epoch: 1 });
        assert_eq!(from_pending_attach, from_attached);

        let from_loading = plan_shell_reveal(&ShellSurface::LoadingShell);
        assert!(from_loading.hide);
        assert!(from_loading.queue_pending);
        assert!(!from_loading.eval_now);
        assert!(!from_loading.show);
        assert!(!from_loading.navigate_local);

        let from_shell = plan_shell_reveal(&ShellSurface::Shell);
        assert!(from_shell.hide);
        assert!(!from_shell.navigate_local);
        assert!(from_shell.eval_now);
        assert!(from_shell.queue_pending);
        assert!(!from_shell.show);

        let mut pending = ShellSurface::PendingShell { epoch: 3 };
        assert!(!complete_pending_shell(&mut pending, 2, 3, true));
        assert!(!complete_pending_shell(&mut pending, 3, 3, false));
        assert!(complete_pending_shell(
            &mut ShellSurface::PendingShell { epoch: 3 },
            3,
            3,
            true
        ));

        let mut failed = session_with_pending(4);
        let failed_copy = failed.pending.clone().unwrap();
        assert!(fail_pending_shell(&mut failed, &failed_copy));
        assert_eq!(failed.surface, ShellSurface::Hidden);
        assert!(failed.pending.is_none());
        let mut stale = session_with_pending(4);
        let mut expected = stale.pending.clone().unwrap();
        expected.epoch = 5;
        assert!(!fail_pending_shell(&mut stale, &expected));
        assert_eq!(stale.surface, ShellSurface::PendingShell { epoch: 4 });
    }

    #[test]
    fn loading_shell_queues_diagnostic_without_eval_or_show_before_first_finished() {
        let mut session = ShellSession::default();
        assert_eq!(session.surface, ShellSurface::LoadingShell);
        let command = plan_shell_reveal(&session.surface);
        assert!(command.queue_pending);
        assert!(!command.eval_now);
        assert!(!command.show);
        let snap = session.ledger.begin();
        session.pending = Some(pending_copy(snap.epoch.0));
        session.surface = ShellSurface::PendingShell {
            epoch: snap.epoch.0,
        };
        assert_ne!(session.surface, ShellSurface::Shell);
        assert!(session.pending.is_some());
    }

    #[test]
    fn successful_ack_commits_pending_then_shell() {
        let mut session = session_with_pending(1);
        assert_eq!(
            plan_canonical_finished(true, &mut session, &CanonicalPageUrl::Bare),
            CanonicalFinished::DispatchEval
        );
        assert!(session.pending.is_some());
        let armed = begin_ack_attempt(&mut session).expect("arm");
        let attempt = armed.attempt.clone().expect("attempt");
        assert!(commit_shell_ack(
            true,
            &mut session,
            true,
            &armed.marker,
            armed.epoch,
            &attempt
        ));
        assert_eq!(session.surface, ShellSurface::Shell);
        assert!(session.pending.is_none());
    }

    #[test]
    fn dispatch_failure_retains_pending_and_does_not_show_shell() {
        let mut session = ShellSession {
            surface: ShellSurface::Shell,
            ..Default::default()
        };
        let snap = session.ledger.begin();
        let copy = pending_copy(snap.epoch.0);
        let ReadyShellEval::DispatchFailed { attempt } =
            eval_ready_shell(&mut session, copy.clone(), |_| Err("eval failed"))
        else {
            panic!("eval dispatch failure must keep the attempt");
        };
        assert_eq!(
            session.pending.as_ref().unwrap().attempt.as_deref(),
            Some(attempt.as_str())
        );
        assert_eq!(session.pending.as_ref().unwrap().marker, copy.marker);
        assert_eq!(
            session.surface,
            ShellSurface::PendingShell {
                epoch: snap.epoch.0
            }
        );
    }

    #[test]
    fn first_finished_without_pending_marks_shell_ready_without_show() {
        let mut session = ShellSession::default();
        assert_eq!(session.surface, ShellSurface::LoadingShell);
        assert_eq!(
            plan_canonical_finished(true, &mut session, &CanonicalPageUrl::Bare),
            CanonicalFinished::ReadyHidden
        );
        assert_eq!(session.surface, ShellSurface::Shell);
        assert!(session.pending.is_none());

        let later = plan_shell_reveal(&session.surface);
        assert!(later.eval_now);
        assert!(later.queue_pending);
        assert!(!later.show);
        assert!(!later.navigate_local);

        let snap = session.ledger.begin();
        let copy = pending_copy(snap.epoch.0);
        let ReadyShellEval::WaitForAck { attempt } =
            eval_ready_shell(&mut session, copy.clone(), |_| Ok::<(), ()>(()))
        else {
            panic!("eval dispatch must wait for ack");
        };
        assert_eq!(
            session.surface,
            ShellSurface::PendingShell {
                epoch: snap.epoch.0
            }
        );
        assert!(commit_shell_ack(
            true,
            &mut session,
            true,
            &copy.marker,
            copy.epoch,
            &attempt
        ));
        assert_eq!(session.surface, ShellSurface::Shell);
    }

    #[test]
    fn first_finished_does_not_mark_shell_for_attach_hidden_stale_or_noncanonical() {
        let mut attaching = ShellSession {
            surface: ShellSurface::PendingAttach { epoch: 1 },
            ..Default::default()
        };
        assert_eq!(
            plan_canonical_finished(true, &mut attaching, &CanonicalPageUrl::Bare),
            CanonicalFinished::Ignore
        );
        assert_eq!(attaching.surface, ShellSurface::PendingAttach { epoch: 1 });

        let mut hidden = ShellSession {
            surface: ShellSurface::Hidden,
            ..Default::default()
        };
        assert_eq!(
            plan_canonical_finished(true, &mut hidden, &CanonicalPageUrl::Bare),
            CanonicalFinished::Ignore
        );
        assert_eq!(hidden.surface, ShellSurface::Hidden);

        let mut stale = ShellSession::default();
        let first = stale.ledger.begin();
        stale.pending = Some(pending_copy(first.epoch.0));
        stale.surface = ShellSurface::PendingShell {
            epoch: first.epoch.0,
        };
        let _ = stale.ledger.begin();
        assert_eq!(
            plan_canonical_finished(true, &mut stale, &CanonicalPageUrl::Bare),
            CanonicalFinished::Ignore
        );
        assert_eq!(
            stale.surface,
            ShellSurface::PendingShell {
                epoch: first.epoch.0
            }
        );
        assert!(stale.pending.is_some());

        let mut loading = ShellSession::default();
        assert_eq!(
            plan_canonical_finished(true, &mut loading, &CanonicalPageUrl::NotAppLocal),
            CanonicalFinished::Ignore
        );
        assert_eq!(loading.surface, ShellSurface::LoadingShell);
    }

    #[test]
    fn ready_shell_eval_failure_retains_pending_and_later_ack_retries() {
        let mut session = ShellSession {
            surface: ShellSurface::Shell,
            ..Default::default()
        };
        let snap = session.ledger.begin();
        let copy = pending_copy(snap.epoch.0);
        let ReadyShellEval::DispatchFailed { attempt: failed } =
            eval_ready_shell(&mut session, copy.clone(), |_| Err("eval failed"))
        else {
            panic!("eval dispatch failure must keep the attempt");
        };
        assert_eq!(
            session.pending.as_ref().unwrap().attempt.as_deref(),
            Some(failed.as_str())
        );
        assert_eq!(
            plan_canonical_finished(true, &mut session, &CanonicalPageUrl::Bare),
            CanonicalFinished::DispatchEval
        );
        let armed = begin_ack_attempt(&mut session).expect("retry arm");
        let attempt = armed.attempt.clone().expect("attempt");
        assert!(commit_shell_ack(
            true,
            &mut session,
            true,
            &armed.marker,
            armed.epoch,
            &attempt
        ));
        assert_eq!(session.surface, ShellSurface::Shell);
        assert!(session.pending.is_none());
    }

    #[test]
    fn epoch_change_between_install_and_commit_syncs_from_held_ledger() {
        use std::sync::{Arc, Barrier, Mutex};
        use std::thread;

        let older = identity("http://localhost:10100", 11);
        let newer = identity("http://localhost:20200", 22);
        let ledger = Arc::new(Mutex::new(TrustLedger::default()));
        let installed = Arc::new(Barrier::new(2));
        let bumped = Arc::new(Barrier::new(2));

        let snapshot = {
            let mut guard = ledger.lock().unwrap();
            let snap = guard.begin();
            assert!(guard.install_if_current(&snap, older.clone()));
            snap
        };

        let ledger_b = Arc::clone(&ledger);
        let installed_b = Arc::clone(&installed);
        let bumped_b = Arc::clone(&bumped);
        let newer_b = newer.clone();
        let bumper = thread::spawn(move || {
            installed_b.wait();
            {
                let mut guard = ledger_b.lock().unwrap();
                let snap = guard.begin();
                assert!(guard.commit_if_current(&snap, Some(newer_b)));
            }
            bumped_b.wait();
        });

        installed.wait();
        bumped.wait();
        bumper.join().expect("epoch bumper");

        let mut policy = NavigationPolicy {
            attachment: Some(older.clone()),
        };
        let mut guard = ledger.lock().unwrap();
        assert!(
            ledger.try_lock().is_err(),
            "stale-CAS holds the ledger; re-locking it deadlocks"
        );
        assert!(!commit_attach_from_ledger(
            &mut guard,
            &mut policy,
            &snapshot,
            older
        ));
        assert_eq!(policy.attachment.as_ref(), Some(&newer));
        assert_eq!(guard.attachment(), Some(&newer));
    }

    fn pending_copy(epoch: u64) -> PendingShellCopy {
        PendingShellCopy {
            title: "OpenCodex".into(),
            message: "status".into(),
            detail: "detail".into(),
            epoch,
            marker: format!("marker-{epoch}"),
            attempt: None,
            retries: 0,
        }
    }

    fn session_with_pending(epoch: u64) -> ShellSession {
        let mut session = ShellSession::default();
        while session.ledger.epoch().0 < epoch {
            session.ledger.begin();
        }
        session.pending = Some(pending_copy(epoch));
        session.surface = ShellSurface::PendingShell { epoch };
        session
    }

    #[test]
    fn stale_pageload_epoch_e_must_not_show_after_attach_e_plus_one_starts() {
        let mut session = ShellSession::default();
        let reveal = session.ledger.begin();
        let epoch_e = reveal.epoch.0;
        session.pending = Some(pending_copy(epoch_e));
        session.surface = ShellSurface::PendingShell { epoch: epoch_e };
        let sampled_e = session.ledger.epoch().0;
        assert_eq!(sampled_e, epoch_e);

        // Attach starts: epoch advances to E+1 during the unlocked navigate window
        // of the old attach path, which left pending/surface at E.
        let _attach = session.ledger.begin();
        assert_eq!(session.ledger.epoch().0, epoch_e + 1);
        assert_eq!(
            session.surface,
            ShellSurface::PendingShell { epoch: epoch_e }
        );

        let mut stale_pending = session.pending.clone();
        let mut stale_surface = session.surface.clone();
        let stale_show = consume_pending_with_sampled_epoch(
            sampled_e,
            &mut stale_pending,
            &mut stale_surface,
            true,
        );
        assert!(
            stale_show.is_some(),
            "sampling epoch E then consuming after attach started is the lost race"
        );
        assert_eq!(stale_surface, ShellSurface::Shell);

        assert!(shell_copy_ready_to_eval(
            sampled_e,
            &session.pending,
            &session.surface,
            true
        ));
        assert!(!shell_copy_ready_to_eval(
            session.ledger.epoch().0,
            &session.pending,
            &session.surface,
            true
        ));
        assert_eq!(
            plan_canonical_finished(true, &mut session, &CanonicalPageUrl::Bare),
            CanonicalFinished::Ignore
        );
        assert_eq!(
            session.surface,
            ShellSurface::PendingShell { epoch: epoch_e }
        );
        assert_eq!(
            session.pending.as_ref().map(|copy| copy.epoch),
            Some(epoch_e)
        );

        let mut attaching = ShellSession::default();
        let queued = attaching.ledger.begin();
        attaching.pending = Some(pending_copy(queued.epoch.0));
        attaching.surface = ShellSurface::PendingShell {
            epoch: queued.epoch.0,
        };
        let snapshot =
            begin_pending_attach(&mut attaching, identity("http://localhost:20200", 22)).unwrap();
        assert_eq!(snapshot.epoch.0, queued.epoch.0 + 1);
        assert!(attaching.pending.is_none());
        assert_eq!(
            attaching.surface,
            ShellSurface::PendingAttach {
                epoch: snapshot.epoch.0
            }
        );
        assert!(!shell_copy_ready_to_eval(
            attaching.ledger.epoch().0,
            &attaching.pending,
            &attaching.surface,
            true
        ));
        assert!(!shell_copy_ready_to_eval(
            queued.epoch.0,
            &attaching.pending,
            &attaching.surface,
            true
        ));
    }

    #[test]
    fn quit_after_gate_aborts_attach_and_ack_commits() {
        let mut session = ShellSession::default();
        let candidate = identity("http://localhost:10100", 11);
        let snapshot = begin_pending_attach(&mut session, candidate.clone()).unwrap();
        let mut policy = NavigationPolicy::default();
        assert!(!commit_attach_if_running(
            false,
            &mut session,
            &mut policy,
            &snapshot,
            candidate.clone()
        ));
        assert_eq!(
            session.surface,
            ShellSurface::PendingAttach {
                epoch: snapshot.epoch.0
            }
        );
        assert!(rollback_attach_if_not_running(
            false,
            &mut session,
            &mut policy,
            &snapshot
        ));
        assert_eq!(session.surface, ShellSurface::Hidden);

        let mut pending = session_with_pending(1);
        let copy = begin_ack_attempt(&mut pending).unwrap();
        let attempt = copy.attempt.clone().unwrap();
        assert!(!commit_shell_ack(
            false,
            &mut pending,
            true,
            &copy.marker,
            copy.epoch,
            &attempt
        ));
        assert_eq!(
            pending.surface,
            ShellSurface::PendingShell { epoch: copy.epoch }
        );
        assert!(pending.pending.is_some());
    }

    #[test]
    fn canonical_finished_during_quit_in_progress_does_not_show() {
        let mut loading = ShellSession::default();
        assert_eq!(
            plan_canonical_finished(false, &mut loading, &CanonicalPageUrl::Bare),
            CanonicalFinished::ReadyHidden
        );
        assert_eq!(loading.surface, ShellSurface::Shell);
        assert!(loading.pending.is_none());

        let mut pending = session_with_pending(1);
        let copy = begin_ack_attempt(&mut pending).unwrap();
        let attempt = copy.attempt.clone().unwrap();
        assert_eq!(
            plan_canonical_finished(false, &mut pending, &CanonicalPageUrl::Bare),
            CanonicalFinished::Ignore
        );
        assert_eq!(
            pending.surface,
            ShellSurface::PendingShell { epoch: copy.epoch }
        );
        assert!(!commit_shell_ack(
            false,
            &mut pending,
            true,
            &copy.marker,
            copy.epoch,
            &attempt
        ));
        assert!(pending.pending.is_some());
    }

    #[test]
    fn ack_rejects_noncanonical_url_and_marker_mismatch() {
        let mut session = session_with_pending(1);
        let copy = begin_ack_attempt(&mut session).unwrap();
        let attempt = copy.attempt.clone().unwrap();
        assert!(!commit_shell_ack(
            true,
            &mut session,
            false,
            &copy.marker,
            copy.epoch,
            &attempt
        ));
        assert!(!commit_shell_ack(
            true,
            &mut session,
            true,
            "forged-marker",
            copy.epoch,
            &attempt
        ));
        assert!(!commit_shell_ack(
            true,
            &mut session,
            true,
            &copy.marker,
            copy.epoch,
            "forged-attempt"
        ));
        assert_eq!(
            session.surface,
            ShellSurface::PendingShell { epoch: copy.epoch }
        );
    }

    #[test]
    fn fail_pending_before_finished_hides_and_finished_before_fail_keeps_shell() {
        let mut session = session_with_pending(2);
        let copy = session.pending.clone().unwrap();
        assert!(fail_pending_shell(&mut session, &copy));
        assert_eq!(session.surface, ShellSurface::Hidden);
        assert!(session.pending.is_none());

        let mut finished = session_with_pending(2);
        let copy = begin_ack_attempt(&mut finished).unwrap();
        let attempt = copy.attempt.clone().unwrap();
        assert!(commit_shell_ack(
            true,
            &mut finished,
            true,
            &copy.marker,
            copy.epoch,
            &attempt
        ));
        assert_eq!(finished.surface, ShellSurface::Shell);
        assert!(!fail_pending_shell(&mut finished, &copy));
        assert_eq!(finished.surface, ShellSurface::Shell);
    }

    fn reload_generation(decision: AckAttemptDecision, epoch: u64) -> String {
        match decision {
            AckAttemptDecision::Reload {
                epoch: got,
                generation,
            } => {
                assert_eq!(got, epoch);
                generation
            }
            other => panic!("expected Reload, got {other:?}"),
        }
    }

    #[test]
    fn ack_timeout_reloads_then_gives_up_without_showing() {
        let mut session = session_with_pending(1);
        let copy = session.pending.clone().unwrap();
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                false,
                &mut session,
                &copy.marker,
                copy.epoch,
                "stale-attempt"
            )),
            TimeoutWindowAction::Noop
        );
        for _ in 0..MAX_SHELL_ACK_RETRIES {
            let armed = begin_ack_attempt(&mut session).unwrap();
            let attempt = armed.attempt.clone().unwrap();
            let generation = reload_generation(
                resolve_ack_attempt_failure(
                    true,
                    &mut session,
                    &armed.marker,
                    armed.epoch,
                    &attempt,
                ),
                armed.epoch,
            );
            assert!(session.pending.as_ref().unwrap().attempt.is_none());
            assert_eq!(
                session.surface,
                ShellSurface::ReloadingShell {
                    epoch: armed.epoch,
                    generation: generation.clone()
                }
            );
            assert!(begin_ack_attempt(&mut session).is_none());
            assert_eq!(
                timeout_window_action(resolve_ack_attempt_failure(
                    true,
                    &mut session,
                    &armed.marker,
                    armed.epoch,
                    &attempt
                )),
                TimeoutWindowAction::Noop
            );
            assert_eq!(
                plan_canonical_finished(
                    true,
                    &mut session,
                    &CanonicalPageUrl::Reload { generation }
                ),
                CanonicalFinished::DispatchEval
            );
        }
        let armed = begin_ack_attempt(&mut session).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut session,
                &armed.marker,
                armed.epoch,
                &attempt
            )),
            TimeoutWindowAction::Hide
        );
        assert_eq!(session.surface, ShellSurface::Hidden);
        assert!(session.pending.is_none());
    }

    #[test]
    fn ignore_timeout_after_ack_or_newer_surface_is_window_noop() {
        assert_eq!(
            timeout_window_action(AckAttemptDecision::Ignore),
            TimeoutWindowAction::Noop
        );
        assert_eq!(
            timeout_window_action(AckAttemptDecision::GiveUp),
            TimeoutWindowAction::Hide
        );
        let mapped = timeout_window_action(AckAttemptDecision::Reload {
            epoch: 7,
            generation: "gen-7".into(),
        });
        assert_eq!(
            mapped,
            TimeoutWindowAction::HideAndNavigate {
                epoch: 7,
                generation: "gen-7".into()
            }
        );

        let mut acked = session_with_pending(1);
        let armed = begin_ack_attempt(&mut acked).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        assert!(commit_shell_ack(
            true,
            &mut acked,
            true,
            &armed.marker,
            armed.epoch,
            &attempt
        ));
        assert_eq!(acked.surface, ShellSurface::Shell);
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut acked,
                &armed.marker,
                armed.epoch,
                &attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert_eq!(acked.surface, ShellSurface::Shell);

        let mut attaching = session_with_pending(1);
        let armed = begin_ack_attempt(&mut attaching).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        begin_pending_attach(&mut attaching, identity("http://localhost:10100", 11)).unwrap();
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut attaching,
                &armed.marker,
                armed.epoch,
                &attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert!(matches!(
            attaching.surface,
            ShellSurface::PendingAttach { .. }
        ));

        let mut superseded = session_with_pending(1);
        let old = begin_ack_attempt(&mut superseded).unwrap();
        let old_attempt = old.attempt.clone().unwrap();
        let next = superseded.ledger.begin();
        superseded.pending = Some(pending_copy(next.epoch.0));
        superseded.surface = ShellSurface::PendingShell {
            epoch: next.epoch.0,
        };
        let _new = begin_ack_attempt(&mut superseded).unwrap();
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut superseded,
                &old.marker,
                old.epoch,
                &old_attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert_eq!(
            superseded.surface,
            ShellSurface::PendingShell {
                epoch: next.epoch.0
            }
        );
    }

    #[test]
    fn timeout_wins_late_ack_fails_ack_wins_timeout_is_noop_duplicate_timer_is_noop() {
        let mut timeout_wins = session_with_pending(3);
        let armed = begin_ack_attempt(&mut timeout_wins).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        let generation = reload_generation(
            resolve_ack_attempt_failure(
                true,
                &mut timeout_wins,
                &armed.marker,
                armed.epoch,
                &attempt,
            ),
            armed.epoch,
        );
        assert!(!commit_shell_ack(
            true,
            &mut timeout_wins,
            true,
            &armed.marker,
            armed.epoch,
            &attempt
        ));
        assert_eq!(
            timeout_wins.surface,
            ShellSurface::ReloadingShell {
                epoch: armed.epoch,
                generation
            }
        );

        let mut ack_wins = session_with_pending(3);
        let armed = begin_ack_attempt(&mut ack_wins).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        assert!(commit_shell_ack(
            true,
            &mut ack_wins,
            true,
            &armed.marker,
            armed.epoch,
            &attempt
        ));
        assert_eq!(ack_wins.surface, ShellSurface::Shell);
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut ack_wins,
                &armed.marker,
                armed.epoch,
                &attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert_eq!(ack_wins.surface, ShellSurface::Shell);

        let mut duplicate = session_with_pending(3);
        let first = begin_ack_attempt(&mut duplicate).unwrap();
        let first_attempt = first.attempt.clone().unwrap();
        let second = begin_ack_attempt(&mut duplicate).unwrap();
        let second_attempt = second.attempt.clone().unwrap();
        assert_ne!(first_attempt, second_attempt);
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut duplicate,
                &first.marker,
                first.epoch,
                &first_attempt
            )),
            TimeoutWindowAction::Noop
        );
        let _ = reload_generation(
            resolve_ack_attempt_failure(
                true,
                &mut duplicate,
                &second.marker,
                second.epoch,
                &second_attempt,
            ),
            second.epoch,
        );
        assert!(duplicate.pending.as_ref().unwrap().attempt.is_none());
        assert!(matches!(
            duplicate.surface,
            ShellSurface::ReloadingShell { .. }
        ));
    }

    #[test]
    fn stale_eval_failure_loses_to_newer_attach_ack_attempt_and_quit() {
        let mut attaching = session_with_pending(4);
        let ReadyShellEval::DispatchFailed { attempt } =
            eval_ready_shell(&mut attaching, pending_copy(4), |_| Err("eval failed"))
        else {
            panic!("dispatch failure");
        };
        let marker = attaching.pending.as_ref().unwrap().marker.clone();
        begin_pending_attach(&mut attaching, identity("http://localhost:10100", 11)).unwrap();
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut attaching,
                &marker,
                4,
                &attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert!(matches!(
            attaching.surface,
            ShellSurface::PendingAttach { .. }
        ));

        let mut acked = session_with_pending(4);
        let ReadyShellEval::WaitForAck { attempt } =
            eval_ready_shell(&mut acked, pending_copy(4), |_| Ok::<(), ()>(()))
        else {
            panic!("dispatch ok");
        };
        let marker = acked.pending.as_ref().unwrap().marker.clone();
        assert!(commit_shell_ack(
            true, &mut acked, true, &marker, 4, &attempt
        ));
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true, &mut acked, &marker, 4, &attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert_eq!(acked.surface, ShellSurface::Shell);

        let mut newer = session_with_pending(4);
        let ReadyShellEval::DispatchFailed {
            attempt: old_attempt,
        } = eval_ready_shell(&mut newer, pending_copy(4), |_| Err("eval failed"))
        else {
            panic!("dispatch failure");
        };
        let marker = newer.pending.as_ref().unwrap().marker.clone();
        let second = begin_ack_attempt(&mut newer).unwrap();
        assert_ne!(second.attempt.as_deref(), Some(old_attempt.as_str()));
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut newer,
                &marker,
                4,
                &old_attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert_eq!(newer.pending.as_ref().unwrap().attempt, second.attempt);

        let mut quitting = session_with_pending(4);
        let ReadyShellEval::DispatchFailed { attempt } =
            eval_ready_shell(&mut quitting, pending_copy(4), |_| Err("eval failed"))
        else {
            panic!("dispatch failure");
        };
        let marker = quitting.pending.as_ref().unwrap().marker.clone();
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                false,
                &mut quitting,
                &marker,
                4,
                &attempt
            )),
            TimeoutWindowAction::Noop
        );
        assert_eq!(quitting.surface, ShellSurface::PendingShell { epoch: 4 });
        assert_eq!(
            quitting.pending.as_ref().unwrap().attempt.as_deref(),
            Some(attempt.as_str())
        );
    }

    #[test]
    fn eval_failure_wins_invalidates_attempt_late_ack_fails_and_retries_give_up() {
        let mut session = session_with_pending(5);
        let ReadyShellEval::DispatchFailed { attempt } =
            eval_ready_shell(&mut session, pending_copy(5), |_| Err("eval failed"))
        else {
            panic!("dispatch failure");
        };
        let marker = session.pending.as_ref().unwrap().marker.clone();
        let mut generation = reload_generation(
            resolve_ack_attempt_failure(true, &mut session, &marker, 5, &attempt),
            5,
        );
        assert!(session.pending.as_ref().unwrap().attempt.is_none());
        assert_eq!(session.pending.as_ref().unwrap().retries, 1);
        assert!(!commit_shell_ack(
            true,
            &mut session,
            true,
            &marker,
            5,
            &attempt
        ));
        assert_eq!(
            session.surface,
            ShellSurface::ReloadingShell {
                epoch: 5,
                generation: generation.clone()
            }
        );
        assert!(begin_ack_attempt(&mut session).is_none());

        for expected in 2..=MAX_SHELL_ACK_RETRIES {
            assert_eq!(
                plan_canonical_finished(
                    true,
                    &mut session,
                    &CanonicalPageUrl::Reload {
                        generation: generation.clone()
                    }
                ),
                CanonicalFinished::DispatchEval
            );
            let armed = begin_ack_attempt(&mut session).unwrap();
            let next = armed.attempt.clone().unwrap();
            let next_generation = reload_generation(
                resolve_ack_attempt_failure(true, &mut session, &armed.marker, 5, &next),
                5,
            );
            assert_eq!(session.pending.as_ref().unwrap().retries, expected);
            generation = next_generation;
        }
        assert_eq!(
            plan_canonical_finished(true, &mut session, &CanonicalPageUrl::Reload { generation }),
            CanonicalFinished::DispatchEval
        );
        let armed = begin_ack_attempt(&mut session).unwrap();
        let last = armed.attempt.clone().unwrap();
        assert_eq!(
            timeout_window_action(resolve_ack_attempt_failure(
                true,
                &mut session,
                &armed.marker,
                5,
                &last
            )),
            TimeoutWindowAction::Hide
        );
        assert_eq!(session.surface, ShellSurface::Hidden);
        assert!(session.pending.is_none());
        assert!(!commit_shell_ack(
            true,
            &mut session,
            true,
            &armed.marker,
            5,
            &last
        ));
    }

    #[test]
    fn pageload_ack_between_reload_cas_and_effect_stays_non_dispatchable() {
        let mut session = session_with_pending(8);
        let armed = begin_ack_attempt(&mut session).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        let generation = reload_generation(
            resolve_ack_attempt_failure(true, &mut session, &armed.marker, armed.epoch, &attempt),
            armed.epoch,
        );
        assert!(begin_ack_attempt(&mut session).is_none());
        assert!(!commit_shell_ack(
            true,
            &mut session,
            true,
            &armed.marker,
            armed.epoch,
            &attempt
        ));
        assert_eq!(
            plan_canonical_finished(true, &mut session, &CanonicalPageUrl::Bare),
            CanonicalFinished::Ignore
        );
        assert_eq!(
            plan_canonical_finished(
                true,
                &mut session,
                &CanonicalPageUrl::Reload {
                    generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into()
                }
            ),
            CanonicalFinished::Ignore
        );
        assert_eq!(
            plan_canonical_finished(
                true,
                &mut session,
                &CanonicalPageUrl::Reload {
                    generation: generation.clone()
                }
            ),
            CanonicalFinished::DispatchEval
        );
        assert_eq!(
            session.surface,
            ShellSurface::PendingShell { epoch: armed.epoch }
        );
        let retry = begin_ack_attempt(&mut session).unwrap();
        assert!(retry.attempt.is_some());
        assert_eq!(
            plan_canonical_finished(true, &mut session, &CanonicalPageUrl::Reload { generation }),
            CanonicalFinished::Ignore,
            "duplicate matching Finished after arm must not re-dispatch"
        );
    }

    #[test]
    fn fail_reloading_generation_gives_up_and_stale_watchdog_is_noop() {
        let mut session = session_with_pending(9);
        let armed = begin_ack_attempt(&mut session).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        let generation = reload_generation(
            resolve_ack_attempt_failure(true, &mut session, &armed.marker, armed.epoch, &attempt),
            armed.epoch,
        );
        assert!(!fail_reloading_generation(
            false,
            &mut session,
            armed.epoch,
            &generation
        ));
        assert!(!fail_reloading_generation(
            true,
            &mut session,
            armed.epoch,
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        ));
        assert!(fail_reloading_generation(
            true,
            &mut session,
            armed.epoch,
            &generation
        ));
        assert_eq!(session.surface, ShellSurface::Hidden);
        assert!(session.pending.is_none());
        assert!(!fail_reloading_generation(
            true,
            &mut session,
            armed.epoch,
            &generation
        ));

        let mut live = session_with_pending(9);
        let armed = begin_ack_attempt(&mut live).unwrap();
        let attempt = armed.attempt.clone().unwrap();
        let generation = reload_generation(
            resolve_ack_attempt_failure(true, &mut live, &armed.marker, armed.epoch, &attempt),
            armed.epoch,
        );
        assert_eq!(
            plan_canonical_finished(
                true,
                &mut live,
                &CanonicalPageUrl::Reload {
                    generation: generation.clone()
                }
            ),
            CanonicalFinished::DispatchEval
        );
        assert!(!fail_reloading_generation(
            true,
            &mut live,
            armed.epoch,
            &generation
        ));
        assert_eq!(
            live.surface,
            ShellSurface::PendingShell { epoch: armed.epoch }
        );
    }
}
