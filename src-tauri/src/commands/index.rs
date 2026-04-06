//! High-performance in-memory text indexing for code search
//!
//! This module provides fast text search capabilities using:
//! - Inverted index (word -> locations)
//! - Trigram indexing for fuzzy/substring search
//! - Incremental updates for file changes
//! - Multi-threaded indexing with Rayon

use dashmap::DashMap;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::State;

const DEFAULT_MAX_FILE_SIZE: u64 = 1024 * 1024; // 1MB
const DEFAULT_MAX_RESULTS: usize = 1000;
const BINARY_CHECK_BYTES: usize = 8192; // 8KB

/// Options for building the index
#[derive(Debug, Clone, Deserialize)]
pub struct IndexOptions {
    pub file_extensions: Vec<String>,
    pub max_file_size: Option<u64>,
    pub exclude_dirs: Option<Vec<String>>,
}

impl Default for IndexOptions {
    fn default() -> Self {
        Self {
            file_extensions: vec![],
            max_file_size: Some(DEFAULT_MAX_FILE_SIZE),
            exclude_dirs: Some(vec![
                "node_modules".to_string(),
                ".git".to_string(),
                "target".to_string(),
                "dist".to_string(),
                "build".to_string(),
                "__pycache__".to_string(),
                ".next".to_string(),
            ]),
        }
    }
}

/// Options for searching the index
#[derive(Debug, Clone, Deserialize)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub max_results: Option<usize>,
    pub whole_word: bool,
    pub regex: bool,
    pub file_pattern: Option<String>,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            max_results: Some(DEFAULT_MAX_RESULTS),
            whole_word: false,
            regex: false,
            file_pattern: None,
        }
    }
}

/// Search result containing location and context
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub line_number: usize,
    pub column: usize,
    pub line_content: String,
    pub score: f32,
}

/// File change event for incremental updates
#[derive(Debug, Clone, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub change_type: String, // "created", "modified", "deleted"
}

/// Statistics about the index
#[derive(Debug, Clone, Serialize)]
pub struct IndexStats {
    pub total_files: usize,
    pub total_words: usize,
    pub memory_bytes: usize,
    pub root_path: String,
}

/// Location of a word occurrence in a file
#[derive(Debug, Clone)]
struct WordLocation {
    file_id: u32,
    line: usize,
    column: usize,
}

/// Information stored about each indexed file
#[derive(Debug, Clone)]
struct FileInfo {
    path: String,
    words: HashSet<String>, // Words present in this file (for removal)
}

/// Inverted index for fast text search
pub struct InvertedIndex {
    /// word -> list of (file_id, line, column)
    word_index: DashMap<String, Vec<WordLocation>>,
    /// trigram -> list of words containing it (for fuzzy search)
    trigram_index: Option<DashMap<String, Vec<String>>>,
    /// file_id -> file path mapping
    files: DashMap<u32, FileInfo>,
    /// path -> file_id reverse mapping
    path_to_id: DashMap<String, u32>,
    /// Next available file ID
    next_file_id: AtomicU32,
    /// Root path of the indexed directory
    root_path: std::sync::RwLock<String>,
    /// Word tokenizer regex
    word_regex: Regex,
    /// Total memory estimate (in bytes)
    memory_estimate: AtomicUsize,
}

impl InvertedIndex {
    fn new(enable_trigram: bool) -> Self {
        Self {
            word_index: DashMap::new(),
            trigram_index: if enable_trigram {
                Some(DashMap::new())
            } else {
                None
            },
            files: DashMap::new(),
            path_to_id: DashMap::new(),
            next_file_id: AtomicU32::new(1),
            root_path: std::sync::RwLock::new(String::new()),
            word_regex: Regex::new(r"[a-zA-Z_][a-zA-Z0-9_]{2,}").unwrap(),
            memory_estimate: AtomicUsize::new(0),
        }
    }

    fn set_root(&self, root: String) {
        let mut root_path = self.root_path.write().unwrap();
        *root_path = root;
    }

    fn get_root(&self) -> String {
        self.root_path.read().unwrap().clone()
    }

    /// Get or create file ID for a path
    fn get_or_create_file_id(&self, path: &str) -> u32 {
        if let Some(id) = self.path_to_id.get(path) {
            *id
        } else {
            let new_id = self.next_file_id.fetch_add(1, Ordering::SeqCst);
            self.path_to_id.insert(path.to_string(), new_id);
            new_id
        }
    }

    /// Add a word to the trigram index
    fn add_trigrams(&self, word: &str) {
        if let Some(ref trigram_index) = self.trigram_index {
            if word.len() >= 3 {
                let word_lower = word.to_lowercase();
                for i in 0..=word_lower.len().saturating_sub(3) {
                    let trigram = &word_lower[i..i + 3];
                    trigram_index
                        .entry(trigram.to_string())
                        .and_modify(|v| {
                            if !v.contains(&word_lower) {
                                v.push(word_lower.clone());
                            }
                        })
                        .or_insert_with(|| vec![word_lower.clone()]);
                }
            }
        }
    }

    /// Index a single file
    fn index_file(&self, file_path: &Path, max_file_size: u64) -> Result<(), String> {
        let path_str = file_path.to_string_lossy().to_string();
        
        // Skip if file is too large
        let metadata = fs::metadata(file_path).map_err(|e| e.to_string())?;
        if metadata.len() > max_file_size {
            return Ok(());
        }

        // Check if binary file
        if is_binary_file(file_path)? {
            return Ok(());
        }

        // Remove existing index for this file if present
        self.remove_file(&path_str);

        // Read file content
        let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;

        // Get or create file ID
        let file_id = self.get_or_create_file_id(&path_str);

        // Track words in this file
        let mut file_words: HashSet<String> = HashSet::new();

        // Index each line
        for (line_idx, line) in content.lines().enumerate() {
            for mat in self.word_regex.find_iter(line) {
                let word = mat.as_str();
                let column = mat.start();

                // Normalize word for indexing
                let normalized_word = word.to_lowercase();

                // Add to word index
                self.word_index
                    .entry(normalized_word.clone())
                    .and_modify(|v| {
                        v.push(WordLocation {
                            file_id,
                            line: line_idx + 1,
                            column: column + 1,
                        });
                    })
                    .or_insert_with(|| {
                        vec![WordLocation {
                            file_id,
                            line: line_idx + 1,
                            column: column + 1,
                        }]
                    });

                // Add to trigram index
                self.add_trigrams(&normalized_word);

                file_words.insert(normalized_word);

                // Update memory estimate
                self.memory_estimate.fetch_add(
                    std::mem::size_of::<WordLocation>() + word.len(),
                    Ordering::Relaxed,
                );
            }
        }

        // Store file info
        self.files.insert(
            file_id,
            FileInfo {
                path: path_str.clone(),
                words: file_words,
            },
        );

        Ok(())
    }

    /// Remove a file from the index
    fn remove_file(&self, path: &str) {
        if let Some((_, file_id)) = self.path_to_id.remove(path) {
            if let Some((_, file_info)) = self.files.remove(&file_id) {
                // Remove all word entries for this file
                for word in file_info.words {
                    if let Some(mut locations) = self.word_index.get_mut(&word) {
                        locations.retain(|loc| loc.file_id != file_id);
                        if locations.is_empty() {
                            drop(locations);
                            self.word_index.remove(&word);
                        }
                    }
                }
            }
        }
    }

    /// Search for exact word matches
    fn search_exact(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Vec<SearchResult> {
        let max_results = options.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
        let mut results = Vec::new();

        let search_word = if options.case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };

        // Check file pattern if specified
        let file_pattern = options.file_pattern.as_ref().and_then(|p| {
            globset::Glob::new(p).ok().map(|g| g.compile_matcher())
        });

        if let Some(locations) = self.word_index.get(&search_word) {
            for loc in locations.iter() {
                if results.len() >= max_results {
                    break;
                }

                if let Some(file_info) = self.files.get(&loc.file_id) {
                    // Filter by file pattern
                    if let Some(ref pattern) = file_pattern {
                        if !pattern.is_match(&file_info.path) {
                            continue;
                        }
                    }

                    // Get line content
                    if let Ok(line_content) =
                        get_line_at(&file_info.path, loc.line)
                    {
                        results.push(SearchResult {
                            path: file_info.path.clone(),
                            line_number: loc.line,
                            column: loc.column,
                            line_content,
                            score: 1.0,
                        });
                    }
                }
            }
        }

        results
    }

    /// Search using trigram index for fuzzy matching
    fn search_fuzzy(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Vec<SearchResult> {
        let max_results = options.max_results.unwrap_or(DEFAULT_MAX_RESULTS);

        if query.len() < 3 {
            return self.search_exact(query, options);
        }

        let query_lower = query.to_lowercase();
        let mut candidate_words: Option<HashSet<String>> = None;

        // Find candidate words using trigrams
        if let Some(ref trigram_index) = self.trigram_index {
            for i in 0..=query_lower.len().saturating_sub(3) {
                let trigram = &query_lower[i..i + 3];
                
                if let Some(words) = trigram_index.get(trigram) {
                    let word_set: HashSet<String> = words.iter().cloned().collect();
                    
                    candidate_words = match candidate_words {
                        Some(existing) => {
                            let intersection: HashSet<String> = existing
                                .intersection(&word_set)
                                .cloned()
                                .collect();
                            if intersection.is_empty() {
                                // No intersection, fall back to union
                                Some(
                                    existing
                                        .union(&word_set)
                                        .cloned()
                                        .collect(),
                                )
                            } else {
                                Some(intersection)
                            }
                        }
                        None => Some(word_set),
                    };
                }
            }
        }

        let candidates = match candidate_words {
            Some(c) => c,
            None => return self.search_exact(query, options),
        };

        // Score and filter candidates
        let mut scored_results: Vec<(SearchResult, f32)> = Vec::new();
        
        // Check file pattern if specified
        let file_pattern = options.file_pattern.as_ref().and_then(|p| {
            globset::Glob::new(p).ok().map(|g| g.compile_matcher())
        });

        for word in candidates {
            if let Some(locations) = self.word_index.get(&word) {
                for loc in locations.iter() {
                    if scored_results.len() >= max_results * 2 {
                        break;
                    }

                    if let Some(file_info) = self.files.get(&loc.file_id) {
                        // Filter by file pattern
                        if let Some(ref pattern) = file_pattern {
                            if !pattern.is_match(&file_info.path) {
                                continue;
                            }
                        }

                        // Calculate relevance score
                        let score = calculate_score(query, &word);

                        if score > 0.3 {
                            if let Ok(line_content) =
                                get_line_at(&file_info.path, loc.line)
                            {
                                // Verify the query is actually in the line
                                let line_check = if options.case_sensitive {
                                    line_content.clone()
                                } else {
                                    line_content.to_lowercase()
                                };
                                
                                if line_check.contains(&query_lower) {
                                    scored_results.push((
                                        SearchResult {
                                            path: file_info.path.clone(),
                                            line_number: loc.line,
                                            column: loc.column,
                                            line_content,
                                            score,
                                        },
                                        score,
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        // Sort by score and limit results
        scored_results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        scored_results.truncate(max_results);

        scored_results.into_iter().map(|(r, _)| r).collect()
    }

    /// Search with regex pattern
    fn search_regex(
        &self,
        pattern: &str,
        options: &SearchOptions,
    ) -> Result<Vec<SearchResult>, String> {
        let regex = if options.case_sensitive {
            Regex::new(pattern).map_err(|e| e.to_string())?
        } else {
            Regex::new(&format!("(?i){}", pattern)).map_err(|e| e.to_string())?
        };

        let max_results = options.max_results.unwrap_or(DEFAULT_MAX_RESULTS);
        let mut results = Vec::new();

        // Check file pattern if specified
        let file_pattern = options.file_pattern.as_ref().and_then(|p| {
            globset::Glob::new(p).ok().map(|g| g.compile_matcher())
        });

        // Scan all indexed files (this is slower but necessary for regex)
        for entry in self.files.iter() {
            if results.len() >= max_results {
                break;
            }

            let file_info = entry.value();

            // Filter by file pattern
            if let Some(ref pat) = file_pattern {
                if !pat.is_match(&file_info.path) {
                    continue;
                }
            }

            if let Ok(content) = fs::read_to_string(&file_info.path) {
                for (line_idx, line) in content.lines().enumerate() {
                    if results.len() >= max_results {
                        break;
                    }

                    if let Some(mat) = regex.find(line) {
                        results.push(SearchResult {
                            path: file_info.path.clone(),
                            line_number: line_idx + 1,
                            column: mat.start() + 1,
                            line_content: line.to_string(),
                            score: 1.0,
                        });
                    }
                }
            }
        }

        Ok(results)
    }

    /// Get statistics about the index
    fn stats(&self) -> IndexStats {
        IndexStats {
            total_files: self.files.len(),
            total_words: self.word_index.len(),
            memory_bytes: self.memory_estimate.load(Ordering::Relaxed),
            root_path: self.get_root(),
        }
    }

    /// Clear the entire index
    fn clear(&self) {
        self.word_index.clear();
        if let Some(ref trigram_index) = self.trigram_index {
            trigram_index.clear();
        }
        self.files.clear();
        self.path_to_id.clear();
        self.next_file_id.store(1, Ordering::SeqCst);
        self.memory_estimate.store(0, Ordering::Relaxed);
    }
}

/// Calculate relevance score between query and word
fn calculate_score(query: &str, word: &str) -> f32 {
    let query_lower = query.to_lowercase();
    let word_lower = word.to_lowercase();

    // Exact match
    if query_lower == word_lower {
        return 1.0;
    }

    // Prefix match
    if word_lower.starts_with(&query_lower) {
        return 0.9;
    }

    // Contains query
    if word_lower.contains(&query_lower) {
        return 0.8;
    }

    // Subsequence match
    if is_subsequence(&query_lower, &word_lower) {
        return 0.6;
    }

    // Calculate Levenshtein distance ratio
    let distance = levenshtein_distance(&query_lower, &word_lower);
    let max_len = query_lower.len().max(word_lower.len());
    
    if max_len == 0 {
        return 0.0;
    }

    let similarity = 1.0 - (distance as f32 / max_len as f32);
    similarity * 0.5 // Scale down fuzzy matches
}

/// Check if query is a subsequence of word
fn is_subsequence(query: &str, word: &str) -> bool {
    let mut query_chars = query.chars();
    let mut current = query_chars.next();

    for c in word.chars() {
        if let Some(qc) = current {
            if qc == c {
                current = query_chars.next();
            }
        } else {
            break;
        }
    }

    current.is_none()
}

/// Calculate Levenshtein distance between two strings
fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let a_len = a_chars.len();
    let b_len = b_chars.len();

    if a_len == 0 {
        return b_len;
    }
    if b_len == 0 {
        return a_len;
    }

    let mut prev_row: Vec<usize> = (0..=b_len).collect();
    let mut curr_row = vec![0; b_len + 1];

    for i in 1..=a_len {
        curr_row[0] = i;
        for j in 1..=b_len {
            let cost = if a_chars[i - 1] == b_chars[j - 1] {
                0
            } else {
                1
            };
            curr_row[j] = (curr_row[j - 1] + 1)
                .min(prev_row[j] + 1)
                .min(prev_row[j - 1] + cost);
        }
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    prev_row[b_len]
}

/// Check if a file is binary by looking for null bytes in the first N bytes
fn is_binary_file(path: &Path) -> Result<bool, String> {
    let content = fs::read(path).map_err(|e| e.to_string())?;
    let check_len = content.len().min(BINARY_CHECK_BYTES);
    
    for i in 0..check_len {
        if content[i] == 0 {
            return Ok(true);
        }
    }
    
    Ok(false)
}

/// Get the content of a specific line from a file
fn get_line_at(path: &str, line_number: usize) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    
    content
        .lines()
        .nth(line_number.saturating_sub(1))
        .map(|s| s.to_string())
        .ok_or_else(|| "Line not found".to_string())
}

/// Collect all files to index in a directory
fn collect_files(
    root: &Path,
    options: &IndexOptions,
) -> Result<Vec<std::path::PathBuf>, String> {
    let max_file_size = options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE);
    let exclude_dirs: HashSet<String> = options
        .exclude_dirs
        .as_ref()
        .map(|v| v.iter().cloned().collect())
        .unwrap_or_default();

    let extensions: HashSet<String> = options
        .file_extensions
        .iter()
        .map(|e| e.to_lowercase())
        .collect();

    let mut files = Vec::new();

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(50)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !exclude_dirs.contains(name.as_ref())
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        // Check file extension
        if !extensions.is_empty() {
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase());
            
            if ext.map_or(true, |e| !extensions.contains(&e)) {
                continue;
            }
        }

        // Check file size
        if let Ok(metadata) = entry.metadata() {
            if metadata.len() > max_file_size {
                continue;
            }
        }

        files.push(entry.path().to_path_buf());
    }

    Ok(files)
}

/// Shared index store for Tauri state
pub struct IndexStore {
    index: InvertedIndex,
}

impl IndexStore {
    pub fn new(enable_trigram: bool) -> Self {
        Self {
            index: InvertedIndex::new(enable_trigram),
        }
    }
}

/// Build index for a directory
#[tauri::command]
pub fn index_build(
    state: State<'_, Arc<IndexStore>>,
    root: String,
    options: Option<IndexOptions>,
) -> Result<IndexStats, String> {
    let options = options.unwrap_or_default();
    let root_path = Path::new(&root);

    if !root_path.exists() {
        return Err(format!("Root path does not exist: {}", root));
    }

    // Clear existing index and set new root
    state.index.clear();
    state.index.set_root(root.clone());

    // Collect files to index
    let files = collect_files(root_path, &options)?;

    // Index files in parallel using Rayon
    let max_file_size = options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE);
    
    files.par_iter().for_each(|file_path| {
        let _ = state.index.index_file(file_path, max_file_size);
    });

    Ok(state.index.stats())
}

/// Search the index
#[tauri::command]
pub fn index_search(
    state: State<'_, Arc<IndexStore>>,
    query: String,
    options: Option<SearchOptions>,
) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let options = options.unwrap_or_default();

    if options.regex {
        state.index.search_regex(&query, &options)
    } else if options.whole_word {
        Ok(state.index.search_exact(&query, &options))
    } else {
        // Default to fuzzy search for partial matches
        Ok(state.index.search_fuzzy(&query, &options))
    }
}

/// Update index for changed files
#[tauri::command]
pub fn index_update(
    state: State<'_, Arc<IndexStore>>,
    changes: Vec<FileChange>,
) -> Result<(), String> {
    let max_file_size = DEFAULT_MAX_FILE_SIZE;

    for change in changes {
        match change.change_type.as_str() {
            "created" | "modified" => {
                let path = Path::new(&change.path);
                if path.exists() {
                    state.index.index_file(path, max_file_size)?;
                }
            }
            "deleted" => {
                state.index.remove_file(&change.path);
            }
            _ => {}
        }
    }

    Ok(())
}

/// Get index statistics
#[tauri::command]
pub fn index_stats(state: State<'_, Arc<IndexStore>>) -> Result<IndexStats, String> {
    Ok(state.index.stats())
}

/// Clear the index
#[tauri::command]
pub fn index_clear(state: State<'_, Arc<IndexStore>>) -> Result<(), String> {
    state.index.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_score() {
        assert_eq!(calculate_score("hello", "hello"), 1.0);
        assert_eq!(calculate_score("hel", "hello"), 0.9);
        assert!(calculate_score("ell", "hello") > 0.5);
    }

    #[test]
    fn test_is_subsequence() {
        assert!(is_subsequence("abc", "aabbcc"));
        assert!(!is_subsequence("abc", "acb"));
        assert!(is_subsequence("", "anything"));
    }

    #[test]
    fn test_levenshtein_distance() {
        assert_eq!(levenshtein_distance("kitten", "sitting"), 3);
        assert_eq!(levenshtein_distance("", ""), 0);
        assert_eq!(levenshtein_distance("a", ""), 1);
        assert_eq!(levenshtein_distance("", "a"), 1);
    }
}
