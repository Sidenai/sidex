use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct FileSummary {
    pub line_count: usize,
    pub word_count: usize,
    pub char_count: usize,
    pub has_bom: bool,
    pub likely_encoding: String,
    pub line_endings: String,
}

/// Fast line counting without loading entire file into memory
#[tauri::command]
pub fn count_lines(path: String) -> Result<usize, String> {
    let file = std::fs::File::open(&path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    
    let mut count = 0usize;
    let buf = std::io::BufReader::new(file);
    
    for line in std::io::BufRead::lines(buf) {
        if line.is_ok() {
            count += 1;
        }
    }
    
    Ok(count)
}

/// Get file summary stats efficiently
#[tauri::command]
pub fn file_summary(path: String) -> Result<FileSummary, String> {
    let content = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    // Check for BOM
    let has_bom = content.starts_with(&[0xEF, 0xBB, 0xBF]); // UTF-8 BOM
    
    // Convert to string, skipping BOM if present
    let text = if has_bom {
        String::from_utf8_lossy(&content[3..])
    } else {
        String::from_utf8_lossy(&content)
    };
    
    let line_count = text.lines().count();
    let char_count = text.chars().count();
    let word_count = text.split_whitespace().count();
    
    // Detect line endings
    let line_endings = if text.contains("\r\n") {
        "CRLF".to_string()
    } else if text.contains('\r') {
        "CR".to_string()
    } else {
        "LF".to_string()
    };
    
    // Simple encoding detection
    let likely_encoding = if has_bom {
        "UTF-8 (with BOM)".to_string()
    } else if content.is_ascii() {
        "ASCII".to_string()
    } else {
        "UTF-8".to_string()
    };
    
    Ok(FileSummary {
        line_count,
        word_count,
        char_count,
        has_bom,
        likely_encoding,
        line_endings,
    })
}

/// Normalize line endings to LF
#[tauri::command]
pub fn normalize_line_endings(text: String) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Convert line endings to CRLF
#[tauri::command]
pub fn to_crlf(text: String) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n")
}

/// Remove trailing whitespace from each line
#[tauri::command]
pub fn trim_trailing_whitespace(text: String) -> String {
    text.lines()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Ensure file ends with single newline
#[tauri::command]
pub fn ensure_final_newline(text: String) -> String {
    if text.ends_with('\n') {
        text.trim_end_matches('\n').to_string() + "\n"
    } else {
        text + "\n"
    }
}

/// Get word boundaries for a line (for double-click selection)
#[derive(Debug, Serialize)]
pub struct WordBoundary {
    pub start: usize,
    pub end: usize,
}

#[tauri::command]
pub fn get_word_boundaries(line: String, column: usize) -> Result<WordBoundary, String> {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() || column >= chars.len() {
        return Ok(WordBoundary { start: 0, end: 0 });
    }
    
    let is_word_char = |c: char| c.is_alphanumeric() || c == '_';
    
    // Find start of word
    let mut start = column;
    while start > 0 && is_word_char(chars[start - 1]) {
        start -= 1;
    }
    
    // Find end of word
    let mut end = column;
    while end < chars.len() && is_word_char(chars[end]) {
        end += 1;
    }
    
    // If not on a word char, expand to surrounding whitespace/punctuation
    if start == column && end == column {
        start = column.saturating_sub(1);
        end = (column + 1).min(chars.len());
    }
    
    Ok(WordBoundary { start, end })
}

/// Fast diff between two texts (simplified)
#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub line_number: usize,
    pub change_type: String, // "added", "removed", "modified"
    pub content: String,
}

#[tauri::command]
pub fn simple_diff(old_text: String, new_text: String) -> Vec<DiffLine> {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();
    
    let mut result = Vec::new();
    let max_lines = old_lines.len().max(new_lines.len());
    
    for i in 0..max_lines {
        let old_line = old_lines.get(i);
        let new_line = new_lines.get(i);
        
        match (old_line, new_line) {
            (Some(old), Some(new)) if old != new => {
                result.push(DiffLine {
                    line_number: i + 1,
                    change_type: "modified".to_string(),
                    content: new.to_string(),
                });
            }
            (None, Some(new)) => {
                result.push(DiffLine {
                    line_number: i + 1,
                    change_type: "added".to_string(),
                    content: new.to_string(),
                });
            }
            (Some(_), None) => {
                result.push(DiffLine {
                    line_number: i + 1,
                    change_type: "removed".to_string(),
                    content: "".to_string(),
                });
            }
            _ => {}
        }
    }
    
    result
}

/// Calculate file hash (for change detection)
#[tauri::command]
pub fn file_hash(path: String) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let content = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    Ok(format!("{:x}", hasher.finish()))
}

/// Fast file content comparison
#[tauri::command]
pub fn files_equal(path1: String, path2: String) -> Result<bool, String> {
    let content1 = std::fs::read(&path1)
        .map_err(|e| format!("Failed to read file 1: {}", e))?;
    let content2 = std::fs::read(&path2)
        .map_err(|e| format!("Failed to read file 2: {}", e))?;
    
    Ok(content1 == content2)
}
