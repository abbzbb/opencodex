use url::Url;

pub const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];
pub const MAX_ORIGIN_LENGTH: usize = 253;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackOrigin {
    pub origin: String,
    pub host: String,
    pub scheme: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginError {
    pub message: String,
}

impl OriginError {
    fn new(message: &str) -> Self {
        Self {
            message: message.to_string(),
        }
    }
}

fn ascii_printable_no_space(input: &str) -> bool {
    !input.is_empty() && input.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn normalize_hextet(part: &str) -> Option<u16> {
    if part.is_empty() || part.len() > 4 || !part.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(part, 16).ok()
}

fn expand_ipv6(host: &str) -> Option<[u16; 8]> {
    if host.contains('.')
        || host.contains('%')
        || host.chars().any(|c| !c.is_ascii_hexdigit() && c != ':')
    {
        return None;
    }
    let nums = if let Some((left_raw, right_raw)) = host.split_once("::") {
        if left_raw.contains("::") || right_raw.contains("::") {
            return None;
        }
        let left: Vec<&str> = if left_raw.is_empty() {
            Vec::new()
        } else {
            left_raw.split(':').collect()
        };
        let right: Vec<&str> = if right_raw.is_empty() {
            Vec::new()
        } else {
            right_raw.split(':').collect()
        };
        let missing = 8isize - left.len() as isize - right.len() as isize;
        if missing < 0 {
            return None;
        }
        if missing == 0 && left.len() + right.len() != 8 {
            return None;
        }
        let mut parts = left;
        parts.extend(std::iter::repeat("0").take(missing as usize));
        parts.extend(right);
        if parts.len() != 8 {
            return None;
        }
        let mut nums = [0u16; 8];
        for (i, part) in parts.iter().enumerate() {
            nums[i] = if *part == "0" {
                0
            } else {
                normalize_hextet(part)?
            };
        }
        nums
    } else {
        let parts: Vec<&str> = host.split(':').collect();
        if parts.len() != 8 {
            return None;
        }
        let mut nums = [0u16; 8];
        for (i, part) in parts.iter().enumerate() {
            nums[i] = normalize_hextet(part)?;
        }
        nums
    };
    Some(nums)
}

fn is_ipv6_loopback(hostname: &str) -> bool {
    expand_ipv6(hostname).is_some_and(|n| n == [0, 0, 0, 0, 0, 0, 0, 1])
}

pub fn is_loopback_host(value: &str) -> bool {
    LOOPBACK_HOSTS.contains(&value) || is_ipv6_loopback(value)
}

fn raw_authority_hostname(input: &str) -> Option<String> {
    let scheme_sep = input.find("://")?;
    let authority = &input[scheme_sep + 3..];
    if let Some(rest) = authority.strip_prefix('[') {
        let close = rest.find(']')?;
        let after = &rest[close + 1..];
        if !after.is_empty() && !after.starts_with(':') {
            return None;
        }
        if after.starts_with(':') && after[1..].bytes().any(|b| !b.is_ascii_digit()) {
            return None;
        }
        Some(rest[..close].to_string())
    } else {
        let host = match authority.rfind(':') {
            Some(i) => &authority[..i],
            None => authority,
        };
        Some(host.to_ascii_lowercase())
    }
}

fn url_hostname(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        inner.to_ascii_lowercase()
    } else {
        host.to_ascii_lowercase()
    }
}

fn reject_forbidden_url_tokens(input: &str) -> Option<&'static str> {
    if input.contains('@') {
        return Some("origin must not include credentials");
    }
    if input.contains('?') {
        return Some("origin must not include a query");
    }
    if input.contains('#') {
        return Some("origin must not include a fragment");
    }
    if input.contains('\\') {
        return Some("origin must not include a backslash");
    }
    if input.contains('*') {
        return Some("origin must not include a wildcard");
    }
    None
}

fn reject_explicit_path(input: &str) -> Option<&'static str> {
    let scheme_sep = match input.find("://") {
        Some(i) if i > 0 => i,
        _ => return Some("origin must be an absolute http(s) URL"),
    };
    let after_scheme = &input[scheme_sep + 3..];
    if after_scheme.is_empty() {
        return Some("origin host is missing");
    }
    if after_scheme.contains('/') || after_scheme.contains('\\') {
        return Some("origin must not include a path");
    }
    None
}

fn canonical_host(hostname: &str) -> String {
    if hostname == "localhost" || hostname == "127.0.0.1" {
        hostname.to_string()
    } else {
        "[::1]".to_string()
    }
}

pub fn parse_loopback_origin(input: &str) -> Result<LoopbackOrigin, OriginError> {
    if input.is_empty() || input.len() > MAX_ORIGIN_LENGTH {
        return Err(OriginError::new("origin length is invalid"));
    }
    if !ascii_printable_no_space(input) {
        return Err(OriginError::new("origin must be ASCII without whitespace"));
    }
    if let Some(message) = reject_forbidden_url_tokens(input) {
        return Err(OriginError::new(message));
    }
    if let Some(message) = reject_explicit_path(input) {
        return Err(OriginError::new(message));
    }
    let _raw_hostname = raw_authority_hostname(input)
        .filter(|host| is_loopback_host(host))
        .ok_or_else(|| OriginError::new("origin host must be localhost, 127.0.0.1, or ::1"))?;

    let url = Url::parse(input).map_err(|_| OriginError::new("origin is not a valid URL"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(OriginError::new("origin scheme must be http or https"));
    }
    if input.contains("localhost.") || input.contains("127.0.0.1.") {
        return Err(OriginError::new(
            "origin host must be localhost, 127.0.0.1, or ::1",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(OriginError::new("origin must not include credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(OriginError::new(
            "origin must not include query or fragment",
        ));
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err(OriginError::new("origin must not include a path"));
    }
    let hostname = url_hostname(&url);
    if !is_loopback_host(&hostname) {
        return Err(OriginError::new(
            "origin host must be localhost, 127.0.0.1, or ::1",
        ));
    }
    let scheme = url.scheme();
    let port = match url.port() {
        Some(port) => port,
        None if scheme == "https" => 443,
        None => 80,
    };
    if port == 0 {
        return Err(OriginError::new("origin port is invalid"));
    }
    let host = if hostname == "localhost" || hostname == "127.0.0.1" {
        hostname
    } else {
        "::1".to_string()
    };
    let origin = format!("{scheme}://{}:{port}", canonical_host(&host));
    Ok(LoopbackOrigin {
        origin,
        host,
        scheme: scheme.to_string(),
        port,
    })
}

#[allow(dead_code)]
pub fn is_loopback_origin(input: &str) -> bool {
    parse_loopback_origin(input).is_ok()
}

pub fn normalize_loopback_origin(input: &str) -> Option<String> {
    parse_loopback_origin(input)
        .ok()
        .map(|parsed| parsed.origin)
}

pub fn navigation_matches_allowed_origin(url: &Url, allowed_origin: &str) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if url.username() != "" || url.password().is_some() {
        return false;
    }
    let hostname = url_hostname(url);
    if !is_loopback_host(&hostname) {
        return false;
    }
    let scheme = url.scheme();
    let port = match url.port() {
        Some(port) => port,
        None if scheme == "https" => 443,
        None => 80,
    };
    let host = if hostname == "localhost" || hostname == "127.0.0.1" {
        hostname
    } else {
        "::1".to_string()
    };
    let origin = format!("{scheme}://{}:{port}", canonical_host(&host));
    origin == allowed_origin
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_is_localhost_ipv4_and_ipv6() {
        assert_eq!(LOOPBACK_HOSTS, ["localhost", "127.0.0.1", "::1"]);
    }

    #[test]
    fn accepts_normalized_loopback_origins() {
        let accepted = [
            ("http://localhost:10100", "http://localhost:10100"),
            ("http://127.0.0.1:10100", "http://127.0.0.1:10100"),
            ("http://[::1]:10100", "http://[::1]:10100"),
            ("https://localhost:10100", "https://localhost:10100"),
            ("https://127.0.0.1:8443", "https://127.0.0.1:8443"),
            ("https://[::1]:8443", "https://[::1]:8443"),
            ("HTTP://LOCALHOST:10100", "http://localhost:10100"),
            ("http://localhost", "http://localhost:80"),
            ("https://127.0.0.1", "https://127.0.0.1:443"),
            ("http://[0:0:0:0:0:0:0:1]:10100", "http://[::1]:10100"),
        ];
        for (input, canonical) in accepted {
            let parsed = parse_loopback_origin(input).expect(input);
            assert_eq!(parsed.origin, canonical, "{input}");
            assert!(is_loopback_origin(input), "{input}");
            assert_eq!(normalize_loopback_origin(input).as_deref(), Some(canonical));
        }
    }

    #[test]
    fn rejects_wildcard_lan_credentials_path_query_fragment() {
        let rejected = [
            "http://0.0.0.0:10100",
            "http://[::]:10100",
            "http://[::0]:10100",
            "http://*:10100",
            "http://192.168.1.10:10100",
            "http://10.0.0.1:10100",
            "http://172.16.1.2:10100",
            "http://opencodex.local:10100",
            "http://example.com:10100",
            "http://[2001:db8::1]:10100",
            "http://[::ffff:127.0.0.1]:10100",
            "http://user:pass@127.0.0.1:10100",
            "http://user@localhost:10100",
            "http://127.0.0.1:10100/dashboard",
            "http://localhost:10100/",
            "http://localhost:10100/index.html",
            "http://127.0.0.1:10100?x=1",
            "http://127.0.0.1:10100#frag",
            "http://localhost:10100#",
            "http://localhost:10100?",
            "ws://localhost:10100",
            "file://localhost/tmp",
            "localhost:10100",
            "//localhost:10100",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://localhost.:10100",
            "http://127.0.0.1.:10100",
            "http://127.1:10100",
            "http://[::1%eth0]:10100",
            "https://localhost:10100/path?q=1#h",
        ];
        for input in rejected {
            assert!(
                parse_loopback_origin(input).is_err(),
                "should reject {input}"
            );
            assert!(!is_loopback_origin(input), "{input}");
            assert_eq!(normalize_loopback_origin(input), None, "{input}");
        }
    }

    #[test]
    fn dashboard_path_on_allowed_origin_is_navigation_ok() {
        let url = Url::parse("http://localhost:10100/#/providers").unwrap();
        assert!(navigation_matches_allowed_origin(
            &url,
            "http://localhost:10100"
        ));
        let other = Url::parse("http://localhost:10101/").unwrap();
        assert!(!navigation_matches_allowed_origin(
            &other,
            "http://localhost:10100"
        ));
        let lan = Url::parse("http://192.168.1.10:10100/").unwrap();
        assert!(!navigation_matches_allowed_origin(
            &lan,
            "http://localhost:10100"
        ));
    }
}
