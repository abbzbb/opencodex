use std::sync::{Mutex, MutexGuard};

/// Exclusive shell-transition lock. Bootstrap, Tray Open, Tray Status, and
/// explicit Quit each acquire this before resolving a bridge spec and hold it
/// through their state change so those operations cannot overlap.
pub fn lock_exclusive(lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    lock.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn run_exclusive<R>(lock: &Mutex<()>, op: impl FnOnce() -> R) -> R {
    let _guard = lock_exclusive(lock);
    op()
}

/// Serialized ack-attempt failure handoff. `reduce` (CAS) runs first; `apply`
/// (window effect) runs after, still under the exclusive lock, so attach/reveal
/// cannot enter between CAS and HideAndNavigate. Callers must drop
/// phase/session/navigation inside `reduce` before `apply` navigates.
pub fn run_ack_attempt_handoff<D, R>(
    exclusive: &Mutex<()>,
    reduce: impl FnOnce() -> D,
    apply: impl FnOnce(D) -> R,
) -> R {
    run_exclusive(exclusive, || {
        let decision = reduce();
        apply(decision)
    })
}

/// Status protocol: the live bridge spec is resolved only after the exclusive
/// lock is held, then the query runs before the lock is released. Capturing a
/// spec first (generation A) and querying it after a later generation B is
/// published is the tray-status race this adapter forbids.
pub fn status_with_locked_spec<S, R>(
    exclusive: &Mutex<()>,
    resolve_spec: impl FnOnce() -> S,
    query: impl FnOnce(&S) -> R,
) -> R {
    run_exclusive(exclusive, || {
        let spec = resolve_spec();
        query(&spec)
    })
}

/// Quit protocol: spec resolution, stop, and the Exit / StayVisible commit all
/// run under one exclusive hold. Phase is set to QuitInProgress *before* the
/// worker is spawned; this adapter does not take the phase lock first, so it
/// cannot invert with callers that hold the exclusive lock and then read phase.
pub fn quit_with_locked_spec<S, D>(
    exclusive: &Mutex<()>,
    resolve_spec: impl FnOnce() -> Result<S, D>,
    stop: impl FnOnce(&S) -> D,
    finish: impl FnOnce(D),
) {
    run_exclusive(exclusive, || {
        let decision = match resolve_spec() {
            Ok(spec) => stop(&spec),
            Err(decision) => decision,
        };
        finish(decision);
    });
}

/// Canonical PageLoad Finished protocol.
///
/// Reveal/attach hold the exclusive transition lock across `WebView::navigate`.
/// A local app URL can deliver `PageLoadEvent::Finished` reentrantly, so this
/// callback must **not** take that lock. It blocking-locks the consolidated
/// shell session instead — never `try_lock`, which would drop the only Finished
/// event — then the caller rechecks live epoch/pending/surface before eval.
/// Show is reserved for the ack CAS, not this callback.
pub fn complete_canonical_pageload<T, R>(
    session: &Mutex<T>,
    complete: impl FnOnce(&mut T) -> R,
) -> R {
    let mut session = session
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    complete(&mut session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::{phase_allows_bridge_work, QuitPhase};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Condvar, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn quit_bootstrap_open_and_status_never_overlap() {
        let exclusive = Arc::new(Mutex::new(()));
        let inside = Arc::new(AtomicUsize::new(0));
        let max_inside = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(4));

        let spawn_exclusive = || {
            let exclusive = Arc::clone(&exclusive);
            let inside = Arc::clone(&inside);
            let max_inside = Arc::clone(&max_inside);
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                run_exclusive(&exclusive, || bump(&inside, &max_inside));
            })
        };

        let quit = {
            let exclusive = Arc::clone(&exclusive);
            let inside = Arc::clone(&inside);
            let max_inside = Arc::clone(&max_inside);
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                quit_with_locked_spec(
                    &exclusive,
                    || {
                        bump(&inside, &max_inside);
                        Ok::<&str, &str>("spec")
                    },
                    |_spec| {
                        bump(&inside, &max_inside);
                        "exit"
                    },
                    |_decision| bump(&inside, &max_inside),
                );
            })
        };
        let bootstrap = spawn_exclusive();
        let open = spawn_exclusive();
        let status = {
            let exclusive = Arc::clone(&exclusive);
            let inside = Arc::clone(&inside);
            let max_inside = Arc::clone(&max_inside);
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                status_with_locked_spec(
                    &exclusive,
                    || {
                        bump(&inside, &max_inside);
                        1u64
                    },
                    |_spec| bump(&inside, &max_inside),
                );
            })
        };

        quit.join().expect("quit");
        bootstrap.join().expect("bootstrap");
        open.join().expect("open");
        status.join().expect("status");
        assert_eq!(
            max_inside.load(Ordering::SeqCst),
            1,
            "quit/bootstrap/open/status must not overlap"
        );
    }

    fn bump(inside: &AtomicUsize, max_inside: &AtomicUsize) {
        let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
        max_inside.fetch_max(now, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(10));
        inside.fetch_sub(1, Ordering::SeqCst);
    }

    #[test]
    fn status_resolves_spec_after_lock_and_sees_generation_b() {
        let exclusive = Arc::new(Mutex::new(()));
        let generation = Arc::new(Mutex::new(1u64));
        let holder_has_lock = Arc::new((Mutex::new(false), Condvar::new()));
        let status_waiting = Arc::new((Mutex::new(false), Condvar::new()));

        let exclusive_p = Arc::clone(&exclusive);
        let generation_p = Arc::clone(&generation);
        let holder_has_lock_p = Arc::clone(&holder_has_lock);
        let status_waiting_p = Arc::clone(&status_waiting);
        let publisher = thread::spawn(move || {
            let _guard = lock_exclusive(&exclusive_p);
            *holder_has_lock_p.0.lock().unwrap() = true;
            holder_has_lock_p.1.notify_all();
            {
                let mut waiting = status_waiting_p.0.lock().unwrap();
                while !*waiting {
                    waiting = status_waiting_p.1.wait(waiting).unwrap();
                }
            }
            *generation_p.lock().unwrap() = 2;
        });

        {
            let mut held = holder_has_lock.0.lock().unwrap();
            while !*held {
                held = holder_has_lock.1.wait(held).unwrap();
            }
        }

        let exclusive_s = Arc::clone(&exclusive);
        let generation_s = Arc::clone(&generation);
        let status_waiting_s = Arc::clone(&status_waiting);
        let status = thread::spawn(move || {
            *status_waiting_s.0.lock().unwrap() = true;
            status_waiting_s.1.notify_all();
            status_with_locked_spec(&exclusive_s, || *generation_s.lock().unwrap(), |spec| *spec)
        });

        let observed = status.join().expect("status");
        publisher.join().expect("publisher");
        assert_eq!(observed, 2, "lock-first status must query generation B");
    }

    #[test]
    fn capturing_generation_a_before_lock_misses_published_b() {
        let exclusive = Arc::new(Mutex::new(()));
        let generation = Arc::new(Mutex::new(1u64));
        let holder_has_lock = Arc::new((Mutex::new(false), Condvar::new()));
        let status_waiting = Arc::new((Mutex::new(false), Condvar::new()));

        let captured_a = *generation.lock().unwrap();

        let exclusive_p = Arc::clone(&exclusive);
        let generation_p = Arc::clone(&generation);
        let holder_has_lock_p = Arc::clone(&holder_has_lock);
        let status_waiting_p = Arc::clone(&status_waiting);
        let publisher = thread::spawn(move || {
            let _guard = lock_exclusive(&exclusive_p);
            *holder_has_lock_p.0.lock().unwrap() = true;
            holder_has_lock_p.1.notify_all();
            {
                let mut waiting = status_waiting_p.0.lock().unwrap();
                while !*waiting {
                    waiting = status_waiting_p.1.wait(waiting).unwrap();
                }
            }
            *generation_p.lock().unwrap() = 2;
        });

        {
            let mut held = holder_has_lock.0.lock().unwrap();
            while !*held {
                held = holder_has_lock.1.wait(held).unwrap();
            }
        }

        let exclusive_s = Arc::clone(&exclusive);
        let status_waiting_s = Arc::clone(&status_waiting);
        let status = thread::spawn(move || {
            *status_waiting_s.0.lock().unwrap() = true;
            status_waiting_s.1.notify_all();
            run_exclusive(&exclusive_s, || captured_a)
        });

        let queried = status.join().expect("status");
        publisher.join().expect("publisher");
        assert_eq!(queried, 1, "pre-lock capture is generation A");
        assert_eq!(*generation.lock().unwrap(), 2, "generation B was published");
        assert_ne!(
            queried,
            *generation.lock().unwrap(),
            "querying a spec captured before the lock revokes generation B"
        );
    }

    #[test]
    fn quit_does_not_resolve_spec_until_the_exclusive_lock_is_held() {
        let exclusive = Arc::new(Mutex::new(()));
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let quit_entered = Arc::new((Mutex::new(false), Condvar::new()));

        let hold = lock_exclusive(&exclusive);

        let exclusive_q = Arc::clone(&exclusive);
        let order_q = Arc::clone(&order);
        let quit_entered_q = Arc::clone(&quit_entered);
        let worker = thread::spawn(move || {
            *quit_entered_q.0.lock().unwrap() = true;
            quit_entered_q.1.notify_all();
            quit_with_locked_spec(
                &exclusive_q,
                || {
                    order_q.lock().unwrap().push("resolve");
                    Ok::<&str, &str>("spec")
                },
                |_spec| {
                    order_q.lock().unwrap().push("stop");
                    "exit"
                },
                |_decision| {
                    order_q.lock().unwrap().push("finish");
                },
            );
        });

        {
            let mut entered = quit_entered.0.lock().unwrap();
            while !*entered {
                entered = quit_entered.1.wait(entered).unwrap();
            }
        }
        thread::sleep(Duration::from_millis(20));
        assert!(
            order.lock().unwrap().is_empty(),
            "quit must not resolve the spec while bootstrap still holds the lock"
        );
        order.lock().unwrap().push("bootstrap");
        drop(hold);
        worker.join().expect("quit");
        assert_eq!(
            *order.lock().unwrap(),
            ["bootstrap", "resolve", "stop", "finish"]
        );
    }

    #[test]
    fn canonical_pageload_blocks_on_session_instead_of_dropping_finished() {
        let session = Arc::new(Mutex::new(0u32));
        let ran = Arc::new(AtomicBool::new(false));
        let hold = session.lock().unwrap();
        let session_w = Arc::clone(&session);
        let ran_w = Arc::clone(&ran);
        let worker = thread::spawn(move || {
            complete_canonical_pageload(&session_w, |value| {
                *value += 1;
                ran_w.store(true, Ordering::SeqCst);
            });
        });
        thread::sleep(Duration::from_millis(20));
        assert!(
            !ran.load(Ordering::SeqCst),
            "Finished must wait for the session lock; try_lock would have skipped it"
        );
        drop(hold);
        worker.join().expect("pageload");
        assert!(ran.load(Ordering::SeqCst));
        assert_eq!(*session.lock().unwrap(), 1);
    }

    #[test]
    fn quit_in_progress_and_exiting_do_not_resolve_bridge_work() {
        let exclusive = Mutex::new(());
        for phase in [QuitPhase::QuitInProgress, QuitPhase::Exiting] {
            let mut resolved = false;
            status_with_locked_spec(
                &exclusive,
                || {
                    if !phase_allows_bridge_work(phase) {
                        return None;
                    }
                    resolved = true;
                    Some("spec")
                },
                |spec| {
                    assert!(spec.is_none());
                },
            );
            assert!(!resolved, "{phase:?} must return before spec resolution");
        }
        let mut resolved = false;
        status_with_locked_spec(
            &exclusive,
            || {
                if !phase_allows_bridge_work(QuitPhase::Running) {
                    return None;
                }
                resolved = true;
                Some("spec")
            },
            |spec| {
                assert_eq!(*spec, Some("spec"));
            },
        );
        assert!(resolved);
    }

    #[test]
    fn attach_cannot_enter_between_ack_attempt_cas_and_window_effect() {
        use crate::attachment::{timeout_window_action, AckAttemptDecision, TimeoutWindowAction};

        let exclusive = Arc::new(Mutex::new(()));
        let cas_done = Arc::new(Barrier::new(2));
        let attacher_observed = Arc::new(Barrier::new(2));
        let attach_entered_during_effect = Arc::new(AtomicBool::new(false));
        let effect_action = Arc::new(Mutex::new(None));

        let worker = {
            let exclusive = Arc::clone(&exclusive);
            let cas_done = Arc::clone(&cas_done);
            let attacher_observed = Arc::clone(&attacher_observed);
            let attach_entered_during_effect = Arc::clone(&attach_entered_during_effect);
            let effect_action = Arc::clone(&effect_action);
            thread::spawn(move || {
                run_ack_attempt_handoff(
                    &exclusive,
                    || {
                        cas_done.wait();
                        AckAttemptDecision::Reload {
                            epoch: 1,
                            generation: "gen-1".into(),
                        }
                    },
                    |decision| {
                        attacher_observed.wait();
                        thread::sleep(Duration::from_millis(20));
                        assert!(
                            !attach_entered_during_effect.load(Ordering::SeqCst),
                            "attach/reveal must not take transition between CAS and effect"
                        );
                        *effect_action.lock().unwrap() = Some(timeout_window_action(decision));
                    },
                );
            })
        };

        cas_done.wait();
        assert!(
            exclusive.try_lock().is_err(),
            "transition must stay held after failure CAS"
        );
        attacher_observed.wait();
        let entered = exclusive.try_lock().is_ok();
        attach_entered_during_effect.store(entered, Ordering::SeqCst);
        worker.join().expect("handoff worker");
        assert!(!entered, "attach must wait until HideAndNavigate finishes");
        assert_eq!(
            *effect_action.lock().unwrap(),
            Some(TimeoutWindowAction::HideAndNavigate {
                epoch: 1,
                generation: "gen-1".into(),
            })
        );
        assert!(
            exclusive.lock().is_ok(),
            "attach may enter after the handoff"
        );
    }

    #[test]
    fn pageload_ack_between_reload_cas_and_effect_cannot_show() {
        use crate::attachment::{
            begin_ack_attempt, commit_shell_ack, plan_canonical_finished,
            resolve_ack_attempt_failure, CanonicalFinished, ShellSession, ShellSurface,
        };
        use crate::navigation::CanonicalPageUrl;

        let exclusive = Arc::new(Mutex::new(()));
        let session = Arc::new(Mutex::new({
            let mut session = ShellSession::default();
            while session.ledger.epoch().0 < 1 {
                session.ledger.begin();
            }
            session.pending = Some(crate::attachment::PendingShellCopy {
                title: "OpenCodex".into(),
                message: "status".into(),
                detail: "detail".into(),
                epoch: 1,
                marker: "marker-1".into(),
                attempt: None,
                retries: 0,
            });
            session.surface = ShellSurface::PendingShell { epoch: 1 };
            session
        }));
        let cas_done = Arc::new(Barrier::new(2));
        let stale_tried = Arc::new(Barrier::new(2));
        let generation = Arc::new(Mutex::new(None));

        let worker = {
            let exclusive = Arc::clone(&exclusive);
            let session = Arc::clone(&session);
            let cas_done = Arc::clone(&cas_done);
            let stale_tried = Arc::clone(&stale_tried);
            thread::spawn(move || {
                run_ack_attempt_handoff(
                    &exclusive,
                    || {
                        let mut guard = session.lock().unwrap();
                        let armed = begin_ack_attempt(&mut guard).unwrap();
                        let attempt = armed.attempt.clone().unwrap();
                        let decision = resolve_ack_attempt_failure(
                            true,
                            &mut guard,
                            &armed.marker,
                            armed.epoch,
                            &attempt,
                        );
                        drop(guard);
                        cas_done.wait();
                        stale_tried.wait();
                        decision
                    },
                    |_decision| {},
                );
            })
        };

        cas_done.wait();
        {
            let mut guard = session.lock().unwrap();
            assert!(matches!(guard.surface, ShellSurface::ReloadingShell { .. }));
            assert!(begin_ack_attempt(&mut guard).is_none());
            assert!(!commit_shell_ack(
                true, &mut guard, true, "marker-1", 1, "attempt"
            ));
            assert_eq!(
                plan_canonical_finished(true, &mut guard, &CanonicalPageUrl::Bare),
                CanonicalFinished::Ignore
            );
            if let ShellSurface::ReloadingShell {
                generation: live, ..
            } = &guard.surface
            {
                *generation.lock().unwrap() = Some(live.clone());
            }
        }
        stale_tried.wait();
        worker.join().expect("worker");
        let live = generation.lock().unwrap().clone().expect("generation");
        let mut guard = session.lock().unwrap();
        assert_eq!(
            plan_canonical_finished(
                true,
                &mut guard,
                &CanonicalPageUrl::Reload { generation: live }
            ),
            CanonicalFinished::DispatchEval
        );
        assert!(begin_ack_attempt(&mut guard).is_some());
    }
}
