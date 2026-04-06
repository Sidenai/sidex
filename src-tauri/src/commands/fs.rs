use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, State};

pub struct FsWatchStore {
    watchers: Mutex<HashMap<u32, RecommendedWatcher>>,
    next_id: Mutex<u32>,
}

impl FsWatchStore {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct FsChangeEvent {
    watch_id: u32,
    kind: String,
    paths: Vec<String>,
}

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
pub struct FileStat {
    pub size: u64,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub modified: u64,
    pub created: u64,
    pub readonly: bool,
}

fn validate_safe_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Path must not be empty".to_string());
    }
    if path.contains('\0') {
        return Err("Path must not contain NUL bytes".to_string());
    }
    if Path::new(path)
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(format!("Path must not contain '..': {}", path));
    }
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    validate_safe_path(&path)?;
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    validate_safe_path(&path)?;
    fs::read(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    validate_safe_path(&path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

#[tauri::command]
pub fn write_file_bytes(path: String, content: Vec<u8>) -> Result<(), String> {
    validate_safe_path(&path)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    validate_safe_path(&path)?;
    let entries =
        fs::read_dir(&path).map_err(|e| format!("Failed to read dir '{}': {}", path, e))?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to get metadata: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to get file type: {}", e))?;

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        result.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            is_file: file_type.is_file(),
            is_symlink: file_type.is_symlink(),
            size: metadata.len(),
            modified,
        });
    }

    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub fn stat(path: String) -> Result<FileStat, String> {
    validate_safe_path(&path)?;
    let metadata = fs::metadata(&path).map_err(|e| format!("Failed to stat '{}': {}", path, e))?;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let created = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(FileStat {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
        is_file: metadata.file_type().is_file(),
        is_symlink: metadata.file_type().is_symlink(),
        modified,
        created,
        readonly: metadata.permissions().readonly(),
    })
}

#[tauri::command]
pub fn mkdir(path: String, recursive: bool) -> Result<(), String> {
    validate_safe_path(&path)?;
    if recursive {
        fs::create_dir_all(&path)
    } else {
        fs::create_dir(&path)
    }
    .map_err(|e| format!("Failed to create dir '{}': {}", path, e))
}

#[tauri::command]
pub fn remove(path: String, recursive: bool) -> Result<(), String> {
    validate_safe_path(&path)?;
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to stat '{}': {}", path, e))?;

    if meta.is_dir() {
        if recursive {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_dir(&path)
        }
    } else {
        fs::remove_file(&path)
    }
    .map_err(|e| format!("Failed to remove '{}': {}", path, e))
}

#[tauri::command]
pub fn rename(old_path: String, new_path: String) -> Result<(), String> {
    validate_safe_path(&old_path)?;
    validate_safe_path(&new_path)?;
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename '{}' -> '{}': {}", old_path, new_path, e))
}

#[tauri::command]
pub fn exists(path: String) -> bool {
    validate_safe_path(&path).is_ok() && Path::new(&path).exists()
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<FileStat, String> {
    validate_safe_path(&path)?;
    let _p = Path::new(&path);
    let symlink_meta =
        fs::symlink_metadata(&path).map_err(|e| format!("Failed to stat '{}': {}", path, e))?;
    let is_symlink = symlink_meta.file_type().is_symlink();

    let metadata = fs::metadata(&path).map_err(|e| format!("Failed to stat '{}': {}", path, e))?;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let created = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(FileStat {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
        is_file: metadata.file_type().is_file(),
        is_symlink,
        modified,
        created,
        readonly: metadata.permissions().readonly(),
    })
}

#[tauri::command]
pub fn fs_symlink(target: String, path: String) -> Result<(), String> {
    validate_safe_path(&target)?;
    validate_safe_path(&path)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, &path)
            .map_err(|e| format!("Failed to symlink '{}' -> '{}': {}", path, target, e))
    }
    #[cfg(windows)]
    {
        let target_path = Path::new(&target);
        if target_path.is_dir() {
            std::os::windows::fs::symlink_dir(&target, &path)
        } else {
            std::os::windows::fs::symlink_file(&target, &path)
        }
        .map_err(|e| format!("Failed to symlink '{}' -> '{}': {}", path, target, e))
    }
}

#[tauri::command]
pub fn fs_readlink(path: String) -> Result<String, String> {
    validate_safe_path(&path)?;
    fs::read_link(&path)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to readlink '{}': {}", path, e))
}

#[tauri::command]
pub fn fs_watch(
    app: AppHandle,
    state: State<'_, Arc<FsWatchStore>>,
    path: String,
) -> Result<u32, String> {
    validate_safe_path(&path)?;
    let id = {
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        let val = *next;
        *next += 1;
        val
    };

    let watch_id = id;
    let app_clone = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let kind_str = format!("{:?}", event.kind);
            let paths: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let _ = app_clone.emit(
                "fs-change",
                FsChangeEvent {
                    watch_id,
                    kind: kind_str,
                    paths,
                },
            );
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch '{}': {}", path, e))?;

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.insert(id, watcher);

    Ok(id)
}

#[tauri::command]
pub fn fs_unwatch(state: State<'_, Arc<FsWatchStore>>, watch_id: u32) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers
        .remove(&watch_id)
        .ok_or_else(|| format!("Watch {} not found", watch_id))?;
    Ok(())
}

#[tauri::command]
pub fn fs_copy(src: String, dest: String) -> Result<(), String> {
    validate_safe_path(&src)?;
    validate_safe_path(&dest)?;
    let src_path = Path::new(&src);
    if src_path.is_dir() {
        copy_dir_recursive(src_path, Path::new(&dest))
    } else {
        if let Some(parent) = Path::new(&dest).parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent dirs: {}", e))?;
        }
        fs::copy(&src, &dest)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy '{}' -> '{}': {}", src, dest, e))
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir '{}': {}", dest.display(), e))?;
    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read dir '{}': {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_child = entry.path();
        let dest_child = dest.join(entry.file_name());
        if src_child.is_dir() {
            copy_dir_recursive(&src_child, &dest_child)?;
        } else {
            fs::copy(&src_child, &dest_child).map_err(|e| {
                format!(
                    "Failed to copy '{}' -> '{}': {}",
                    src_child.display(),
                    dest_child.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn fs_temp_file(prefix: Option<String>) -> Result<String, String> {
    let dir = std::env::temp_dir();
    let pfx = prefix.unwrap_or_else(|| "sidex-".to_string());
    let name = format!(
        "{}{}",
        pfx,
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let path = dir.join(name);
    fs::write(&path, "").map_err(|e| format!("Failed to create temp file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fs_temp_dir(prefix: Option<String>) -> Result<String, String> {
    let dir = std::env::temp_dir();
    let pfx = prefix.unwrap_or_else(|| "sidex-".to_string());
    let name = format!(
        "{}{}",
        pfx,
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let path = dir.join(name);
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create temp dir: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fs_read_binary(path: String) -> Result<Vec<u8>, String> {
    validate_safe_path(&path)?;
    fs::read(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}
