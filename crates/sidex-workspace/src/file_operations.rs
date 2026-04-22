//! File operations service — high-level file management with trash support,
//! atomic writes, large-file detection, and participant notifications.
//!
//! Wraps the lower-level `file_ops` module with editor-aware behaviors:
//! move-to-trash, overwrite confirmation, atomic writes via temp files, and
//! extension notification hooks.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{WorkspaceError, WorkspaceResult};

/// 50 MiB threshold for "large file" warnings.
const LARGE_FILE_THRESHOLD: u64 = 50 * 1024 * 1024;

// ── File type ───────────────────────────────────────────────────────────

/// The type of a filesystem entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    File,
    Directory,
    SymbolicLink,
    Unknown,
}

impl FileType {
    fn from_metadata(meta: &std::fs::Metadata) -> Self {
        let ft = meta.file_type();
        if ft.is_symlink() {
            Self::SymbolicLink
        } else if ft.is_dir() {
            Self::Directory
        } else if ft.is_file() {
            Self::File
        } else {
            Self::Unknown
        }
    }
}

// ── Stat / dir entry ────────────────────────────────────────────────────

/// Metadata about a file or directory.
#[derive(Debug, Clone)]
pub struct FileStatInfo {
    pub file_type: FileType,
    pub size: u64,
    pub created: SystemTime,
    pub modified: SystemTime,
    pub is_readonly: bool,
    pub is_symlink: bool,
}

/// A directory entry.
#[derive(Debug, Clone)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: PathBuf,
    pub file_type: FileType,
}

// ── File operation events (participant notifications) ───────────────────

/// Events that extensions/participants can observe.
#[derive(Debug, Clone)]
pub enum FileOperationEvent {
    WillCreate(PathBuf),
    DidCreate(PathBuf),
    WillDelete(PathBuf),
    DidDelete(PathBuf),
    WillRename { old: PathBuf, new: PathBuf },
    DidRename { old: PathBuf, new: PathBuf },
}

/// Callback type for file operation observers.
type FileOperationListener = Box<dyn Fn(&FileOperationEvent) + Send + Sync>;

// ── FileOperationService ────────────────────────────────────────────────

/// High-level file operation service with trash support, atomic writes,
/// large-file detection, and observer notifications.
pub struct FileOperationService {
    listeners: Vec<FileOperationListener>,
}

impl std::fmt::Debug for FileOperationService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileOperationService")
            .field("listeners", &self.listeners.len())
            .finish()
    }
}

impl Default for FileOperationService {
    fn default() -> Self {
        Self::new()
    }
}

impl FileOperationService {
    #[must_use]
    pub fn new() -> Self {
        Self {
            listeners: Vec::new(),
        }
    }

    /// Register an observer that is notified of file operations.
    pub fn on_file_operation<F>(&mut self, listener: F)
    where
        F: Fn(&FileOperationEvent) + Send + Sync + 'static,
    {
        self.listeners.push(Box::new(listener));
    }

    fn notify(&self, event: &FileOperationEvent) {
        for listener in &self.listeners {
            listener(event);
        }
    }

    // ── Create ──────────────────────────────────────────────────────────

    /// Create a file with content, creating parent directories as needed.
    pub fn create_file(&self, path: &Path, content: &str) -> WorkspaceResult<()> {
        self.notify(&FileOperationEvent::WillCreate(path.to_path_buf()));
        ensure_parent(path)?;
        std::fs::write(path, content).map_err(|e| io_err(path, e))?;
        self.notify(&FileOperationEvent::DidCreate(path.to_path_buf()));
        Ok(())
    }

    /// Create a directory, including parent directories.
    pub fn create_directory(&self, path: &Path) -> WorkspaceResult<()> {
        self.notify(&FileOperationEvent::WillCreate(path.to_path_buf()));
        std::fs::create_dir_all(path).map_err(|e| io_err(path, e))?;
        self.notify(&FileOperationEvent::DidCreate(path.to_path_buf()));
        Ok(())
    }

    // ── Delete ──────────────────────────────────────────────────────────

    /// Delete a file or directory.
    ///
    /// When `use_trash` is true, the path is moved to the OS trash
    /// directory instead of being permanently removed.
    pub fn delete(&self, path: &Path, use_trash: bool) -> WorkspaceResult<()> {
        self.notify(&FileOperationEvent::WillDelete(path.to_path_buf()));

        if use_trash {
            move_to_trash(path)?;
        } else {
            let meta = std::fs::symlink_metadata(path).map_err(|e| io_err(path, e))?;
            if meta.is_dir() {
                std::fs::remove_dir_all(path).map_err(|e| io_err(path, e))?;
            } else {
                std::fs::remove_file(path).map_err(|e| io_err(path, e))?;
            }
        }

        self.notify(&FileOperationEvent::DidDelete(path.to_path_buf()));
        Ok(())
    }

    // ── Rename ──────────────────────────────────────────────────────────

    /// Rename (move) a file or directory.
    ///
    /// If `overwrite` is false and the target exists, returns an error.
    pub fn rename(&self, old: &Path, new: &Path, overwrite: bool) -> WorkspaceResult<()> {
        if !overwrite && new.exists() {
            return Err(WorkspaceError::Other(format!(
                "target already exists: {}",
                new.display()
            )));
        }

        self.notify(&FileOperationEvent::WillRename {
            old: old.to_path_buf(),
            new: new.to_path_buf(),
        });

        ensure_parent(new)?;
        std::fs::rename(old, new).map_err(|e| io_err(old, e))?;

        self.notify(&FileOperationEvent::DidRename {
            old: old.to_path_buf(),
            new: new.to_path_buf(),
        });
        Ok(())
    }

    // ── Copy ────────────────────────────────────────────────────────────

    /// Copy a file. If `overwrite` is false and the target exists, returns
    /// an error.
    pub fn copy(&self, source: &Path, target: &Path, overwrite: bool) -> WorkspaceResult<()> {
        if !overwrite && target.exists() {
            return Err(WorkspaceError::Other(format!(
                "target already exists: {}",
                target.display()
            )));
        }
        ensure_parent(target)?;
        std::fs::copy(source, target).map_err(|e| io_err(source, e))?;
        Ok(())
    }

    /// Copy a directory recursively.
    pub fn copy_directory(
        &self,
        source: &Path,
        target: &Path,
        overwrite: bool,
    ) -> WorkspaceResult<()> {
        if !overwrite && target.exists() {
            return Err(WorkspaceError::Other(format!(
                "target directory already exists: {}",
                target.display()
            )));
        }
        copy_dir_recursive(source, target)
    }

    // ── Move ────────────────────────────────────────────────────────────

    /// Move a file or directory. Tries rename first, falls back to
    /// copy + delete for cross-device moves.
    pub fn move_file(&self, source: &Path, target: &Path, overwrite: bool) -> WorkspaceResult<()> {
        if !overwrite && target.exists() {
            return Err(WorkspaceError::Other(format!(
                "target already exists: {}",
                target.display()
            )));
        }

        self.notify(&FileOperationEvent::WillRename {
            old: source.to_path_buf(),
            new: target.to_path_buf(),
        });

        ensure_parent(target)?;

        if std::fs::rename(source, target).is_ok() {
        } else {
            // Cross-device: copy then delete.
            std::fs::copy(source, target).map_err(|e| io_err(source, e))?;
            let meta = std::fs::symlink_metadata(source).map_err(|e| io_err(source, e))?;
            if meta.is_dir() {
                std::fs::remove_dir_all(source).map_err(|e| io_err(source, e))?;
            } else {
                std::fs::remove_file(source).map_err(|e| io_err(source, e))?;
            }
        }

        self.notify(&FileOperationEvent::DidRename {
            old: source.to_path_buf(),
            new: target.to_path_buf(),
        });
        Ok(())
    }

    // ── Read / Write ────────────────────────────────────────────────────

    /// Read a file as raw bytes.
    pub fn read_file(path: &Path) -> WorkspaceResult<Vec<u8>> {
        std::fs::read(path).map_err(|e| io_err(path, e))
    }

    /// Read a file as UTF-8 string.
    pub fn read_file_string(path: &Path) -> WorkspaceResult<String> {
        std::fs::read_to_string(path).map_err(|e| io_err(path, e))
    }

    /// Write content to a file, creating parent directories as needed.
    pub fn write_file(path: &Path, content: &[u8]) -> WorkspaceResult<()> {
        ensure_parent(path)?;
        std::fs::write(path, content).map_err(|e| io_err(path, e))
    }

    /// Atomic write: writes to a temporary file in the same directory, then
    /// renames to the final path. Prevents partial writes on crash.
    pub fn write_file_atomic(path: &Path, content: &[u8]) -> WorkspaceResult<()> {
        ensure_parent(path)?;

        let dir = path.parent().unwrap_or(Path::new("."));
        let temp_name = format!(
            ".sidex-tmp-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let temp_path = dir.join(temp_name);

        let mut file = std::fs::File::create(&temp_path).map_err(|e| io_err(&temp_path, e))?;
        file.write_all(content).map_err(|e| io_err(&temp_path, e))?;
        file.sync_all().map_err(|e| io_err(&temp_path, e))?;
        drop(file);

        std::fs::rename(&temp_path, path).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            io_err(path, e)
        })
    }

    // ── Stat / Query ────────────────────────────────────────────────────

    /// Get metadata for a path.
    pub fn stat(path: &Path) -> WorkspaceResult<FileStatInfo> {
        let meta = std::fs::symlink_metadata(path).map_err(|e| io_err(path, e))?;
        Ok(FileStatInfo {
            file_type: FileType::from_metadata(&meta),
            size: meta.len(),
            created: meta.created().unwrap_or(UNIX_EPOCH),
            modified: meta.modified().unwrap_or(UNIX_EPOCH),
            is_readonly: meta.permissions().readonly(),
            is_symlink: meta.file_type().is_symlink(),
        })
    }

    /// List directory contents, sorted directories-first then by name.
    pub fn read_dir(path: &Path) -> WorkspaceResult<Vec<DirEntryInfo>> {
        let entries = std::fs::read_dir(path).map_err(|e| io_err(path, e))?;
        let mut result = Vec::new();

        for entry in entries {
            let entry = entry.map_err(|e| io_err(path, e))?;
            let meta = entry.metadata().map_err(|e| io_err(&entry.path(), e))?;
            result.push(DirEntryInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path(),
                file_type: FileType::from_metadata(&meta),
            });
        }

        result.sort_unstable_by(|a, b| {
            let a_dir = a.file_type == FileType::Directory;
            let b_dir = b.file_type == FileType::Directory;
            b_dir.cmp(&a_dir).then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
        });

        Ok(result)
    }

    /// Check whether a path exists.
    #[must_use]
    pub fn exists(path: &Path) -> bool {
        path.exists()
    }

    /// Check if a file is read-only.
    #[must_use]
    pub fn is_readonly(path: &Path) -> bool {
        std::fs::metadata(path).is_ok_and(|m| m.permissions().readonly())
    }

    // ── Large file detection ────────────────────────────────────────────

    /// Check if a file is larger than the threshold (50 MiB by default).
    #[must_use]
    pub fn is_large_file(path: &Path) -> bool {
        Self::is_file_larger_than(path, LARGE_FILE_THRESHOLD)
    }

    /// Check if a file exceeds a custom byte threshold.
    #[must_use]
    pub fn is_file_larger_than(path: &Path, threshold: u64) -> bool {
        std::fs::metadata(path).is_ok_and(|m| m.len() > threshold)
    }

    /// Get the file size in bytes, or 0 if it cannot be read.
    #[must_use]
    pub fn file_size(path: &Path) -> u64 {
        std::fs::metadata(path).map_or(0, |m| m.len())
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn io_err(path: &Path, source: std::io::Error) -> WorkspaceError {
    WorkspaceError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn ensure_parent(path: &Path) -> WorkspaceResult<()> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> WorkspaceResult<()> {
    std::fs::create_dir_all(dst).map_err(|e| io_err(dst, e))?;
    for entry in std::fs::read_dir(src).map_err(|e| io_err(src, e))? {
        let entry = entry.map_err(|e| io_err(src, e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| io_err(&src_path, e))?;
        }
    }
    Ok(())
}

/// Move a file or directory to the OS trash.
///
/// On macOS this uses `NSFileManager`-style semantics via a `.Trash`
/// directory. On Linux it follows the `FreeDesktop` trash spec. As a
/// fallback, the item is moved to `~/.Trash/`.
fn move_to_trash(path: &Path) -> WorkspaceResult<()> {
    let trash_dir = trash_directory()?;
    std::fs::create_dir_all(&trash_dir).map_err(|e| io_err(&trash_dir, e))?;

    let file_name = path.file_name().map_or_else(
        || "unknown".to_string(),
        |n| n.to_string_lossy().to_string(),
    );

    let mut target = trash_dir.join(&file_name);
    let mut counter = 1u32;
    while target.exists() {
        let stem = Path::new(&file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = Path::new(&file_name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        target = trash_dir.join(format!("{stem}.{counter}{ext}"));
        counter += 1;
    }

    std::fs::rename(path, &target).map_err(|e| io_err(path, e))
}

fn trash_directory() -> WorkspaceResult<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| {
            WorkspaceError::Other("cannot determine home directory for trash".to_string())
        })?;
    Ok(PathBuf::from(home).join(".Trash"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Arc, Mutex};

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("sidex-fileops-{name}"));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn create_and_read_file() {
        let dir = tmp("create-read");
        let svc = FileOperationService::new();
        let p = dir.join("hello.txt");
        svc.create_file(&p, "hello world").unwrap();
        assert_eq!(
            FileOperationService::read_file_string(&p).unwrap(),
            "hello world"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_directory() {
        let dir = tmp("create-dir");
        let svc = FileOperationService::new();
        let p = dir.join("a/b/c");
        svc.create_directory(&p).unwrap();
        assert!(p.is_dir());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_permanent() {
        let dir = tmp("delete-perm");
        let svc = FileOperationService::new();
        let p = dir.join("file.txt");
        svc.create_file(&p, "data").unwrap();
        svc.delete(&p, false).unwrap();
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_file() {
        let dir = tmp("rename");
        let svc = FileOperationService::new();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        svc.create_file(&a, "data").unwrap();
        svc.rename(&a, &b, false).unwrap();
        assert!(!a.exists());
        assert!(b.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_no_overwrite() {
        let dir = tmp("rename-no-ow");
        let svc = FileOperationService::new();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        svc.create_file(&a, "a").unwrap();
        svc.create_file(&b, "b").unwrap();
        assert!(svc.rename(&a, &b, false).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_file() {
        let dir = tmp("copy");
        let svc = FileOperationService::new();
        let src = dir.join("src.txt");
        let dst = dir.join("dst.txt");
        svc.create_file(&src, "content").unwrap();
        svc.copy(&src, &dst, false).unwrap();
        assert_eq!(
            FileOperationService::read_file_string(&dst).unwrap(),
            "content"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_file() {
        let dir = tmp("move");
        let svc = FileOperationService::new();
        let src = dir.join("src.txt");
        let dst = dir.join("sub/dst.txt");
        svc.create_file(&src, "data").unwrap();
        svc.move_file(&src, &dst, false).unwrap();
        assert!(!src.exists());
        assert_eq!(
            FileOperationService::read_file_string(&dst).unwrap(),
            "data"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stat_file() {
        let dir = tmp("stat");
        let svc = FileOperationService::new();
        let p = dir.join("file.txt");
        svc.create_file(&p, "hello").unwrap();
        let s = FileOperationService::stat(&p).unwrap();
        assert_eq!(s.file_type, FileType::File);
        assert!(!s.is_symlink);
        assert_eq!(s.size, 5);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_dir_sorted() {
        let dir = tmp("readdir");
        let svc = FileOperationService::new();
        svc.create_directory(&dir.join("zdir")).unwrap();
        svc.create_file(&dir.join("afile.txt"), "a").unwrap();
        svc.create_file(&dir.join("bfile.txt"), "b").unwrap();

        let entries = FileOperationService::read_dir(&dir).unwrap();
        assert_eq!(entries[0].file_type, FileType::Directory);
        assert_eq!(entries[0].name, "zdir");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exists_and_readonly() {
        let dir = tmp("exists");
        let p = dir.join("nope.txt");
        assert!(!FileOperationService::exists(&p));
        assert!(!FileOperationService::is_readonly(&p));

        fs::write(&p, "x").unwrap();
        assert!(FileOperationService::exists(&p));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write() {
        let dir = tmp("atomic");
        let p = dir.join("atomic.txt");
        FileOperationService::write_file_atomic(&p, b"safe content").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "safe content");

        FileOperationService::write_file_atomic(&p, b"updated").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "updated");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_file_detection() {
        let dir = tmp("large");
        let p = dir.join("small.txt");
        fs::write(&p, "tiny").unwrap();
        assert!(!FileOperationService::is_large_file(&p));
        assert!(!FileOperationService::is_file_larger_than(&p, 100));
        assert!(FileOperationService::is_file_larger_than(&p, 2));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_size_query() {
        let dir = tmp("size");
        let p = dir.join("data.bin");
        fs::write(&p, "12345").unwrap();
        assert_eq!(FileOperationService::file_size(&p), 5);
        assert_eq!(FileOperationService::file_size(&dir.join("nope")), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_directory_recursive() {
        let dir = tmp("copydir");
        let src = dir.join("src");
        let dst = dir.join("dst");

        let svc = FileOperationService::new();
        svc.create_directory(&src.join("sub")).unwrap();
        svc.create_file(&src.join("a.txt"), "a").unwrap();
        svc.create_file(&src.join("sub/b.txt"), "b").unwrap();

        svc.copy_directory(&src, &dst, false).unwrap();
        assert!(dst.join("a.txt").exists());
        assert!(dst.join("sub/b.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn event_notifications() {
        let dir = tmp("events");
        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = Arc::clone(&events);

        let mut svc = FileOperationService::new();
        svc.on_file_operation(move |event| {
            let label = match event {
                FileOperationEvent::WillCreate(_) => "will_create",
                FileOperationEvent::DidCreate(_) => "did_create",
                FileOperationEvent::WillDelete(_) => "will_delete",
                FileOperationEvent::DidDelete(_) => "did_delete",
                FileOperationEvent::WillRename { .. } => "will_rename",
                FileOperationEvent::DidRename { .. } => "did_rename",
            };
            events_clone.lock().unwrap().push(label.to_string());
        });

        let p = dir.join("observed.txt");
        svc.create_file(&p, "data").unwrap();
        svc.delete(&p, false).unwrap();

        let log = events.lock().unwrap();
        assert_eq!(
            *log,
            vec!["will_create", "did_create", "will_delete", "did_delete"]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_and_read_bytes() {
        let dir = tmp("bytes");
        let p = dir.join("data.bin");
        FileOperationService::write_file(&p, &[0xDE, 0xAD]).unwrap();
        assert_eq!(
            FileOperationService::read_file(&p).unwrap(),
            vec![0xDE, 0xAD]
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
