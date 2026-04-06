use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct PathInfo {
    pub dir: String,
    pub base: String,
    pub ext: String,
    pub name: String,
    pub is_absolute: bool,
    pub normalized: String,
}

/// Parse and normalize a path
#[tauri::command]
pub fn parse_path(path: String) -> Result<PathInfo, String> {
    let p = Path::new(&path);

    let dir = p
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();

    let base = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();

    let name = p
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let normalized = normalize_path(&path);

    Ok(PathInfo {
        dir,
        base,
        ext,
        name,
        is_absolute: p.is_absolute(),
        normalized,
    })
}

/// Normalize a path (resolve . and ..)
fn normalize_path(path: &str) -> String {
    let p = Path::new(path);
    let mut components = Vec::new();

    for component in p.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                components.push(component.as_os_str());
            }
            std::path::Component::CurDir => {
                // Skip .
            }
            std::path::Component::ParentDir => {
                // Handle ..
                if let Some(last) = components.last() {
                    if *last != ".." {
                        components.pop();
                    } else {
                        components.push(std::ffi::OsStr::new(".."));
                    }
                }
            }
            std::path::Component::Normal(name) => {
                components.push(name);
            }
        }
    }

    // Reconstruct path
    let mut result = PathBuf::new();
    for comp in components {
        result.push(comp);
    }

    result.to_string_lossy().to_string()
}

/// Join paths
#[tauri::command]
pub fn join_paths(base: String, segments: Vec<String>) -> String {
    let mut path = PathBuf::from(base);
    for segment in segments {
        path.push(segment);
    }
    path.to_string_lossy().to_string()
}

/// Get relative path from base to target
#[tauri::command]
pub fn relative_path(base: String, target: String) -> Result<String, String> {
    let base_path = Path::new(&base);
    let target_path = Path::new(&target);

    pathdiff::diff_paths(target_path, base_path)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to compute relative path".to_string())
}

/// Check if path matches glob pattern
#[tauri::command]
pub fn glob_match(pattern: String, path: String) -> bool {
    glob::Pattern::new(&pattern)
        .map(|p| p.matches(&path))
        .unwrap_or(false)
}

/// Get file extension category
#[tauri::command]
pub fn ext_category(path: String) -> String {
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs" => "javascript",
        "py" | "pyw" | "pyi" => "python",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "cpp" | "cc" | "cxx" | "c" | "h" | "hpp" => "cpp",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" | "less" => "css",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "ps1" => "powershell",
        "bat" | "cmd" => "batch",
        "dockerfile" => "docker",
        "sql" => "sql",
        "vue" => "vue",
        "svelte" => "svelte",
        _ => "unknown",
    }
    .to_string()
}

/// Check if file is binary (simple heuristic)
#[tauri::command]
pub fn is_binary_file(path: String) -> Result<bool, String> {
    let content = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Check for null bytes in first 8KB
    let sample = &content[..content.len().min(8192)];
    Ok(sample.contains(&0))
}

/// Get common parent directory of multiple paths
#[tauri::command]
pub fn common_parent(paths: Vec<String>) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No paths provided".to_string());
    }

    let mut common = PathBuf::from(&paths[0]);

    for path in &paths[1..] {
        let p = Path::new(path);
        let mut new_common = PathBuf::new();

        for (a, b) in common.components().zip(p.components()) {
            if a == b {
                new_common.push(a);
            } else {
                break;
            }
        }

        common = new_common;
        if common.as_os_str().is_empty() {
            break;
        }
    }

    Ok(common.to_string_lossy().to_string())
}
