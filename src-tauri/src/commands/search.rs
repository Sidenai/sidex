use globset::{Glob, GlobSet, GlobSetBuilder};
use rayon::prelude::*;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::{Arc, Mutex};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub score: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextMatch {
    pub path: String,
    pub line_number: usize,
    pub line_content: String,
    pub column: usize,
    pub match_length: usize,
}

#[derive(Debug, Deserialize)]
pub struct SearchFileOptions {
    pub max_results: Option<usize>,
    pub include_hidden: Option<bool>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct SearchTextOptions {
    pub max_results: Option<usize>,
    pub case_sensitive: Option<bool>,
    pub is_regex: Option<bool>,
    pub include_hidden: Option<bool>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
    pub max_file_size: Option<u64>,
}

const DEFAULT_MAX_RESULTS: usize = 500;
const DEFAULT_MAX_FILE_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

static ALWAYS_SKIP: &[&str] = &[
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

fn build_globset(patterns: &[String]) -> Option<GlobSet> {
    if patterns.is_empty() {
        return None;
    }
    let mut builder = GlobSetBuilder::new();
    for p in patterns {
        if let Ok(g) = Glob::new(p) {
            builder.add(g);
        }
    }
    builder.build().ok()
}

fn should_skip(entry: &walkdir::DirEntry, include_hidden: bool) -> bool {
    let name = entry.file_name().to_string_lossy();
    if !include_hidden && name.starts_with('.') {
        return true;
    }
    if entry.file_type().is_dir() && ALWAYS_SKIP.contains(&name.as_ref()) {
        return true;
    }
    false
}

fn fuzzy_score(pattern: &str, target: &str) -> Option<i64> {
    if pattern.is_empty() {
        return Some(0);
    }
    let pat: Vec<char> = pattern.chars().collect();
    let tgt: Vec<char> = target.chars().collect();
    let mut pi = 0;
    let mut score: i64 = 0;
    let mut prev_match = false;
    let mut consecutive = 0i64;

    for (ti, &tc) in tgt.iter().enumerate() {
        if pi < pat.len() && tc.to_ascii_lowercase() == pat[pi].to_ascii_lowercase() {
            score += 1;
            if ti == 0 || !tgt[ti - 1].is_alphanumeric() {
                score += 5; // word boundary
            }
            if tc == pat[pi] {
                score += 1; // exact case
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

    if pi == pat.len() {
        let len_penalty = (tgt.len() as i64 - pat.len() as i64).min(20);
        Some(score * 100 - len_penalty)
    } else {
        None
    }
}

#[tauri::command]
pub fn search_files(
    root: String,
    pattern: String,
    options: Option<SearchFileOptions>,
) -> Result<Vec<FileMatch>, String> {
    let max_results = options.as_ref().and_then(|o| o.max_results).unwrap_or(DEFAULT_MAX_RESULTS);
    let include_hidden = options.as_ref().and_then(|o| o.include_hidden).unwrap_or(false);
    let include_set = options.as_ref()
        .and_then(|o| o.include.as_deref())
        .and_then(|v| if v.is_empty() { None } else { Some(build_globset(v)) })
        .flatten();
    let exclude_set = options.as_ref()
        .and_then(|o| o.exclude.as_deref())
        .and_then(|v| if v.is_empty() { None } else { Some(build_globset(v)) })
        .flatten();

    let mut scored: Vec<FileMatch> = Vec::new();

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .max_depth(20)
        .into_iter()
        .filter_entry(|e| !should_skip(e, include_hidden))
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() {
            continue;
        }

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

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

        let score = match fuzzy_score(&pattern, &name) {
            Some(s) => s,
            None => continue,
        };

        scored.push(FileMatch {
            path: path.to_string_lossy().to_string(),
            name,
            score,
        });
    }

    scored.sort_by(|a, b| b.score.cmp(&a.score));
    scored.truncate(max_results);
    Ok(scored)
}

#[tauri::command]
pub fn search_text(
    root: String,
    query: String,
    options: Option<SearchTextOptions>,
) -> Result<Vec<TextMatch>, String> {
    let max_results = options.as_ref().and_then(|o| o.max_results).unwrap_or(DEFAULT_MAX_RESULTS);
    let case_sensitive = options.as_ref().and_then(|o| o.case_sensitive).unwrap_or(false);
    let is_regex = options.as_ref().and_then(|o| o.is_regex).unwrap_or(false);
    let include_hidden = options.as_ref().and_then(|o| o.include_hidden).unwrap_or(false);
    let max_file_size = options.as_ref().and_then(|o| o.max_file_size).unwrap_or(DEFAULT_MAX_FILE_SIZE);
    let include_set = options.as_ref()
        .and_then(|o| o.include.as_deref())
        .and_then(|v| if v.is_empty() { None } else { Some(build_globset(v)) })
        .flatten();
    let exclude_set = options.as_ref()
        .and_then(|o| o.exclude.as_deref())
        .and_then(|v| if v.is_empty() { None } else { Some(build_globset(v)) })
        .flatten();

    let pattern = if is_regex {
        query.clone()
    } else {
        regex::escape(&query)
    };

    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid search pattern: {e}"))?;

    let files: Vec<_> = WalkDir::new(&root)
        .follow_links(false)
        .max_depth(20)
        .into_iter()
        .filter_entry(|e| !should_skip(e, include_hidden))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let path = e.path();
            if let Some(ref inc) = include_set {
                if !inc.is_match(path) {
                    return false;
                }
            }
            if let Some(ref exc) = exclude_set {
                if exc.is_match(path) {
                    return false;
                }
            }
            if let Ok(meta) = e.metadata() {
                if meta.len() > max_file_size {
                    return false;
                }
            }
            true
        })
        .collect();

    let results = Arc::new(Mutex::new(Vec::<TextMatch>::new()));

    files.par_iter().for_each(|entry| {
        {
            let r = results.lock().unwrap();
            if r.len() >= max_results {
                return;
            }
        }

        let content = match fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => return,
        };

        let path_str = entry.path().to_string_lossy().to_string();

        for (line_idx, line) in content.lines().enumerate() {
            let mut r = results.lock().unwrap();
            if r.len() >= max_results {
                break;
            }
            for m in re.find_iter(line) {
                r.push(TextMatch {
                    path: path_str.clone(),
                    line_number: line_idx + 1,
                    line_content: line.to_string(),
                    column: m.start(),
                    match_length: m.end() - m.start(),
                });
                if r.len() >= max_results {
                    break;
                }
            }
        }
    });

    Ok(Arc::try_unwrap(results).unwrap().into_inner().unwrap())
}
