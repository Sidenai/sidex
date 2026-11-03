//! Extension manifest parsing for both Node (`package.json`) and WASM
//! (`sidex.toml`) extensions.
//!
//! Ported from `src-tauri/src/commands/extension_platform.rs`, removing all
//! Tauri dependencies. The original VS Code-compatible `package.json`
//! parsing is preserved and augmented with WASM manifest support.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Extension kind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionKind {
    Node,
    Wasm,
}

// ---------------------------------------------------------------------------
// Core manifest (unified)
// ---------------------------------------------------------------------------

/// Parsed extension manifest — works for both Node and WASM extensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    /// Fully qualified id (`publisher.name`).
    #[serde(default)]
    pub id: String,
    /// Short machine-readable name.
    pub name: String,
    /// Human-readable display name.
    #[serde(default)]
    pub display_name: String,
    /// Semver version string.
    #[serde(default)]
    pub version: String,
    /// Extension description.
    #[serde(default)]
    pub description: String,
    /// Publisher identifier.
    #[serde(default)]
    pub publisher: Option<String>,
    /// Entry point JS file for the Node host.
    #[serde(default)]
    pub main: Option<String>,
    /// Browser entry point (web extensions).
    #[serde(default)]
    pub browser: Option<String>,
    /// WASM binary path (relative to extension dir).
    #[serde(default)]
    pub wasm_binary: Option<String>,
    /// Extension kind.
    #[serde(default = "default_kind")]
    pub kind: ExtensionKind,
    /// Filesystem path to the extension directory.
    #[serde(default)]
    pub path: String,
    /// Where the extension came from.
    #[serde(default)]
    pub source: String,
    /// Whether this is a built-in extension.
    #[serde(default)]
    pub builtin: bool,
    /// Events that trigger extension activation.
    #[serde(default)]
    pub activation_events: Vec<String>,
    /// Contribution points.
    #[serde(default)]
    pub contributes: ExtensionContributes,
    /// Top-level contributes key names (for scanning).
    #[serde(default)]
    pub contributes_keys: Vec<String>,
    /// VS Code engine version constraint.
    #[serde(default)]
    pub engines: EngineRequirement,
}

fn default_kind() -> ExtensionKind {
    ExtensionKind::Node
}

impl ExtensionManifest {
    /// Derives the canonical `publisher.name` id if not already set.
    pub fn canonical_id(&self) -> String {
        if !self.id.is_empty() {
            return self.id.clone();
        }
        match &self.publisher {
            Some(pub_id) => format!("{pub_id}.{}", self.name),
            None => self.name.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Contribution types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionContributes {
    #[serde(default)]
    pub commands: Vec<ContributedCommand>,
    #[serde(default)]
    pub keybindings: Vec<serde_json::Value>,
    #[serde(default)]
    pub menus: serde_json::Value,
    #[serde(default)]
    pub themes: Vec<ContributedTheme>,
    #[serde(default)]
    pub languages: Vec<ContributedLanguage>,
    #[serde(default)]
    pub grammars: Vec<ContributedGrammar>,
    #[serde(default)]
    pub snippets: Vec<serde_json::Value>,
    #[serde(default)]
    pub views: serde_json::Value,
    #[serde(default)]
    pub configuration: serde_json::Value,
    #[serde(default)]
    pub debuggers: Vec<serde_json::Value>,
    #[serde(default)]
    pub task_definitions: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContributedCommand {
    pub command: String,
    pub title: String,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContributedTheme {
    pub label: String,
    #[serde(rename = "uiTheme")]
    pub ui_theme: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContributedLanguage {
    pub id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub configuration: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributedGrammar {
    pub language: Option<String>,
    pub scope_name: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EngineRequirement {
    #[serde(default)]
    pub vscode: Option<String>,
}

// ---------------------------------------------------------------------------
// WASM manifest (sidex.toml)
// ---------------------------------------------------------------------------

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
    #[allow(dead_code)]
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
#[allow(dead_code)]
struct SidexTomlCommand {
    id: String,
    title: String,
}

// ---------------------------------------------------------------------------
// VS Code-compatible extension description (for Node host init data)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Init data payload (for Node extension host)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parsing functions
// ---------------------------------------------------------------------------

/// Parses an extension manifest from a `package.json` file.
pub fn parse_manifest(path: &Path) -> Result<ExtensionManifest> {
    let content = std::fs::read_to_string(path).context("failed to read extension manifest")?;
    parse_manifest_str(&content)
}

/// Parses an extension manifest from a JSON string.
pub fn parse_manifest_str(json: &str) -> Result<ExtensionManifest> {
    let mut manifest: ExtensionManifest =
        serde_json::from_str(json).context("failed to parse extension manifest JSON")?;

    if manifest.id.is_empty() {
        manifest.id = manifest.canonical_id();
    }
    if manifest.kind == ExtensionKind::Node && manifest.wasm_binary.is_none() {
        // Already correct default
    }

    Ok(manifest)
}

/// Reads a WASM extension manifest from `sidex.toml` in `ext_dir`.
pub fn read_wasm_manifest(ext_dir: &Path) -> Result<ExtensionManifest> {
    let toml_path = ext_dir.join("sidex.toml");
    let raw = std::fs::read_to_string(&toml_path)
        .with_context(|| format!("read {}", toml_path.display()))?;
    let manifest: SidexTomlManifest =
        toml::from_str(&raw).with_context(|| format!("parse {}", toml_path.display()))?;

    let wasm_path = ext_dir.join(&manifest.extension.wasm);
    if !wasm_path.exists() {
        anyhow::bail!(
            "wasm binary '{}' not found for extension {}",
            manifest.extension.wasm,
            manifest.extension.id
        );
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

    Ok(ExtensionManifest {
        id: manifest.extension.id,
        publisher: Some(publisher),
        name,
        display_name: manifest.extension.name,
        version: manifest.extension.version,
        path: ext_dir.to_string_lossy().to_string(),
        kind: ExtensionKind::Wasm,
        main: None,
        browser: None,
        wasm_binary: Some(manifest.extension.wasm),
        source: String::new(),
        builtin: false,
        activation_events,
        contributes: ExtensionContributes::default(),
        contributes_keys,
        engines: EngineRequirement::default(),
        description: String::new(),
    })
}

/// Reads a Node extension manifest from `package.json` in `ext_dir`,
/// populating the full `ExtensionManifest` with `contributes_keys` and path.
pub fn read_node_manifest(ext_dir: &Path) -> Result<ExtensionManifest> {
    let pkg_path = ext_dir.join("package.json");
    let raw = std::fs::read_to_string(&pkg_path)
        .with_context(|| format!("read {}", pkg_path.display()))?;
    let val: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", pkg_path.display()))?;

    let publisher = val
        .get("publisher")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("manifest missing 'name' in {}", pkg_path.display()))?
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
        let entry_path = ext_dir.join(entry);
        if !entry_path.exists() && !entry_path.with_extension("js").exists() {
            anyhow::bail!("entry '{entry}' missing for extension {publisher}.{name}");
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

    // Parse contributes for the typed struct
    let contributes: ExtensionContributes = val
        .get("contributes")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    Ok(ExtensionManifest {
        id: format!("{publisher}.{name}"),
        publisher: Some(publisher),
        name,
        display_name,
        version,
        path: ext_dir.to_string_lossy().to_string(),
        kind: ExtensionKind::Node,
        main,
        browser,
        wasm_binary: None,
        source: String::new(),
        builtin: false,
        activation_events,
        contributes,
        contributes_keys,
        engines: EngineRequirement::default(),
        description: String::new(),
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a filesystem path to a URI path.
pub fn path_to_uri_path(path: &str) -> String {
    let stripped = path.strip_prefix(r"\\?\").unwrap_or(path);
    let p = stripped.replace('\\', "/");
    if p.starts_with('/') {
        p
    } else {
        format!("/{p}")
    }
}

/// Sanitize an extension id for use as a directory name.
pub fn sanitize_ext_id(id: &str) -> Result<String> {
    let clean: String = id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    if clean.is_empty() || clean.contains("..") {
        anyhow::bail!("invalid extension id: {id}");
    }
    Ok(clean)
}

fn version_weight(version: &str) -> Vec<u32> {
    version
        .split(['.', '-'])
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

/// Returns true if version `a` is greater than version `b`.
pub fn is_version_greater(a: &str, b: &str) -> bool {
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

/// Build VS Code-compatible extension descriptions from manifests.
/// Only includes Node extensions with an entry point.
pub fn build_extension_descriptions(manifests: &[ExtensionManifest]) -> Vec<ExtensionDescription> {
    manifests
        .iter()
        .filter(|m| m.kind == ExtensionKind::Node && (m.main.is_some() || m.browser.is_some()))
        .map(|m| {
            let pkg_path = Path::new(&m.path).join("package.json");
            let package_json = std::fs::read_to_string(&pkg_path)
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
    let global_storage = crate::paths::global_storage_dir();
    let data_dir = crate::paths::user_data_dir();

    ExtensionHostInitData {
        version: "1.93.0".to_string(),
        commit: None,
        parent_pid: std::process::id(),
        environment: InitDataEnvironment {
            is_extension_development_debug: false,
            app_root: std::env::current_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
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
                path: path_to_uri_path(&data_dir.join("workspaceStorage").to_string_lossy()),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_manifest_json() -> &'static str {
        r#"{
            "name": "rust-analyzer",
            "displayName": "rust-analyzer",
            "version": "0.4.1234",
            "description": "Rust language support",
            "publisher": "rust-lang",
            "main": "./dist/main.js",
            "activationEvents": ["onLanguage:rust"],
            "engines": { "vscode": "^1.75.0" },
            "contributes": {
                "commands": [
                    { "command": "rust-analyzer.reload", "title": "Reload" }
                ],
                "languages": [
                    { "id": "rust", "extensions": [".rs"], "aliases": ["Rust"] }
                ],
                "grammars": [
                    { "language": "rust", "scopeName": "source.rust", "path": "./syntaxes/rust.tmLanguage.json" }
                ],
                "themes": [],
                "configuration": {}
            }
        }"#
    }

    #[test]
    fn parse_basic_manifest() {
        let m = parse_manifest_str(sample_manifest_json()).unwrap();
        assert_eq!(m.name, "rust-analyzer");
        assert_eq!(m.display_name, "rust-analyzer");
        assert_eq!(m.version, "0.4.1234");
        assert_eq!(m.publisher.as_deref(), Some("rust-lang"));
        assert_eq!(m.main.as_deref(), Some("./dist/main.js"));
    }

    #[test]
    fn canonical_id_from_publisher() {
        let m = parse_manifest_str(sample_manifest_json()).unwrap();
        assert_eq!(m.id, "rust-lang.rust-analyzer");
    }

    #[test]
    fn version_comparison() {
        assert!(is_version_greater("2.0.0", "1.0.0"));
        assert!(is_version_greater("1.1.0", "1.0.9"));
        assert!(!is_version_greater("1.0.0", "1.0.0"));
        assert!(!is_version_greater("0.9.0", "1.0.0"));
    }

    #[test]
    fn sanitize_ids() {
        assert_eq!(
            sanitize_ext_id("rust-lang.rust-analyzer").unwrap(),
            "rust-lang.rust-analyzer"
        );
        assert!(sanitize_ext_id("..").is_err());
        assert!(sanitize_ext_id("").is_err());
    }

    #[test]
    fn path_to_uri() {
        assert_eq!(path_to_uri_path("/home/user"), "/home/user");
        assert_eq!(path_to_uri_path("C:\\Users\\me"), "/C:/Users/me");
    }
}
