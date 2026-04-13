#![allow(clippy::all)]

//! LRU Cache for file metadata to improve performance.
//!
//! This module provides a thread-safe LRU cache that stores file metadata
//! to avoid repeated stat() system calls for the same files.
//!
//! # Performance Benefits
//!
//! - O(1) lookup for cached file metadata
//! - Reduces filesystem calls significantly when accessing same files repeatedly
//! - Automatic eviction of least recently used entries
//!
//! # Usage
//!
//! The cache is integrated into the file system commands and automatically
//! caches stat() results. Cache is cleared on file modifications.

use lru::LruCache;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tokio::sync::Mutex;

/// Maximum number of file metadata entries to cache
const MAX_CACHE_ENTRIES: usize = 10_000;

/// Cache entry with timestamp for staleness detection
#[derive(Debug, Clone)]
pub struct FileMetadataCacheEntry {
    pub size: u64,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub modified: u64,
    pub created: u64,
    pub readonly: bool,
}

/// Thread-safe LRU cache for file metadata
pub struct FileMetadataCache {
    cache: Arc<Mutex<LruCache<PathBuf, FileMetadataCacheEntry>>>,
}

impl FileMetadataCache {
    /// Creates a new file metadata cache with the specified capacity
    pub fn new(capacity: usize) -> Self {
        Self {
            cache: Arc::new(Mutex::new(LruCache::new(
                std::num::NonZeroUsize::new(capacity)
                    .unwrap_or(std::num::NonZeroUsize::new(MAX_CACHE_ENTRIES).unwrap()),
            ))),
        }
    }

    /// Gets cached metadata for a file path
    pub async fn get(&self, path: &str) -> Option<FileMetadataCacheEntry> {
        let path_buf = PathBuf::from(path);
        let mut cache = self.cache.lock().await;
        cache.get(&path_buf).cloned()
    }

    /// Stores metadata for a file path in the cache
    pub async fn insert(&self, path: String, entry: FileMetadataCacheEntry) {
        let path_buf = PathBuf::from(path);
        let mut cache = self.cache.lock().await;
        cache.push(path_buf, entry);
    }

    /// Removes a specific entry from the cache
    pub async fn remove(&self, path: &str) {
        let path_buf = PathBuf::from(path);
        let mut cache = self.cache.lock().await;
        cache.pop(&path_buf);
    }

    /// Clears all cached entries
    pub async fn clear(&self) {
        let mut cache = self.cache.lock().await;
        cache.clear();
    }

    /// Returns the number of cached entries
    pub async fn len(&self) -> usize {
        let cache = self.cache.lock().await;
        cache.len()
    }
}

impl Default for FileMetadataCache {
    fn default() -> Self {
        Self::new(MAX_CACHE_ENTRIES)
    }
}

/// Converts std::fs::Metadata to cache entry
pub fn metadata_to_cache_entry(metadata: &fs::Metadata) -> Option<FileMetadataCacheEntry> {
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

    let readonly = metadata.permissions().readonly();

    Some(FileMetadataCacheEntry {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
        is_file: metadata.is_file(),
        is_symlink: metadata.is_symlink(),
        modified,
        created,
        readonly,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cache_basic_operations() {
        let cache = FileMetadataCache::new(10);

        // Initially empty
        assert_eq!(cache.len().await, 0);

        // Insert an entry
        cache
            .insert(
                "/test/path".to_string(),
                FileMetadataCacheEntry {
                    size: 100,
                    is_dir: false,
                    is_file: true,
                    is_symlink: false,
                    modified: 1000,
                    created: 500,
                    readonly: false,
                },
            )
            .await;

        // Should have 1 entry
        assert_eq!(cache.len().await, 1);

        // Get the entry
        let entry = cache.get("/test/path").await;
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().size, 100);

        // Remove the entry
        cache.remove("/test/path").await;
        assert_eq!(cache.len().await, 0);
    }

    #[tokio::test]
    async fn test_cache_eviction() {
        let cache = FileMetadataCache::new(2);

        cache
            .insert(
                "file1".to_string(),
                FileMetadataCacheEntry {
                    size: 1,
                    is_dir: false,
                    is_file: true,
                    is_symlink: false,
                    modified: 0,
                    created: 0,
                    readonly: false,
                },
            )
            .await;

        cache
            .insert(
                "file2".to_string(),
                FileMetadataCacheEntry {
                    size: 2,
                    is_dir: false,
                    is_file: true,
                    is_symlink: false,
                    modified: 0,
                    created: 0,
                    readonly: false,
                },
            )
            .await;

        // Adding third entry should trigger eviction of oldest
        cache
            .insert(
                "file3".to_string(),
                FileMetadataCacheEntry {
                    size: 3,
                    is_dir: false,
                    is_file: true,
                    is_symlink: false,
                    modified: 0,
                    created: 0,
                    readonly: false,
                },
            )
            .await;

        // file1 should be evicted
        assert!(cache.get("file1").await.is_none());
    }
}
