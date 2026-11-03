use std::collections::HashMap;
use std::time::Instant;

/// An LRU-bounded file-content cache for predictive pre-fetching.
///
/// Default capacity is 50 MB. Entries are evicted least-recently-used first
/// when the total size exceeds `max_size_bytes`.
pub struct FileCache {
    entries: HashMap<String, CacheEntry>,
    max_size_bytes: usize,
    current_size: usize,
}

struct CacheEntry {
    content: String,
    accessed_at: Instant,
}

/// Statistics snapshot for observability.
#[derive(Debug, Clone)]
pub struct CacheStats {
    pub entry_count: usize,
    pub current_size_bytes: usize,
    pub max_size_bytes: usize,
}

impl FileCache {
    pub fn new(max_size_mb: usize) -> Self {
        Self {
            entries: HashMap::new(),
            max_size_bytes: max_size_mb * 1024 * 1024,
            current_size: 0,
        }
    }

    /// Pre-fetch a batch of file paths into the cache.
    /// Files that are already cached or that fail to read are silently skipped.
    pub fn prefetch(&mut self, file_paths: &[String]) {
        for path in file_paths {
            if self.entries.contains_key(path) {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(path) {
                self.insert(path.clone(), content);
            }
        }
    }

    /// Retrieve cached content. Returns `None` on miss and updates access time
    /// on hit (for LRU tracking).
    pub fn get(&mut self, path: &str) -> Option<&str> {
        if let Some(entry) = self.entries.get_mut(path) {
            entry.accessed_at = Instant::now();
            Some(&entry.content)
        } else {
            None
        }
    }

    /// Peek without updating the access timestamp.
    pub fn contains(&self, path: &str) -> bool {
        self.entries.contains_key(path)
    }

    /// Explicitly insert content (e.g. after a read_file that was not cached).
    pub fn insert(&mut self, path: String, content: String) {
        let size = content.len();

        if size > self.max_size_bytes {
            return;
        }

        if let Some(old) = self.entries.remove(&path) {
            self.current_size -= old.content.len();
        }

        self.current_size += size;
        self.entries.insert(
            path,
            CacheEntry {
                content,
                accessed_at: Instant::now(),
            },
        );

        self.evict_if_needed();
    }

    /// Remove a specific entry (e.g. when the file is modified).
    pub fn invalidate(&mut self, path: &str) {
        if let Some(entry) = self.entries.remove(path) {
            self.current_size -= entry.content.len();
        }
    }

    /// Drop all cached entries.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.current_size = 0;
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entry_count: self.entries.len(),
            current_size_bytes: self.current_size,
            max_size_bytes: self.max_size_bytes,
        }
    }

    fn evict_if_needed(&mut self) {
        while self.current_size > self.max_size_bytes && !self.entries.is_empty() {
            let oldest_key = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.accessed_at)
                .map(|(k, _)| k.clone());

            if let Some(key) = oldest_key {
                if let Some(entry) = self.entries.remove(&key) {
                    self.current_size -= entry.content.len();
                }
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_get() {
        let mut cache = FileCache::new(1);
        cache.insert("a.txt".into(), "hello world".into());
        assert_eq!(cache.get("a.txt"), Some("hello world"));
        assert_eq!(cache.get("missing.txt"), None);
    }

    #[test]
    fn lru_eviction() {
        // 1 byte max
        let mut cache = FileCache {
            entries: HashMap::new(),
            max_size_bytes: 20,
            current_size: 0,
        };

        cache.insert("a.txt".into(), "aaaaaaaaaa".into()); // 10 bytes
        cache.insert("b.txt".into(), "bbbbbbbbbb".into()); // 10 bytes — at capacity
        assert!(cache.contains("a.txt"));
        assert!(cache.contains("b.txt"));

        // Touch a so it's more recent
        let _ = cache.get("a.txt");

        // Insert c — should evict b (oldest access)
        cache.insert("c.txt".into(), "cccccccccc".into());
        assert!(
            cache.contains("a.txt"),
            "a should survive (recently accessed)"
        );
        assert!(!cache.contains("b.txt"), "b should be evicted (LRU)");
        assert!(cache.contains("c.txt"));
    }

    #[test]
    fn invalidate() {
        let mut cache = FileCache::new(1);
        cache.insert("a.txt".into(), "data".into());
        assert!(cache.contains("a.txt"));
        cache.invalidate("a.txt");
        assert!(!cache.contains("a.txt"));
        assert_eq!(cache.stats().current_size_bytes, 0);
    }

    #[test]
    fn oversize_entry_rejected() {
        let mut cache = FileCache {
            entries: HashMap::new(),
            max_size_bytes: 5,
            current_size: 0,
        };
        cache.insert("huge.txt".into(), "this is way too long".into());
        assert!(!cache.contains("huge.txt"));
    }

    #[test]
    fn update_existing_entry() {
        let mut cache = FileCache::new(1);
        cache.insert("a.txt".into(), "v1".into());
        cache.insert("a.txt".into(), "version2".into());
        assert_eq!(cache.get("a.txt"), Some("version2"));
        assert_eq!(cache.stats().current_size_bytes, "version2".len());
    }

    #[test]
    fn clear_resets_everything() {
        let mut cache = FileCache::new(1);
        cache.insert("a.txt".into(), "data".into());
        cache.insert("b.txt".into(), "more".into());
        cache.clear();
        assert_eq!(cache.stats().entry_count, 0);
        assert_eq!(cache.stats().current_size_bytes, 0);
    }

    #[test]
    fn stats_accurate() {
        let mut cache = FileCache::new(10);
        cache.insert("a.txt".into(), "12345".into());
        cache.insert("b.txt".into(), "67890".into());
        let stats = cache.stats();
        assert_eq!(stats.entry_count, 2);
        assert_eq!(stats.current_size_bytes, 10);
        assert_eq!(stats.max_size_bytes, 10 * 1024 * 1024);
    }
}
