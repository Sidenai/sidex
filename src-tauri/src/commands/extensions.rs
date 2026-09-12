use crate::commands::extension_platform::{read_extension_manifest, ExtensionManifest};
use serde::Serialize;
use sidex_extensions::contributions::{parse_contributions, ContributionPoint};
use sidex_extensions::installer::{
    install_from_vsix as crate_install_from_vsix, uninstall as crate_uninstall,
};
use sidex_extensions::manifest::sanitize_ext_id;
use sidex_extensions::marketplace::MarketplaceClient;
use sidex_extensions::paths::user_extensions_dir;
use sidex_extensions::platform::{
    host_target_platform, is_target_platform_compatible, target_platform_from_vsix_manifest,
    vsix_identity_attr,
};
use sidex_extensions::vsix::{
    install_package, read_vsix_target_platform, unpack_vsix, validate_vsix, VsixPackage,
};
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

    // A locally supplied package cannot be swapped for another build without
    // second-guessing the user, so a platform mismatch is fatal here rather
    // than auto-corrected. Reading the manifest is cheap (one zip entry).
    let host_platform = host_target_platform();
    match read_vsix_target_platform(vsix) {
        Ok(declared) if !is_target_platform_compatible(declared.as_deref(), host_platform) => {
            return Err(format!(
                "this .vsix is packaged for {} but this machine is {host_platform}; \
                 install the {host_platform} build instead",
                declared.as_deref().unwrap_or("an unknown platform")
            ));
        }
        Ok(_) => {}
        Err(e) => log::warn!(
            "could not read target platform from {}: {e:#}",
            vsix.display()
        ),
    }

    let target_dir = user_extensions_dir();
    let installed =
        crate_install_from_vsix(vsix, &target_dir).map_err(|e| format!("install: {e:#}"))?;
    let safe_id = sanitize_ext_id(&installed.canonical_id()).map_err(|e| format!("{e:#}"))?;
    let ext_dir = target_dir.join(&safe_id);

    log::info!("installed extension {safe_id} to {}", ext_dir.display());
    Ok(to_installed(&installed, &ext_dir))
}

// ---------------------------------------------------------------------------
// Platform-aware installs
// ---------------------------------------------------------------------------

/// Downloads a `.vsix` and unpacks it in memory. The temp file is deleted as
/// soon as unpacking finishes — [`VsixPackage`] owns the whole payload.
async fn download_and_unpack(url: &str) -> Result<VsixPackage, String> {
    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;

    let tmp_path = std::env::temp_dir().join(format!("sidex-{}.vsix", uuid::Uuid::new_v4()));
    fs::write(&tmp_path, &bytes).map_err(|e| format!("write tempfile: {e}"))?;

    let unpacked = (|| -> Result<VsixPackage, String> {
        let pkg = unpack_vsix(&tmp_path).map_err(|e| format!("unpack vsix: {e:#}"))?;
        let validation = validate_vsix(&pkg);
        if !validation.valid {
            return Err(format!(
                "vsix validation failed: {}",
                validation.errors.join("; ")
            ));
        }
        Ok(pkg)
    })();

    let _ = fs::remove_file(&tmp_path);
    unpacked
}

/// Registry path segments are `[A-Za-z0-9._+-]` in practice; anything else
/// means we are not looking at an Open VSX package and must not build a URL
/// out of it.
fn is_registry_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

/// Looks up the build of `pkg`'s extension that matches `host_platform`,
/// using Open VSX's platform-keyed detail endpoint:
/// `GET /api/{namespace}/{name}/{targetPlatform}/{version}`.
///
/// Returns `Ok(None)` when the registry has no such build (or when the
/// package did not come from Open VSX at all).
async fn resolve_platform_vsix(
    pkg: &VsixPackage,
    host_platform: &str,
) -> Result<Option<String>, String> {
    let xml = pkg.vsix_manifest_xml.as_deref().unwrap_or_default();
    let (Some(namespace), Some(name)) = (
        vsix_identity_attr(xml, "Publisher"),
        vsix_identity_attr(xml, "Id"),
    ) else {
        return Ok(None);
    };
    let version =
        vsix_identity_attr(xml, "Version").unwrap_or_else(|| pkg.manifest.version.clone());

    if !is_registry_segment(&namespace) || !is_registry_segment(&name) || !is_registry_segment(&version)
    {
        return Ok(None);
    }

    let url = format!("https://open-vsx.org/api/{namespace}/{name}/{host_platform}/{version}");
    log::info!("resolving platform-specific build: {url}");

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("resolve platform build: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("resolve platform build: {e}"))?;

    Ok(json
        .get("files")
        .and_then(|files| files.get("download"))
        .and_then(|download| download.as_str())
        .filter(|download| download.starts_with("https://"))
        .map(str::to_string))
}

#[tauri::command]
pub async fn install_extension_from_url(url: String) -> Result<InstalledExtension, String> {
    log::info!("downloading extension from {url}");

    let mut pkg = download_and_unpack(&url).await?;
    let mut source_url = url.clone();

    // Platform guard.
    //
    // Marketplace search is not platform-aware: Open VSX's `/api/-/search`
    // returns whichever build of a per-platform extension sorts first
    // (`alpine-arm64` today), and gallery responses that omit
    // `targetPlatform` leave the client unable to notice. Without this check
    // a Windows user silently gets an ELF binary that can never launch — and
    // the install still reports success. Swap in the matching build instead.
    let host_platform = host_target_platform();
    let declared = pkg
        .vsix_manifest_xml
        .as_deref()
        .and_then(target_platform_from_vsix_manifest);

    if !is_target_platform_compatible(declared.as_deref(), host_platform) {
        let declared_platform = declared.as_deref().unwrap_or("an unknown platform");
        log::warn!(
            "{source_url} is packaged for {declared_platform} but this machine is {host_platform}; \
             looking for a matching build"
        );

        match resolve_platform_vsix(&pkg, host_platform).await? {
            Some(fixed_url) => {
                log::info!("re-downloading platform-correct build from {fixed_url}");
                let fixed_pkg = download_and_unpack(&fixed_url).await?;
                let fixed_declared = fixed_pkg
                    .vsix_manifest_xml
                    .as_deref()
                    .and_then(target_platform_from_vsix_manifest);
                if !is_target_platform_compatible(fixed_declared.as_deref(), host_platform) {
                    return Err(format!(
                        "registry returned a {} build when {host_platform} was requested",
                        fixed_declared.as_deref().unwrap_or("unknown")
                    ));
                }
                pkg = fixed_pkg;
                source_url = fixed_url;
            }
            None => {
                return Err(format!(
                    "extension is packaged for {declared_platform} and no {host_platform} build is \
                     published; refusing to install a binary that cannot run on this machine"
                ));
            }
        }
    }

    let target_dir = user_extensions_dir();
    let installed = install_package(&pkg, &target_dir).map_err(|e| format!("install: {e:#}"))?;
    log::info!(
        "installed extension {} to {}",
        installed.manifest.canonical_id(),
        installed.install_dir.display()
    );
    Ok(to_installed(&installed.manifest, &installed.install_dir))
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
