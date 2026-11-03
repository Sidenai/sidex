use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticEditResponse {
    pub success: bool,
    pub diff: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditPair {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiEditResponse {
    pub applied: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolInfo {
    pub file: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallerInfo {
    pub file: String,
    pub line: usize,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnderstandSymbolResponse {
    pub definition: Option<SymbolInfo>,
    pub type_info: Option<String>,
    pub docstring: Option<String>,
    pub callers: Vec<CallerInfo>,
    pub references: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffPreviewResponse {
    pub found: bool,
    pub unified_diff: String,
    pub context_before: String,
    pub context_after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchReadResult {
    pub path: String,
    pub content: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchReadResponse {
    pub results: Vec<BatchReadResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSearchResult {
    pub file: String,
    pub line: usize,
    pub score: f64,
    pub snippet: String,
    pub symbol: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSearchResponse {
    pub results: Vec<ContextSearchResult>,
    pub search_mode: String,
    pub total_candidates: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointResponse {
    pub label: String,
    pub files_saved: usize,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackResponse {
    pub label: String,
    pub files_restored: usize,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorAnalysis {
    pub diagnosis: String,
    pub suggested_fix: Option<String>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct CheckpointEntry {
    label: String,
    timestamp: u64,
    files: HashMap<String, String>,
    /// Files that did not exist when first tracked after this checkpoint —
    /// rolling back deletes them instead of writing empty content.
    created: Vec<String>,
}

pub struct CheckpointStore {
    entries: Mutex<Vec<CheckpointEntry>>,
    dirty_files: Mutex<HashSet<String>>,
}

/// Snapshots larger than this are skipped: checkpointing exists for source
/// files, and unbounded reads on the tool hot path stall the runtime.
const MAX_SNAPSHOT_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB

/// Retain at most this many checkpoint entries (oldest dropped first).
const MAX_CHECKPOINT_ENTRIES: usize = 20;

impl CheckpointStore {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            dirty_files: Mutex::new(HashSet::new()),
        }
    }

    /// Record that `path` is about to be modified. Must be called BEFORE the
    /// write. Copy-on-write: the file's pre-edit content is snapshotted into
    /// the most recent checkpoint the first time it's touched after that
    /// checkpoint, so rollback can actually restore it.
    ///
    /// File I/O happens BEFORE any lock is taken so a slow disk or large file
    /// never blocks concurrent checkpoint operations. Callers should invoke
    /// this from a blocking-capable thread (e.g. inside `spawn_blocking`).
    pub fn track_modified(&self, path: &str) {
        // Decide whether a snapshot is even needed (cheap lock, no I/O).
        let needs_snapshot = {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            match entries.last() {
                Some(last) => {
                    !last.files.contains_key(path) && !last.created.contains(&path.to_string())
                }
                None => false,
            }
        };

        // Perform all file I/O without holding any lock.
        let snapshot: Option<Option<String>> = if needs_snapshot {
            match std::fs::metadata(path) {
                Ok(meta) if meta.len() > MAX_SNAPSHOT_BYTES => None, // too big — skip silently
                Ok(_) => match std::fs::read_to_string(path) {
                    Ok(content) => Some(Some(content)),
                    Err(_) => Some(None), // unreadable as text — treat as created
                },
                Err(_) => Some(None), // doesn't exist — being created
            }
        } else {
            None
        };

        {
            let mut dirty = self.dirty_files.lock().unwrap_or_else(|e| e.into_inner());
            dirty.insert(path.to_string());
        }

        if let Some(content) = snapshot {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(last) = entries.last_mut() {
                // Re-check: another thread may have snapshotted meanwhile.
                if !last.files.contains_key(path) && !last.created.contains(&path.to_string()) {
                    match content {
                        Some(c) => {
                            last.files.insert(path.to_string(), c);
                        }
                        None => {
                            last.created.push(path.to_string());
                        }
                    }
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn detect_language(path: &str) -> &str {
    match Path::new(path).extension().and_then(|e| e.to_str()) {
        Some("rs") => "rust",
        Some("ts") | Some("tsx") => "typescript",
        Some("js") | Some("jsx") => "javascript",
        Some("py") => "python",
        Some("go") => "go",
        Some("java") => "java",
        Some("c") | Some("h") => "c",
        Some("cpp") | Some("cc") | Some("hpp") => "cpp",
        _ => "unknown",
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn semantic_edit(
    checkpoint_state: State<'_, CheckpointStore>,
    path: String,
    instruction: String,
    scope: Option<String>,
    language: Option<String>,
) -> Result<SemanticEditResponse, String> {
    let lang = language.unwrap_or_else(|| detect_language(&path).to_string());
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Cannot read {}: {}", path, e))?;

    let scope_filter = scope.unwrap_or_default();
    let target_section = if scope_filter.is_empty() {
        content.clone()
    } else {
        find_scope_section(&content, &scope_filter, &lang).unwrap_or_else(|| content.clone())
    };

    let edited = apply_structural_edit(&target_section, &instruction, &lang);
    if edited == target_section {
        return Ok(SemanticEditResponse {
            success: false,
            diff: String::new(),
            error: Some("No changes produced by semantic edit".into()),
        });
    }

    let new_content = content.replace(&target_section, &edited);
    let diff = generate_unified_diff(&content, &new_content, &path);

    checkpoint_state.track_modified(&path);
    tokio::fs::write(&path, &new_content)
        .await
        .map_err(|e| format!("Failed to write {}: {}", path, e))?;

    Ok(SemanticEditResponse {
        success: true,
        diff,
        error: None,
    })
}

#[tauri::command]
pub async fn multi_edit_file(
    checkpoint_state: State<'_, CheckpointStore>,
    path: String,
    edits: Vec<EditPair>,
) -> Result<MultiEditResponse, String> {
    let mut content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Cannot read {}: {}", path, e))?;

    let original = content.clone();
    let mut applied = 0;
    let mut errors = Vec::new();

    for edit in &edits {
        if content.contains(&edit.old_text) {
            content = content.replacen(&edit.old_text, &edit.new_text, 1);
            applied += 1;
        } else {
            errors.push(format!("Not found: {:?}", truncate_str(&edit.old_text, 60)));
        }
    }

    if applied == 0 {
        return Ok(MultiEditResponse {
            applied: 0,
            failed: edits.len(),
            errors,
        });
    }

    if applied > 0 && errors.is_empty() {
        checkpoint_state.track_modified(&path);
        tokio::fs::write(&path, &content)
            .await
            .map_err(|e| format!("Failed to write: {}", e))?;
    } else if applied > 0 {
        // Partial success: roll back, only apply successful ones atomically
        let mut retry_content = original;
        for edit in &edits {
            if retry_content.contains(&edit.old_text) {
                retry_content = retry_content.replacen(&edit.old_text, &edit.new_text, 1);
            }
        }
        checkpoint_state.track_modified(&path);
        tokio::fs::write(&path, &retry_content)
            .await
            .map_err(|e| format!("Failed to write: {}", e))?;
    }

    Ok(MultiEditResponse {
        applied,
        failed: errors.len(),
        errors,
    })
}

#[tauri::command]
pub async fn understand_symbol(
    symbol: String,
    path: Option<String>,
    include_callers: Option<bool>,
    include_type_info: Option<bool>,
) -> Result<UnderstandSymbolResponse, String> {
    let search_path = path.unwrap_or_else(|| ".".into());
    let include_callers = include_callers.unwrap_or(true);

    // Find definition using ripgrep
    let def_output = tokio::process::Command::new("rg")
        .args(["--max-count=1", "--line-number", "--no-heading", "-e"])
        .arg(format!(
            r"(fn|function|class|struct|type|interface|def|const|let|var)\s+{}\b",
            symbol
        ))
        .arg(&search_path)
        .output()
        .await
        .map_err(|e| format!("ripgrep failed: {}", e))?;

    let def_str = String::from_utf8_lossy(&def_output.stdout);
    let definition = parse_first_match(&def_str);

    // Find callers/references
    let mut callers = Vec::new();
    let mut references = 0;
    if include_callers {
        let ref_output = tokio::process::Command::new("rg")
            .args(["--max-count=20", "--line-number", "--no-heading", "-e"])
            .arg(format!(r"\b{}\b", symbol))
            .arg(&search_path)
            .output()
            .await
            .map_err(|e| format!("ripgrep failed: {}", e))?;

        let ref_str = String::from_utf8_lossy(&ref_output.stdout);
        for line in ref_str.lines() {
            references += 1;
            if callers.len() < 10 {
                if let Some(caller) = parse_reference_line(line) {
                    callers.push(caller);
                }
            }
        }
    }

    // Extract docstring from definition context
    let docstring = if let Some(ref def) = definition {
        extract_docstring(&def.file, def.line).await
    } else {
        None
    };

    let type_info = if include_type_info.unwrap_or(true) {
        definition.as_ref().map(|d| d.text.clone())
    } else {
        None
    };

    Ok(UnderstandSymbolResponse {
        definition,
        type_info,
        docstring,
        callers,
        references,
    })
}

#[tauri::command]
pub async fn diff_preview(
    path: String,
    old_str: String,
    new_str: String,
) -> Result<DiffPreviewResponse, String> {
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Cannot read {}: {}", path, e))?;

    if !content.contains(&old_str) {
        return Ok(DiffPreviewResponse {
            found: false,
            unified_diff: String::new(),
            context_before: String::new(),
            context_after: String::new(),
        });
    }

    let new_content = content.replacen(&old_str, &new_str, 1);
    let diff = generate_unified_diff(&content, &new_content, &path);

    Ok(DiffPreviewResponse {
        found: true,
        unified_diff: diff,
        context_before: String::new(),
        context_after: String::new(),
    })
}

#[tauri::command]
pub async fn batch_read_files(
    paths: Vec<String>,
    _format: Option<String>,
    max_lines_per_file: Option<usize>,
) -> Result<BatchReadResponse, String> {
    let max_lines = max_lines_per_file.unwrap_or(500);
    let mut results = Vec::with_capacity(paths.len());

    for p in &paths {
        match tokio::fs::read_to_string(p).await {
            Ok(content) => {
                let truncated: String = content
                    .lines()
                    .take(max_lines)
                    .collect::<Vec<_>>()
                    .join("\n");
                let was_truncated = content.lines().count() > max_lines;
                let final_content = if was_truncated {
                    format!("{}\n[... truncated at {} lines]", truncated, max_lines)
                } else {
                    truncated
                };
                results.push(BatchReadResult {
                    path: p.clone(),
                    content: Some(final_content),
                    error: None,
                });
            }
            Err(e) => {
                results.push(BatchReadResult {
                    path: p.clone(),
                    content: None,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    Ok(BatchReadResponse { results })
}

#[tauri::command]
pub async fn context_search(
    query: String,
    path: Option<String>,
    max_results: Option<usize>,
    mode: Option<String>,
) -> Result<ContextSearchResponse, String> {
    let search_path = path.unwrap_or_else(|| ".".into());
    let max = max_results.unwrap_or(15);
    let mode_str = mode.unwrap_or_else(|| "hybrid".into());

    // BM25-style: use ripgrep with relevance
    let keywords: Vec<&str> = query.split_whitespace().collect();
    let pattern = keywords.join("|");

    let output = tokio::process::Command::new("rg")
        .args([
            "--line-number",
            "--no-heading",
            "--max-count=100",
            "-i",
            "-e",
        ])
        .arg(&pattern)
        .arg(&search_path)
        .output()
        .await
        .map_err(|e| format!("Search failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let total_candidates = stdout.lines().count();

    let mut scored_results: Vec<ContextSearchResult> = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, ':').collect();
            if parts.len() < 3 {
                return None;
            }
            let file = parts[0].to_string();
            let line_num = parts[1].parse::<usize>().unwrap_or(0);
            let snippet = parts[2].to_string();

            // Simple BM25-like scoring: count keyword hits
            let score = keywords
                .iter()
                .filter(|kw| snippet.to_lowercase().contains(&kw.to_lowercase()))
                .count() as f64
                / keywords.len().max(1) as f64;

            Some(ContextSearchResult {
                file,
                line: line_num,
                score,
                snippet,
                symbol: None,
                kind: None,
            })
        })
        .collect();

    scored_results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored_results.truncate(max);

    Ok(ContextSearchResponse {
        results: scored_results,
        search_mode: mode_str,
        total_candidates,
    })
}

#[tauri::command]
pub async fn checkpoint_create(
    state: State<'_, CheckpointStore>,
    label: Option<String>,
) -> Result<CheckpointResponse, String> {
    let label = label.unwrap_or_else(|| format!("checkpoint-{}", now_ms()));

    // Transfer ownership of the dirty set to this checkpoint: snapshot the
    // currently-dirty files eagerly, then CLEAR the set so future checkpoints
    // don't re-read and re-store every file ever touched in the session.
    // Files modified after this checkpoint are captured lazily by
    // track_modified's copy-on-write.
    let dirty: Vec<String> = {
        let mut d = state.dirty_files.lock().unwrap_or_else(|e| e.into_inner());
        let taken: Vec<String> = d.iter().cloned().collect();
        d.clear();
        taken
    };

    let mut files = HashMap::new();
    for path in &dirty {
        if let Ok(meta) = tokio::fs::metadata(path).await {
            if meta.len() > MAX_SNAPSHOT_BYTES {
                continue;
            }
        }
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            files.insert(path.clone(), content);
        }
    }

    let files_saved = files.len();
    let timestamp = now_ms();
    let entry = CheckpointEntry {
        label: label.clone(),
        timestamp,
        files,
        created: Vec::new(),
    };

    let mut entries = state.entries.lock().unwrap_or_else(|e| e.into_inner());
    entries.push(entry);
    // Bound memory: drop the oldest checkpoints beyond the retention cap.
    if entries.len() > MAX_CHECKPOINT_ENTRIES {
        let excess = entries.len() - MAX_CHECKPOINT_ENTRIES;
        entries.drain(0..excess);
    }

    Ok(CheckpointResponse {
        label,
        files_saved,
        timestamp,
    })
}

#[tauri::command]
pub async fn checkpoint_rollback(
    state: State<'_, CheckpointStore>,
    label: Option<String>,
) -> Result<RollbackResponse, String> {
    let entry = {
        let entries = state.entries.lock().unwrap_or_else(|e| e.into_inner());
        let found = if let Some(lbl) = &label {
            entries.iter().rev().find(|e| e.label == *lbl).cloned()
        } else {
            entries.last().cloned()
        };
        found.ok_or("No checkpoint found")?
    };

    let mut restored = 0;
    for (path, content) in &entry.files {
        if tokio::fs::write(path, content).await.is_ok() {
            restored += 1;
        }
    }
    // Files created after the checkpoint are removed on rollback.
    for path in &entry.created {
        if tokio::fs::remove_file(path).await.is_ok() {
            restored += 1;
        }
    }

    // Remove checkpoints up to and including the one we rolled back to
    {
        let mut entries = state.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(idx) = entries.iter().position(|e| e.label == entry.label) {
            entries.truncate(idx);
        }
    }

    Ok(RollbackResponse {
        label: entry.label,
        files_restored: restored,
        timestamp: entry.timestamp,
    })
}

#[tauri::command]
pub async fn analyze_error(
    command: String,
    output: String,
    exit_code: i32,
) -> Result<ErrorAnalysis, String> {
    let diagnosis = if output.contains("ModuleNotFoundError") || output.contains("ImportError") {
        format!("Missing import/module. A required dependency is not installed or the import path is wrong.")
    } else if output.contains("SyntaxError") {
        "Syntax error in the code. Check for unclosed brackets, missing colons, or invalid tokens."
            .into()
    } else if output.contains("TypeError") {
        "Type mismatch. A function received an argument of the wrong type or wrong number of arguments.".into()
    } else if output.contains("AssertionError") {
        "Assertion failed. The test's expected value doesn't match the actual output.".into()
    } else if output.contains("Permission denied") {
        "Permission denied. The process lacks access to a file or resource.".into()
    } else if output.contains("No such file") || output.contains("ENOENT") {
        "File not found. A referenced file or directory does not exist.".into()
    } else {
        format!("Command '{}' exited with code {}.", command, exit_code)
    };

    let suggested_fix = if output.contains("ModuleNotFoundError") {
        let module = output
            .lines()
            .find(|l| l.contains("ModuleNotFoundError"))
            .and_then(|l| l.split('\'').nth(1))
            .unwrap_or("unknown");
        Some(format!("pip install {}", module))
    } else {
        None
    };

    Ok(ErrorAnalysis {
        diagnosis,
        suggested_fix,
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn find_scope_section(content: &str, scope: &str, _lang: &str) -> Option<String> {
    let parts: Vec<&str> = scope.splitn(2, ':').collect();
    if parts.len() != 2 {
        return None;
    }
    let (kind, name) = (parts[0], parts[1]);

    let pattern = match kind {
        "function" | "fn" => format!(r"(pub\s+)?(async\s+)?fn\s+{}\b", name),
        "class" | "struct" => format!(r"(pub\s+)?(struct|class|interface)\s+{}\b", name),
        "method" | "def" => format!(r"(pub\s+)?(async\s+)?(fn|def|function)\s+{}\b", name),
        _ => format!(r"\b{}\b", name),
    };

    let re = regex::Regex::new(&pattern).ok()?;
    let mat = re.find(content)?;
    let start = content[..mat.start()].rfind('\n').map_or(0, |i| i + 1);

    // Find the end of the block by brace counting
    let mut depth = 0;
    let mut end = mat.end();
    let bytes = content.as_bytes();
    let mut found_open = false;

    while end < bytes.len() {
        match bytes[end] {
            b'{' => {
                depth += 1;
                found_open = true;
            }
            b'}' => {
                depth -= 1;
                if found_open && depth == 0 {
                    end += 1;
                    break;
                }
            }
            _ => {}
        }
        end += 1;
    }

    Some(content[start..end].to_string())
}

fn apply_structural_edit(section: &str, instruction: &str, _lang: &str) -> String {
    let instruction_lower = instruction.to_lowercase();

    if instruction_lower.contains("add parameter") || instruction_lower.contains("add param") {
        if let Some(param) = extract_quoted(instruction) {
            return add_parameter_to_function(section, &param);
        }
    }

    if instruction_lower.contains("wrap") && instruction_lower.contains("try") {
        return wrap_in_try_catch(section, _lang);
    }

    if instruction_lower.contains("add import") || instruction_lower.contains("add use") {
        if let Some(import_line) = extract_quoted(instruction) {
            return format!("{}\n{}", import_line, section);
        }
    }

    section.to_string()
}

fn add_parameter_to_function(section: &str, param: &str) -> String {
    if let Some(paren_open) = section.find('(') {
        if let Some(paren_close) = section[paren_open..].find(')') {
            let abs_close = paren_open + paren_close;
            let existing_params = section[paren_open + 1..abs_close].trim();
            let new_params = if existing_params.is_empty() {
                param.to_string()
            } else {
                format!("{}, {}", existing_params, param)
            };
            return format!(
                "{}({}){}",
                &section[..paren_open],
                new_params,
                &section[abs_close + 1..]
            );
        }
    }
    section.to_string()
}

fn wrap_in_try_catch(section: &str, lang: &str) -> String {
    let indent = section
        .lines()
        .find(|l| l.contains('{'))
        .map(|l| {
            let trimmed = l.trim_start();
            &l[..l.len() - trimmed.len()]
        })
        .unwrap_or("");

    let body_indent = format!("{}    ", indent);

    match lang {
        "rust" => {
            // For Rust, don't wrap in try/catch but suggest Result wrapping
            section.to_string()
        }
        "python" => {
            let lines: Vec<&str> = section.lines().collect();
            if lines.len() < 2 {
                return section.to_string();
            }
            let header = lines[0];
            let body: Vec<String> = lines[1..].iter().map(|l| format!("    {}", l)).collect();
            format!(
                "{}\n{}try:\n{}\n{}except Exception as e:\n{}    raise",
                header,
                indent,
                body.join("\n"),
                indent,
                body_indent
            )
        }
        _ => {
            let lines: Vec<&str> = section.lines().collect();
            if lines.len() < 2 {
                return section.to_string();
            }
            let header = lines[0];
            let body: Vec<String> = lines[1..].iter().map(|l| format!("    {}", l)).collect();
            format!(
                "{}\n{}try {{\n{}\n{}}} catch (e) {{\n{}throw e;\n{}}}",
                header,
                indent,
                body.join("\n"),
                indent,
                body_indent,
                indent
            )
        }
    }
}

fn extract_quoted(s: &str) -> Option<String> {
    let start = s.find('\'')?;
    let end = s[start + 1..].find('\'')?;
    Some(s[start + 1..start + 1 + end].to_string())
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}

fn generate_unified_diff(old: &str, new: &str, path: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut diff = format!("--- a/{}\n+++ b/{}\n", path, path);

    let mut i = 0;
    let mut j = 0;
    while i < old_lines.len() || j < new_lines.len() {
        if i < old_lines.len() && j < new_lines.len() && old_lines[i] == new_lines[j] {
            i += 1;
            j += 1;
        } else {
            let ctx_start = i.saturating_sub(2);
            for ci in ctx_start..i {
                diff.push_str(&format!(" {}\n", old_lines[ci]));
            }
            while i < old_lines.len() && (j >= new_lines.len() || old_lines[i] != new_lines[j]) {
                diff.push_str(&format!("-{}\n", old_lines[i]));
                i += 1;
            }
            while j < new_lines.len() && (i >= old_lines.len() || old_lines[i] != new_lines[j]) {
                diff.push_str(&format!("+{}\n", new_lines[j]));
                j += 1;
            }
        }
    }
    diff
}

fn parse_first_match(output: &str) -> Option<SymbolInfo> {
    let line = output.lines().next()?;
    let parts: Vec<&str> = line.splitn(3, ':').collect();
    if parts.len() < 3 {
        return None;
    }
    Some(SymbolInfo {
        file: parts[0].to_string(),
        line: parts[1].parse().unwrap_or(0),
        text: parts[2].trim().to_string(),
    })
}

fn parse_reference_line(line: &str) -> Option<CallerInfo> {
    let parts: Vec<&str> = line.splitn(3, ':').collect();
    if parts.len() < 3 {
        return None;
    }
    Some(CallerInfo {
        file: parts[0].to_string(),
        line: parts[1].parse().unwrap_or(0),
        snippet: parts[2].trim().to_string(),
    })
}

async fn extract_docstring(file: &str, line: usize) -> Option<String> {
    let content = tokio::fs::read_to_string(file).await.ok()?;
    let lines: Vec<&str> = content.lines().collect();
    if line == 0 || line > lines.len() {
        return None;
    }

    // Look above the definition for doc comments
    let mut doc_lines = Vec::new();
    let start = line.saturating_sub(1);
    let mut i = start.saturating_sub(1);
    while i > 0 {
        let trimmed = lines[i].trim();
        if trimmed.starts_with("///")
            || trimmed.starts_with("#")
            || trimmed.starts_with("/**")
            || trimmed.starts_with("*")
            || trimmed.starts_with("\"\"\"")
        {
            doc_lines.push(
                trimmed
                    .trim_start_matches('/')
                    .trim_start_matches('*')
                    .trim_start_matches('#')
                    .trim(),
            );
            i -= 1;
        } else {
            break;
        }
    }

    if doc_lines.is_empty() {
        return None;
    }
    doc_lines.reverse();
    Some(doc_lines.join("\n"))
}
