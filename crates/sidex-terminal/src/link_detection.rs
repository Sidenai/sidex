//! Terminal link detection.
//!
//! Detects URLs, file paths, and commands in terminal output lines
//! for Ctrl+Click-to-open functionality.

use crate::grid::Cell;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The kind of link detected in terminal output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LinkKind {
    /// An HTTP or HTTPS URL.
    Url,
    /// A local file path (absolute or relative).
    FilePath,
    /// An explicit OSC 8 hyperlink.
    OscHyperlink,
    /// A detected command that can be re-run.
    Command,
}

/// A link detected within a terminal line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalLink {
    /// Start position as (row, col), 0-based.
    pub start: (u16, u16),
    /// End position as (row, col), 0-based exclusive on col.
    pub end: (u16, u16),
    /// The URL or path string.
    pub url: String,
    /// What kind of link this is.
    pub kind: LinkKind,
}

/// Detects links in a terminal line (represented as a slice of cells).
/// `row` is the row index used for link start/end positions.
pub fn detect_links(line: &[Cell]) -> Vec<TerminalLink> {
    detect_links_on_row(line, 0)
}

/// Detects links on a specific row.
pub fn detect_links_on_row(line: &[Cell], row: u16) -> Vec<TerminalLink> {
    let text: String = line.iter().map(|c| c.c).collect();
    let trimmed_len = text.trim_end().len();
    let text = &text[..trimmed_len];
    if text.is_empty() {
        return Vec::new();
    }

    let mut links = Vec::new();

    detect_osc8_links(line, row, &mut links);
    detect_urls(text, row, &mut links);
    detect_file_paths(text, row, &mut links);

    links.sort_by_key(|l| l.start);
    dedup_overlapping(&mut links);
    links
}

/// Detects links across the entire visible grid.
pub fn detect_links_in_grid(grid: &crate::grid::TerminalGrid) -> Vec<TerminalLink> {
    let mut all_links = Vec::new();
    for row in 0..grid.rows() {
        let cells = grid.cells();
        if (row as usize) < cells.len() {
            let row_links = detect_links_on_row(&cells[row as usize], row);
            all_links.extend(row_links);
        }
    }
    all_links
}

/// Detects links from a line with an optional shell CWD for relative path resolution.
pub fn detect_links_with_cwd(line: &[Cell], cwd: Option<&Path>) -> Vec<TerminalLink> {
    let mut links = detect_links(line);

    if let Some(cwd) = cwd {
        for link in &mut links {
            if link.kind == LinkKind::FilePath && !Path::new(&link.url).is_absolute() {
                let resolved = cwd.join(&link.url);
                if resolved.exists() {
                    link.url = resolved.to_string_lossy().to_string();
                }
            }
        }
    }

    links
}

/// Parses a file path link string into (path, line, column).
/// Handles patterns like `/path/to/file.rs:42:10`, `file.rs:42`, `file.rs(42)`.
pub fn parse_file_link(text: &str) -> Option<(PathBuf, Option<u32>, Option<u32>)> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    // Try pattern: path:line:col
    if let Some(colon_idx) = text.rfind(':') {
        let before_last = &text[..colon_idx];
        let after_last = &text[colon_idx + 1..];

        if let Ok(col) = after_last.parse::<u32>() {
            if let Some(colon2) = before_last.rfind(':') {
                let path_part = &before_last[..colon2];
                let line_part = &before_last[colon2 + 1..];
                if let Ok(line) = line_part.parse::<u32>() {
                    return Some((PathBuf::from(path_part), Some(line), Some(col)));
                }
            }
            // path:col (treat as path:line)
            return Some((PathBuf::from(before_last), Some(col), None));
        }

        // Try path:line
        if let Ok(line) = after_last.parse::<u32>() {
            return Some((PathBuf::from(before_last), Some(line), None));
        }
    }

    // Try pattern: path(line,col) or path(line)
    if text.ends_with(')') {
        if let Some(paren_start) = text.rfind('(') {
            let path_part = &text[..paren_start];
            let inner = &text[paren_start + 1..text.len() - 1];
            let parts: Vec<&str> = inner.split(',').collect();
            let line = parts.first().and_then(|s| s.trim().parse::<u32>().ok());
            let col = parts.get(1).and_then(|s| s.trim().parse::<u32>().ok());
            if line.is_some() {
                return Some((PathBuf::from(path_part), line, col));
            }
        }
    }

    // Plain path
    Some((PathBuf::from(text), None, None))
}

fn detect_osc8_links(line: &[Cell], row: u16, links: &mut Vec<TerminalLink>) {
    let mut current_url: Option<(u16, &str)> = None;
    for (col, cell) in line.iter().enumerate() {
        match (&current_url, &cell.hyperlink) {
            (None, Some(url)) => {
                #[allow(clippy::cast_possible_truncation)]
                {
                    current_url = Some((col as u16, url));
                }
            }
            (Some((_start, prev_url)), Some(url)) if *prev_url == url.as_str() => {}
            (Some((start, prev_url)), _) => {
                #[allow(clippy::cast_possible_truncation)]
                links.push(TerminalLink {
                    start: (row, *start),
                    end: (row, col as u16),
                    url: prev_url.to_string(),
                    kind: if prev_url.starts_with("http://") || prev_url.starts_with("https://") {
                        LinkKind::Url
                    } else {
                        LinkKind::OscHyperlink
                    },
                });
                current_url = cell.hyperlink.as_ref().map(|u| {
                    #[allow(clippy::cast_possible_truncation)]
                    (col as u16, u.as_str())
                });
            }
            _ => {}
        }
    }
    if let Some((start, url)) = current_url {
        #[allow(clippy::cast_possible_truncation)]
        links.push(TerminalLink {
            start: (row, start),
            end: (row, line.len() as u16),
            url: url.to_string(),
            kind: if url.starts_with("http://") || url.starts_with("https://") {
                LinkKind::Url
            } else {
                LinkKind::OscHyperlink
            },
        });
    }
}

fn detect_urls(text: &str, row: u16, links: &mut Vec<TerminalLink>) {
    let prefixes = ["https://", "http://"];
    for prefix in &prefixes {
        let mut search_from = 0;
        while let Some(idx) = text[search_from..].find(prefix) {
            let abs = search_from + idx;
            let url_end = find_url_end(text, abs);
            let url = &text[abs..url_end];
            if url.len() > prefix.len() + 1 {
                let start_col = text[..abs].chars().count();
                let end_col = text[..url_end].chars().count();
                #[allow(clippy::cast_possible_truncation)]
                links.push(TerminalLink {
                    start: (row, start_col as u16),
                    end: (row, end_col as u16),
                    url: url.to_string(),
                    kind: LinkKind::Url,
                });
            }
            search_from = url_end;
        }
    }
}

fn find_url_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut i = start;
    let mut paren_depth: i32 = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b' ' | b'\t' | b'"' | b'\'' | b'<' | b'>' | b'`' => break,
            b'(' => {
                paren_depth += 1;
                i += 1;
            }
            b')' => {
                if paren_depth > 0 {
                    paren_depth -= 1;
                    i += 1;
                } else {
                    break;
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    while i > start && matches!(bytes[i - 1], b'.' | b',' | b';' | b':' | b'!' | b'?') {
        i -= 1;
    }
    i
}

fn detect_file_paths(text: &str, row: u16, links: &mut Vec<TerminalLink>) {
    detect_absolute_paths(text, row, links);
    detect_relative_paths(text, row, links);
}

fn detect_absolute_paths(text: &str, row: u16, links: &mut Vec<TerminalLink>) {
    let mut search_from = 0;
    while search_from < text.len() {
        let remaining = &text[search_from..];
        let start = if cfg!(target_os = "windows") {
            remaining.find(":\\").and_then(|colon_idx| {
                if colon_idx > 0 {
                    let drive_char = remaining.as_bytes()[colon_idx - 1];
                    if drive_char.is_ascii_alphabetic() {
                        Some(colon_idx - 1)
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
        } else {
            remaining
                .find('/')
                .filter(|&i| i == 0 || !remaining.as_bytes()[i - 1].is_ascii_alphanumeric())
        };

        let Some(rel_start) = start else {
            break;
        };
        let abs_start = search_from + rel_start;
        let path_end = find_path_end(text, abs_start);
        let path_str = &text[abs_start..path_end];

        if path_str.len() > 1 && !path_str.starts_with("//") {
            let p = PathBuf::from(path_str);
            if looks_like_file_path(&p) {
                let start_col = text[..abs_start].chars().count();
                let end_col = text[..path_end].chars().count();
                #[allow(clippy::cast_possible_truncation)]
                links.push(TerminalLink {
                    start: (row, start_col as u16),
                    end: (row, end_col as u16),
                    url: path_str.to_string(),
                    kind: LinkKind::FilePath,
                });
            }
        }
        search_from = path_end;
    }
}

fn detect_relative_paths(text: &str, row: u16, links: &mut Vec<TerminalLink>) {
    let prefixes = ["./", "../"];
    for prefix in &prefixes {
        let mut search_from = 0;
        while let Some(idx) = text[search_from..].find(prefix) {
            let abs_start = search_from + idx;
            if abs_start > 0 && !text.as_bytes()[abs_start - 1].is_ascii_whitespace() {
                search_from = abs_start + prefix.len();
                continue;
            }
            let path_end = find_path_end(text, abs_start);
            let path_str = &text[abs_start..path_end];
            if path_str.len() > prefix.len() {
                let start_col = text[..abs_start].chars().count();
                let end_col = text[..path_end].chars().count();
                #[allow(clippy::cast_possible_truncation)]
                links.push(TerminalLink {
                    start: (row, start_col as u16),
                    end: (row, end_col as u16),
                    url: path_str.to_string(),
                    kind: LinkKind::FilePath,
                });
            }
            search_from = path_end;
        }
    }
}

fn find_path_end(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'"' | b'\'' | b'<' | b'>' | b'|' | b';' | b'&' => break,
            b':' => {
                if i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
                    break;
                }
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }
    while i > start && matches!(bytes[i - 1], b'.' | b',' | b')' | b']') {
        i -= 1;
    }
    i
}

fn looks_like_file_path(p: &Path) -> bool {
    let s = p.to_string_lossy();
    if s.len() <= 1 {
        return false;
    }
    if s.contains('\0') {
        return false;
    }
    let has_ext = p.extension().is_some();
    let has_sep = s.contains('/') || s.contains('\\');
    has_ext || has_sep
}

fn dedup_overlapping(links: &mut Vec<TerminalLink>) {
    links.dedup_by(|b, a| a.start <= b.start && a.end >= b.end);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells_from_str(s: &str) -> Vec<Cell> {
        s.chars()
            .map(|c| Cell {
                c,
                ..Cell::default()
            })
            .collect()
    }

    #[test]
    fn detect_https_url() {
        let cells = cells_from_str("Visit https://example.com/path?q=1 for info");
        let links = detect_links(&cells);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://example.com/path?q=1");
        assert_eq!(links[0].kind, LinkKind::Url);
    }

    #[test]
    fn detect_http_url() {
        let cells = cells_from_str("http://localhost:3000/api");
        let links = detect_links(&cells);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "http://localhost:3000/api");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn detect_absolute_path_unix() {
        let cells = cells_from_str("Error in /usr/local/bin/app.rs");
        let links = detect_links(&cells);
        let path_links: Vec<_> = links
            .iter()
            .filter(|l| l.kind == LinkKind::FilePath)
            .collect();
        assert!(!path_links.is_empty());
        assert!(path_links[0].url.starts_with("/usr/local/bin/app.rs"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn detect_absolute_path_windows() {
        let cells = cells_from_str("Error in C:\\usr\\local\\bin\\app.rs");
        let links = detect_links(&cells);
        let path_links: Vec<_> = links
            .iter()
            .filter(|l| l.kind == LinkKind::FilePath)
            .collect();
        assert!(!path_links.is_empty());
        assert!(path_links[0].url.starts_with("C:\\usr\\local\\bin\\app.rs"));
    }

    #[test]
    fn detect_relative_path() {
        let cells = cells_from_str("Error in ./src/main.rs");
        let links = detect_links(&cells);
        let path_links: Vec<_> = links
            .iter()
            .filter(|l| l.kind == LinkKind::FilePath)
            .collect();
        assert!(!path_links.is_empty());
        assert_eq!(path_links[0].url, "./src/main.rs");
    }

    #[test]
    fn no_links_in_plain_text() {
        let cells = cells_from_str("Hello world, no links here");
        let links = detect_links(&cells);
        assert!(links.is_empty());
    }

    #[test]
    fn osc8_hyperlink() {
        let cells: Vec<Cell> = "click"
            .chars()
            .map(|c| Cell {
                c,
                hyperlink: Some("https://example.com".to_string()),
                ..Cell::default()
            })
            .collect();
        let links = detect_links(&cells);
        assert!(!links.is_empty());
        assert_eq!(links[0].url, "https://example.com");
        assert_eq!(links[0].kind, LinkKind::Url);
    }

    #[test]
    fn url_with_trailing_punctuation() {
        let cells = cells_from_str("See https://example.com.");
        let links = detect_links(&cells);
        assert_eq!(links.len(), 1);
        assert!(!links[0].url.ends_with('.'));
    }

    #[test]
    fn parse_file_link_with_line_col() {
        let result = parse_file_link("/path/to/file.rs:42:10");
        let (path, line, col) = result.unwrap();
        assert_eq!(path, PathBuf::from("/path/to/file.rs"));
        assert_eq!(line, Some(42));
        assert_eq!(col, Some(10));
    }

    #[test]
    fn parse_file_link_with_line_only() {
        let result = parse_file_link("/path/to/file.rs:42");
        let (path, line, col) = result.unwrap();
        assert_eq!(path, PathBuf::from("/path/to/file.rs"));
        assert_eq!(line, Some(42));
        assert_eq!(col, None);
    }

    #[test]
    fn parse_file_link_paren_format() {
        let result = parse_file_link("file.rs(42,10)");
        let (path, line, col) = result.unwrap();
        assert_eq!(path, PathBuf::from("file.rs"));
        assert_eq!(line, Some(42));
        assert_eq!(col, Some(10));
    }

    #[test]
    fn parse_file_link_plain_path() {
        let result = parse_file_link("/path/to/file.rs");
        let (path, line, col) = result.unwrap();
        assert_eq!(path, PathBuf::from("/path/to/file.rs"));
        assert_eq!(line, None);
        assert_eq!(col, None);
    }
}
