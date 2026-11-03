use base64::Engine as _;
use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 50 * 1024 * 1024; // 50 MB
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const ALLOWED_HOSTS: &[&str] = &[
    // SideX marketplace (Open VSX + Microsoft, via the siden.ai Worker)
    "marketplace.siden.ai",
    // Open VSX
    "open-vsx.org",
    "openvsx.eclipsecontent.org",
    // Microsoft Marketplace
    "marketplace.visualstudio.com",
    "az764295.vo.msecnd.net",
    "vscode-unpkg.net",
    "gallery.vsassets.io",
    "vsmarketplacebadges.dev",
    "vscode.blob.core.windows.net",
    // VS Code asset CDN (VSIX packages + icons)
    "vsassets.io",
    "openvsxorg.blob.core.windows.net",
    // GitHub (readme images, OAuth, API, codespaces, extension assets)
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
    // Updates
    "update.code.visualstudio.com",
];

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed: reqwest::Url = url.parse().map_err(|_| "invalid URL".to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("blocked scheme: {s}")),
    }

    let host = parsed.host_str().ok_or("missing host")?;

    if let Ok(ip) = host.parse::<IpAddr>() {
        if ip.is_loopback() || ip.is_unspecified() {
            return Err("requests to loopback/unspecified addresses are blocked".to_string());
        }
        if let IpAddr::V4(v4) = ip {
            if v4.is_private() || v4.is_link_local() {
                return Err("requests to private/link-local addresses are blocked".to_string());
            }
            if v4.octets() == [169, 254, 169, 254] {
                return Err("requests to metadata endpoints are blocked".to_string());
            }
        }
    }

    Ok(parsed)
}

/// Checks if a URL's host is allowed to be proxied.
///
/// # Security
///
/// The allowlist comparison is case-insensitive to prevent bypass attacks
/// where an attacker uses mixed-case hostnames (e.g., "OpenVSX.org" vs "openvsx.org").
///
/// Also prevents subdomain takeover attacks by ensuring the host is either:
/// - An exact match for an allowed host
/// - A proper subdomain (e.g., "extension.openvsx.org" matches "openvsx.org")
fn is_host_allowed(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    // SECURITY: Normalize to lowercase for case-insensitive comparison
    // Prevents bypass via case variation (e.g., "OpenVSX.org" vs "openvsx.org")
    let host = host.to_ascii_lowercase();

    for allowed in ALLOWED_HOSTS {
        let allowed = allowed.to_ascii_lowercase();
        if host == allowed {
            return true;
        }
        // Check if host is a subdomain of allowed
        // e.g., "ext.openvsx.org" ends with ".openvsx.org"
        if host.ends_with(&format!(".{allowed}")) {
            return true;
        }
    }
    false
}

/// Process-wide shared HTTP client. One client = one connection pool
/// shared across all proxy requests. This eliminates the per-request
/// TCP + TLS handshake overhead that was causing 8-10 s cold requests.
static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn get_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .tcp_keepalive(Some(Duration::from_mins(1)))
            .pool_idle_timeout(Some(Duration::from_secs(90)))
            .pool_max_idle_per_host(8)
            .http2_keep_alive_interval(Some(Duration::from_secs(30)))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .http2_adaptive_window(true)
            .gzip(true)
            .brotli(true)
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[allow(clippy::cast_possible_truncation)]
async fn read_body_limited(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(len) = response.content_length() {
        if len as usize > MAX_RESPONSE_BYTES {
            return Err(format!("response too large: {len} bytes"));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!("response too large: {} bytes", bytes.len()));
    }
    Ok(bytes.to_vec())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn fetch_url(url: String) -> Result<Vec<u8>, String> {
    let parsed = validate_url(&url)?;
    let client = get_client();
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    read_body_limited(response).await
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn fetch_url_text(url: String) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    let client = get_client();
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    let bytes = read_body_limited(response).await?;
    String::from_utf8(bytes).map_err(|e| format!("invalid UTF-8: {e}"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn proxy_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    if !is_host_allowed(&parsed) {
        return Err(format!(
            "proxy requests to '{}' are not allowed",
            parsed.host_str().unwrap_or("unknown")
        ));
    }

    let client = get_client();

    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(parsed),
        "PUT" => client.put(parsed),
        "DELETE" => client.delete(parsed),
        "PATCH" => client.patch(parsed),
        _ => client.get(parsed),
    };

    for (key, value) in &headers {
        req = req.header(key.as_str(), value.as_str());
    }

    if let Some(b) = body {
        req = req.body(b);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("proxy request failed: {e}"))?;

    let bytes = read_body_limited(response).await?;
    String::from_utf8(bytes).map_err(|e| format!("invalid UTF-8 in proxy response: {e}"))
}

#[derive(Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_b64: String,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn proxy_request_full(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let parsed = validate_url(&url)?;
    if !is_host_allowed(&parsed) {
        return Err(format!(
            "proxy requests to '{}' are not allowed",
            parsed.host_str().unwrap_or("unknown")
        ));
    }

    let client = get_client();

    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(parsed),
        "PUT" => client.put(parsed),
        "DELETE" => client.delete(parsed),
        "PATCH" => client.patch(parsed),
        _ => client.get(parsed),
    };

    for (key, value) in &headers {
        if key.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        req = req.header(key.as_str(), value.as_str());
    }

    if let Some(b) = body {
        req = req.body(b);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("proxy request failed: {e}"))?;

    let status = response.status().as_u16();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (k, v) in response.headers() {
        if let Ok(v_str) = v.to_str() {
            resp_headers.insert(k.to_string(), v_str.to_string());
        }
    }

    let bytes = read_body_limited(response).await?;
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(ProxyResponse {
        status,
        headers: resp_headers,
        body_b64,
    })
}
