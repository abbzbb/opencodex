use std::sync::{Mutex, MutexGuard};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

use crate::origin::navigation_matches_allowed_origin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardAttachment {
    pub origin: String,
    pub pid: u32,
    pub owner: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NavigationPolicy {
    pub attachment: Option<DashboardAttachment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    Allow,
    OpenSystemBrowser,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NewWindowAction {
    Deny,
    DenyAndHandoff { url: String },
}

impl NewWindowAction {
    pub fn creates_webview(&self) -> bool {
        false
    }

    pub fn hands_off(&self) -> Option<&str> {
        match self {
            Self::DenyAndHandoff { url } => Some(url.as_str()),
            Self::Deny => None,
        }
    }
}

pub fn is_about_blank(url: &Url) -> bool {
    url.scheme() == "about" && (url.path() == "blank" || url.as_str() == "about:blank")
}

/// Tauri 2.11.5 `WebviewUrl::App` with default `use_https_scheme=false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppLocalPlatform {
    WindowsOrAndroid,
    Unix,
}

pub fn current_app_local_platform() -> AppLocalPlatform {
    if cfg!(windows) || cfg!(target_os = "android") {
        AppLocalPlatform::WindowsOrAndroid
    } else {
        AppLocalPlatform::Unix
    }
}

pub fn canonical_app_local_url_for(platform: AppLocalPlatform) -> Url {
    match platform {
        AppLocalPlatform::WindowsOrAndroid => {
            Url::parse("http://tauri.localhost/").expect("canonical windows app URL")
        }
        AppLocalPlatform::Unix => Url::parse("tauri://localhost/").expect("canonical unix app URL"),
    }
}

pub fn canonical_app_local_url() -> Url {
    canonical_app_local_url_for(current_app_local_platform())
}

fn has_userinfo(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

fn is_bootstrap_path(path: &str) -> bool {
    path.is_empty() || path == "/" || path == "/index.html"
}

fn is_custom_protocol_webview_url(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "asset")
        || matches!(
            url.host_str(),
            Some("tauri.localhost") | Some("asset.localhost")
        )
}

/// Reserved query key for a generation-bound diagnostic reload. Query, not
/// fragment: WebView2 `Navigate` does not fire navigation for fragment-only
/// changes, so `#ocx-reload-<uuid>` cannot produce `PageLoadEvent::Finished`.
pub const RELOAD_QUERY_KEY: &str = "ocx-reload";

/// Classification of a PageLoad event URL. Production classifies
/// `payload.url()` only; a later `webview.url()` sample must not recast an
/// older Finished event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalPageUrl {
    NotAppLocal,
    Bare,
    Reload { generation: String },
}

/// Accept only the lowercase hyphenated form produced by
/// `Uuid::hyphenated().to_string()`. Uppercase, unhyphenated, URN, and
/// percent-encoded aliases are rejected.
fn canonical_reload_generation(token: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(token).ok()?;
    let canonical = parsed.hyphenated().to_string();
    if token != canonical.as_str() {
        return None;
    }
    Some(canonical)
}

fn base_is_platform_canonical(url: &Url, platform: AppLocalPlatform) -> bool {
    if has_userinfo(url) {
        return false;
    }
    if !is_bootstrap_path(url.path()) {
        return false;
    }
    match platform {
        AppLocalPlatform::Unix => {
            url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none()
        }
        AppLocalPlatform::WindowsOrAndroid => {
            url.scheme() == "http"
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none()
        }
    }
}

fn classify_retry_query(url: &Url) -> Option<CanonicalPageUrl> {
    if url.fragment().is_some() {
        return None;
    }
    match url.query() {
        None => Some(CanonicalPageUrl::Bare),
        Some(raw) => {
            // `Url::query()` is the raw serialized query. Form-decoded pairs
            // would accept percent-encoded aliases of this same token.
            let rest = raw.strip_prefix(RELOAD_QUERY_KEY)?.strip_prefix('=')?;
            let parsed = uuid::Uuid::parse_str(rest).ok()?;
            let canonical_uuid = parsed.hyphenated().to_string();
            if raw != format!("{RELOAD_QUERY_KEY}={canonical_uuid}") {
                return None;
            }
            Some(CanonicalPageUrl::Reload {
                generation: canonical_uuid,
            })
        }
    }
}

pub fn classify_canonical_page_url_for(url: &Url, platform: AppLocalPlatform) -> CanonicalPageUrl {
    if !base_is_platform_canonical(url, platform) {
        return CanonicalPageUrl::NotAppLocal;
    }
    classify_retry_query(url).unwrap_or(CanonicalPageUrl::NotAppLocal)
}

/// Classify the PageLoad **event** URL. Never substitute a sampled current
/// webview URL; an older Finished can otherwise be treated as a newer load.
pub fn classify_canonical_page_url(event_url: &Url) -> CanonicalPageUrl {
    classify_canonical_page_url_for(event_url, current_app_local_platform())
}

/// Only the active platform's default App URL is trusted. Inactive tauri/http/https
/// representations, asset protocol, credentials, extra paths, fragments,
/// and unknown/extra query keys are rejected. Non-default ports are rejected;
/// `url::Url` omits an explicit default HTTP `:80`, so that spelling is the
/// same origin as no port. The sole retry token is the raw query
/// `ocx-reload=<lowercase-hyphenated-uuid>`.
pub fn is_canonical_app_local_url_for(url: &Url, platform: AppLocalPlatform) -> bool {
    !matches!(
        classify_canonical_page_url_for(url, platform),
        CanonicalPageUrl::NotAppLocal
    )
}

pub fn is_canonical_app_local_url(url: &Url) -> bool {
    is_canonical_app_local_url_for(url, current_app_local_platform())
}

pub fn canonical_app_local_reload_url_for(
    platform: AppLocalPlatform,
    generation: &str,
) -> Option<Url> {
    let generation = canonical_reload_generation(generation)?;
    let query = format!("{RELOAD_QUERY_KEY}={generation}");
    let mut url = canonical_app_local_url_for(platform);
    url.set_query(Some(&query));
    if url.query() != Some(query.as_str()) {
        return None;
    }
    Some(url)
}

pub fn canonical_app_local_reload_url(generation: &str) -> Option<Url> {
    canonical_app_local_reload_url_for(current_app_local_platform(), generation)
}

pub fn decide_navigation(url: &Url, policy: &NavigationPolicy) -> NavigationDecision {
    if is_about_blank(url) {
        return NavigationDecision::Allow;
    }
    if let Some(attachment) = policy.attachment.as_ref() {
        if navigation_matches_allowed_origin(url, &attachment.origin) {
            return NavigationDecision::Allow;
        }
        if is_custom_protocol_webview_url(url) {
            return NavigationDecision::Deny;
        }
    } else if is_canonical_app_local_url(url) {
        return NavigationDecision::Allow;
    } else if is_custom_protocol_webview_url(url) {
        return NavigationDecision::Deny;
    }
    if url.host_str() == Some("ipc.localhost") {
        return NavigationDecision::Deny;
    }
    if url.scheme() == "http" || url.scheme() == "https" {
        return NavigationDecision::OpenSystemBrowser;
    }
    NavigationDecision::Deny
}

/// http(s) URLs without userinfo may leave the WebView via the system browser.
/// Credentials, unknown schemes, and non-http(s) URLs are never handed to opener.
pub fn system_browser_handoff_url(url: &Url) -> Option<&str> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if has_userinfo(url) {
        return None;
    }
    Some(url.as_str())
}

pub fn decide_new_window_action(url: &Url, policy: &NavigationPolicy) -> NewWindowAction {
    match decide_navigation(url, policy) {
        NavigationDecision::OpenSystemBrowser => match system_browser_handoff_url(url) {
            Some(handoff) => NewWindowAction::DenyAndHandoff {
                url: handoff.to_string(),
            },
            None => NewWindowAction::Deny,
        },
        NavigationDecision::Allow | NavigationDecision::Deny => NewWindowAction::Deny,
    }
}

fn handoff_to_system_browser<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if let Some(handoff) = system_browser_handoff_url(url) {
        let _ = app.opener().open_url(handoff, None::<&str>);
    }
}

pub fn apply_new_window_policy<R: Runtime>(
    app: &AppHandle<R>,
    policy: &Mutex<NavigationPolicy>,
    url: &Url,
) -> NewWindowResponse<R> {
    let action = {
        let guard = lock_policy(policy);
        decide_new_window_action(url, &guard)
    };
    if let Some(handoff) = action.hands_off() {
        let _ = app.opener().open_url(handoff, None::<&str>);
    }
    let _ = action.creates_webview();
    NewWindowResponse::Deny
}

pub fn lock_policy(policy: &Mutex<NavigationPolicy>) -> MutexGuard<'_, NavigationPolicy> {
    policy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
                    handoff_to_system_browser(webview.app_handle(), url);
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

    fn attached(origin: &str) -> NavigationPolicy {
        NavigationPolicy {
            attachment: Some(DashboardAttachment {
                origin: origin.to_string(),
                pid: 4242,
                owner: "desktop-direct".to_string(),
                version: "2.36.0".to_string(),
            }),
        }
    }

    #[test]
    fn unix_canonical_app_url_rejects_inactive_http_https_forms() {
        let unix = AppLocalPlatform::Unix;
        assert!(is_canonical_app_local_url_for(
            &url("tauri://localhost/"),
            unix
        ));
        assert!(is_canonical_app_local_url_for(
            &url("tauri://localhost/index.html"),
            unix
        ));
        assert_eq!(
            canonical_app_local_url_for(unix).as_str(),
            "tauri://localhost/"
        );
        for inactive in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "asset://localhost/",
            "tauri://localhost:1/",
            "tauri://localhost:80/",
            "tauri://user@localhost/",
            "tauri://localhost/other.html",
        ] {
            assert!(
                !is_canonical_app_local_url_for(&url(inactive), unix),
                "{inactive}"
            );
        }
        assert_eq!(
            classify_canonical_page_url_for(&url("tauri://localhost:80/"), unix),
            CanonicalPageUrl::NotAppLocal,
            "tauri is not a special scheme; :80 is kept and rejected"
        );
    }

    #[test]
    fn windows_canonical_app_url_is_http_tauri_localhost() {
        let win = AppLocalPlatform::WindowsOrAndroid;
        assert!(is_canonical_app_local_url_for(
            &url("http://tauri.localhost/"),
            win
        ));
        assert!(is_canonical_app_local_url_for(
            &url("http://tauri.localhost/index.html"),
            win
        ));
        assert_eq!(
            canonical_app_local_url_for(win).as_str(),
            "http://tauri.localhost/"
        );
        for inactive in [
            "https://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "asset://localhost/",
            "http://tauri.localhost:1/",
            "http://tauri.localhost:8080/",
            "http://user@tauri.localhost/",
            "http://tauri.localhost/other.html",
            "http://asset.localhost/",
        ] {
            assert!(
                !is_canonical_app_local_url_for(&url(inactive), win),
                "{inactive}"
            );
        }
        assert_eq!(
            classify_canonical_page_url_for(&url("http://tauri.localhost:80/"), win),
            CanonicalPageUrl::Bare,
            "url::Url drops explicit default HTTP :80; that spelling is same-origin"
        );
        assert_eq!(
            classify_canonical_page_url_for(
                &url("http://tauri.localhost:80/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
                win
            ),
            CanonicalPageUrl::Reload {
                generation: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into()
            },
            "default-port spelling normalizes before query classification"
        );
        assert_eq!(
            classify_canonical_page_url_for(&url("http://tauri.localhost:81/"), win),
            CanonicalPageUrl::NotAppLocal
        );
        assert_eq!(
            classify_canonical_page_url_for(
                &url("http://tauri.localhost:81/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
                win
            ),
            CanonicalPageUrl::NotAppLocal
        );
    }

    #[test]
    fn canonical_reload_query_is_generation_bound_and_event_url_wins() {
        let unix = AppLocalPlatform::Unix;
        let win = AppLocalPlatform::WindowsOrAndroid;
        let generation = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let unix_reload =
            canonical_app_local_reload_url_for(unix, generation).expect("valid unix generation");
        let win_reload =
            canonical_app_local_reload_url_for(win, generation).expect("valid windows generation");
        assert!(unix_reload.as_str().contains("ocx-reload="));
        assert!(unix_reload.fragment().is_none());
        assert!(win_reload.fragment().is_none());
        assert_eq!(
            classify_canonical_page_url_for(&unix_reload, unix),
            CanonicalPageUrl::Reload {
                generation: generation.to_string()
            }
        );
        assert_eq!(
            classify_canonical_page_url_for(&win_reload, win),
            CanonicalPageUrl::Reload {
                generation: generation.to_string()
            }
        );
        assert_eq!(
            classify_canonical_page_url_for(&url("tauri://localhost/"), unix),
            CanonicalPageUrl::Bare
        );
        for bad in [
            "tauri://localhost/#providers",
            "tauri://localhost/#ocx-reload-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?ocx-reload=",
            "tauri://localhost/?ocx-reload=not-a-uuid",
            "tauri://localhost/?ocx-reload=../eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "tauri://localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee&x=1",
            "tauri://localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee&ocx-reload=ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?other=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?",
            "tauri://localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee#hash",
            "tauri://localhost/other.html?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://user@localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost:1/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "http://tauri.localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?%6fcx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?ocx-reload=aaaaaaaa%2Dbbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?ocx-reload=AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
        ] {
            assert_eq!(
                classify_canonical_page_url_for(&url(bad), unix),
                CanonicalPageUrl::NotAppLocal,
                "{bad}"
            );
        }
        let event = url("tauri://localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
        let current =
            canonical_app_local_reload_url_for(unix, "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee")
                .expect("valid current generation");
        assert_eq!(
            classify_canonical_page_url_for(&event, unix),
            CanonicalPageUrl::Reload {
                generation: generation.to_string()
            },
            "old Finished must be classified from the event URL, not a newer current URL"
        );
        assert_eq!(
            classify_canonical_page_url_for(&current, unix),
            CanonicalPageUrl::Reload {
                generation: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee".into()
            }
        );
    }

    #[test]
    fn reload_query_rejects_encoded_aliases_uppercase_duplicates_extras_empty_and_fragment() {
        let unix = AppLocalPlatform::Unix;
        let generation = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        for bad in [
            "tauri://localhost/?%6fcx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?ocx%2Dreload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?ocx-reload=aaaaaaaa%2Dbbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?ocx-reload=AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
            "tauri://localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee&ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "tauri://localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee&x=1",
            "tauri://localhost/?ocx-reload=",
            "tauri://localhost/?",
            "tauri://localhost/?ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee#x",
        ] {
            assert_eq!(
                classify_canonical_page_url_for(&url(bad), unix),
                CanonicalPageUrl::NotAppLocal,
                "{bad}"
            );
        }
        let encoded_key =
            url("tauri://localhost/?%6fcx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
        assert_eq!(
            encoded_key.query(),
            Some("%6fcx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        );
        let decoded_keys: Vec<String> = encoded_key
            .query_pairs()
            .map(|(key, _)| key.into_owned())
            .collect();
        assert_eq!(
            decoded_keys,
            vec!["ocx-reload"],
            "query_pairs form-decodes aliases; classification must not"
        );
        let minted = canonical_app_local_reload_url_for(unix, generation).expect("valid");
        assert_eq!(
            minted.query(),
            Some("ocx-reload=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        );
        assert_eq!(
            classify_canonical_page_url_for(&minted, unix),
            CanonicalPageUrl::Reload {
                generation: generation.into()
            }
        );
    }

    #[test]
    fn consecutive_reload_generations_are_distinct_query_documents() {
        let unix = AppLocalPlatform::Unix;
        let first = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let second = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let url_a = canonical_app_local_reload_url_for(unix, first).expect("first");
        let url_b = canonical_app_local_reload_url_for(unix, second).expect("second");
        assert_ne!(url_a.as_str(), url_b.as_str());
        assert_ne!(url_a.query(), url_b.query());
        assert!(url_a.fragment().is_none());
        assert!(url_b.fragment().is_none());
        assert_eq!(
            classify_canonical_page_url_for(&url_a, unix),
            CanonicalPageUrl::Reload {
                generation: first.into()
            }
        );
        assert_eq!(
            classify_canonical_page_url_for(&url_b, unix),
            CanonicalPageUrl::Reload {
                generation: second.into()
            }
        );
        assert_ne!(
            classify_canonical_page_url_for(&url_a, unix),
            classify_canonical_page_url_for(&url_b, unix)
        );
    }

    #[test]
    fn reload_url_builder_uses_query_not_fragment() {
        let source = include_str!("navigation.rs");
        let start = source
            .find("fn canonical_app_local_reload_url_for")
            .expect("reload builder");
        let end = source
            .find("fn canonical_app_local_reload_url(")
            .expect("reload wrapper");
        let body = &source[start..end];
        assert!(body.contains("set_query"));
        assert!(body.contains("RELOAD_QUERY_KEY"));
        assert!(!body.contains("set_fragment"));
        assert!(!body.contains("query_pairs"));
        assert!(!body.contains("RELOAD_FRAGMENT_PREFIX"));
        assert!(body.contains("canonical_reload_generation") || body.contains("Option<Url>"));
    }

    #[test]
    fn classify_retry_query_compares_raw_query_bytes_not_form_decoded_pairs() {
        let source = include_str!("navigation.rs");
        let start = source
            .find("fn classify_retry_query")
            .expect("classify_retry_query");
        let end = source
            .find("pub fn classify_canonical_page_url_for")
            .expect("classify caller");
        let body = &source[start..end];
        assert!(body.contains("url.query()"));
        assert!(body.contains("hyphenated()"));
        assert!(body.contains("{RELOAD_QUERY_KEY}={canonical_uuid}"));
        assert!(!body.contains("query_pairs"));
    }

    #[test]
    fn invalid_generation_does_not_mint_a_reload_url() {
        let unix = AppLocalPlatform::Unix;
        for bad in [
            "",
            "not-a-uuid",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee",
            "../eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "ocx-reload-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee extra",
            "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
            "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",
            "urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        ] {
            assert!(
                canonical_app_local_reload_url_for(unix, bad).is_none(),
                "{bad}"
            );
            assert!(canonical_app_local_reload_url(bad).is_none(), "{bad}");
        }
        let good = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        assert!(canonical_app_local_reload_url_for(unix, good).is_some());
    }

    #[test]
    fn unattached_allows_only_this_platform_canonical_url() {
        let policy = NavigationPolicy::default();
        let active = canonical_app_local_url();
        assert_eq!(
            decide_navigation(&active, &policy),
            NavigationDecision::Allow
        );
        let inactive = match current_app_local_platform() {
            AppLocalPlatform::Unix => [
                "http://tauri.localhost/",
                "https://tauri.localhost/",
                "tauri://localhost:1/",
            ],
            AppLocalPlatform::WindowsOrAndroid => [
                "https://tauri.localhost/",
                "tauri://localhost/",
                "http://tauri.localhost:1/",
            ],
        };
        for input in inactive {
            assert_ne!(
                decide_navigation(&url(input), &policy),
                NavigationDecision::Allow,
                "{input}"
            );
            assert!(!is_canonical_app_local_url(&url(input)), "{input}");
        }
    }

    #[test]
    fn unattached_rejects_disabled_asset_and_spoofed_app_local() {
        let policy = NavigationPolicy::default();
        let rejected = [
            "asset://localhost/",
            "asset://localhost/index.html",
            "http://asset.localhost/",
            "https://asset.localhost/",
            "tauri://localhost:1/",
            "tauri://user@localhost/",
            "tauri://localhost/other.html",
            "tauri://localhost/index.html/extra",
            "https://tauri.localhost:8443/",
            "https://user:pass@tauri.localhost/",
            "https://tauri.localhost/?q=1",
            "tauri://example.com/",
        ];
        for input in rejected {
            assert_eq!(
                decide_navigation(&url(input), &policy),
                NavigationDecision::Deny,
                "{input}"
            );
            assert!(!is_canonical_app_local_url(&url(input)), "{input}");
        }
        assert_eq!(
            decide_navigation(&url("https://nottauri.localhost/"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
        assert!(!is_canonical_app_local_url(&url(
            "https://nottauri.localhost/"
        )));
    }

    #[test]
    fn attached_rejects_app_local_and_keeps_exact_origin() {
        let policy = attached("http://localhost:10100");
        assert_eq!(
            decide_navigation(&url("http://localhost:10100/#providers"), &policy),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&url("http://localhost:10100/#logs/debug"), &policy),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&canonical_app_local_url(), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("tauri://localhost/"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("http://tauri.localhost/"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("https://tauri.localhost/"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("asset://localhost/"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("http://127.0.0.1:10100/"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
        assert_eq!(
            decide_navigation(&url("https://example.com/login"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
        assert_eq!(
            decide_navigation(&url("http://ipc.localhost/command"), &policy),
            NavigationDecision::Deny
        );
        assert_eq!(
            decide_navigation(&url("file:///etc/passwd"), &policy),
            NavigationDecision::Deny
        );
    }

    #[test]
    fn hash_routes_stay_on_the_exact_allowed_origin() {
        let policy = attached("http://127.0.0.1:10100");
        assert_eq!(
            decide_navigation(&url("http://127.0.0.1:10100/#providers"), &policy),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide_navigation(&url("http://localhost:10100/#providers"), &policy),
            NavigationDecision::OpenSystemBrowser
        );
    }

    #[test]
    fn constrained_opener_accepts_only_http_without_credentials() {
        assert_eq!(
            system_browser_handoff_url(&url("https://example.com/login?state=oauth")),
            Some("https://example.com/login?state=oauth")
        );
        assert_eq!(
            system_browser_handoff_url(&url("http://example.com/docs")),
            Some("http://example.com/docs")
        );
        assert_eq!(
            system_browser_handoff_url(&url("http://user:pass@example.com/login")),
            None
        );
        assert_eq!(system_browser_handoff_url(&url("file:///etc/passwd")), None);
        assert_eq!(
            system_browser_handoff_url(&url("javascript:alert(1)")),
            None
        );
        assert_eq!(system_browser_handoff_url(&url("opencodex://status")), None);
    }

    #[test]
    fn new_window_actions_always_deny_webview_creation() {
        let policy = attached("http://localhost:10100");
        let cases = [
            "http://localhost:10100/#providers",
            "https://example.com/login",
            "http://user:pass@example.com/login",
            "tauri://localhost/",
            "file:///etc/passwd",
            "about:blank",
        ];
        for input in cases {
            let action = decide_new_window_action(&url(input), &policy);
            assert!(!action.creates_webview(), "{input}");
            assert!(
                matches!(
                    action,
                    NewWindowAction::Deny | NewWindowAction::DenyAndHandoff { .. }
                ),
                "{input}"
            );
        }
        assert_eq!(
            decide_new_window_action(&url("https://example.com/login"), &policy).hands_off(),
            Some("https://example.com/login")
        );
        assert_eq!(
            decide_new_window_action(&url("http://user:pass@example.com/login"), &policy)
                .hands_off(),
            None
        );
        assert_eq!(
            decide_new_window_action(&url("http://localhost:10100/"), &policy),
            NewWindowAction::Deny
        );
    }
}
