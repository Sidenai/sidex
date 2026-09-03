use serde::Serialize;
use std::path::Path;

use sidex_workspace::path_util;

#[derive(Debug, Serialize)]
pub struct PathInfo {
    pub dir: String,
    pub base: String,
    pub ext: String,
    pub name: String,
    pub is_absolute: bool,
    pub normalized: String,
}

impl From<path_util::PathInfo> for PathInfo {
    fn from(p: path_util::PathInfo) -> Self {
        Self {
            dir: p.dir,
            base: p.base,
            ext: p.ext,
            name: p.name,
            is_absolute: p.is_absolute,
            normalized: p.normalized,
        }
    }
}

#[allow(clippy::unnecessary_wraps, clippy::needless_pass_by_value)]
#[tauri::command]
pub fn parse_path(path: String) -> Result<PathInfo, String> {
    Ok(path_util::parse_path(&path).into())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn join_paths(base: String, segments: Vec<String>) -> Result<String, String> {
    let segs: Vec<&str> = segments.iter().map(String::as_str).collect();
    Ok(path_util::join_paths(&base, &segs))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn relative_path(base: String, target: String) -> Result<String, String> {
    path_util::relative_path(Path::new(&base), Path::new(&target))
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to compute relative path".to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn glob_match(pattern: String, path: String) -> Result<bool, String> {
    Ok(path_util::glob_match(&pattern, &path))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn ext_category(path: String) -> Result<String, String> {
    Ok(path_util::ext_category(&path).to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn is_binary_file(path: String) -> Result<bool, String> {
    sidex_workspace::file_ops::is_binary_file(Path::new(&path)).map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn common_parent(paths: Vec<String>) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No paths provided".to_string());
    }
    let path_refs: Vec<&Path> = paths.iter().map(Path::new).collect();
    path_util::common_parent(&path_refs)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Failed to compute common parent".to_string())
}
