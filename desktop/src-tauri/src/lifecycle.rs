use serde_json::Value;

use crate::bridge::BridgeClientError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPhase {
    Running,
    QuitInProgress,
    Exiting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitDecision {
    Exit,
    StayVisible { message: String },
}

pub fn quit_decision_from_stop(result: Result<&Value, &BridgeClientError>) -> QuitDecision {
    match result {
        Ok(envelope) if envelope["ok"] == Value::Bool(true) => {
            let result = &envelope["result"];
            if result["code"].as_str() == Some("stopped") && result["proxyAbsent"] == Value::Bool(true)
            {
                QuitDecision::Exit
            } else {
                QuitDecision::StayVisible {
                    message: "stop transaction did not confirm proxyAbsent".to_string(),
                }
            }
        }
        Ok(envelope) => {
            let code = envelope["error"]["code"].as_str().unwrap_or("stop_failed");
            let message = envelope["error"]["message"]
                .as_str()
                .unwrap_or("stop failed");
            QuitDecision::StayVisible {
                message: format!("{code}: {message}"),
            }
        }
        Err(BridgeClientError::DeadlineExceeded { operation }) => QuitDecision::StayVisible {
            message: format!(
                "{operation} deadline exceeded; outcome unknown; reconcile with status; shell stays visible"
            ),
        },
        Err(err) => QuitDecision::StayVisible {
            message: format!("{}: {}", err.code(), err.message()),
        },
    }
}

pub fn should_prevent_window_close() -> bool {
    true
}

/// Open, Status, and bootstrap may resolve a bridge spec only while the app is
/// still `Running`. `QuitInProgress` and `Exiting` must not start, attach, or show.
pub fn phase_allows_bridge_work(phase: QuitPhase) -> bool {
    matches!(phase, QuitPhase::Running)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::BridgeClientError;

    #[test]
    fn successful_stop_with_absent_proxy_exits() {
        let envelope = serde_json::json!({
            "ok": true,
            "result": {
                "ok": true,
                "code": "stopped",
                "proxyAbsent": true,
                "restoreStatus": "restored",
                "grokStatus": "not-needed"
            }
        });
        assert_eq!(quit_decision_from_stop(Ok(&envelope)), QuitDecision::Exit);
    }

    #[test]
    fn stop_failure_and_protocol_errors_stay_visible() {
        let restore_failed = serde_json::json!({
            "ok": false,
            "error": {
                "code": "restore_failed",
                "message": "restore failed",
                "retryable": false
            }
        });
        match quit_decision_from_stop(Ok(&restore_failed)) {
            QuitDecision::StayVisible { message } => {
                assert!(message.contains("restore_failed"));
            }
            QuitDecision::Exit => panic!("restore failure must not exit"),
        }

        let ownership = serde_json::json!({
            "ok": false,
            "error": {
                "code": "ownership_conflict",
                "message": "home mismatch",
                "retryable": false
            }
        });
        assert!(matches!(
            quit_decision_from_stop(Ok(&ownership)),
            QuitDecision::StayVisible { .. }
        ));

        let protocol = BridgeClientError::Protocol {
            message: "exit code 0 does not match envelope (expected 1)".to_string(),
        };
        assert!(matches!(
            quit_decision_from_stop(Err(&protocol)),
            QuitDecision::StayVisible { .. }
        ));

        let deadline = BridgeClientError::DeadlineExceeded { operation: "stop" };
        match quit_decision_from_stop(Err(&deadline)) {
            QuitDecision::StayVisible { message } => {
                assert!(message.contains("outcome unknown"));
            }
            QuitDecision::Exit => panic!("timeout must not pretend quit succeeded"),
        }
    }

    #[test]
    fn close_hides_rather_than_quits() {
        assert!(should_prevent_window_close());
    }

    #[test]
    fn only_running_phase_allows_bootstrap_open_or_status() {
        assert!(phase_allows_bridge_work(QuitPhase::Running));
        assert!(!phase_allows_bridge_work(QuitPhase::QuitInProgress));
        assert!(!phase_allows_bridge_work(QuitPhase::Exiting));
    }
}
