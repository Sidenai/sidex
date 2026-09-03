use serde::Serialize;
use sidex_text::diff::{compute_line_diff, LineDiff};
use sidex_text::encoding::detect_encoding;
use sidex_text::Buffer;
use sidex_text::{detect_line_ending, line_ending_label, normalize_line_endings, LineEnding};
use std::io::Read;

#[derive(Debug, Serialize)]
pub struct FileSummary {
    pub line_count: usize,
    pub word_count: usize,
    pub char_count: usize,
    pub has_bom: bool,
    pub likely_encoding: String,
    pub line_endings: String,
}

#[allow(clippy::needless_pass_by_value, clippy::large_stack_arrays)]
#[tauri::command]
pub fn count_lines(path: String) -> Result<usize, String> {
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut buf = [0u8; 32768];
    let mut count = 0usize;

    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read: {e}"))?;
        if n == 0 {
            break;
        }
        count += memchr::memchr_iter(b'\n', &buf[..n]).count();
    }

    Ok(count)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn file_summary(path: String) -> Result<FileSummary, String> {
    let content = std::fs::read(&path).map_err(|e| format!("Failed to read file: {e}"))?;

    let encoding = detect_encoding(&content);
    let has_bom = matches!(encoding, sidex_text::encoding::Encoding::Utf8Bom);

    let text_start = if has_bom { 3 } else { 0 };
    let text = String::from_utf8_lossy(&content[text_start..]);

    let buffer = Buffer::from_str(&text);
    let line_count = buffer.len_lines();
    let char_count = buffer.len_chars();

    let mut word_count = 0usize;
    for line_idx in 0..buffer.len_lines() {
        for word_info in buffer.words_at(line_idx) {
            if word_info.word_type == sidex_text::WordType::Word {
                word_count += 1;
            }
        }
    }

    let line_ending = detect_line_ending(&text);
    let line_endings = line_ending_label(line_ending).to_string();
    let likely_encoding = encoding.label().to_string();

    Ok(FileSummary {
        line_count,
        word_count,
        char_count,
        has_bom,
        likely_encoding,
        line_endings,
    })
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(rename_all = "snake_case")]
pub fn normalize_line_endings_cmd(text: String) -> Result<String, String> {
    Ok(normalize_line_endings(&text, LineEnding::Lf))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn to_crlf(text: String) -> Result<String, String> {
    Ok(normalize_line_endings(&text, LineEnding::CrLf))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn trim_trailing_whitespace(text: String) -> Result<String, String> {
    let mut result = String::with_capacity(text.len());
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            result.push('\n');
        }
        result.push_str(line.trim_end());
    }
    Ok(result)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn ensure_final_newline(mut text: String) -> Result<String, String> {
    if text.is_empty() || text.ends_with('\n') {
        return Ok(text);
    }
    text.push('\n');
    Ok(text)
}

#[derive(Debug, Serialize)]
pub struct WordBoundary {
    pub start: usize,
    pub end: usize,
}

#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)]
#[tauri::command]
pub fn get_word_boundaries(line: String, column: usize) -> Result<WordBoundary, String> {
    let buffer = Buffer::from_str(&line);
    #[allow(clippy::cast_possible_truncation)]
    let pos = sidex_text::Position::new(0, column as u32);

    if let Some(word) = buffer.get_word_at_position(pos) {
        Ok(WordBoundary {
            start: word.start_column as usize,
            end: word.end_column as usize,
        })
    } else {
        let bytes = line.as_bytes();
        if bytes.is_empty() || column >= bytes.len() {
            return Ok(WordBoundary { start: 0, end: 0 });
        }
        let start = column.saturating_sub(1);
        let end = (column + 1).min(bytes.len());
        Ok(WordBoundary { start, end })
    }
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    pub line_number: usize,
    pub change_type: &'static str,
    pub content: String,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn simple_diff(old_text: String, new_text: String) -> Result<Vec<DiffLine>, String> {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();

    let diff = compute_line_diff(&old_lines, &new_lines);

    let mut result = Vec::new();
    for (line_number, entry) in diff.iter().enumerate() {
        let line_number = line_number + 1;
        match entry {
            LineDiff::Equal(_) => {}
            LineDiff::Modified(_, new) => {
                result.push(DiffLine {
                    line_number,
                    change_type: "modified",
                    content: new.clone(),
                });
            }
            LineDiff::Added(content) => {
                result.push(DiffLine {
                    line_number,
                    change_type: "added",
                    content: content.clone(),
                });
            }
            LineDiff::Removed(_) => {
                result.push(DiffLine {
                    line_number,
                    change_type: "removed",
                    content: String::new(),
                });
            }
        }
    }
    Ok(result)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn file_hash(path: String) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let content = std::fs::read(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    Ok(format!("{:x}", hasher.finish()))
}

#[allow(clippy::needless_pass_by_value, clippy::large_stack_arrays)]
#[tauri::command]
pub fn files_equal(path1: String, path2: String) -> Result<bool, String> {
    let meta1 = std::fs::metadata(&path1).map_err(|e| format!("Failed to stat file 1: {e}"))?;
    let meta2 = std::fs::metadata(&path2).map_err(|e| format!("Failed to stat file 2: {e}"))?;

    if meta1.len() != meta2.len() {
        return Ok(false);
    }

    let mut f1 = std::fs::File::open(&path1).map_err(|e| format!("Failed to open file 1: {e}"))?;
    let mut f2 = std::fs::File::open(&path2).map_err(|e| format!("Failed to open file 2: {e}"))?;
    let mut buf1 = [0u8; 32768];
    let mut buf2 = [0u8; 32768];

    loop {
        let n1 = f1.read(&mut buf1).map_err(|e| format!("Read error: {e}"))?;
        let n2 = f2.read(&mut buf2).map_err(|e| format!("Read error: {e}"))?;
        if n1 != n2 || buf1[..n1] != buf2[..n2] {
            return Ok(false);
        }
        if n1 == 0 {
            return Ok(true);
        }
    }
}
