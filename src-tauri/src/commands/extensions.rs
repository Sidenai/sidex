use crate::commands::extension_platform::{read_extension_manifest, ExtensionManifest};
use serde::Serialize;
use sidex_extensions::contributions::{parse_contributions, ContributionPoint};
use sidex_extensions::installer::{
    install_from_vsix as crate_install_from_vsix, uninstall as crate_uninstall,
};
use sidex_extensions::manifest::sanitize_ext_id;
use sidex_extensions::marketplace::MarketplaceClient;
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

#[tauri::command]
pub async fn install_extension_from_url(url: String) -> Result<InstalledExtension, String> {
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
