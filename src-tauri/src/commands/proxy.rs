use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 50 * 1024 * 1024; // 50 MB
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const ALLOWED_HOSTS: &[&str] = &[
    "open-vsx.org",
    "openvsx.eclipsecontent.org",
    "marketplace.visualstudio.com",
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
];

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed: reqwest::Url = url.parse().map_err(|_| "invalid URL".to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("blocked scheme: {}", s)),
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

fn is_host_allowed(url: &reqwest::Url) -> bool {
    let host = match url.host_str() {
        Some(h) => h,
        None => return false,
    };
    ALLOWED_HOSTS.iter().any(|allowed| {
        host == *allowed || host.ends_with(&format!(".{}", allowed))
    })
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {}", e))
}

async fn read_body_limited(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(len) = response.content_length() {
        if len as usize > MAX_RESPONSE_BYTES {
            return Err(format!("response too large: {} bytes", len));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read failed: {}", e))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!("response too large: {} bytes", bytes.len()));
    }
    Ok(bytes.to_vec())
}

#[tauri::command]
pub async fn fetch_url(url: String) -> Result<Vec<u8>, String> {
    let parsed = validate_url(&url)?;
    let client = build_client()?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;
    read_body_limited(response).await
}

#[tauri::command]
pub async fn fetch_url_text(url: String) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    let client = build_client()?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;
    let bytes = read_body_limited(response).await?;
    String::from_utf8(bytes).map_err(|e| format!("invalid UTF-8: {}", e))
}

#[tauri::command]
pub async fn proxy_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let parsed = validate_url(&url)?;
    if !is_host_allowed(&parsed) {
        return Err(format!("proxy requests to '{}' are not allowed", parsed.host_str().unwrap_or("unknown")));
    }

    let client = build_client()?;

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
        .map_err(|e| format!("proxy request failed: {}", e))?;

    let bytes = read_body_limited(response).await?;
    String::from_utf8(bytes).map_err(|e| format!("invalid UTF-8 in proxy response: {}", e))
}
