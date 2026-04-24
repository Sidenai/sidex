use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

use sidex_workspace::file_ops as ws;

use super::cache::{FileMetadataCache, FileMetadataCacheEntry};
use super::validation::validate_path;

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Debug, Serialize)]
#[allow(clippy::struct_excessive_bools)]
pub struct FileStat {
    pub size: u64,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub modified: u64,
    pub created: u64,
    pub readonly: bool,
}

fn io_err(path: &str, e: &sidex_workspace::WorkspaceError) -> String {
    format!("{path}: {e}")
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    validate_path(&path)?;
    ws::read_file(Path::new(&path)).map_err(|e| io_err(&path, &e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    validate_path(&path)?;
    ws::read_file_bytes(Path::new(&path)).map_err(|e| io_err(&path, &e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    validate_path(&path)?;
    ws::write_file(Path::new(&path), &content).map_err(|e| io_err(&path, &e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn write_file_bytes(path: String, content: Vec<u8>) -> Result<(), String> {
    validate_path(&path)?;
    ws::write_file_bytes(Path::new(&path), &content).map_err(|e| io_err(&path, &e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    validate_path(&path)?;
    let entries = ws::read_dir(Path::new(&path)).map_err(|e| io_err(&path, &e))?;

    Ok(entries
        .into_iter()
        .map(|e| DirEntry {
            name: e.name,
            path: e.path,
            is_dir: e.is_dir,
            is_file: e.is_file,
            is_symlink: e.is_symlink,
            size: e.size,
            modified: e.modified,
        })
        .collect())
}

/// Helper to convert metadata to cache entry
fn metadata_to_cache_entry(metadata: &std::fs::Metadata) -> Option<FileMetadataCacheEntry> {
    use std::time::UNIX_EPOCH;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());

    let created = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());

    Some(FileMetadataCacheEntry {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
        is_file: metadata.is_file(),
        is_symlink: metadata.is_symlink(),
        modified,
        created,
        readonly: metadata.permissions().readonly(),
    })
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn stat(
    path: String,
    cache: State<'_, Arc<Mutex<FileMetadataCache>>>,
) -> Result<FileStat, String> {
    validate_path(&path)?;

    // Try to get from cache first
    {
        let cache_lock = cache.lock().await;
        if let Some(entry) = cache_lock.get(&path).await {
            return Ok(FileStat {
                size: entry.size,
                is_dir: entry.is_dir,
                is_file: entry.is_file,
                is_symlink: entry.is_symlink,
                modified: entry.modified,
                created: entry.created,
                readonly: entry.readonly,
            });
        }
    }

    // Cache miss - get from filesystem
    let s = ws::stat(Path::new(&path)).map_err(|e| io_err(&path, &e))?;

    // Cache the result
    if let Some(metadata) = std::fs::metadata(&path).ok() {
        if let Some(entry) = metadata_to_cache_entry(&metadata) {
            let mut cache_lock = cache.lock().await;
            cache_lock.insert(path.clone(), entry).await;
        }
    }

    Ok(FileStat {
        size: s.size,
        is_dir: s.is_dir,
        is_file: s.is_file,
        is_symlink: s.is_symlink,
        modified: s.modified,
        created: s.created,
        readonly: s.readonly,
    })
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn mkdir(path: String, recursive: bool) -> Result<(), String> {
    validate_path(&path)?;
    ws::mkdir(Path::new(&path), recursive).map_err(|e| io_err(&path, &e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn remove(path: String, recursive: bool) -> Result<(), String> {
    validate_path(&path)?;
    ws::remove(Path::new(&path), recursive).map_err(|e| io_err(&path, &e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn rename(old_path: String, new_path: String) -> Result<(), String> {
    validate_path(&old_path)?;
    validate_path(&new_path)?;
    ws::rename(Path::new(&old_path), Path::new(&new_path))
        .map_err(|e| format!("{old_path} -> {new_path}: {e}"))
}

#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)]
#[tauri::command]
pub fn exists(path: String) -> Result<bool, String> {
    validate_path(&path)?;
    Ok(ws::exists(Path::new(&path)))
}
