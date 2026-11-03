use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

#[derive(Debug, Clone)]
pub enum IndexEvent {
    FileChanged(String),
    FileCreated(String),
    FileDeleted(String),
}

pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    receiver: mpsc::Receiver<IndexEvent>,
}

const SKIP_SEGMENTS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "vendor",
    ".next",
];

const INDEXABLE_EXTENSIONS: &[&str] = &[
    "rs", "py", "pyi", "js", "jsx", "mjs", "cjs", "ts", "tsx", "go", "c", "h", "cpp", "cc", "cxx",
    "hpp", "java", "rb", "rake", "sh", "bash", "json", "toml", "html", "htm", "css", "md", "yaml",
    "yml", "xml", "sql", "graphql", "proto", "swift", "kt", "kts", "scala", "lua", "zig", "ex",
    "exs", "erl", "hrl", "clj", "php", "dart", "r", "vue", "svelte",
];

fn should_skip_path(path: &Path) -> bool {
    for component in path.components() {
        let s = component.as_os_str().to_string_lossy();
        if SKIP_SEGMENTS.iter().any(|skip| *skip == s.as_ref()) {
            return true;
        }
        if s.starts_with('.') && s.len() > 1 {
            return true;
        }
    }
    false
}

fn is_indexable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| INDEXABLE_EXTENSIONS.contains(&ext))
}

impl FileWatcher {
    pub fn new(root: &Path) -> anyhow::Result<Self> {
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Event>();
        let (tx, rx) = mpsc::channel::<IndexEvent>();

        let root_owned = root.to_path_buf();

        std::thread::spawn(move || {
            Self::debounce_loop(raw_rx, tx, &root_owned);
        });

        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    let _ = raw_tx.send(ev);
                }
            })?;

        watcher.watch(root, RecursiveMode::Recursive)?;

        Ok(Self {
            _watcher: watcher,
            receiver: rx,
        })
    }

    /// Non-blocking: drain all pending events from the channel.
    pub fn poll_changes(&self) -> Vec<IndexEvent> {
        let mut events = Vec::new();
        while let Ok(ev) = self.receiver.try_recv() {
            events.push(ev);
        }
        events
    }

    fn debounce_loop(
        raw_rx: mpsc::Receiver<notify::Event>,
        tx: mpsc::Sender<IndexEvent>,
        root: &Path,
    ) {
        use std::collections::HashMap;

        const DEBOUNCE: Duration = Duration::from_millis(500);

        let mut pending: HashMap<PathBuf, (IndexEvent, Instant)> = HashMap::new();

        loop {
            match raw_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(ev) => {
                    for path in ev.paths {
                        let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();

                        if should_skip_path(&rel) {
                            continue;
                        }

                        if path.is_file() && !is_indexable(&path) {
                            continue;
                        }

                        let rel_str = rel.to_string_lossy().to_string();

                        let index_event = match ev.kind {
                            EventKind::Create(_) => IndexEvent::FileCreated(rel_str),
                            EventKind::Modify(event::ModifyKind::Data(_))
                            | EventKind::Modify(event::ModifyKind::Any) => {
                                IndexEvent::FileChanged(rel_str)
                            }
                            EventKind::Remove(_) => IndexEvent::FileDeleted(rel_str),
                            _ => continue,
                        };

                        pending.insert(rel.clone(), (index_event, Instant::now()));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            let now = Instant::now();
            let ready: Vec<PathBuf> = pending
                .iter()
                .filter(|(_, (_, ts))| now.duration_since(*ts) >= DEBOUNCE)
                .map(|(k, _)| k.clone())
                .collect();

            for key in ready {
                if let Some((ev, _)) = pending.remove(&key) {
                    let _ = tx.send(ev);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skip_path() {
        assert!(should_skip_path(Path::new("node_modules/foo/bar.js")));
        assert!(should_skip_path(Path::new(".git/HEAD")));
        assert!(should_skip_path(Path::new("src/.hidden/foo.rs")));
        assert!(!should_skip_path(Path::new("src/main.rs")));
        assert!(!should_skip_path(Path::new("crates/lib/mod.rs")));
    }

    #[test]
    fn test_is_indexable() {
        assert!(is_indexable(Path::new("main.rs")));
        assert!(is_indexable(Path::new("app.tsx")));
        assert!(is_indexable(Path::new("Cargo.toml")));
        assert!(!is_indexable(Path::new("image.png")));
        assert!(!is_indexable(Path::new("data.bin")));
    }
}
