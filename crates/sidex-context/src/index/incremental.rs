use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;

use super::merkle::{self, MerkleNode};
use super::watcher::{FileWatcher, IndexEvent};
use crate::chunker::{self, Chunk};
use crate::search::bm25::Bm25Index;

#[derive(Debug, Default)]
pub struct IndexStats {
    pub files_indexed: usize,
    pub chunks_indexed: usize,
    pub files_updated: usize,
    pub files_removed: usize,
    pub elapsed_ms: u64,
}

pub struct IncrementalIndexer {
    bm25: Bm25Index,
    merkle_tree: Option<MerkleNode>,
    workspace_root: PathBuf,
    watcher: Option<FileWatcher>,
    total_file_count: usize,
}

impl IncrementalIndexer {
    pub fn new(workspace_root: &Path) -> Self {
        Self {
            bm25: Bm25Index::new(),
            merkle_tree: None,
            workspace_root: workspace_root.to_path_buf(),
            watcher: None,
            total_file_count: 0,
        }
    }

    pub fn full_index(&mut self) -> Result<IndexStats> {
        let start = Instant::now();

        let mut chunks = chunker::chunk_directory(&self.workspace_root, &self.workspace_root)?;

        // Cap total chunks to avoid memory blowup on huge repos
        const MAX_TOTAL_CHUNKS: usize = 50_000;
        if chunks.len() > MAX_TOTAL_CHUNKS {
            chunks.truncate(MAX_TOTAL_CHUNKS);
        }

        let mut files = std::collections::HashSet::new();
        for c in &chunks {
            files.insert(c.file_path.as_str());
        }
        self.total_file_count = files.len();

        let chunk_count = chunks.len();
        self.bm25 = Bm25Index::build(chunks);
        self.merkle_tree = merkle::build_tree(&self.workspace_root).ok();

        Ok(IndexStats {
            files_indexed: self.total_file_count,
            chunks_indexed: chunk_count,
            files_updated: 0,
            files_removed: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    /// Start the file watcher for live re-indexing. No-op if already started.
    pub fn start_watching(&mut self) -> Result<()> {
        if self.watcher.is_some() {
            return Ok(());
        }
        self.watcher = Some(FileWatcher::new(&self.workspace_root)?);
        Ok(())
    }

    pub fn stop_watching(&mut self) {
        self.watcher = None;
    }

    pub fn is_watching(&self) -> bool {
        self.watcher.is_some()
    }

    pub fn is_indexed(&self) -> bool {
        self.bm25.chunk_count() > 0
    }

    /// Process any pending file-system events and incrementally update the index.
    pub fn update(&mut self) -> Result<IndexStats> {
        let start = Instant::now();
        let mut stats = IndexStats::default();

        let events = match &self.watcher {
            Some(w) => w.poll_changes(),
            None => return Ok(stats),
        };

        if events.is_empty() {
            return Ok(stats);
        }

        let mut changed_files: Vec<String> = Vec::new();
        let mut deleted_files: Vec<String> = Vec::new();

        for event in events {
            match event {
                IndexEvent::FileChanged(path) | IndexEvent::FileCreated(path) => {
                    if !changed_files.contains(&path) {
                        changed_files.push(path);
                    }
                }
                IndexEvent::FileDeleted(path) => {
                    if !deleted_files.contains(&path) {
                        deleted_files.push(path);
                    }
                }
            }
        }

        for path in &deleted_files {
            self.bm25.remove_file(path);
            stats.files_removed += 1;
        }

        for rel_path in &changed_files {
            let abs_path = self.workspace_root.join(rel_path);
            if !abs_path.is_file() {
                continue;
            }

            self.bm25.remove_file(rel_path);

            match chunker::chunk_file(&abs_path, &self.workspace_root) {
                Ok(new_chunks) => {
                    if !new_chunks.is_empty() {
                        self.bm25.add_chunks(new_chunks);
                    }
                    stats.files_updated += 1;
                }
                Err(_) => {
                    // File couldn't be chunked (binary, unsupported, etc.) — skip
                }
            }
        }

        if stats.files_updated > 0 || stats.files_removed > 0 {
            // Skip full merkle rebuild on incremental updates — the file watcher
            // already provides change detection. Only rebuild on full_index().
        }

        stats.chunks_indexed = self.bm25.chunk_count();
        stats.elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(stats)
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<(&Chunk, f64)> {
        self.bm25.search(query, limit)
    }

    pub fn chunks(&self) -> &[Chunk] {
        self.bm25.chunks()
    }

    pub fn chunk_count(&self) -> usize {
        self.bm25.chunk_count()
    }

    pub fn file_count(&self) -> usize {
        self.total_file_count
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }
}
