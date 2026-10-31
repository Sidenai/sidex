//! VSCode file-icon themes that use SVG `iconPath`s (vscode-icons, Material,
//! ...). Font-based themes such as Seti need their glyphs converted first,
//! because GPUI refuses icon fonts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub struct IconTheme {
    defs: HashMap<String, PathBuf>,
    file: Option<String>,
    folder: Option<String>,
    folder_expanded: Option<String>,
    root_folder: Option<String>,
    root_folder_expanded: Option<String>,
    folder_names: HashMap<String, String>,
    folder_names_expanded: HashMap<String, String>,
    file_extensions: HashMap<String, String>,
    file_names: HashMap<String, String>,
    language_ids: HashMap<String, String>,
    pub hides_explorer_arrows: bool,
}

fn map(v: &Value, key: &str) -> HashMap<String, String> {
    v.get(key)
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.to_lowercase(), v.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

impl IconTheme {
    pub fn load(path: &Path) -> Option<Self> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        let base = path.parent()?;
        let defs: HashMap<String, PathBuf> = v
            .get("iconDefinitions")?
            .as_object()?
            .iter()
            .filter_map(|(k, d)| {
                let p = d.get("iconPath")?.as_str()?;
                Some((k.clone(), base.join(p)))
            })
            .collect();
        if defs.is_empty() {
            log::warn!(
                "icon theme {} has no SVG iconPaths (font-based?)",
                path.display()
            );
            return None;
        }
        Some(Self {
            defs,
            file: string(&v, "file"),
            folder: string(&v, "folder"),
            folder_expanded: string(&v, "folderExpanded"),
            root_folder: string(&v, "rootFolder"),
            root_folder_expanded: string(&v, "rootFolderExpanded"),
            folder_names: map(&v, "folderNames"),
            folder_names_expanded: map(&v, "folderNamesExpanded"),
            file_extensions: map(&v, "fileExtensions"),
            file_names: map(&v, "fileNames"),
            language_ids: map(&v, "languageIds"),
            hides_explorer_arrows: v
                .get("hidesExplorerArrows")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    fn def(&self, id: Option<&String>) -> Option<PathBuf> {
        id.and_then(|id| self.defs.get(id)).cloned()
    }

    pub fn file(&self, name: &str, language: Option<&str>) -> Option<PathBuf> {
        let lower = name.to_lowercase();
        if let Some(p) = self.def(self.file_names.get(&lower)) {
            return Some(p);
        }
        let mut rest = lower.as_str();
        while let Some(ix) = rest.find('.') {
            rest = &rest[ix + 1..];
            if let Some(p) = self.def(self.file_extensions.get(rest)) {
                return Some(p);
            }
        }
        if let Some(p) = language.and_then(|l| self.def(self.language_ids.get(l))) {
            return Some(p);
        }
        self.def(self.file.as_ref())
    }

    pub fn folder(&self, name: &str, expanded: bool) -> Option<PathBuf> {
        let lower = name.to_lowercase();
        let named = if expanded {
            self.folder_names_expanded.get(&lower)
        } else {
            self.folder_names.get(&lower)
        };
        self.def(named).or_else(|| {
            self.def(if expanded {
                self.folder_expanded.as_ref()
            } else {
                self.folder.as_ref()
            })
        })
    }

    pub fn root_folder(&self, expanded: bool) -> Option<PathBuf> {
        self.def(if expanded {
            self.root_folder_expanded.as_ref()
        } else {
            self.root_folder.as_ref()
        })
    }
}
