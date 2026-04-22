//! Timeline view — git history and local save snapshots for a file.
//!
//! The Timeline panel shows the history of changes for the currently selected
//! file, combining git commit history with local editor save snapshots.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{WorkspaceError, WorkspaceResult};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Source of a timeline entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimelineSource {
    Git,
    LocalHistory,
}

/// Icon to render next to a timeline entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimelineIcon {
    GitCommit,
    LocalSave,
    GitMerge,
    GitTag,
}

/// A single entry in the timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub id: String,
    pub source: TimelineSource,
    pub timestamp: u64,
    pub label: String,
    pub description: String,
    pub icon: TimelineIcon,
    pub detail: Option<String>,
}

/// Top-level timeline state for a file.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Timeline {
    pub entries: Vec<TimelineEntry>,
    pub sources: Vec<TimelineSource>,
    pub active_file: Option<PathBuf>,
}

impl Timeline {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            sources: vec![TimelineSource::Git, TimelineSource::LocalHistory],
            active_file: None,
        }
    }

    /// Load timeline for a file, combining git and local history.
    pub fn load(
        &mut self,
        path: &Path,
        repo_root: &Path,
        history_dir: &Path,
    ) -> WorkspaceResult<()> {
        self.active_file = Some(path.to_path_buf());
        self.entries.clear();

        if self.sources.contains(&TimelineSource::Git) {
            if let Ok(git_entries) = get_git_timeline(path, repo_root) {
                self.entries.extend(git_entries);
            }
        }

        if self.sources.contains(&TimelineSource::LocalHistory) {
            if let Ok(local_entries) = get_local_history(path, history_dir) {
                self.entries.extend(local_entries);
            }
        }

        self.entries.sort_by_key(|a| std::cmp::Reverse(a.timestamp));
        Ok(())
    }

    /// Toggle a source on or off.
    pub fn toggle_source(&mut self, source: TimelineSource) {
        if let Some(pos) = self.sources.iter().position(|s| *s == source) {
            self.sources.remove(pos);
        } else {
            self.sources.push(source);
        }
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn git_entries(&self) -> Vec<&TimelineEntry> {
        self.entries
            .iter()
            .filter(|e| e.source == TimelineSource::Git)
            .collect()
    }

    pub fn local_entries(&self) -> Vec<&TimelineEntry> {
        self.entries
            .iter()
            .filter(|e| e.source == TimelineSource::LocalHistory)
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Git timeline
// ---------------------------------------------------------------------------

/// Get git log entries for a specific file.
pub fn get_git_timeline(path: &Path, repo_root: &Path) -> WorkspaceResult<Vec<TimelineEntry>> {
    let rel_path = pathdiff::diff_paths(path, repo_root).unwrap_or_else(|| path.to_path_buf());

    let output = Command::new("git")
        .args([
            "log",
            "--follow",
            "--format=%H%n%an%n%at%n%s%n---",
            "--",
            &rel_path.to_string_lossy(),
        ])
        .current_dir(repo_root)
        .output()
        .map_err(|e| WorkspaceError::Other(format!("git log failed: {e}")))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    let mut lines = stdout.lines().peekable();
    while lines.peek().is_some() {
        let hash = match lines.next() {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => break,
        };
        let author = lines.next().unwrap_or("").to_string();
        let timestamp_str = lines.next().unwrap_or("0");
        let timestamp: u64 = timestamp_str.parse().unwrap_or(0);
        let subject = lines.next().unwrap_or("").to_string();

        // Consume the "---" separator.
        if let Some(sep) = lines.next() {
            if sep != "---" {
                continue;
            }
        }

        let short_hash = hash[..hash.len().min(8)].to_string();
        let icon = if subject.to_lowercase().contains("merge") {
            TimelineIcon::GitMerge
        } else {
            TimelineIcon::GitCommit
        };

        entries.push(TimelineEntry {
            id: hash,
            source: TimelineSource::Git,
            timestamp,
            label: subject,
            description: format!("{author} • {short_hash}"),
            icon,
            detail: Some(author),
        });
    }

    Ok(entries)
}

// ---------------------------------------------------------------------------
// Local history
// ---------------------------------------------------------------------------

/// Directory structure for local history:
///   `<history_dir>/<sha256_of_path>/<timestamp>.snapshot`
fn history_subdir(path: &Path, history_dir: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let hash = hex::encode(hasher.finalize());
    history_dir.join(&hash[..16])
}

/// Save a snapshot of the file's current content into local history.
pub fn save_local_snapshot(
    path: &Path,
    content: &str,
    history_dir: &Path,
) -> WorkspaceResult<PathBuf> {
    let dir = history_subdir(path, history_dir);
    fs::create_dir_all(&dir).map_err(|e| WorkspaceError::Io {
        path: dir.clone(),
        source: e,
    })?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();

    let snapshot_path = dir.join(format!("{timestamp}.snapshot"));
    fs::write(&snapshot_path, content).map_err(|e| WorkspaceError::Io {
        path: snapshot_path.clone(),
        source: e,
    })?;

    // Write metadata alongside.
    let meta_path = dir.join(format!("{timestamp}.meta"));
    let meta = serde_json::json!({
        "original_path": path.to_string_lossy(),
        "timestamp": timestamp,
    });
    let _ = fs::write(&meta_path, meta.to_string());

    Ok(snapshot_path)
}

/// Read local history entries for a file.
pub fn get_local_history(path: &Path, history_dir: &Path) -> WorkspaceResult<Vec<TimelineEntry>> {
    let dir = history_subdir(path, history_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| WorkspaceError::Io {
        path: dir.clone(),
        source: e,
    })?;

    for entry in read_dir {
        let entry = entry.map_err(|e| WorkspaceError::Io {
            path: dir.clone(),
            source: e,
        })?;

        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.ends_with(".snapshot") {
            continue;
        }

        let timestamp_str = file_name.trim_end_matches(".snapshot");
        let timestamp: u64 = timestamp_str.parse().unwrap_or(0);

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let label = format_local_timestamp(timestamp);

        entries.push(TimelineEntry {
            id: format!("local-{timestamp}"),
            source: TimelineSource::LocalHistory,
            timestamp,
            label,
            description: format_byte_size(size),
            icon: TimelineIcon::LocalSave,
            detail: Some(entry.path().to_string_lossy().to_string()),
        });
    }

    entries.sort_by_key(|a| std::cmp::Reverse(a.timestamp));
    Ok(entries)
}

/// Read the content of a local history snapshot.
pub fn read_local_snapshot(snapshot_path: &Path) -> WorkspaceResult<String> {
    fs::read_to_string(snapshot_path).map_err(|e| WorkspaceError::Io {
        path: snapshot_path.to_path_buf(),
        source: e,
    })
}

/// Read the content of a git revision of a file.
pub fn read_git_revision(
    path: &Path,
    commit_hash: &str,
    repo_root: &Path,
) -> WorkspaceResult<String> {
    let rel_path = pathdiff::diff_paths(path, repo_root).unwrap_or_else(|| path.to_path_buf());
    let spec = format!("{commit_hash}:{}", rel_path.to_string_lossy());

    let output = Command::new("git")
        .args(["show", &spec])
        .current_dir(repo_root)
        .output()
        .map_err(|e| WorkspaceError::Other(format!("git show failed: {e}")))?;

    if !output.status.success() {
        return Err(WorkspaceError::Other(format!(
            "git show failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Purge local history entries older than `max_age`.
pub fn prune_local_history(
    path: &Path,
    history_dir: &Path,
    max_age: Duration,
) -> WorkspaceResult<usize> {
    let dir = history_subdir(path, history_dir);
    if !dir.exists() {
        return Ok(0);
    }

    let cutoff = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
        .saturating_sub(max_age.as_secs());

    let mut removed = 0;
    let read_dir = fs::read_dir(&dir).map_err(|e| WorkspaceError::Io {
        path: dir.clone(),
        source: e,
    })?;

    for entry in read_dir {
        let entry = entry.map_err(|e| WorkspaceError::Io {
            path: dir.clone(),
            source: e,
        })?;

        let file_name = entry.file_name().to_string_lossy().to_string();
        let ts_str = file_name
            .trim_end_matches(".snapshot")
            .trim_end_matches(".meta");
        let ts: u64 = ts_str.parse().unwrap_or(u64::MAX);

        if ts < cutoff {
            let _ = fs::remove_file(entry.path());
            removed += 1;
        }
    }

    Ok(removed)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn format_local_timestamp(epoch_secs: u64) -> String {
    let secs_ago = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
        .saturating_sub(epoch_secs);

    if secs_ago < 60 {
        "just now".to_string()
    } else if secs_ago < 3600 {
        let mins = secs_ago / 60;
        format!("{mins} minute{} ago", if mins == 1 { "" } else { "s" })
    } else if secs_ago < 86400 {
        let hours = secs_ago / 3600;
        format!("{hours} hour{} ago", if hours == 1 { "" } else { "s" })
    } else {
        let days = secs_ago / 86400;
        format!("{days} day{} ago", if days == 1 { "" } else { "s" })
    }
}

#[allow(clippy::cast_precision_loss)]
fn format_byte_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn save_and_read_local_snapshot() {
        let tmp = TempDir::new().unwrap();
        let file_path = PathBuf::from("/project/src/main.rs");
        let history_dir = tmp.path();

        let snap = save_local_snapshot(&file_path, "fn main() {}", history_dir).unwrap();
        assert!(snap.exists());

        let content = read_local_snapshot(&snap).unwrap();
        assert_eq!(content, "fn main() {}");
    }

    #[test]
    fn local_history_lists_snapshots() {
        let tmp = TempDir::new().unwrap();
        let file_path = PathBuf::from("/project/src/lib.rs");
        let history_dir = tmp.path();

        save_local_snapshot(&file_path, "v1", history_dir).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        save_local_snapshot(&file_path, "v2", history_dir).unwrap();

        let entries = get_local_history(&file_path, history_dir).unwrap();
        assert!(entries.len() >= 1);
        assert!(entries
            .iter()
            .all(|e| e.source == TimelineSource::LocalHistory));
    }

    #[test]
    fn timeline_new_defaults() {
        let timeline = Timeline::new();
        assert!(timeline.entries.is_empty());
        assert_eq!(timeline.sources.len(), 2);
        assert!(timeline.active_file.is_none());
    }

    #[test]
    fn toggle_source() {
        let mut timeline = Timeline::new();
        assert!(timeline.sources.contains(&TimelineSource::Git));
        timeline.toggle_source(TimelineSource::Git);
        assert!(!timeline.sources.contains(&TimelineSource::Git));
        timeline.toggle_source(TimelineSource::Git);
        assert!(timeline.sources.contains(&TimelineSource::Git));
    }

    #[test]
    fn format_timestamp_just_now() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(format_local_timestamp(now), "just now");
    }

    #[test]
    fn format_timestamp_minutes() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(format_local_timestamp(now - 300).contains("minute"));
    }

    #[test]
    fn format_byte_size_units() {
        assert_eq!(format_byte_size(500), "500 B");
        assert!(format_byte_size(2048).contains("KB"));
        assert!(format_byte_size(2 * 1024 * 1024).contains("MB"));
    }

    #[test]
    fn prune_removes_old() {
        let tmp = TempDir::new().unwrap();
        let file_path = PathBuf::from("/project/old.rs");
        let history_dir = tmp.path();

        let dir = history_subdir(&file_path, history_dir);
        fs::create_dir_all(&dir).unwrap();
        // Create a snapshot with a very old timestamp.
        fs::write(dir.join("1000000000.snapshot"), "old content").unwrap();

        let removed = prune_local_history(&file_path, history_dir, Duration::from_secs(1)).unwrap();
        assert!(removed >= 1);
    }
}
