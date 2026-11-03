//! Local account.
//!
//! SideX has no sign-in. There is no identity provider, no token exchange and
//! no remote profile — the "account" is just the person at the keyboard, and
//! every model call is made with credentials they supplied themselves (see
//! `commands::providers`).
//!
//! The command surface here is trimmed to exactly what the workbench still
//! calls: `auth_get_session` hands back a synthetic
//! local session so the chat UI needs no special case for "logged out", and
//! `auth_get_usage` reads token/spend totals from the local server.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Plan label reported to the UI. Not a tier — there is only one mode.
const LOCAL_PLAN: &str = "local";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub email: String,
    pub name: String,
    pub picture: Option<String>,
    pub plan: String,
    pub credits_remaining: f64,
    pub extra_credits: f64,
    pub billing_period_end: Option<String>,
}

impl UserProfile {
    /// Build a profile from this machine. The display name is the computer's
    /// own name (macOS Computer Name, Windows COMPUTERNAME, else hostname) so
    /// the account row reads as this device on every OS.
    fn local() -> Self {
        let name = std::env::var("SIDEX_USER_NAME")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(computer_display_name);

        Self {
            id: "local".to_string(),
            email: String::new(),
            name,
            picture: None,
            plan: LOCAL_PLAN.to_string(),
            credits_remaining: 0.0,
            extra_credits: 0.0,
            billing_period_end: None,
        }
    }
}

/// Pretty name of this computer, not the logged-in user.
fn computer_display_name() -> String {
    #[cfg(target_os = "macos")]
    if let Some(name) = macos_computer_name() {
        return name;
    }
    #[cfg(windows)]
    if let Some(name) = env_nonempty("COMPUTERNAME") {
        return name;
    }
    #[cfg(unix)]
    if let Some(name) = env_nonempty("HOSTNAME") {
        return strip_local_suffix(name);
    }
    hostname::get()
        .ok()
        .map(|h| h.to_string_lossy().into_owned())
        .map(strip_local_suffix)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "You".to_string())
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn strip_local_suffix(name: String) -> String {
    name.strip_suffix(".local")
        .unwrap_or(name.as_str())
        .trim()
        .to_string()
}

#[cfg(target_os = "macos")]
fn macos_computer_name() -> Option<String> {
    let out = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    /// Always empty in local mode. Kept so callers that check for a token
    /// before contacting a remote service continue to short-circuit.
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_at: u64,
    pub user: UserProfile,
}

impl AuthSession {
    fn local() -> Self {
        Self {
            access_token: String::new(),
            refresh_token: None,
            id_token: None,
            expires_at: 0,
            user: UserProfile::local(),
        }
    }
}

/// Vestigial managed state. Nothing reads it — the local session is
/// reconstructed fresh on every call instead of cached — but `lib.rs` still
/// seeds it via `.manage(AuthState::new())`, so the type stays as an empty
/// marker rather than being torn out of both files at once.
#[derive(Default)]
pub struct AuthState;

impl AuthState {
    pub fn new() -> Self {
        Self
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Always returns the local session.
#[tauri::command]
pub fn auth_get_session() -> Result<Option<AuthSession>, String> {
    Ok(Some(AuthSession::local()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub used_percent: f64,
    #[serde(default)]
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraCredits {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub used: f64,
    #[serde(default)]
    pub limit: f64,
    #[serde(default)]
    pub used_percent: f64,
    #[serde(default)]
    pub balance: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub credits_remaining: Option<f64>,
    #[serde(default)]
    pub usd_remaining: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAccount {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cost: f64,
    #[serde(default)]
    pub windows: Vec<UsageWindow>,
    #[serde(default)]
    pub extra_credits: Option<ExtraCredits>,
    #[serde(default)]
    pub unavailable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_cost: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub credits_remaining: f64,
    pub extra_credits: f64,
    pub period_start: String,
    pub period_end: String,
    pub percent_used: f64,
    #[serde(default)]
    pub accounts: Vec<UsageAccount>,
}

/// Token and spend totals, read from the local server's on-device usage store.
///
/// Reports zeroes when the server is not running rather than failing, so the
/// settings panel renders on a cold start.
#[tauri::command]
pub async fn auth_get_usage(
    server: tauri::State<'_, Arc<crate::server::LocalServer>>,
) -> Result<UsageSummary, String> {
    let empty = UsageSummary {
        total_cost: 0.0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        credits_remaining: 0.0,
        extra_credits: 0.0,
        period_start: String::new(),
        period_end: String::new(),
        percent_used: 0.0,
        accounts: Vec::new(),
    };

    if !server.is_running() {
        return Ok(empty);
    }

    let url = format!("{}/v1/usage/summary", server.http_url());
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(empty),
    };

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => Ok(resp.json().await.unwrap_or(empty)),
        _ => Ok(empty),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_session_carries_no_token() {
        let s = AuthSession::local();
        assert!(
            s.access_token.is_empty(),
            "local mode must not fabricate a bearer token"
        );
        assert_eq!(s.expires_at, 0);
    }

    #[test]
    fn auth_state_is_constructible() {
        // Guards that lib.rs's `.manage(AuthState::new())` keeps compiling
        // now that the type carries no fields.
        let _ = AuthState::new();
        let _ = AuthState;
    }

    #[test]
    fn profile_always_has_a_display_name() {
        assert!(!UserProfile::local().name.trim().is_empty());
        assert!(!computer_display_name().trim().is_empty());
    }

    #[test]
    fn strip_local_suffix_drops_mdns_tail() {
        assert_eq!(strip_local_suffix("Office-PC.local".into()), "Office-PC");
        assert_eq!(strip_local_suffix("devbox".into()), "devbox");
    }
}
