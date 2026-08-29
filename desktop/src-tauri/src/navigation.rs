use std::sync::{Mutex, MutexGuard};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

use crate::origin::navigation_matches_allowed_origin;

#[derive(Debug, Clone, Default)]
pub struct NavigationPolicy {
    pub allowed_origin: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    Allow,
    OpenSystemBrowser,
    Deny,
}

pub fn is_about_blank(url: &Url) -> bool {
    url.scheme() == "about" && (url.path() == "blank" || url.as_str() == "about:blank")
}

pub fn is_app_local_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" => url.host_str() == Some("localhost"),
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost") | Some("asset.localhost")
        ),
        _ => false,
    }
}

pub fn decide_navigation(url: &Url, policy: &NavigationPolicy) -> NavigationDecision {
    if is_about_blank(url) || is_app_local_url(url) {
        return NavigationDecision::Allow;
    }
    if let Some(allowed) = policy.allowed_origin.as_deref() {
        if navigation_matches_allowed_origin(url, allowed) {
            return NavigationDecision::Allow;
        }
    }
    if url.host_str() == Some("ipc.localhost") {
        return NavigationDecision::Deny;
    }
    if url.scheme() == "http" || url.scheme() == "https" {
        return NavigationDecision::OpenSystemBrowser;
    }
    NavigationDecision::Deny
}

pub fn lock_policy(policy: &Mutex<NavigationPolicy>) -> MutexGuard<'_, NavigationPolicy> {
    policy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn set_allowed_origin(policy: &Mutex<NavigationPolicy>, origin: Option<String>) {
    lock_policy(policy).allowed_origin = origin;
}

pub fn init_plugin<R: Runtime>(policy: std::sync::Arc<Mutex<NavigationPolicy>>) -> TauriPlugin<R> {
    Builder::new("opencodex-navigation")
        .on_navigation(move |webview, url| {
            let decision = {
                let guard = lock_policy(&policy);
                decide_navigation(url, &guard)
            };
            match decision {
                NavigationDecision::Allow => true,
                NavigationDecision::OpenSystemBrowser => {
                    let _ = webview
                        .app_handle()
                        .opener()
                        .open_url(url.as_str(), None::<&str>);
                    false
                }
                NavigationDecision::Deny => false,
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use url::Url;

    fn url(input: &str) -> Url {
        Url::parse(input).expect(input)
    }

    #[test]
    fn allowlist_and_system_browser_handoff() {
        let mut policy = NavigationPolicy::default();
        assert_eq!(
            decide_navigation(&url("tauri://localhost/index.html"), &policy),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&url("http://tauri.localhost/index.html"), &policy),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&url("http://localhost:10100/"), &policy),
            NavigationDecision::OpenSystemBrowser
        );

        policy.allowed_origin = Some("http://localhost:10100".to_string());
        assert_eq!(
            decide_navigation(&url("http://localhost:10100/#/providers"), &policy),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&url("http://127.0.0.1:10100/"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
        assert_eq!(
            decide_navigation(&url("http://localhost:9999/"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
        assert_eq!(
            decide_navigation(&url("https://example.com/login"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
        assert_eq!(
            decide_navigation(&url("http://192.168.1.10:10100/"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
        assert_eq!(
            decide_navigation(&url("file:///etc/passwd"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("opencodex://status"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("ipc://localhost/command"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("http://ipc.localhost/command"), &policy),
            NavigationDecision::Deny
        );
    }
}
