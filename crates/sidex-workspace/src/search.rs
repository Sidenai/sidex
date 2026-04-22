//! Production-quality parallel text search across workspace files.
//!
//! Uses `rayon` for parallelism, `memchr` / `regex` for matching, and the
//! `ignore` crate's `WalkBuilder` for fast `.gitignore`-aware file walking.
//! Binary files are detected (null-byte heuristic) and skipped automatically.
//!
//! Features:
//! - Include/exclude glob patterns
//! - Context lines (N lines before/after each match)
//! - Grouped results by file (`SearchResultGroup`)
//! - Streaming progress callback
//! - Replace-in-files with preview and apply
//! - Encoding-aware search (gracefully handles non-UTF-8)

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use ignore::WalkBuilder;
use memchr::memmem;
use rayon::prelude::*;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

use crate::error::WorkspaceResult;

const BINARY_CHECK_BYTES: usize = 8192;
const DEFAULT_MAX_RESULTS: usize = 500;
const DEFAULT_MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
const DEFAULT_CONTEXT_LINES: usize = 0;

/// Parameters for a search query.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default = "default_true")]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub max_results: Option<usize>,
}

fn default_true() -> bool {
    true
}

/// Extended search options for production use.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SearchOptions {
    /// Glob patterns to include (e.g. `["*.rs", "*.toml"]`).
    #[serde(default)]
    pub include_patterns: Vec<String>,
    /// Glob patterns to exclude (e.g. `["*.min.js"]`).
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// Maximum results to return.
    pub max_results: Option<usize>,
    /// Maximum file size in bytes.
    pub max_file_size: Option<u64>,
    /// Number of context lines before/after each match.
    pub context_lines: Option<usize>,
}

/// A single match result.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub path: PathBuf,
    pub line_number: usize,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
}

/// A context line shown around a match.
#[derive(Debug, Clone, Serialize)]
pub struct ContextLine {
    pub line_number: usize,
    pub text: String,
}

/// A match with surrounding context lines.
#[derive(Debug, Clone, Serialize)]
pub struct SearchMatchWithContext {
    pub line_number: usize,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
    pub before_context: Vec<ContextLine>,
    pub after_context: Vec<ContextLine>,
}

/// Search results grouped by file.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResultGroup {
    pub file_path: PathBuf,
    pub matches: Vec<SearchMatchWithContext>,
    pub line_count: usize,
}

/// Callback type for streaming search progress.
pub type SearchProgress = Arc<dyn Fn(&SearchResult) + Send + Sync>;

/// A previewed replacement edit for a single file.
#[derive(Debug, Clone, Serialize)]
pub struct FileReplacement {
    pub path: PathBuf,
    pub edits: Vec<ReplacementEdit>,
}

/// A single replacement edit within a file.
#[derive(Debug, Clone, Serialize)]
pub struct ReplacementEdit {
    pub line_number: usize,
    pub match_start: usize,
    pub match_end: usize,
    pub original: String,
    pub replacement: String,
}

/// A previewed replacement edit (legacy compat).
#[derive(Debug, Clone, Serialize)]
pub struct FileEdit {
    pub path: PathBuf,
    pub line_number: usize,
    pub original: String,
    pub replaced: String,
}

/// Parallel text search engine.
pub struct SearchEngine;

impl SearchEngine {
    /// Search for `query` across all files under `root`, respecting `.gitignore`.
    pub fn search(root: &Path, query: &SearchQuery) -> WorkspaceResult<Vec<SearchResult>> {
        Self::search_with_options(root, query, &SearchOptions::default())
    }

    /// Search with extended options (include/exclude patterns, max file size).
    pub fn search_with_options(
        root: &Path,
        query: &SearchQuery,
        options: &SearchOptions,
    ) -> WorkspaceResult<Vec<SearchResult>> {
        Self::search_inner(root, query, options, None)
    }

    /// Search with a progress callback for streaming results.
    pub fn search_with_progress(
        root: &Path,
        query: &SearchQuery,
        options: &SearchOptions,
        progress: SearchProgress,
    ) -> WorkspaceResult<Vec<SearchResult>> {
        Self::search_inner(root, query, options, Some(progress))
    }

    #[allow(clippy::too_many_lines, clippy::needless_pass_by_value)]
    fn search_inner(
        root: &Path,
        query: &SearchQuery,
        options: &SearchOptions,
        progress: Option<SearchProgress>,
    ) -> WorkspaceResult<Vec<SearchResult>> {
        let max_results = options
            .max_results
            .or(query.max_results)
            .unwrap_or(DEFAULT_MAX_RESULTS);
        let max_file_size = options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE);
        let files = collect_files_with_options(root, options, max_file_size);

        let use_literal = !query.is_regex && query.case_sensitive && !query.whole_word;

        let literal_finder = if use_literal {
            Some(Arc::new(memmem::Finder::new(query.pattern.as_bytes())))
        } else {
            None
        };

        let re = if use_literal {
            None
        } else {
            let mut pat = if query.is_regex {
                query.pattern.clone()
            } else {
                regex::escape(&query.pattern)
            };
            if query.whole_word {
                pat = format!(r"\b{pat}\b");
            }
            Some(
                RegexBuilder::new(&pat)
                    .case_insensitive(!query.case_sensitive)
                    .build()?,
            )
        };

        let hit_count = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));

        let batches: Vec<Vec<SearchResult>> = files
            .par_iter()
            .filter_map(|path| {
                if done.load(Ordering::Relaxed) {
                    return None;
                }

                let content = read_file_lossy(path)?;
                let path_buf = path.clone();
                let mut local = Vec::new();

                if let Some(ref finder) = literal_finder {
                    for (line_idx, line) in content.lines().enumerate() {
                        let bytes = line.as_bytes();
                        let mut start = 0;
                        while let Some(pos) = finder.find(&bytes[start..]) {
                            let result = SearchResult {
                                path: path_buf.clone(),
                                line_number: line_idx + 1,
                                line_text: line.to_string(),
                                match_start: start + pos,
                                match_end: start + pos + query.pattern.len(),
                            };
                            if let Some(ref cb) = progress {
                                cb(&result);
                            }
                            local.push(result);
                            start += pos + 1;
                            if hit_count.load(Ordering::Relaxed) + local.len() >= max_results {
                                break;
                            }
                        }
                        if hit_count.load(Ordering::Relaxed) + local.len() >= max_results {
                            break;
                        }
                    }
                } else if let Some(ref re) = re {
                    for (line_idx, line) in content.lines().enumerate() {
                        for m in re.find_iter(line) {
                            let result = SearchResult {
                                path: path_buf.clone(),
                                line_number: line_idx + 1,
                                line_text: line.to_string(),
                                match_start: m.start(),
                                match_end: m.end(),
                            };
                            if let Some(ref cb) = progress {
                                cb(&result);
                            }
                            local.push(result);
                            if hit_count.load(Ordering::Relaxed) + local.len() >= max_results {
                                break;
                            }
                        }
                        if hit_count.load(Ordering::Relaxed) + local.len() >= max_results {
                            break;
                        }
                    }
                }

                if local.is_empty() {
                    None
                } else {
                    let prev = hit_count.fetch_add(local.len(), Ordering::Relaxed);
                    if prev + local.len() >= max_results {
                        done.store(true, Ordering::Relaxed);
                        local.truncate(max_results.saturating_sub(prev));
                    }
                    Some(local)
                }
            })
            .collect();

        let mut results = Vec::with_capacity(max_results);
        for batch in batches {
            let remaining = max_results.saturating_sub(results.len());
            if remaining == 0 {
                break;
            }
            results.extend(batch.into_iter().take(remaining));
        }

        Ok(results)
    }

    /// Search and group results by file, with context lines.
    pub fn search_grouped(
        root: &Path,
        query: &SearchQuery,
        options: &SearchOptions,
    ) -> WorkspaceResult<Vec<SearchResultGroup>> {
        let results = Self::search_with_options(root, query, options)?;
        let context_lines = options.context_lines.unwrap_or(DEFAULT_CONTEXT_LINES);

        let mut groups: HashMap<PathBuf, Vec<SearchResult>> = HashMap::new();
        for r in results {
            groups.entry(r.path.clone()).or_default().push(r);
        }

        let mut output: Vec<SearchResultGroup> = groups
            .into_iter()
            .map(|(file_path, matches)| {
                let file_lines: Vec<String> = fs::read_to_string(&file_path)
                    .map(|c| c.lines().map(String::from).collect())
                    .unwrap_or_default();
                let line_count = file_lines.len();

                let matches_with_ctx: Vec<SearchMatchWithContext> = matches
                    .into_iter()
                    .map(|m| {
                        let line_idx = m.line_number.saturating_sub(1);

                        let before_start = line_idx.saturating_sub(context_lines);
                        let before_context: Vec<ContextLine> = (before_start..line_idx)
                            .filter_map(|i| {
                                file_lines.get(i).map(|text| ContextLine {
                                    line_number: i + 1,
                                    text: text.clone(),
                                })
                            })
                            .collect();

                        let after_end = (line_idx + 1 + context_lines).min(file_lines.len());
                        let after_context: Vec<ContextLine> = ((line_idx + 1)..after_end)
                            .filter_map(|i| {
                                file_lines.get(i).map(|text| ContextLine {
                                    line_number: i + 1,
                                    text: text.clone(),
                                })
                            })
                            .collect();

                        SearchMatchWithContext {
                            line_number: m.line_number,
                            line_text: m.line_text,
                            match_start: m.match_start,
                            match_end: m.match_end,
                            before_context,
                            after_context,
                        }
                    })
                    .collect();

                SearchResultGroup {
                    file_path,
                    matches: matches_with_ctx,
                    line_count,
                }
            })
            .collect();

        output.sort_by_key(|a| a.file_path.clone());
        Ok(output)
    }

    /// Preview replacements without writing to disk.
    pub fn search_replace(
        root: &Path,
        query: &SearchQuery,
        replacement: &str,
    ) -> WorkspaceResult<Vec<FileEdit>> {
        let hits = Self::search(root, query)?;
        let mut edits = Vec::with_capacity(hits.len());

        let re = if query.is_regex {
            Some(
                RegexBuilder::new(&query.pattern)
                    .case_insensitive(!query.case_sensitive)
                    .build()?,
            )
        } else {
            None
        };

        for hit in hits {
            let replaced = if let Some(ref re) = re {
                re.replace_all(&hit.line_text, replacement).into_owned()
            } else if query.case_sensitive {
                hit.line_text.replace(&query.pattern, replacement)
            } else {
                case_insensitive_replace(&hit.line_text, &query.pattern, replacement)
            };

            edits.push(FileEdit {
                path: hit.path,
                line_number: hit.line_number,
                original: hit.line_text,
                replaced,
            });
        }

        Ok(edits)
    }

    /// Preview replacements grouped by file as `FileReplacement`s.
    pub fn replace_in_files(
        root: &Path,
        query: &SearchQuery,
        replacement: &str,
    ) -> WorkspaceResult<Vec<FileReplacement>> {
        let hits = Self::search(root, query)?;

        let re = if query.is_regex {
            Some(
                RegexBuilder::new(&query.pattern)
                    .case_insensitive(!query.case_sensitive)
                    .build()?,
            )
        } else {
            None
        };

        let mut file_map: HashMap<PathBuf, Vec<ReplacementEdit>> = HashMap::new();

        for hit in hits {
            let replaced_text = if let Some(ref re) = re {
                re.replace_all(&hit.line_text, replacement).into_owned()
            } else if query.case_sensitive {
                hit.line_text.replace(&query.pattern, replacement)
            } else {
                case_insensitive_replace(&hit.line_text, &query.pattern, replacement)
            };

            file_map.entry(hit.path).or_default().push(ReplacementEdit {
                line_number: hit.line_number,
                match_start: hit.match_start,
                match_end: hit.match_end,
                original: hit.line_text,
                replacement: replaced_text,
            });
        }

        let mut result: Vec<FileReplacement> = file_map
            .into_iter()
            .map(|(path, edits)| FileReplacement { path, edits })
            .collect();
        result.sort_by_key(|a| a.path.clone());
        Ok(result)
    }

    /// Apply replacements to disk. Returns the list of modified files.
    pub fn apply_replacements(replacements: &[FileReplacement]) -> WorkspaceResult<Vec<PathBuf>> {
        let mut modified = Vec::new();

        for file_rep in replacements {
            let Ok(content) = fs::read_to_string(&file_rep.path) else {
                continue;
            };
            let lines: Vec<&str> = content.lines().collect();
            let mut new_lines: Vec<String> = lines.iter().map(|l| (*l).to_string()).collect();

            for edit in &file_rep.edits {
                let idx = edit.line_number.saturating_sub(1);
                if idx < new_lines.len() {
                    new_lines[idx].clone_from(&edit.replacement);
                }
            }

            let new_content = new_lines.join("\n");
            let trailing = if content.ends_with('\n') { "\n" } else { "" };
            fs::write(&file_rep.path, format!("{new_content}{trailing}")).map_err(|e| {
                crate::error::WorkspaceError::Io {
                    path: file_rep.path.clone(),
                    source: e,
                }
            })?;
            modified.push(file_rep.path.clone());
        }

        Ok(modified)
    }
}

fn case_insensitive_replace(text: &str, pattern: &str, replacement: &str) -> String {
    let lower_text = text.to_lowercase();
    let lower_pat = pattern.to_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut last = 0;

    for (idx, _) in lower_text.match_indices(&lower_pat) {
        result.push_str(&text[last..idx]);
        result.push_str(replacement);
        last = idx + pattern.len();
    }
    result.push_str(&text[last..]);
    result
}

/// Read a file, falling back to lossy UTF-8 for non-UTF-8 content.
fn read_file_lossy(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Collect searchable files with extended options.
fn collect_files_with_options(
    root: &Path,
    options: &SearchOptions,
    max_file_size: u64,
) -> Vec<PathBuf> {
    let include_set = build_search_globset(&options.include_patterns);
    let exclude_set = build_search_globset(&options.exclude_patterns);

    let mut files = Vec::new();

    for result in WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build()
    {
        let Ok(entry) = result else { continue };

        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }

        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.len() > max_file_size {
                continue;
            }
        }

        if let Some(ref inc) = include_set {
            if !inc.is_match(path) {
                continue;
            }
        }
        if let Some(ref exc) = exclude_set {
            if exc.is_match(path) {
                continue;
            }
        }

        if is_binary(path) {
            continue;
        }

        files.push(path.to_path_buf());
    }

    files
}

fn build_search_globset(patterns: &[String]) -> Option<globset::GlobSet> {
    if patterns.is_empty() {
        return None;
    }
    let mut builder = globset::GlobSetBuilder::new();
    for p in patterns {
        if let Ok(g) = globset::Glob::new(p) {
            builder.add(g);
        }
    }
    builder.build().ok()
}

fn is_binary(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; BINARY_CHECK_BYTES];
    let Ok(n) = file.read(&mut buf) else {
        return false;
    };
    buf[..n].contains(&0)
}

// ---------------------------------------------------------------------------
// Cancellation support
// ---------------------------------------------------------------------------

/// A cancellation token for in-progress searches.
#[derive(Debug, Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Signal cancellation.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    /// Check if cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// Search result cache
// ---------------------------------------------------------------------------

/// Cached search results for avoiding redundant re-searches.
#[derive(Debug, Clone)]
pub struct SearchResultCache {
    pub query: String,
    pub options: SearchOptions,
    pub results: Vec<SearchResultGroup>,
    pub timestamp: Instant,
}

impl SearchResultCache {
    /// Check whether this cache entry matches the given query and options.
    pub fn matches(&self, query: &str, options: &SearchOptions) -> bool {
        self.query == query && self.options_match(options)
    }

    fn options_match(&self, other: &SearchOptions) -> bool {
        self.options.include_patterns == other.include_patterns
            && self.options.exclude_patterns == other.exclude_patterns
            && self.options.max_results == other.max_results
            && self.options.max_file_size == other.max_file_size
            && self.options.context_lines == other.context_lines
    }

    /// Returns the age of the cache entry in seconds.
    pub fn age_secs(&self) -> f64 {
        self.timestamp.elapsed().as_secs_f64()
    }
}

// ---------------------------------------------------------------------------
// Progress callback with richer info
// ---------------------------------------------------------------------------

/// Detailed search progress for UI display.
#[derive(Debug, Clone, Serialize)]
pub struct SearchProgressInfo {
    pub files_searched: u32,
    pub total_files: u32,
    pub matches_found: u32,
}

impl SearchProgressInfo {
    /// Returns a fraction (0.0 to 1.0) representing completion.
    #[allow(clippy::cast_precision_loss)]
    pub fn fraction(&self) -> f32 {
        if self.total_files == 0 {
            0.0
        } else {
            (self.files_searched as f32 / self.total_files as f32).min(1.0)
        }
    }
}

/// Callback type for detailed search progress updates.
pub type SearchProgressCallback = Arc<dyn Fn(&SearchProgressInfo) + Send + Sync>;

// ---------------------------------------------------------------------------
// Replace report
// ---------------------------------------------------------------------------

/// Report from a replace-in-files operation.
#[derive(Debug, Clone, Serialize)]
pub struct ReplaceReport {
    pub files_modified: u32,
    pub replacements_made: u32,
    pub errors: Vec<(PathBuf, String)>,
}

// ---------------------------------------------------------------------------
// Extended SearchEngine methods
// ---------------------------------------------------------------------------

impl SearchEngine {
    /// Search with cancellation support.
    #[allow(clippy::too_many_lines)]
    pub fn search_cancellable(
        root: &Path,
        query: &SearchQuery,
        options: &SearchOptions,
        token: &CancellationToken,
    ) -> WorkspaceResult<Vec<SearchResult>> {
        let max_results = options
            .max_results
            .or(query.max_results)
            .unwrap_or(DEFAULT_MAX_RESULTS);
        let max_file_size = options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE);
        let files = collect_files_with_options(root, options, max_file_size);

        let use_literal = !query.is_regex && query.case_sensitive && !query.whole_word;

        let literal_finder = if use_literal {
            Some(Arc::new(memmem::Finder::new(query.pattern.as_bytes())))
        } else {
            None
        };

        let re = if use_literal {
            None
        } else {
            let mut pat = if query.is_regex {
                query.pattern.clone()
            } else {
                regex::escape(&query.pattern)
            };
            if query.whole_word {
                pat = format!(r"\b{pat}\b");
            }
            Some(
                RegexBuilder::new(&pat)
                    .case_insensitive(!query.case_sensitive)
                    .build()?,
            )
        };

        let hit_count = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let cancel_flag = Arc::clone(&token.cancelled);

        let batches: Vec<Vec<SearchResult>> = files
            .par_iter()
            .filter_map(|path| {
                if done.load(Ordering::Relaxed) || cancel_flag.load(Ordering::Relaxed) {
                    return None;
                }

                let content = read_file_lossy(path)?;
                let path_buf = path.clone();
                let mut local = Vec::new();

                if let Some(ref finder) = literal_finder {
                    for (line_idx, line) in content.lines().enumerate() {
                        if cancel_flag.load(Ordering::Relaxed) {
                            break;
                        }
                        let bytes = line.as_bytes();
                        let mut start = 0;
                        while let Some(pos) = finder.find(&bytes[start..]) {
                            local.push(SearchResult {
                                path: path_buf.clone(),
                                line_number: line_idx + 1,
                                line_text: line.to_string(),
                                match_start: start + pos,
                                match_end: start + pos + query.pattern.len(),
                            });
                            start += pos + 1;
                            if hit_count.load(Ordering::Relaxed) + local.len() >= max_results {
                                break;
                            }
                        }
                    }
                } else if let Some(ref re) = re {
                    for (line_idx, line) in content.lines().enumerate() {
                        if cancel_flag.load(Ordering::Relaxed) {
                            break;
                        }
                        for m in re.find_iter(line) {
                            local.push(SearchResult {
                                path: path_buf.clone(),
                                line_number: line_idx + 1,
                                line_text: line.to_string(),
                                match_start: m.start(),
                                match_end: m.end(),
                            });
                            if hit_count.load(Ordering::Relaxed) + local.len() >= max_results {
                                break;
                            }
                        }
                    }
                }

                if local.is_empty() {
                    None
                } else {
                    let prev = hit_count.fetch_add(local.len(), Ordering::Relaxed);
                    if prev + local.len() >= max_results {
                        done.store(true, Ordering::Relaxed);
                        local.truncate(max_results.saturating_sub(prev));
                    }
                    Some(local)
                }
            })
            .collect();

        if token.is_cancelled() {
            return Ok(Vec::new());
        }

        let mut results = Vec::with_capacity(max_results);
        for batch in batches {
            let remaining = max_results.saturating_sub(results.len());
            if remaining == 0 {
                break;
            }
            results.extend(batch.into_iter().take(remaining));
        }

        Ok(results)
    }

    /// Search with a detailed progress callback that includes file/match counts.
    #[allow(clippy::too_many_lines)]
    pub fn search_with_detailed_progress(
        root: &Path,
        query: &SearchQuery,
        options: &SearchOptions,
        progress: &SearchProgressCallback,
        token: Option<&CancellationToken>,
    ) -> WorkspaceResult<Vec<SearchResult>> {
        let max_results = options
            .max_results
            .or(query.max_results)
            .unwrap_or(DEFAULT_MAX_RESULTS);
        let max_file_size = options.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE);
        let files = collect_files_with_options(root, options, max_file_size);

        #[allow(clippy::cast_possible_truncation)]
        let total_files = files.len() as u32;
        let files_searched = Arc::new(AtomicUsize::new(0));
        let matches_found = Arc::new(AtomicUsize::new(0));
        let cancel_flag = token.map(|t| Arc::clone(&t.cancelled));

        let use_literal = !query.is_regex && query.case_sensitive && !query.whole_word;

        let literal_finder = if use_literal {
            Some(Arc::new(memmem::Finder::new(query.pattern.as_bytes())))
        } else {
            None
        };

        let re = if use_literal {
            None
        } else {
            let mut pat = if query.is_regex {
                query.pattern.clone()
            } else {
                regex::escape(&query.pattern)
            };
            if query.whole_word {
                pat = format!(r"\b{pat}\b");
            }
            Some(
                RegexBuilder::new(&pat)
                    .case_insensitive(!query.case_sensitive)
                    .build()?,
            )
        };

        let done = Arc::new(AtomicBool::new(false));

        let batches: Vec<Vec<SearchResult>> = files
            .par_iter()
            .filter_map(|path| {
                if done.load(Ordering::Relaxed) {
                    return None;
                }
                if let Some(ref cf) = cancel_flag {
                    if cf.load(Ordering::Relaxed) {
                        return None;
                    }
                }

                let content = read_file_lossy(path)?;
                let path_buf = path.clone();
                let mut local = Vec::new();

                if let Some(ref finder) = literal_finder {
                    for (line_idx, line) in content.lines().enumerate() {
                        let bytes = line.as_bytes();
                        let mut start = 0;
                        while let Some(pos) = finder.find(&bytes[start..]) {
                            local.push(SearchResult {
                                path: path_buf.clone(),
                                line_number: line_idx + 1,
                                line_text: line.to_string(),
                                match_start: start + pos,
                                match_end: start + pos + query.pattern.len(),
                            });
                            start += pos + 1;
                        }
                    }
                } else if let Some(ref re) = re {
                    for (line_idx, line) in content.lines().enumerate() {
                        for m in re.find_iter(line) {
                            local.push(SearchResult {
                                path: path_buf.clone(),
                                line_number: line_idx + 1,
                                line_text: line.to_string(),
                                match_start: m.start(),
                                match_end: m.end(),
                            });
                        }
                    }
                }

                #[allow(clippy::cast_possible_truncation)]
                let searched = files_searched.fetch_add(1, Ordering::Relaxed) as u32 + 1;
                #[allow(clippy::cast_possible_truncation)]
                let found = if local.is_empty() {
                    matches_found.load(Ordering::Relaxed) as u32
                } else {
                    matches_found.fetch_add(local.len(), Ordering::Relaxed) as u32
                        + local.len() as u32
                };

                progress(&SearchProgressInfo {
                    files_searched: searched,
                    total_files,
                    matches_found: found,
                });

                if local.is_empty() {
                    None
                } else {
                    if matches_found.load(Ordering::Relaxed) >= max_results {
                        done.store(true, Ordering::Relaxed);
                        let excess = matches_found
                            .load(Ordering::Relaxed)
                            .saturating_sub(max_results);
                        if excess > 0 && local.len() > excess {
                            local.truncate(local.len() - excess);
                        }
                    }
                    Some(local)
                }
            })
            .collect();

        let mut results = Vec::with_capacity(max_results);
        for batch in batches {
            let remaining = max_results.saturating_sub(results.len());
            if remaining == 0 {
                break;
            }
            results.extend(batch.into_iter().take(remaining));
        }

        Ok(results)
    }

    /// Replace across files using a set of grouped search results, returning
    /// a detailed report.
    pub fn replace_in_files_with_report(
        root: &Path,
        query: &SearchQuery,
        replacement: &str,
    ) -> WorkspaceResult<ReplaceReport> {
        let replacements = Self::replace_in_files(root, query, replacement)?;
        let mut report = ReplaceReport {
            files_modified: 0,
            replacements_made: 0,
            errors: Vec::new(),
        };

        for file_rep in &replacements {
            let content = match fs::read_to_string(&file_rep.path) {
                Ok(c) => c,
                Err(e) => {
                    report.errors.push((file_rep.path.clone(), e.to_string()));
                    continue;
                }
            };

            let lines: Vec<&str> = content.lines().collect();
            let mut new_lines: Vec<String> = lines.iter().map(|l| (*l).to_string()).collect();

            let mut edit_count = 0u32;
            for edit in &file_rep.edits {
                let idx = edit.line_number.saturating_sub(1);
                if idx < new_lines.len() {
                    new_lines[idx].clone_from(&edit.replacement);
                    edit_count += 1;
                }
            }

            let new_content = new_lines.join("\n");
            let trailing = if content.ends_with('\n') { "\n" } else { "" };
            match fs::write(&file_rep.path, format!("{new_content}{trailing}")) {
                Ok(()) => {
                    report.files_modified += 1;
                    report.replacements_made += edit_count;
                }
                Err(e) => {
                    report.errors.push((file_rep.path.clone(), e.to_string()));
                }
            }
        }

        Ok(report)
    }

    /// Search with caching: returns cached results if the query/options haven't changed.
    pub fn search_cached(
        root: &Path,
        query: &SearchQuery,
        options: &SearchOptions,
        cache: &mut Option<SearchResultCache>,
        max_cache_age_secs: f64,
    ) -> WorkspaceResult<Vec<SearchResultGroup>> {
        if let Some(ref c) = cache {
            if c.matches(&query.pattern, options) && c.age_secs() < max_cache_age_secs {
                return Ok(c.results.clone());
            }
        }

        let results = Self::search_grouped(root, query, options)?;

        *cache = Some(SearchResultCache {
            query: query.pattern.clone(),
            options: options.clone(),
            results: results.clone(),
            timestamp: Instant::now(),
        });

        Ok(results)
    }
}

// ---------------------------------------------------------------------------
// Fuzzy file search (ported from src-tauri/src/commands/search.rs)
// ---------------------------------------------------------------------------

static ALWAYS_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    "out",
    "__pycache__",
    ".next",
    ".cache",
];

/// A file matched by fuzzy filename search.
#[derive(Debug, Clone, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub score: i64,
}

/// Options for fuzzy filename search.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FileSearchOptions {
    pub max_results: Option<usize>,
    pub include_hidden: Option<bool>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
}

fn should_skip_entry(entry: &walkdir::DirEntry, include_hidden: bool) -> bool {
    let name = entry.file_name().to_string_lossy();
    if !include_hidden && name.starts_with('.') {
        return true;
    }
    if entry.file_type().is_dir() && ALWAYS_SKIP_DIRS.contains(&name.as_ref()) {
        return true;
    }
    false
}

fn build_globset(patterns: &[String]) -> Option<globset::GlobSet> {
    if patterns.is_empty() {
        return None;
    }
    let mut builder = globset::GlobSetBuilder::new();
    for p in patterns {
        if let Ok(g) = globset::Glob::new(p) {
            builder.add(g);
        }
    }
    builder.build().ok()
}

#[allow(clippy::cast_possible_wrap)]
fn fuzzy_score(pattern: &[u8], target: &str) -> Option<i64> {
    if pattern.is_empty() {
        return Some(0);
    }
    let target_bytes = target.as_bytes();
    let mut pi = 0;
    let mut score: i64 = 0;
    let mut consecutive = 0i64;
    let mut prev_match = false;

    for (ti, &tc) in target_bytes.iter().enumerate() {
        if pi < pattern.len() && tc.eq_ignore_ascii_case(&pattern[pi]) {
            score += 1;
            if ti == 0 || !target_bytes[ti - 1].is_ascii_alphanumeric() {
                score += 5;
            }
            if tc == pattern[pi] {
                score += 1;
            }
            if prev_match {
                consecutive += 1;
                score += consecutive * 2;
            } else {
                consecutive = 0;
            }
            prev_match = true;
            pi += 1;
        } else {
            prev_match = false;
            consecutive = 0;
        }
    }

    if pi == pattern.len() {
        let len_penalty = (target_bytes.len() as i64 - pattern.len() as i64).min(20);
        Some(score * 100 - len_penalty)
    } else {
        None
    }
}

/// Fuzzy-search for files by name under `root`.
pub fn search_files(
    root: &Path,
    pattern: &str,
    options: Option<&FileSearchOptions>,
) -> Vec<FileMatch> {
    let max_results = options
        .and_then(|o| o.max_results)
        .unwrap_or(DEFAULT_MAX_RESULTS);
    let include_hidden = options.and_then(|o| o.include_hidden).unwrap_or(false);
    let include_set = options.and_then(|o| o.include.as_deref()).and_then(|v| {
        if v.is_empty() {
            None
        } else {
            build_globset(v)
        }
    });
    let exclude_set = options.and_then(|o| o.exclude.as_deref()).and_then(|v| {
        if v.is_empty() {
            None
        } else {
            build_globset(v)
        }
    });

    let pattern_bytes = pattern.as_bytes().to_vec();
    let mut scored: Vec<FileMatch> = Vec::with_capacity(max_results * 2);

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(20)
        .into_iter()
        .filter_entry(|e| !should_skip_entry(e, include_hidden))
        .filter_map(std::result::Result::ok)
    {
        if entry.file_type().is_dir() {
            continue;
        }

        let path = entry.path();

        if let Some(ref inc) = include_set {
            if !inc.is_match(path) {
                continue;
            }
        }
        if let Some(ref exc) = exclude_set {
            if exc.is_match(path) {
                continue;
            }
        }

        let name = entry.file_name().to_string_lossy();
        let Some(score) = fuzzy_score(&pattern_bytes, &name) else {
            continue;
        };

        scored.push(FileMatch {
            path: path.to_string_lossy().into_owned(),
            name: name.into_owned(),
            score,
        });
    }

    scored.sort_unstable_by(|a, b| b.score.cmp(&a.score));
    scored.truncate(max_results);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("hello.rs"),
            "fn main() {\n    println!(\"Hello\");\n}\n",
        )
        .unwrap();
        fs::write(tmp.path().join("notes.txt"), "Hello world\nhello again\n").unwrap();
        tmp
    }

    #[test]
    fn case_sensitive_search() {
        let tmp = setup();
        let query = SearchQuery {
            pattern: "Hello".to_string(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let results = SearchEngine::search(tmp.path(), &query).unwrap();
        assert!(results.len() >= 2, "should match both files");
        assert!(results.iter().all(|r| r.line_text.contains("Hello")));
    }

    #[test]
    fn case_insensitive_search() {
        let tmp = setup();
        let query = SearchQuery {
            pattern: "hello".to_string(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            max_results: None,
        };
        let results = SearchEngine::search(tmp.path(), &query).unwrap();
        assert!(results.len() >= 3, "should find both casings");
    }

    #[test]
    fn regex_search() {
        let tmp = setup();
        let query = SearchQuery {
            pattern: r"fn\s+\w+".to_string(),
            is_regex: true,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let results = SearchEngine::search(tmp.path(), &query).unwrap();
        assert!(!results.is_empty());
    }

    #[test]
    fn search_replace_preview() {
        let tmp = setup();
        let query = SearchQuery {
            pattern: "Hello".to_string(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let edits = SearchEngine::search_replace(tmp.path(), &query, "Goodbye").unwrap();
        assert!(!edits.is_empty());
        for edit in &edits {
            assert!(edit.replaced.contains("Goodbye"));
            assert!(!edit.replaced.contains("Hello"));
        }
    }

    #[test]
    fn binary_files_are_skipped() {
        let tmp = TempDir::new().unwrap();
        let mut data = vec![0u8; 128];
        data[0] = 0;
        fs::write(tmp.path().join("binary.bin"), &data).unwrap();
        fs::write(tmp.path().join("text.txt"), "needle").unwrap();

        let query = SearchQuery {
            pattern: "needle".to_string(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let results = SearchEngine::search(tmp.path(), &query).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("text.txt"));
    }

    #[test]
    fn search_with_include_pattern() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.rs"), "needle").unwrap();
        fs::write(tmp.path().join("b.txt"), "needle").unwrap();

        let query = SearchQuery {
            pattern: "needle".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let options = SearchOptions {
            include_patterns: vec!["*.rs".into()],
            ..Default::default()
        };
        let results = SearchEngine::search_with_options(tmp.path(), &query, &options).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("a.rs"));
    }

    #[test]
    fn search_with_exclude_pattern() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.rs"), "needle").unwrap();
        fs::write(tmp.path().join("b.txt"), "needle").unwrap();

        let query = SearchQuery {
            pattern: "needle".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let options = SearchOptions {
            exclude_patterns: vec!["*.txt".into()],
            ..Default::default()
        };
        let results = SearchEngine::search_with_options(tmp.path(), &query, &options).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].path.ends_with("a.rs"));
    }

    #[test]
    fn search_grouped_with_context() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("test.rs"),
            "line 1\nline 2\nneedle here\nline 4\nline 5\n",
        )
        .unwrap();

        let query = SearchQuery {
            pattern: "needle".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let options = SearchOptions {
            context_lines: Some(1),
            ..Default::default()
        };
        let groups = SearchEngine::search_grouped(tmp.path(), &query, &options).unwrap();
        assert_eq!(groups.len(), 1);
        let group = &groups[0];
        assert_eq!(group.matches.len(), 1);
        let m = &group.matches[0];
        assert_eq!(m.line_number, 3);
        assert_eq!(m.before_context.len(), 1);
        assert_eq!(m.before_context[0].text, "line 2");
        assert_eq!(m.after_context.len(), 1);
        assert_eq!(m.after_context[0].text, "line 4");
    }

    #[test]
    fn replace_in_files_grouped() {
        let tmp = setup();
        let query = SearchQuery {
            pattern: "Hello".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let replacements = SearchEngine::replace_in_files(tmp.path(), &query, "Goodbye").unwrap();
        assert!(!replacements.is_empty());
        for fr in &replacements {
            assert!(!fr.edits.is_empty());
            for edit in &fr.edits {
                assert!(edit.replacement.contains("Goodbye"));
            }
        }
    }

    #[test]
    fn apply_replacements_modifies_disk() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("test.txt"), "hello world\n").unwrap();

        let query = SearchQuery {
            pattern: "hello".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let replacements = SearchEngine::replace_in_files(tmp.path(), &query, "goodbye").unwrap();
        let modified = SearchEngine::apply_replacements(&replacements).unwrap();
        assert_eq!(modified.len(), 1);

        let content = fs::read_to_string(tmp.path().join("test.txt")).unwrap();
        assert!(content.contains("goodbye"));
        assert!(!content.contains("hello"));
    }

    #[test]
    fn search_with_progress_callback() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "needle\n").unwrap();

        let count = Arc::new(AtomicUsize::new(0));
        let count_clone = Arc::clone(&count);
        let progress: SearchProgress = Arc::new(move |_result| {
            count_clone.fetch_add(1, Ordering::Relaxed);
        });

        let query = SearchQuery {
            pattern: "needle".into(),
            is_regex: false,
            case_sensitive: true,
            whole_word: false,
            max_results: None,
        };
        let results = SearchEngine::search_with_progress(
            tmp.path(),
            &query,
            &SearchOptions::default(),
            progress,
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn fuzzy_file_search() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("main.rs"), "").unwrap();
        fs::write(tmp.path().join("utils.rs"), "").unwrap();
        fs::write(tmp.path().join("readme.md"), "").unwrap();

        let opts = FileSearchOptions {
            include_hidden: Some(true),
            ..Default::default()
        };
        let results = search_files(tmp.path(), "main", Some(&opts));
        assert!(!results.is_empty());
        assert_eq!(results[0].name, "main.rs");
    }

    #[test]
    fn fuzzy_score_exact_match() {
        let score = fuzzy_score(b"main", "main.rs");
        assert!(score.is_some());
        assert!(score.unwrap() > 0);
    }

    #[test]
    fn fuzzy_score_no_match() {
        let score = fuzzy_score(b"xyz", "main.rs");
        assert!(score.is_none());
    }

    #[test]
    fn lossy_read_non_utf8() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("latin1.txt");
        fs::write(&path, b"caf\xe9 needle").unwrap();
        let content = read_file_lossy(&path);
        assert!(content.is_some());
        assert!(content.unwrap().contains("needle"));
    }

    #[test]
    fn search_options_default() {
        let opts = SearchOptions::default();
        assert!(opts.include_patterns.is_empty());
        assert!(opts.exclude_patterns.is_empty());
        assert!(opts.max_results.is_none());
        assert!(opts.context_lines.is_none());
    }

    #[test]
    fn context_line_serde() {
        let cl = ContextLine {
            line_number: 5,
            text: "some line".into(),
        };
        let json = serde_json::to_string(&cl).unwrap();
        assert!(json.contains("some line"));
    }

    #[test]
    fn file_replacement_serde() {
        let fr = FileReplacement {
            path: PathBuf::from("/test.rs"),
            edits: vec![ReplacementEdit {
                line_number: 1,
                match_start: 0,
                match_end: 5,
                original: "hello".into(),
                replacement: "world".into(),
            }],
        };
        let json = serde_json::to_string(&fr).unwrap();
        assert!(json.contains("world"));
    }
}
