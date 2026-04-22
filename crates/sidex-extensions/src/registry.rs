//! Installed extensions registry.
//!
//! Discovers, indexes, and manages the set of installed extensions. Each
//! extension is identified by its canonical `publisher.name` id and can be
//! individually enabled or disabled. Includes the full multi-path scanning
//! logic ported from `src-tauri/src/commands/extension_platform.rs`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use walkdir::WalkDir;

use crate::manifest::{
    is_version_greater, read_node_manifest, read_wasm_manifest, ExtensionKind, ExtensionManifest,
};
use crate::paths;

/// Registry of installed extensions.
#[derive(Debug)]
pub struct ExtensionRegistry {
    extensions: Vec<ExtensionManifest>,
    index: HashMap<String, usize>,
    disabled: HashSet<String>,
}

impl ExtensionRegistry {
    pub fn new() -> Self {
        Self {
            extensions: Vec::new(),
            index: HashMap::new(),
            disabled: HashSet::new(),
        }
    }

    /// Scans `dir` for installed extensions (Node and WASM).
    pub fn scan_directory(dir: &Path) -> Result<Vec<ExtensionManifest>> {
        let mut manifests = Vec::new();

        for entry in WalkDir::new(dir).min_depth(1).max_depth(1) {
            let entry = entry?;
            if !entry.file_type().is_dir() {
                continue;
            }
            let ext_dir = entry.path();
            let manifest = if ext_dir.join("sidex.toml").exists() {
                read_wasm_manifest(ext_dir)
            } else if ext_dir.join("package.json").exists() {
                read_node_manifest(ext_dir)
            } else {
                continue;
            };
            match manifest {
                Ok(m) => manifests.push(m),
                Err(e) => {
                    log::warn!("skipping extension at {}: {e:#}", ext_dir.display());
                }
            }
        }

        Ok(manifests)
    }

    /// Returns the default extension search paths.
    pub fn default_search_paths() -> Vec<PathBuf> {
        let mut candidates = vec![paths::user_extensions_dir()];

        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        candidates.push(home.join(".vscode").join("extensions"));
        candidates.push(home.join(".cursor").join("extensions"));

        if cfg!(target_os = "macos") {
            candidates.push(PathBuf::from(
                "/Applications/Cursor.app/Contents/Resources/app/extensions",
            ));
            candidates.push(PathBuf::from(
                "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
            ));
        }

        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("extensions"));
            candidates.push(cwd.join("dist").join("extensions"));
        }

        // De-duplicate
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for c in candidates {
            if c.as_os_str().is_empty() {
                continue;
            }
            let normalized = c.canonicalize().unwrap_or_else(|_| c.clone());
            if seen.insert(normalized.clone()) {
                out.push(normalized);
            }
        }
        out
    }

    /// Scans multiple directories, deduplicating and keeping the highest
    /// version of each extension. Filters out disabled extension ids.
    pub fn scan_all(
        search_paths: &[PathBuf],
        disable_ids: &HashSet<String>,
        disable_prefixes: &[&str],
    ) -> Vec<ExtensionManifest> {
        let mut by_id: HashMap<String, ExtensionManifest> = HashMap::new();

        for search_path in search_paths {
            let Ok(manifests) = Self::scan_directory(search_path) else {
                continue;
            };
            for manifest in manifests {
                if disable_ids.contains(&manifest.id) {
                    continue;
                }
                if disable_prefixes.iter().any(|p| manifest.id.starts_with(p)) {
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
        values.sort_by_key(|a| a.id.clone());
        values
    }

    /// Convenience: scan with default disable list (same as Tauri version).
    pub fn scan_with_defaults(search_paths: &[PathBuf]) -> Vec<ExtensionManifest> {
        let mut disable_ids: HashSet<String> = std::env::var("SIDEX_DISABLE_EXTENSION_IDS")
            .unwrap_or_else(|_| "ms-python.vscode-pylance".to_string())
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();

        for id in [
            "GitHub.copilot",
            "GitHub.copilot-chat",
            "sswg.swift-lang",
            "vscode.github-authentication",
            "vscode.microsoft-authentication",
        ] {
            disable_ids.insert(id.to_string());
        }

        let disable_prefixes = ["anysphere.cursor", "cursor."];
        Self::scan_all(search_paths, &disable_ids, &disable_prefixes)
    }

    /// Loads all extensions from a directory into the registry.
    pub fn load_from_directory(&mut self, dir: &Path) -> Result<()> {
        let manifests = Self::scan_directory(dir)?;
        for m in manifests {
            self.add(m);
        }
        Ok(())
    }

    pub fn add(&mut self, manifest: ExtensionManifest) {
        let id = manifest.canonical_id();
        if let Some(&existing_idx) = self.index.get(&id) {
            self.extensions[existing_idx] = manifest;
        } else {
            let idx = self.extensions.len();
            self.index.insert(id, idx);
            self.extensions.push(manifest);
        }
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        let idx = self
            .index
            .remove(id)
            .ok_or_else(|| anyhow::anyhow!("extension not found: {id}"))?;

        self.extensions.swap_remove(idx);
        self.disabled.remove(id);

        if idx < self.extensions.len() {
            let swapped_id = self.extensions[idx].canonical_id();
            self.index.insert(swapped_id, idx);
        }

        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&ExtensionManifest> {
        self.index.get(id).map(|&i| &self.extensions[i])
    }

    pub fn all(&self) -> &[ExtensionManifest] {
        &self.extensions
    }

    /// Returns only Node extensions.
    pub fn node_extensions(&self) -> Vec<&ExtensionManifest> {
        self.extensions
            .iter()
            .filter(|m| m.kind == ExtensionKind::Node)
            .collect()
    }

    /// Returns only WASM extensions.
    pub fn wasm_extensions(&self) -> Vec<&ExtensionManifest> {
        self.extensions
            .iter()
            .filter(|m| m.kind == ExtensionKind::Wasm)
            .collect()
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.index.contains_key(id) && !self.disabled.contains(id)
    }

    pub fn enable(&mut self, id: &str) {
        self.disabled.remove(id);
    }

    pub fn disable(&mut self, id: &str) {
        if self.index.contains_key(id) {
            self.disabled.insert(id.to_owned());
        }
    }
}

impl Default for ExtensionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// VSIX reader
// ---------------------------------------------------------------------------

/// Parsed from a VSIX archive (extension/package.json).
#[derive(Debug)]
pub struct VsixManifest {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// Reads the manifest from a VSIX (ZIP) archive.
pub fn read_vsix_manifest<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<VsixManifest> {
    use std::io::Read;

    let mut entry = archive
        .by_name("extension/package.json")
        .map_err(|_| anyhow::anyhow!("VSIX missing extension/package.json"))?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf)?;
    let val: serde_json::Value = serde_json::from_str(&buf)?;
    let publisher = val
        .get("publisher")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("manifest missing 'name'"))?;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::parse_manifest_str;

    fn test_manifest(name: &str, publisher: &str) -> ExtensionManifest {
        let json =
            format!(r#"{{ "name": "{name}", "publisher": "{publisher}", "version": "1.0.0" }}"#);
        parse_manifest_str(&json).unwrap()
    }

    #[test]
    fn add_and_get() {
        let mut reg = ExtensionRegistry::new();
        reg.add(test_manifest("my-ext", "acme"));
        assert!(reg.get("acme.my-ext").is_some());
        assert_eq!(reg.all().len(), 1);
    }

    #[test]
    fn enable_disable() {
        let mut reg = ExtensionRegistry::new();
        reg.add(test_manifest("my-ext", "acme"));
        assert!(reg.is_enabled("acme.my-ext"));
        reg.disable("acme.my-ext");
        assert!(!reg.is_enabled("acme.my-ext"));
        reg.enable("acme.my-ext");
        assert!(reg.is_enabled("acme.my-ext"));
    }

    #[test]
    fn remove_extension() {
        let mut reg = ExtensionRegistry::new();
        reg.add(test_manifest("a", "pub"));
        reg.add(test_manifest("b", "pub"));
        reg.remove("pub.a").unwrap();
        assert!(reg.get("pub.a").is_none());
        assert!(reg.get("pub.b").is_some());
    }

    #[test]
    fn scan_directory_discovers_both_kinds() {
        let dir = tempfile::TempDir::new().unwrap();

        // Node extension
        let ext_dir = dir.path().join("my-ext");
        std::fs::create_dir_all(&ext_dir).unwrap();
        std::fs::write(
            ext_dir.join("package.json"),
            r#"{ "name": "my-ext", "version": "1.0.0" }"#,
        )
        .unwrap();

        let found = ExtensionRegistry::scan_directory(dir.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "my-ext");
    }

    #[test]
    fn default_search_paths_non_empty() {
        let paths = ExtensionRegistry::default_search_paths();
        assert!(!paths.is_empty());
    }
}
