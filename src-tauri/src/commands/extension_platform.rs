use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionKind {
    Node,
    Wasm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntimeInfo {
    pub path: String,
    pub version: Option<String>,
    pub source: String,
    pub bundled: bool,
}

#[derive(Debug, Clone)]
pub struct ResolvedNode {
    pub path: String,
    pub version: Option<String>,
    pub source: &'static str,
    pub bundled: bool,
}

impl ResolvedNode {
    pub fn to_info(&self) -> NodeRuntimeInfo {
        NodeRuntimeInfo {
            path: self.path.clone(),
            version: self.version.clone(),
            source: self.source.to_string(),
            bundled: self.bundled,
        }
    }
}

/// Extension manifest record produced entirely by Rust.
/// Works for both Node (package.json) and WASM (sidex.toml) extensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub id: String,
    pub publisher: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub path: String,
    pub kind: ExtensionKind,
    pub main: Option<String>,
    pub browser: Option<String>,
    pub wasm_binary: Option<String>,
    pub source: String,
    pub builtin: bool,
    pub activation_events: Vec<String>,
    pub contributes_keys: Vec<String>,
}

/// VS Code-compatible extension description sent to the Node extension host
/// as part of the init data payload. Mirrors `IExtensionDescription`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDescription {
    pub identifier: ExtensionIdentifier,
    pub extension_location: UriComponents,
    pub package_json: serde_json::Value,
    pub is_builtin: bool,
    pub is_under_development: bool,
    pub target_platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionIdentifier {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UriComponents {
    pub scheme: String,
    pub path: String,
    #[serde(default)]
    pub authority: String,
}

pub fn path_to_uri_path(path: &str) -> String {
    let stripped = path.strip_prefix(r"\\?\").unwrap_or(path);
    let p = stripped.replace('\\', "/");
    if p.starts_with('/') {
        p
    } else {
        format!("/{p}")
    }
}

/// Parsed from a VSIX archive (extension/package.json).
#[derive(Debug)]
pub struct VsixManifest {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
struct SidexTomlManifest {
    extension: SidexTomlExtension,
    activation: Option<SidexTomlActivation>,
    contributes: Option<SidexTomlContributes>,
}

#[derive(Debug, Deserialize)]
struct SidexTomlExtension {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    description: Option<String>,
    wasm: String,
}

#[derive(Debug, Deserialize)]
struct SidexTomlActivation {
    #[serde(default)]
    events: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SidexTomlContributes {
    #[serde(default)]
    languages: Vec<String>,
    #[serde(default)]
    commands: Vec<SidexTomlCommand>,
}

#[derive(Debug, Deserialize)]
struct SidexTomlCommand {
    id: String,
    title: String,
}

pub fn read_wasm_extension_manifest(
    app: &AppHandle,
    ext_dir: &Path,
) -> Result<ExtensionManifest, String> {
    let toml_path = ext_dir.join("sidex.toml");
    let raw =
        fs::read_to_string(&toml_path).map_err(|e| format!("read {}: {e}", toml_path.display()))?;
    let manifest: SidexTomlManifest =
        toml::from_str(&raw).map_err(|e| format!("parse {}: {e}", toml_path.display()))?;

    let wasm_path = ext_dir.join(&manifest.extension.wasm);
    if !wasm_path.exists() {
        return Err(format!(
            "wasm binary '{}' not found for extension {}",
            manifest.extension.wasm, manifest.extension.id
        ));
    }

    let parts: Vec<&str> = manifest.extension.id.splitn(2, '.').collect();
    let (publisher, name) = if parts.len() == 2 {
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("unknown".to_string(), manifest.extension.id.clone())
    };

    let activation_events = manifest.activation.map(|a| a.events).unwrap_or_default();

    let mut contributes_keys = Vec::new();
    if let Some(ref c) = manifest.contributes {
        if !c.languages.is_empty() {
            contributes_keys.push("languages".to_string());
        }
        if !c.commands.is_empty() {
            contributes_keys.push("commands".to_string());
        }
    }

    let (source, builtin) = extension_source(app, ext_dir);

    Ok(ExtensionManifest {
        id: manifest.extension.id,
        publisher,
        name,
        display_name: manifest.extension.name,
        version: manifest.extension.version,
        path: ext_dir.to_string_lossy().to_string(),
        kind: ExtensionKind::Wasm,
        main: None,
        browser: None,
        wasm_binary: Some(manifest.extension.wasm),
        source,
        builtin,
        activation_events,
        contributes_keys,
    })
}

/// The complete init data payload that Rust generates and hands to the Node
/// extension host process. Mirrors VS Code's `IExtensionHostInitData`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHostInitData {
    pub version: String,
    pub commit: Option<String>,
    pub parent_pid: u32,
    pub environment: InitDataEnvironment,
    pub workspace: Option<serde_json::Value>,
    pub extensions: Vec<ExtensionDescription>,
    pub telemetry_info: InitDataTelemetry,
    pub log_level: u8,
    pub loggers: Vec<serde_json::Value>,
    pub logs_location: UriComponents,
    pub auto_start: bool,
    pub remote: InitDataRemote,
    pub ui_kind: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitDataEnvironment {
    pub is_extension_development_debug: bool,
    pub app_root: String,
    pub app_name: String,
    pub app_host: String,
    pub app_uri_scheme: String,
    pub app_language: String,
    pub extension_telemetry_log_resource: UriComponents,
    pub is_extension_telemetry_logging_only: bool,
    pub global_storage_home: UriComponents,
    pub workspace_storage_home: UriComponents,
    pub extension_development_location_uri: Option<String>,
    pub extension_tests_location_uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitDataTelemetry {
    pub session_id: String,
    pub machine_id: String,
    pub sqm_id: String,
    pub dev_device_id: String,
    pub first_session_date: String,
    pub msft_internal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitDataRemote {
    pub is_remote: bool,
    pub authority: Option<String>,
    pub connection_data: Option<serde_json::Value>,
}

pub fn sidex_data_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".sidex")
}

pub fn user_extensions_dir() -> PathBuf {
    let dir = sidex_data_dir().join("extensions");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn global_storage_dir() -> PathBuf {
    let dir = sidex_data_dir()
        .join("data")
        .join("User")
        .join("globalStorage");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn user_data_dir() -> PathBuf {
    sidex_data_dir().join("data")
}

pub fn resolve_server_script(app: &AppHandle) -> PathBuf {
    let resource_path = app
        .path()
        .resolve(
            "extension-host/server.cjs",
            tauri::path::BaseDirectory::Resource,
        )
        .ok();

    if let Some(ref p) = resource_path {
        if p.exists() {
            return p.clone();
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("extension-host/server.cjs")
}

pub fn resolve_builtin_extensions_dir(app: &AppHandle) -> PathBuf {
    let resource_extensions = app
        .path()
        .resolve("extensions", tauri::path::BaseDirectory::Resource)
        .ok();

    if let Some(ref p) = resource_extensions {
        if p.exists() {
            return p.clone();
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("extensions")
}

fn read_node_version(binary: &str) -> Option<String> {
    Command::new(binary)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn is_usable_node(binary: &str) -> bool {
    Command::new(binary)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

pub fn bundled_node_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = std::env::var("SIDEX_NODE_BINARY") {
        candidates.push(PathBuf::from(path));
    }

    let resource_candidates = if cfg!(target_os = "windows") {
        vec!["node/node.exe", "bin/node.exe", "node.exe"]
    } else if cfg!(target_os = "macos") {
        vec!["node/bin/node", "bin/node", "node"]
    } else {
        vec!["node/bin/node", "bin/node", "node"]
    };

    for relative in resource_candidates {
        if let Ok(path) = app
            .path()
            .resolve(relative, tauri::path::BaseDirectory::Resource)
        {
            candidates.push(path);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if cfg!(target_os = "windows") {
        candidates.push(manifest_dir.join("bin").join("node.exe"));
    } else {
        candidates.push(manifest_dir.join("bin").join("node"));
    }

    candidates
}

pub fn resolve_node_runtime(app: &AppHandle) -> Result<ResolvedNode, String> {
    for candidate in bundled_node_candidates(app) {
        if let Some(path) = candidate.to_str() {
            if candidate.exists() && is_usable_node(path) {
                return Ok(ResolvedNode {
                    path: path.to_string(),
                    version: read_node_version(path),
                    source: "bundled",
                    bundled: true,
                });
            }
        }
    }

    let candidates = if cfg!(target_os = "windows") {
        vec!["node.exe", "node"]
    } else {
        vec![
            "node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/opt/homebrew/bin/node",
        ]
    };

    for candidate in candidates {
        if is_usable_node(candidate) {
            return Ok(ResolvedNode {
                path: candidate.to_string(),
                version: read_node_version(candidate),
                source: "system",
                bundled: false,
            });
        }
    }

    Err("Node runtime not found. Bundle Node with SideX or install Node.js (>=18).".into())
}

pub fn sanitize_ext_id(id: &str) -> Result<String, String> {
    let clean: String = id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    if clean.is_empty() || clean.contains("..") {
        return Err(format!("invalid extension id: {id}"));
    }
    Ok(clean)
}

fn extension_source(app: &AppHandle, path: &Path) -> (String, bool) {
    let builtin_dir = resolve_builtin_extensions_dir(app);
    let user_dir = user_extensions_dir();
    if path.starts_with(&builtin_dir) {
        ("builtin".to_string(), true)
    } else if path.starts_with(&user_dir) {
        ("user".to_string(), false)
    } else {
        ("external".to_string(), false)
    }
}

fn version_weight(version: &str) -> Vec<u32> {
    version
        .split(['.', '-'])
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

fn is_version_greater(a: &str, b: &str) -> bool {
    let wa = version_weight(a);
    let wb = version_weight(b);
    let len = wa.len().max(wb.len());
    for idx in 0..len {
        let av = *wa.get(idx).unwrap_or(&0);
        let bv = *wb.get(idx).unwrap_or(&0);
        match av.cmp(&bv) {
            std::cmp::Ordering::Greater => return true,
            std::cmp::Ordering::Less => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    false
}

fn manifest_entry_exists(ext_dir: &Path, entry: &str) -> bool {
    let entry_path = ext_dir.join(entry);
    entry_path.exists() || entry_path.with_extension("js").exists()
}

pub fn read_extension_manifest(
    app: &AppHandle,
    ext_dir: &Path,
) -> Result<ExtensionManifest, String> {
    let pkg_path = ext_dir.join("package.json");
    let raw =
        fs::read_to_string(&pkg_path).map_err(|e| format!("read {}: {e}", pkg_path.display()))?;
    let val: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", pkg_path.display()))?;

    let publisher = val
        .get("publisher")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("manifest missing 'name' in {}", pkg_path.display()))?
        .to_string();
    let display_name = val
        .get("displayName")
        .and_then(|v| v.as_str())
        .unwrap_or(&name)
        .to_string();
    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let main = val.get("main").and_then(|v| v.as_str()).map(str::to_string);
    let browser = val
        .get("browser")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let entry = main.as_ref().or(browser.as_ref());
    if let Some(entry) = entry {
        if !manifest_entry_exists(ext_dir, entry) {
            return Err(format!(
                "entry '{}' missing for extension {}.{}",
                entry, publisher, name
            ));
        }
    }

    let activation_events: Vec<String> = val
        .get("activationEvents")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let contributes_keys: Vec<String> = val
        .get("contributes")
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();

    let (source, builtin) = extension_source(app, ext_dir);

    Ok(ExtensionManifest {
        id: format!("{publisher}.{name}"),
        publisher,
        name,
        display_name,
        version,
        path: ext_dir.to_string_lossy().to_string(),
        kind: ExtensionKind::Node,
        main,
        browser,
        wasm_binary: None,
        source,
        builtin,
        activation_events,
        contributes_keys,
    })
}

pub fn extension_search_paths(app: &AppHandle) -> Vec<PathBuf> {
    let builtin_ext = resolve_builtin_extensions_dir(app);
    let cursor_app_ext = if cfg!(target_os = "macos") {
        Some(PathBuf::from(
            "/Applications/Cursor.app/Contents/Resources/app/extensions",
        ))
    } else {
        None
    };
    let vscode_app_ext = if cfg!(target_os = "macos") {
        Some(PathBuf::from(
            "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
        ))
    } else {
        None
    };
    let dist_ext = std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dist")
        .join("extensions");
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let vscode_user_ext = home.join(".vscode").join("extensions");
    let cursor_user_ext = home.join(".cursor").join("extensions");
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let rust_ext = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("extensions-rust");

    let candidates = vec![
        user_extensions_dir(),
        builtin_ext,
        rust_ext,
        cursor_app_ext.unwrap_or_default(),
        vscode_app_ext.unwrap_or_default(),
        dist_ext,
        vscode_user_ext,
        cursor_user_ext,
        cwd.join("extensions"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("extensions"),
    ];

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for candidate in candidates {
        if candidate.as_os_str().is_empty() {
            continue;
        }
        let normalized = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone());
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    out
}

pub fn scan_extensions(app: &AppHandle, paths: &[PathBuf]) -> Vec<ExtensionManifest> {
    let mut disable_ids: HashSet<String> = std::env::var("SIDEX_DISABLE_EXTENSION_IDS")
        .unwrap_or_else(|_| "ms-python.vscode-pylance".to_string())
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    for id in &[
        "GitHub.copilot",
        "GitHub.copilot-chat",
        "sswg.swift-lang",
        "vscode.github-authentication",
        "vscode.microsoft-authentication",
    ] {
        disable_ids.insert(id.to_string());
    }

    let disable_prefixes = vec![
        "anysphere.cursor",
        "cursor.",
    ];

    let mut by_id: HashMap<String, ExtensionManifest> = HashMap::new();
    for search_path in paths {
        let entries = match fs::read_dir(search_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }

            let ext_dir = entry.path();
            let manifest = if ext_dir.join("sidex.toml").exists() {
                read_wasm_extension_manifest(app, &ext_dir)
            } else {
                read_extension_manifest(app, &ext_dir)
            };
            let manifest = match manifest {
                Ok(m) => m,
                Err(_) => continue,
            };

            if disable_ids.contains(&manifest.id)
                || disable_prefixes.iter().any(|p| manifest.id.starts_with(p))
            {
                continue;
            }

            let replace = match by_id.get(&manifest.id) {
                Some(existing) => is_version_greater(&manifest.version, &existing.version),
                None => true,
            };
            if replace {
                by_id.insert(manifest.id.clone(), manifest);
            }
        }
    }

    let mut values: Vec<_> = by_id.into_values().collect();
    values.sort_by(|a, b| a.id.cmp(&b.id));
    values
}

/// Build the VS Code-compatible extension descriptions from Rust-scanned manifests.
/// Only includes Node extensions — WASM extensions are loaded directly by the runtime.
///
/// NOTE: WASM extensions are additive — they do NOT suppress Node equivalents yet.
/// The WASM implementations provide basic static completions while the Node
/// extensions talk to real language servers (tsserver, css-languageservice, etc.).
/// Once the WASM extensions reach feature parity, re-enable suppression.
pub fn build_extension_descriptions(manifests: &[ExtensionManifest]) -> Vec<ExtensionDescription> {
    manifests
        .iter()
        .filter(|m| m.kind == ExtensionKind::Node && (m.main.is_some() || m.browser.is_some()))
        .map(|m| {
            let pkg_path = Path::new(&m.path).join("package.json");
            let package_json = fs::read_to_string(&pkg_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .unwrap_or(serde_json::Value::Null);

            ExtensionDescription {
                identifier: ExtensionIdentifier {
                    id: m.id.clone(),
                    uuid: None,
                },
                extension_location: UriComponents {
                    scheme: "file".to_string(),
                    path: path_to_uri_path(&m.path),
                    authority: String::new(),
                },
                package_json,
                is_builtin: m.builtin,
                is_under_development: false,
                target_platform: "undefined".to_string(),
            }
        })
        .collect()
}

/// Build the complete init data payload for the Node extension host process.
pub fn build_init_data(
    extensions: &[ExtensionDescription],
    workspace_folders: &[String],
) -> ExtensionHostInitData {
    let global_storage = global_storage_dir();
    let data_dir = user_data_dir();

    ExtensionHostInitData {
        version: "1.93.0".to_string(),
        commit: None,
        parent_pid: std::process::id(),
        environment: InitDataEnvironment {
            is_extension_development_debug: false,
            app_root: std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .to_string_lossy()
                .to_string(),
            app_name: "SideX".to_string(),
            app_host: "desktop".to_string(),
            app_uri_scheme: "sidex".to_string(),
            app_language: "en".to_string(),
            extension_telemetry_log_resource: UriComponents {
                scheme: "file".to_string(),
                path: String::new(),
                authority: String::new(),
            },
            is_extension_telemetry_logging_only: false,
            global_storage_home: UriComponents {
                scheme: "file".to_string(),
                path: path_to_uri_path(&global_storage.to_string_lossy()),
                authority: String::new(),
            },
            workspace_storage_home: UriComponents {
                scheme: "file".to_string(),
                path: path_to_uri_path(&data_dir
                    .join("workspaceStorage")
                    .to_string_lossy()),
                authority: String::new(),
            },
            extension_development_location_uri: None,
            extension_tests_location_uri: None,
        },
        workspace: if workspace_folders.is_empty() {
            None
        } else {
            Some(serde_json::json!({
                "folders": workspace_folders.iter().map(|f| {
                    serde_json::json!({ "uri": { "scheme": "file", "path": path_to_uri_path(f) } })
                }).collect::<Vec<_>>()
            }))
        },
        extensions: extensions.to_vec(),
        telemetry_info: InitDataTelemetry {
            session_id: uuid::Uuid::new_v4().to_string(),
            machine_id: uuid::Uuid::new_v4().to_string(),
            sqm_id: uuid::Uuid::new_v4().to_string(),
            dev_device_id: uuid::Uuid::new_v4().to_string(),
            first_session_date: chrono::Utc::now().to_rfc3339(),
            msft_internal: false,
        },
        log_level: 2,
        loggers: vec![],
        logs_location: UriComponents {
            scheme: "file".to_string(),
            path: path_to_uri_path(&data_dir.join("logs").to_string_lossy()),
            authority: String::new(),
        },
        auto_start: true,
        remote: InitDataRemote {
            is_remote: false,
            authority: None,
            connection_data: None,
        },
        ui_kind: 1,
    }
}

pub fn read_vsix_manifest<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<VsixManifest, String> {
    let pkg_path = "extension/package.json";
    let mut entry = archive
        .by_name(pkg_path)
        .map_err(|_| "VSIX missing extension/package.json".to_string())?;
    let mut buf = String::new();
    entry
        .read_to_string(&mut buf)
        .map_err(|e| format!("read manifest: {e}"))?;
    let val: serde_json::Value =
        serde_json::from_str(&buf).map_err(|e| format!("parse manifest: {e}"))?;
    let publisher = val
        .get("publisher")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("manifest missing 'name'")?;
    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");
    Ok(VsixManifest {
        id: format!("{publisher}.{name}"),
        name: val
            .get("displayName")
            .and_then(|v| v.as_str())
            .unwrap_or(name)
            .to_string(),
        version: version.to_string(),
    })
}

#[tauri::command]
pub async fn list_available_extensions(app: AppHandle) -> Result<Vec<ExtensionManifest>, String> {
    let paths = extension_search_paths(&app);
    Ok(scan_extensions(&app, &paths))
}

#[tauri::command]
pub async fn extension_platform_bootstrap(
    app: AppHandle,
    supervisor: tauri::State<'_, crate::commands::ext_host::ExtensionPlatformSupervisor>,
    wasm_runtime: tauri::State<
        '_,
        std::sync::Arc<crate::commands::extension_wasm::WasmExtensionRuntime>,
    >,
) -> Result<serde_json::Value, String> {
    let paths = extension_search_paths(&app);
    let manifests = scan_extensions(&app, &paths);
    let descriptions = build_extension_descriptions(&manifests);
    let init_data = build_init_data(&descriptions, &[]);
    let init_data_json = serde_json::to_string(&init_data).map_err(|e| e.to_string())?;
    let search_paths: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let port = supervisor.ensure_started(&app, &init_data_json, &search_paths)?;

    let node = resolve_node_runtime(&app)?;

    let wasm_manifests: Vec<ExtensionManifest> = manifests
        .iter()
        .filter(|m| m.kind == ExtensionKind::Wasm && m.wasm_binary.is_some())
        .cloned()
        .collect();

    if !wasm_manifests.is_empty() {
        let runtime = wasm_runtime.inner().clone();
        let app_handle = app.clone();
        let count = wasm_manifests.len();
        log::info!("[platform] loading {count} WASM extensions in background");
        std::thread::spawn(move || {
            for manifest in &wasm_manifests {
                if let Err(e) = runtime.load_extension(manifest) {
                    log::warn!("[platform] failed to load WASM ext {}: {e}", manifest.id);
                }
            }
            log::info!("[platform] {count} WASM extensions loaded, emitting ready event");
            use tauri::Emitter;
            let _ = app_handle.emit("sidex-wasm-extensions-ready", count);
        });
    }

    let summaries: Vec<serde_json::Value> = manifests
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "name": m.display_name,
                "version": m.version,
                "kind": m.kind,
                "activationEvents": m.activation_events,
                "main": m.main,
                "browser": m.browser,
                "wasmBinary": m.wasm_binary,
                "contributes": m.contributes_keys,
                "location": m.path,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "transport": { "kind": "websocket", "endpoint": format!("ws://127.0.0.1:{port}/") },
        "runtime": { "path": node.path, "version": node.version, "source": "system", "bundled": false },
        "paths": {
            "serverScript": resolve_server_script(&app).to_string_lossy(),
            "builtinExtensionsDir": resolve_builtin_extensions_dir(&app).to_string_lossy(),
            "userExtensionsDir": user_extensions_dir().to_string_lossy(),
            "globalStorageDir": global_storage_dir().to_string_lossy(),
        },
        "sessionKind": "local",
        "extensions": summaries,
        "initDataJson": init_data_json,
    }))
}

#[tauri::command]
pub async fn extension_platform_status(
    app: AppHandle,
    supervisor: tauri::State<'_, crate::commands::ext_host::ExtensionPlatformSupervisor>,
) -> Result<serde_json::Value, String> {
    let snapshot = supervisor.snapshot()?;
    let paths = extension_search_paths(&app);
    let ext_count = scan_extensions(&app, &paths).len() as u32;
    Ok(serde_json::json!({
        "running": snapshot.running,
        "port": snapshot.port,
        "sessionId": snapshot.session_id,
        "uptimeSecs": snapshot.uptime_secs,
        "extensionCount": ext_count,
        "restartCount": snapshot.restart_count,
        "totalCrashes": snapshot.total_crashes,
    }))
}

#[tauri::command]
pub async fn extension_platform_restart(
    app: AppHandle,
    supervisor: tauri::State<'_, crate::commands::ext_host::ExtensionPlatformSupervisor>,
) -> Result<serde_json::Value, String> {
    let paths = extension_search_paths(&app);
    let manifests = scan_extensions(&app, &paths);
    let descriptions = build_extension_descriptions(&manifests);
    let init_data = build_init_data(&descriptions, &[]);
    let init_data_json = serde_json::to_string(&init_data).map_err(|e| e.to_string())?;
    let search_paths: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let _ = supervisor.restart(&app, &init_data_json, &search_paths)?;
    extension_platform_status(app, supervisor).await
}

#[tauri::command]
pub async fn extension_platform_stop(
    supervisor: tauri::State<'_, crate::commands::ext_host::ExtensionPlatformSupervisor>,
) -> Result<(), String> {
    supervisor.stop()
}

#[tauri::command]
pub async fn extension_platform_init_data(app: AppHandle) -> Result<String, String> {
    let paths = extension_search_paths(&app);
    let manifests = scan_extensions(&app, &paths);
    let descriptions = build_extension_descriptions(&manifests);
    let init_data = build_init_data(&descriptions, &[]);
    serde_json::to_string(&init_data).map_err(|e| e.to_string())
}
