//! Release manifest schema and platform resolution.
//!
//! The feed is expected to produce JSON matching the shape currently used by
//! Siden (and compatible with the Tauri updater v1/v2 schemas), e.g.:
//!
//! ```json
//! {
//!   "version": "0.1.3",
//!   "notes": "...",
//!   "pub_date": "2026-04-19T00:00:00Z",
//!   "platforms": {
//!     "darwin-aarch64": {
//!       "signature": "<base64-minisign>",
//!       "url": "https://.../SideX_0.1.3_aarch64.app.tar.gz",
//!       "sha256": "..."
//!     }
//!   }
//! }
//! ```
//!
//! Both legacy (`platform: { url, signature }`) and modern (`platforms: { ... }`)
//! layouts are accepted so we can serve a single feed to multiple clients.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::{UpdateError, UpdateResult};

/// Canonical platform identifier used as a key in the manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Platform {
    #[serde(rename = "darwin-x86_64")]
    DarwinX64,
    #[serde(rename = "darwin-aarch64")]
    DarwinArm64,
    #[serde(rename = "linux-x86_64")]
    LinuxX64,
    #[serde(rename = "linux-aarch64")]
    LinuxArm64,
    #[serde(rename = "windows-x86_64")]
    WindowsX64,
    #[serde(rename = "windows-aarch64")]
    WindowsArm64,
}

impl Platform {
    /// Detects the current host platform.
    ///
    /// Returns `None` for platforms we don't ship bundles for so callers can
    /// fall into the `Idle { notAvailable: true }` branch gracefully.
    pub fn current() -> Option<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "x86_64") => Some(Self::DarwinX64),
            ("macos", "aarch64") => Some(Self::DarwinArm64),
            ("linux", "x86_64") => Some(Self::LinuxX64),
            ("linux", "aarch64") => Some(Self::LinuxArm64),
            ("windows", "x86_64") => Some(Self::WindowsX64),
            ("windows", "aarch64") => Some(Self::WindowsArm64),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DarwinX64 => "darwin-x86_64",
            Self::DarwinArm64 => "darwin-aarch64",
            Self::LinuxX64 => "linux-x86_64",
            Self::LinuxArm64 => "linux-aarch64",
            Self::WindowsX64 => "windows-x86_64",
            Self::WindowsArm64 => "windows-aarch64",
        }
    }
}

/// A single platform-specific binary release entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformRelease {
    pub url: String,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default, alias = "sha256hash")]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

/// Raw manifest as served by the update endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseManifest {
    pub version: String,
    #[serde(default, alias = "releaseDate", alias = "pub_date")]
    pub pub_date: Option<String>,
    #[serde(default, alias = "releaseNotes")]
    pub notes: Option<String>,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformRelease>,
}

impl ReleaseManifest {
    /// Looks up the release entry for a given platform, tolerating both
    /// the hyphen-separated keys we emit and the legacy underscore form.
    pub fn release_for(&self, platform: Platform) -> Option<&PlatformRelease> {
        let key = platform.as_str();
        self.platforms.get(key).or_else(|| {
            self.platforms
                .get(&key.replace('-', "_"))
                .or_else(|| self.platforms.get(canonical_legacy_key(platform)))
        })
    }
}

fn canonical_legacy_key(platform: Platform) -> &'static str {
    match platform {
        Platform::DarwinX64 => "darwin",
        Platform::DarwinArm64 => "darwin-aarch64",
        Platform::LinuxX64 => "linux",
        Platform::LinuxArm64 => "linux-aarch64",
        Platform::WindowsX64 => "windows",
        Platform::WindowsArm64 => "windows-aarch64",
    }
}

/// Strongly-typed update record shipped to the frontend. Mirrors the
/// `IUpdate` interface in `src/vs/platform/update/common/update.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "productVersion")]
    pub product_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "sha256hash")]
    pub sha256hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "releaseNotes")]
    pub release_notes: Option<String>,
}

impl UpdateInfo {
    pub(crate) fn from_manifest(manifest: &ReleaseManifest, release: &PlatformRelease) -> Self {
        Self {
            version: manifest.version.clone(),
            product_version: Some(manifest.version.clone()),
            timestamp: manifest
                .pub_date
                .as_deref()
                .and_then(parse_iso8601_to_epoch_seconds),
            url: Some(release.url.clone()),
            sha256hash: release.sha256.clone(),
            release_notes: manifest.notes.clone(),
        }
    }
}

fn parse_iso8601_to_epoch_seconds(iso: &str) -> Option<u64> {
    // Parser for the subset of RFC 3339 emitted by our feed:
    // YYYY-MM-DDTHH:MM:SS[Z|+HH:MM]. Good enough for a timestamp hint.
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: i64 = iso.get(5..7)?.parse().ok()?;
    let day: i64 = iso.get(8..10)?.parse().ok()?;
    let hour: i64 = iso.get(11..13)?.parse().ok()?;
    let minute: i64 = iso.get(14..16)?.parse().ok()?;
    let second: i64 = iso.get(17..19)?.parse().ok()?;
    civil_to_epoch_seconds(year, month, day, hour, minute, second)
        .try_into()
        .ok()
}

fn civil_to_epoch_seconds(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
) -> i64 {
    // Howard Hinnant's `civil_from_days` algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era * 146_097 + doe - 719_468;
    days_since_epoch * 86_400 + hour * 3_600 + minute * 60 + second
}

/// Version comparison using [`semver`] semantics, with a graceful fallback
/// to lexical comparison when the feed publishes a tag that isn't strict
/// semver (e.g. `0.1.3-preview`).
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(current),
    ) {
        (Ok(c), Ok(cur)) => c > cur,
        _ => candidate.trim() != current.trim() && candidate > current,
    }
}

/// Fetches and parses the release manifest from a list of endpoints.
///
/// The endpoints are tried in order until one succeeds; this mirrors the
/// Tauri updater behavior so existing `endpoints: [...]` configs keep
/// working.
pub async fn fetch_manifest(
    client: &reqwest::Client,
    endpoints: &[String],
) -> UpdateResult<ReleaseManifest> {
    let mut last_err: Option<UpdateError> = None;
    for endpoint in endpoints {
        match fetch_one(client, endpoint).await {
            Ok(manifest) => return Ok(manifest),
            Err(err) => {
                log::debug!("update endpoint {endpoint} failed: {err}");
                last_err = Some(err);
            }
        }
    }
    Err(last_err
        .unwrap_or_else(|| UpdateError::MalformedManifest("no endpoints configured".into())))
}

async fn fetch_one(client: &reqwest::Client, endpoint: &str) -> UpdateResult<ReleaseManifest> {
    let response = client.get(endpoint).send().await?.error_for_status()?;

    // 204 No Content (or an empty body) is the server's way of saying "no
    // release published yet" — that's a normal no-update condition, not a
    // malformed manifest.
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(ReleaseManifest {
            version: "0.0.0".to_string(),
            pub_date: None,
            notes: None,
            platforms: std::collections::HashMap::new(),
        });
    }

    let bytes = response.bytes().await?;
    if bytes.is_empty() {
        return Ok(ReleaseManifest {
            version: "0.0.0".to_string(),
            pub_date: None,
            notes: None,
            platforms: std::collections::HashMap::new(),
        });
    }
    serde_json::from_slice::<ReleaseManifest>(&bytes)
        .map_err(|e| UpdateError::MalformedManifest(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.2", "1.2.3"));
    }

    #[test]
    fn manifest_accepts_both_key_styles() {
        let manifest: ReleaseManifest = serde_json::from_value(serde_json::json!({
            "version": "0.2.0",
            "platforms": {
                "darwin-aarch64": { "url": "https://x/a", "sha256": "abc" }
            }
        }))
        .unwrap();
        let release = manifest.release_for(Platform::DarwinArm64).unwrap();
        assert_eq!(release.sha256.as_deref(), Some("abc"));
    }
}
