//! High-performance file watching module with debouncing, batching, and pattern matching
//!
//! Features:
//! - Multi-path watching with a single watcher instance
//! - Debounced events (configurable delay, default 100ms)
//! - Event batching - multiple events sent as single notification
//! - Gitignore-style pattern matching via globset
//! - File extension filtering
//! - Memory-efficient with proper Arc/Mutex usage

use globset::{Glob, GlobSet, GlobSetBuilder};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::AbortHandle;

/// Maximum file size to read content for (100KB)
const MAX_FILE_CONTENT_SIZE: u64 = 100 * 1024;

/// Default debounce duration in milliseconds
const DEFAULT_DEBOUNCE_MS: u64 = 100;

/// Options for configuring file watching behavior
#[derive(Debug, Deserialize)]
pub struct WatchOptions {
    /// Whether to watch directories recursively
    pub recursive: bool,
    /// Debounce delay in milliseconds (default: 100)
    pub debounce_ms: Option<u64>,
    /// File extensions to watch (e.g., ["ts", "js", "json"]). None = all files.
    pub file_extensions: Option<Vec<String>>,
    /// Ignore patterns (gitignore-style, e.g., ["node_modules", ".git", "*.log"])
    pub ignore_patterns: Option<Vec<String>>,
    /// Whether to include file content in change events (for small files only)
    pub emit_content: Option<bool>,
}

impl WatchOptions {
    fn debounce_duration(&self) -> Duration {
        Duration::from_millis(self.debounce_ms.unwrap_or(DEFAULT_DEBOUNCE_MS))
    }

    fn should_emit_content(&self) -> bool {
        self.emit_content.unwrap_or(false)
    }

    fn recursive_mode(&self) -> RecursiveMode {
        if self.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        }
    }
}

/// Individual file system event
#[derive(Debug, Clone, Serialize)]
pub struct WatchEvent {
    /// Absolute path to the file/directory
    pub path: String,
    /// Event kind: "created", "modified", "deleted", "renamed"
    pub kind: String,
    /// Whether this is a directory
    pub is_dir: bool,
    /// File content (only if emit_content is true and file is small enough)
    pub content: Option<String>,
}

/// Batch of watch events sent to frontend
#[derive(Debug, Clone, Serialize)]
pub struct WatchEventBatch {
    /// Watch session ID
    pub watch_id: u32,
    /// Events in this batch
    pub events: Vec<WatchEvent>,
    /// Unix timestamp (milliseconds)
    pub timestamp: u64,
}

/// Internal pending event for debouncing
#[derive(Debug)]
struct PendingEvent {
    path: PathBuf,
    kind: EventKind,
    is_dir: bool,
}

/// Watch session state
struct WatchSession {
    /// Paths being watched (kept for reference)
    #[allow(dead_code)]
    paths: Vec<PathBuf>,
    /// The notify watcher instance (kept alive for the duration of the session)
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    /// Globset for ignore patterns
    ignore_globset: Option<GlobSet>,
    /// File extensions to include (None = all, kept for reference)
    #[allow(dead_code)]
    file_extensions: Option<HashSet<String>>,
    /// Whether to emit file content (kept for reference)
    #[allow(dead_code)]
    emit_content: bool,
    /// Channel sender for debounced events (kept alive to keep receiver working)
    #[allow(dead_code)]
    event_sender: UnboundedSender<PendingEvent>,
    /// Handle to the debounce task (for cleanup)
    #[allow(dead_code)]
    debounce_task: AbortHandle,
}

/// Thread-safe store for all active watch sessions
pub struct WatchStore {
    /// Map of watch ID to session
    sessions: Mutex<HashMap<u32, WatchSession>>,
    /// Counter for generating unique watch IDs
    next_id: Mutex<u32>,
}

impl WatchStore {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    fn next_id(&self) -> Result<u32, String> {
        let mut id = self.next_id.lock().map_err(|e| e.to_string())?;
        let val = *id;
        *id = id.wrapping_add(1);
        if *id == 0 {
            *id = 1; // Skip 0 to avoid potential confusion
        }
        Ok(val)
    }
}

impl Default for WatchStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a GlobSet from ignore patterns
fn build_ignore_globset(patterns: &[String]) -> Result<Option<GlobSet>, String> {
    if patterns.is_empty() {
        return Ok(None);
    }

    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        // Support both glob patterns and simple path patterns
        let glob =
            Glob::new(pattern).map_err(|e| format!("Invalid pattern '{}': {}", pattern, e))?;
        builder.add(glob);
    }

    let globset = builder
        .build()
        .map_err(|e| format!("Failed to build globset: {}", e))?;
    Ok(Some(globset))
}

/// Check if a path should be ignored based on globset
fn should_ignore(path: &Path, ignore_globset: &Option<GlobSet>) -> bool {
    if let Some(globset) = ignore_globset {
        // Check the full path
        if globset.is_match(path) {
            return true;
        }
        // Check each component
        for component in path.components() {
            if let Some(name) = component.as_os_str().to_str() {
                if globset.is_match(name) {
                    return true;
                }
            }
        }
    }
    false
}

/// Check if file extension matches the allowed set
fn extension_matches(path: &Path, extensions: &Option<HashSet<String>>) -> bool {
    if let Some(exts) = extensions {
        if let Some(ext) = path.extension() {
            if let Some(ext_str) = ext.to_str() {
                return exts.contains(&ext_str.to_lowercase());
            }
        }
        false
    } else {
        true // No extension filter = match all
    }
}

/// Read file content if it should be emitted and is small enough
fn maybe_read_content(path: &Path, should_emit: bool) -> Option<String> {
    if !should_emit {
        return None;
    }

    let metadata = std::fs::metadata(path).ok()?;

    // Only read regular files (not directories, symlinks, etc.)
    if !metadata.is_file() {
        return None;
    }

    // Only read if file is small enough
    if metadata.len() > MAX_FILE_CONTENT_SIZE {
        return None;
    }

    // Try to read as UTF-8 text
    std::fs::read_to_string(path).ok()
}

/// Convert EventKind to string representation
fn event_kind_to_string(kind: &EventKind) -> String {
    use notify::event::*;

    match kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Any) => "created",
        EventKind::Modify(ModifyKind::Data(_))
        | EventKind::Modify(ModifyKind::Metadata(_))
        | EventKind::Modify(ModifyKind::Any) => "modified",
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Any) => "deleted",
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => "renamed_from",
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => "renamed_to",
        EventKind::Modify(ModifyKind::Name(_)) => "renamed",
        _ => "unknown",
    }
    .to_string()
}

/// Determine if an event is a deletion
fn is_deletion(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Remove(_))
}

/// Create the debounce task that batches and emits events
fn spawn_debounce_task(
    watch_id: u32,
    app: AppHandle,
    debounce_duration: Duration,
    emit_content: bool,
) -> (UnboundedSender<PendingEvent>, AbortHandle) {
    let (tx, mut rx) = mpsc::unbounded_channel::<PendingEvent>();

    let handle = tokio::spawn(async move {
        let mut pending_events: Vec<PendingEvent> = Vec::new();
        let mut debounce_timer = tokio::time::interval(Duration::from_millis(10));
        debounce_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let mut last_event_time: Option<tokio::time::Instant> = None;

        loop {
            debounce_timer.tick().await;

            // Collect all pending events
            while let Ok(event) = rx.try_recv() {
                pending_events.push(event);
                last_event_time = Some(tokio::time::Instant::now());
            }

            // Check if we should emit the batch
            let should_emit = if let Some(last) = last_event_time {
                let elapsed = tokio::time::Instant::now().duration_since(last);
                elapsed >= debounce_duration && !pending_events.is_empty()
            } else {
                false
            };

            if should_emit {
                // Deduplicate events - keep only the latest event for each path
                let mut latest_events: HashMap<PathBuf, PendingEvent> = HashMap::new();
                for event in pending_events.drain(..) {
                    latest_events.insert(event.path.clone(), event);
                }

                // Convert to WatchEvent structs
                let events: Vec<WatchEvent> = latest_events
                    .into_values()
                    .filter_map(|pending| {
                        // Skip reading content for deletions
                        let content = if is_deletion(&pending.kind) {
                            None
                        } else {
                            maybe_read_content(&pending.path, emit_content)
                        };

                        Some(WatchEvent {
                            path: pending.path.to_string_lossy().to_string(),
                            kind: event_kind_to_string(&pending.kind),
                            is_dir: pending.is_dir,
                            content,
                        })
                    })
                    .collect();

                if !events.is_empty() {
                    let timestamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;

                    let batch = WatchEventBatch {
                        watch_id,
                        events,
                        timestamp,
                    };

                    let _ = app.emit("watch-batch", batch);
                }

                last_event_time = None;
            }
        }
    });

    (tx, handle.abort_handle())
}

/// Start watching multiple paths with advanced options
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    state: State<'_, Arc<WatchStore>>,
    paths: Vec<String>,
    options: WatchOptions,
) -> Result<u32, String> {
    // Validate paths
    if paths.is_empty() {
        return Err("At least one path must be provided".to_string());
    }

    let valid_paths: Vec<PathBuf> = paths
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();

    if valid_paths.is_empty() {
        return Err("No valid paths to watch".to_string());
    }

    let watch_id = state.next_id()?;

    // Extract options before moving values
    let emit_content = options.should_emit_content();
    let debounce_duration = options.debounce_duration();
    let recursive_mode = options.recursive_mode();

    // Build ignore globset
    let ignore_globset =
        build_ignore_globset(&options.ignore_patterns.clone().unwrap_or_default())?;

    // Clone values for the watcher closure
    let app_clone = app.clone();
    let ignore_clone = ignore_globset.clone();

    // Build file extension set
    let file_extensions: Option<HashSet<String>> = options
        .file_extensions
        .as_ref()
        .map(|exts| exts.iter().map(|e| e.to_lowercase()).collect());
    let exts_clone = file_extensions.clone();

    // Spawn debounce task
    let (event_sender, debounce_task) =
        spawn_debounce_task(watch_id, app_clone, debounce_duration, emit_content);

    let sender_clone = event_sender.clone();

    // Create the notify watcher
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                // Process each path in the event
                for path in &event.paths {
                    // Skip ignored paths
                    if should_ignore(path, &ignore_clone) {
                        continue;
                    }

                    // Check file extension filter
                    if !extension_matches(path, &exts_clone) {
                        continue;
                    }

                    // Determine if it's a directory
                    let is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);

                    // Send to debounce channel
                    let pending = PendingEvent {
                        path: path.clone(),
                        kind: event.kind.clone(),
                        is_dir,
                    };

                    let _ = sender_clone.send(pending);
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    // Watch all paths
    for path in &valid_paths {
        watcher
            .watch(path, recursive_mode)
            .map_err(|e| format!("Failed to watch '{}': {}", path.display(), e))?;
    }

    // Store the session
    let session = WatchSession {
        paths: valid_paths,
        watcher,
        ignore_globset,
        file_extensions,
        emit_content,
        event_sender,
        debounce_task,
    };

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(watch_id, session);

    Ok(watch_id)
}

/// Stop a watch session and clean up resources
#[tauri::command]
pub fn watch_stop(state: State<'_, Arc<WatchStore>>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;

    if let Some(session) = sessions.remove(&id) {
        // Abort the debounce task
        session.debounce_task.abort();
        // The watcher and other resources are dropped automatically
        Ok(())
    } else {
        Err(format!("Watch session {} not found", id))
    }
}

/// Update ignore patterns for an existing watch session
#[tauri::command]
pub fn watch_update_patterns(
    state: State<'_, Arc<WatchStore>>,
    id: u32,
    patterns: Vec<String>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;

    if let Some(session) = sessions.get_mut(&id) {
        let new_globset = build_ignore_globset(&patterns)?;
        session.ignore_globset = new_globset;
        Ok(())
    } else {
        Err(format!("Watch session {} not found", id))
    }
}

/// Get information about active watch sessions (for debugging/monitoring)
#[tauri::command]
pub fn watch_list(state: State<'_, Arc<WatchStore>>) -> Result<Vec<u32>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.keys().copied().collect())
}

/// Check if a specific watch session is still active
#[tauri::command]
pub fn watch_is_active(state: State<'_, Arc<WatchStore>>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.contains_key(&id))
}
