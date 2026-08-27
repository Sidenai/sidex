use crate::commands::extension_platform::{read_extension_manifest, ExtensionManifest};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use serde::Serialize;
use sidex_extensions::contributions::{parse_contributions, ContributionPoint};
use sidex_extensions::installer::{
    install_from_vsix as crate_install_from_vsix, uninstall as crate_uninstall,
};
use sidex_extensions::manifest::sanitize_ext_id;
use sidex_extensions::marketplace::{current_target_platform, MarketplaceClient};
use sidex_extensions::paths::user_extensions_dir;
use sidex_extensions::vsix::{install_package, unpack_vsix, validate_vsix};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

/// Shared marketplace client — one HTTP connection pool per process,
/// so searches don't re-do TCP+TLS handshakes on every keystroke.
/// The client also owns the in-process query cache, which was
/// previously wiped every call because a fresh client was constructed.
pub struct MarketplaceClientState {
    inner: Mutex<MarketplaceClient>,
}

impl Default for MarketplaceClientState {
    fn default() -> Self {
        Self::new()
    }
}

impl MarketplaceClientState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MarketplaceClient::new()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub path: String,
}

fn to_installed(
    manifest: &sidex_extensions::manifest::ExtensionManifest,
    path: &Path,
) -> InstalledExtension {
    InstalledExtension {
        id: manifest.canonical_id(),
        name: if manifest.display_name.is_empty() {
            manifest.name.clone()
        } else {
            manifest.display_name.clone()
        },
        version: manifest.version.clone(),
        path: path.to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub async fn install_extension(vsix_path: String) -> Result<InstalledExtension, String> {
    let vsix = Path::new(&vsix_path);
    if !vsix.exists() {
        return Err(format!("VSIX not found: {vsix_path}"));
    }

    let target_dir = user_extensions_dir();
    let installed =
        crate_install_from_vsix(vsix, &target_dir).map_err(|e| format!("install: {e:#}"))?;
    let safe_id = sanitize_ext_id(&installed.canonical_id()).map_err(|e| format!("{e:#}"))?;
    let ext_dir = target_dir.join(&safe_id);

    log::info!("installed extension {safe_id} to {}", ext_dir.display());
    Ok(to_installed(&installed, &ext_dir))
}

/// Ensures a marketplace download URL targets the current platform.
///
/// This is the authoritative fallback for platform detection. The frontend
/// resolves `targetPlatform` at runtime from `navigator.userAgent` and a
/// WebGL-based architecture probe (see `index.html` / `public/sidex-env.js`),
/// which can be wrong in WKWebView - e.g. when `WEBGL_debug_renderer_info` is
/// disabled the architecture is misdetected, and when detection fails the
/// platform resolves to `UNKNOWN`. A wrong value causes the gallery to
/// select a version built for a different OS (e.g. `linux-x64` on macOS), and
/// the download URL it returns then carries `targetPlatform=linux-x64`.
///
/// `current_target_platform()` is resolved at *compile time* via `cfg!`, so it
/// is always correct for the host regardless of what the frontend detected.
/// This function:
///
/// - leaves the URL untouched when it already carries a matching
///   `targetPlatform`,
/// - **replaces** a mismatched `targetPlatform` value with the current
///   platform (instead of trusting the frontend's selection), and
/// - appends `targetPlatform=<current>` when the URL has none.
fn ensure_target_platform(url: &str) -> String {
    let platform = current_target_platform();
    match extract_target_platform(url) {
        Some(existing) if existing == platform => url.to_string(),
        Some(existing) => {
            log::info!(
                "replacing mismatched targetPlatform='{existing}' with '{platform}' in download url"
            );
            replace_target_platform(url, platform)
        }
        None => append_target_platform(url, platform),
    }
}

/// Extracts the value of the `targetPlatform` query parameter, if present.
fn extract_target_platform(url: &str) -> Option<&str> {
    let key = "targetPlatform=";
    let idx = url.find(key)?;
    let start = idx + key.len();
    let rest = &url[start..];
    // Value runs until the next query separator (`&`), fragment (`#`), or end.
    let end = rest
        .find(|c: char| c == '&' || c == '#')
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// Replaces the value of an existing `targetPlatform` parameter.
fn replace_target_platform(url: &str, new_platform: &str) -> String {
    let key = "targetPlatform=";
    let Some(idx) = url.find(key) else {
        return append_target_platform(url, new_platform);
    };
    let start = idx + key.len();
    let rest = &url[start..];
    let end = rest
        .find(|c: char| c == '&' || c == '#')
        .unwrap_or(rest.len());
    let mut result = String::with_capacity(url.len() + new_platform.len());
    result.push_str(&url[..start]);
    result.push_str(new_platform);
    result.push_str(&rest[end..]);
    result
}

/// Appends a `targetPlatform` parameter to a URL that has none.
fn append_target_platform(url: &str, platform: &str) -> String {
    // Keep any fragment after the query string.
    let (base, fragment) = match url.find('#') {
        Some(idx) => (&url[..idx], &url[idx..]),
        None => (url, ""),
    };
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}targetPlatform={platform}{fragment}")
}

/// Rewrites the platform baked into a SideX marketplace proxy VSIX URL.
///
/// The proxy encodes the upstream Open VSX VSIX URL as base64 in the path
/// segment `vsix-{base64}`. For platform-specific builds that encoded URL
/// carries the platform both as a path segment and in the filename, e.g.
/// `.../{platform}/{version}/file/{ns}.{name}-{version}@{platform}.vsix`.
///
/// The proxy serves whatever platform is encoded there and ignores the
/// `targetPlatform` query parameter, so to download the correct platform we
/// decode the base64, swap the platform token, and re-encode. No-op when the
/// URL is not a proxy VSIX URL or when it already targets `new_platform`.
fn rewrite_proxy_vsix_platform(url: &str, new_platform: &str) -> String {
    const SEGMENT: &str = "/vsix-";
    let Some(seg_idx) = url.find(SEGMENT) else {
        return url.to_string();
    };
    let b64_start = seg_idx + SEGMENT.len();
    let rest = &url[b64_start..];
    let b64_end = rest.find('/').unwrap_or(rest.len());
    let b64 = &rest[..b64_end];
    let Ok(decoded_bytes) = STANDARD_NO_PAD.decode(b64) else {
        return url.to_string();
    };
    let Ok(decoded) = String::from_utf8(decoded_bytes) else {
        return url.to_string();
    };
    // Extract the old platform from the `@{platform}.vsix` filename suffix.
    let Some(at_idx) = decoded.rfind('@') else {
        return url.to_string();
    };
    let after_at = &decoded[at_idx + 1..];
    let vsix_idx = after_at.find(".vsix").unwrap_or(after_at.len());
    let old_platform = &after_at[..vsix_idx];
    if old_platform.is_empty() || old_platform == new_platform {
        return url.to_string();
    }
    let rewritten = decoded.replace(old_platform, new_platform);
    log::info!(
        "rewrote proxy vsix platform: {old_platform} -> {new_platform} (decoded url: {rewritten})"
    );
    let new_b64 = STANDARD_NO_PAD.encode(&rewritten);
    let mut result = String::with_capacity(url.len() + new_b64.len());
    result.push_str(&url[..b64_start]);
    result.push_str(&new_b64);
    result.push_str(&rest[b64_end..]);
    result
}

#[tauri::command]
pub async fn install_extension_from_url(url: String) -> Result<InstalledExtension, String> {
    // The SideX marketplace proxy encodes the upstream Open VSX VSIX URL as
    // base64 in the path (`.../vsix-{base64}/...`). The proxy serves the
    // platform baked into that base64 segment and ignores the
    // `targetPlatform` query parameter we append elsewhere, so fix the
    // encoded platform here - this is the authoritative correction point.
    let url = rewrite_proxy_vsix_platform(&url, current_target_platform());
    let url = ensure_target_platform(&url);
    log::info!("downloading extension from {url}");
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;

    let tmp_path = std::env::temp_dir().join(format!("sidex-{}.vsix", uuid::Uuid::new_v4()));
    fs::write(&tmp_path, &bytes).map_err(|e| format!("write tempfile: {e}"))?;

    let result = (|| -> Result<InstalledExtension, String> {
        let pkg = unpack_vsix(&tmp_path).map_err(|e| format!("unpack vsix: {e:#}"))?;
        let validation = validate_vsix(&pkg);
        if !validation.valid {
            return Err(format!(
                "vsix validation failed: {}",
                validation.errors.join("; ")
            ));
        }
        let target_dir = user_extensions_dir();
        let installed =
            install_package(&pkg, &target_dir).map_err(|e| format!("install: {e:#}"))?;
        log::info!(
            "installed extension {} to {}",
            installed.manifest.canonical_id(),
            installed.install_dir.display()
        );
        Ok(to_installed(&installed.manifest, &installed.install_dir))
    })();

    let _ = fs::remove_file(&tmp_path);
    result
}

#[tauri::command]
pub async fn uninstall_extension(extension_id: String) -> Result<(), String> {
    let safe_id = sanitize_ext_id(&extension_id).map_err(|e| format!("{e:#}"))?;
    let target_dir = user_extensions_dir();
    let ext_dir = target_dir.join(&safe_id);
    if !ext_dir.exists() {
        return Err(format!("not installed: {extension_id}"));
    }
    crate_uninstall(&safe_id, &target_dir).map_err(|e| format!("remove: {e:#}"))?;
    log::info!("uninstalled {extension_id}");
    Ok(())
}

#[tauri::command]
pub async fn list_installed_extensions(app: AppHandle) -> Result<Vec<InstalledExtension>, String> {
    let dir = user_extensions_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("readdir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(ExtensionManifest {
            id,
            display_name,
            version,
            path,
            ..
        }) = read_extension_manifest(&app, &path)
        {
            out.push(InstalledExtension {
                id,
                name: display_name,
                version,
                path,
            });
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct MarketplaceResult {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub publisher: String,
    pub install_count: u64,
    pub rating: f32,
    pub icon_url: Option<String>,
    pub download_url: String,
}

#[tauri::command]
pub async fn extension_search_marketplace(
    state: tauri::State<'_, Arc<MarketplaceClientState>>,
    query: String,
    page: u32,
) -> Result<Vec<MarketplaceResult>, String> {
    let mut client = state.inner.lock().await;
    let result = client
        .search(&query, page, 20)
        .await
        .map_err(|e| format!("marketplace search: {e}"))?;

    Ok(result
        .results
        .into_iter()
        .map(|ext| {
            let desc = if ext.short_description.is_empty() {
                ext.description.clone()
            } else {
                ext.short_description.clone()
            };
            MarketplaceResult {
                id: ext.id,
                name: ext.name,
                display_name: ext.display_name,
                description: desc,
                version: ext.version,
                publisher: ext.publisher.display_name,
                install_count: ext.install_count,
                rating: ext.rating,
                icon_url: ext.icon_url,
                download_url: ext.download_url,
            }
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct ContributionInfo {
    pub kind: String,
    pub count: usize,
    pub details: Vec<String>,
}

fn summarize_point(point: &ContributionPoint) -> ContributionInfo {
    match point {
        ContributionPoint::Commands(v) => ContributionInfo {
            kind: "commands".into(),
            count: v.len(),
            details: v.iter().map(|c| c.title.clone()).collect(),
        },
        ContributionPoint::Languages(v) => ContributionInfo {
            kind: "languages".into(),
            count: v.len(),
            details: v.iter().map(|l| l.id.clone()).collect(),
        },
        ContributionPoint::Themes(v) => ContributionInfo {
            kind: "themes".into(),
            count: v.len(),
            details: v.iter().map(|t| t.label.clone()).collect(),
        },
        ContributionPoint::Grammars(v) => ContributionInfo {
            kind: "grammars".into(),
            count: v.len(),
            details: v.iter().map(|g| g.scope_name.clone()).collect(),
        },
        ContributionPoint::Keybindings(v) => ContributionInfo {
            kind: "keybindings".into(),
            count: v.len(),
            details: v.iter().map(|k| k.command.clone()).collect(),
        },
        ContributionPoint::Snippets(v) => ContributionInfo {
            kind: "snippets".into(),
            count: v.len(),
            details: v.iter().map(|s| s.path.clone()).collect(),
        },
        ContributionPoint::Debuggers(v) => ContributionInfo {
            kind: "debuggers".into(),
            count: v.len(),
            details: v.iter().map(|d| d.label.clone()).collect(),
        },
        ContributionPoint::Views(m) => ContributionInfo {
            kind: "views".into(),
            count: m.values().map(Vec::len).sum(),
            details: m.values().flatten().map(|v| v.id.clone()).collect(),
        },
        ContributionPoint::Configuration(v) => ContributionInfo {
            kind: "configuration".into(),
            count: v.len(),
            details: v.iter().filter_map(|c| c.title.clone()).collect(),
        },
        ContributionPoint::IconThemes(v) => ContributionInfo {
            kind: "iconThemes".into(),
            count: v.len(),
            details: v.iter().map(|t| t.label.clone()).collect(),
        },
        ContributionPoint::ViewsContainers(m) => ContributionInfo {
            kind: "viewsContainers".into(),
            count: m.values().map(Vec::len).sum(),
            details: m.values().flatten().map(|c| c.title.clone()).collect(),
        },
        ContributionPoint::Menus(m) => ContributionInfo {
            kind: "menus".into(),
            count: m.values().map(Vec::len).sum(),
            details: m.keys().cloned().collect(),
        },
        ContributionPoint::TaskDefinitions(v) => ContributionInfo {
            kind: "taskDefinitions".into(),
            count: v.len(),
            details: v.iter().map(|t| t.task_type.clone()).collect(),
        },
        ContributionPoint::ProblemMatchers(v) => ContributionInfo {
            kind: "problemMatchers".into(),
            count: v.len(),
            details: v.iter().map(|p| p.name.clone()).collect(),
        },
        ContributionPoint::Terminal(t) => ContributionInfo {
            kind: "terminal".into(),
            count: t.profiles.len(),
            details: t.profiles.iter().map(|p| p.title.clone()).collect(),
        },
    }
}

#[tauri::command]
pub async fn extension_get_contributions(
    extension_dir: String,
) -> Result<Vec<ContributionInfo>, String> {
    let pkg_path = Path::new(&extension_dir).join("package.json");
    let value: serde_json::Value = crate::commands::encoding::read_json_file(&pkg_path)?;

    let points = parse_contributions(&value);
    Ok(points.iter().map(summarize_point).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD_NO_PAD;

    fn proxy_url(platform: &str) -> String {
        let inner = format!(
            "https://open-vsx.org/api/kilocode/kilo-code/{platform}/7.4.11/file/kilocode.kilo-code-7.4.11@{platform}.vsix"
        );
        let b64 = STANDARD_NO_PAD.encode(&inner);
        format!(
            "https://marketplace.siden.ai/api/asset/openvsx/vsix-{b64}/Microsoft.VisualStudio.Services.VSIXPackage?redirect=true"
        )
    }

    fn decoded_inner(url: &str) -> String {
        const SEGMENT: &str = "/vsix-";
        let idx = url.find(SEGMENT).expect("vsix segment");
        let rest = &url[idx + SEGMENT.len()..];
        let b64 = &rest[..rest.find('/').unwrap_or(rest.len())];
        let bytes = STANDARD_NO_PAD.decode(b64).expect("base64");
        String::from_utf8(bytes).expect("utf8")
    }

    #[test]
    fn rewrites_mismatched_platform() {
        let url = proxy_url("alpine-arm64");
        let rewritten = rewrite_proxy_vsix_platform(&url, "darwin-arm64");
        assert_ne!(rewritten, url, "URL should change");
        let decoded = decoded_inner(&rewritten);
        assert!(decoded.contains("darwin-arm64"), "decoded should contain new platform");
        assert!(!decoded.contains("alpine-arm64"), "decoded should not contain old platform");
    }

    #[test]
    fn no_op_when_already_correct_platform() {
        let url = proxy_url("darwin-arm64");
        let rewritten = rewrite_proxy_vsix_platform(&url, "darwin-arm64");
        assert_eq!(rewritten, url, "should be unchanged");
    }

    #[test]
    fn no_op_when_not_proxy_url() {
        let url = "https://open-vsx.org/api/kilocode/kilo-code/7.4.11/file/kilo-code.vsix";
        let rewritten = rewrite_proxy_vsix_platform(url, "darwin-arm64");
        assert_eq!(rewritten, url, "non-proxy URL should be unchanged");
    }

    #[test]
    fn no_op_when_no_at_platform_suffix() {
        // base64 of a URL without the `@{platform}.vsix` filename suffix
        let inner = "https://open-vsx.org/api/kilocode/kilo-code/7.4.11/file/kilo-code.vsix";
        let b64 = STANDARD_NO_PAD.encode(inner);
        let url = format!(
            "https://marketplace.siden.ai/api/asset/openvsx/vsix-{b64}/Microsoft.VisualStudio.Services.VSIXPackage"
        );
        let rewritten = rewrite_proxy_vsix_platform(&url, "darwin-arm64");
        assert_eq!(rewritten, url, "URL without @platform suffix should be unchanged");
    }
}
