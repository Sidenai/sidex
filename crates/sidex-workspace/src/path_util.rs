//! Path utilities — parse, join, relative, glob matching, extension categories.
//!
//! Ported from `src-tauri/src/commands/path.rs`, stripped of Tauri wrappers.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Parsed information about a path.
#[derive(Debug, Clone, Serialize)]
pub struct PathInfo {
    pub dir: String,
    pub base: String,
    pub ext: String,
    pub name: String,
    pub is_absolute: bool,
    pub normalized: String,
}

/// Parse and normalize a path, extracting its components.
pub fn parse_path(path: &str) -> PathInfo {
    let p = Path::new(path);

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

    let normalized = normalize_path(path);

    PathInfo {
        dir,
        base,
        ext,
        name,
        is_absolute: p.is_absolute(),
        normalized,
    }
}

/// Normalize a path (resolve `.` and `..` lexically without touching the filesystem).
pub fn normalize_path(path: &str) -> String {
    let p = Path::new(path);
    let mut components: Vec<&std::ffi::OsStr> = Vec::new();

    for component in p.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                components.push(component.as_os_str());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if let Some(last) = components.last() {
                    if *last == ".." {
                        components.push(std::ffi::OsStr::new(".."));
                    } else {
                        components.pop();
                    }
                }
            }
            std::path::Component::Normal(name) => {
                components.push(name);
            }
        }
    }

    let mut result = PathBuf::new();
    for comp in components {
        result.push(comp);
    }
    result.to_string_lossy().to_string()
}

/// Join a base path with additional segments.
pub fn join_paths(base: &str, segments: &[&str]) -> String {
    let mut path = PathBuf::from(base);
    for segment in segments {
        path.push(segment);
    }
    path.to_string_lossy().to_string()
}

/// Compute a relative path from `base` to `target`.
pub fn relative_path(base: &Path, target: &Path) -> Option<PathBuf> {
    pathdiff::diff_paths(target, base)
}

/// Check if a path matches a glob pattern.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    glob::Pattern::new(pattern).is_ok_and(|p| p.matches(path))
}

/// Categorise a file extension into a language family.
pub fn ext_category(path: &str) -> &'static str {
    let ext = Path::new(path)
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
}

/// Find the longest common parent directory of multiple paths.
pub fn common_parent(paths: &[&Path]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }

    let mut common = paths[0].to_path_buf();

    for path in &paths[1..] {
        let mut new_common = PathBuf::new();
        for (a, b) in common.components().zip(path.components()) {
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

    Some(common)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_path_works() {
        let info = parse_path("/home/user/file.rs");
        assert_eq!(info.base, "file.rs");
        assert_eq!(info.ext, "rs");
        assert_eq!(info.name, "file");
        assert!(info.is_absolute);
    }

    #[test]
    fn normalize_removes_dots() {
        let n = normalize_path("/a/b/../c/./d");
        assert_eq!(n, "/a/c/d");
    }

    #[test]
    fn join_paths_works() {
        let joined = join_paths("/home", &["user", "file.txt"]);
        assert_eq!(joined, "/home/user/file.txt");
    }

    #[test]
    fn relative_path_works() {
        let rel = relative_path(Path::new("/a/b"), Path::new("/a/b/c/d.txt"));
        assert_eq!(rel, Some(PathBuf::from("c/d.txt")));
    }

    #[test]
    fn glob_match_works() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "main.py"));
    }

    #[test]
    fn ext_category_works() {
        assert_eq!(ext_category("main.rs"), "rust");
        assert_eq!(ext_category("app.tsx"), "javascript");
        assert_eq!(ext_category("style.css"), "css");
        assert_eq!(ext_category("unknown.xyz"), "unknown");
    }

    #[test]
    fn common_parent_works() {
        let a = Path::new("/home/user/project/src");
        let b = Path::new("/home/user/project/tests");
        let c = common_parent(&[a, b]).unwrap();
        assert_eq!(c, PathBuf::from("/home/user/project"));
    }

    #[test]
    fn common_parent_empty() {
        assert!(common_parent(&[]).is_none());
    }
}
