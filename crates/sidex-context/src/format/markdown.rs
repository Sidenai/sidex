use std::fmt::Write;

use crate::chunker::Chunk;
use crate::search::SearchResult;

/// Struct-based formatter for Markdown output with configurable heading level.
#[derive(Debug, Default)]
pub struct MarkdownFormatter {
    heading_level: u8,
}

impl MarkdownFormatter {
    pub fn new() -> Self {
        Self { heading_level: 2 }
    }

    pub fn with_heading_level(level: u8) -> Self {
        Self {
            heading_level: level.clamp(1, 6),
        }
    }

    pub fn format_chunk(&self, chunk: &Chunk) -> String {
        let mut buf = String::new();
        let hashes = "#".repeat(self.heading_level as usize);

        if let Some(ref name) = chunk.name {
            let _ = writeln!(buf, "{hashes} `{name}` ({kind})", kind = chunk.kind);
        } else {
            let _ = writeln!(buf, "{hashes} {kind} block", kind = chunk.kind);
        }

        let _ = writeln!(
            buf,
            "**File:** `{}` | **Lines:** {}-{}",
            chunk.file_path, chunk.start_line, chunk.end_line
        );
        buf.push('\n');

        let _ = writeln!(buf, "```{}", chunk.language);
        buf.push_str(&chunk.content);
        if !chunk.content.ends_with('\n') {
            buf.push('\n');
        }
        buf.push_str("```\n");

        buf
    }

    pub fn format_chunks(&self, chunks: &[Chunk]) -> String {
        let mut buf = String::new();
        for chunk in chunks {
            buf.push_str(&self.format_chunk(chunk));
            buf.push('\n');
        }
        buf
    }

    pub fn format_rule(&self, title: &str, body: &str) -> String {
        let hashes = "#".repeat(self.heading_level as usize);
        let mut buf = String::new();
        let _ = writeln!(buf, "{hashes} {title}");
        buf.push('\n');
        buf.push_str(body);
        if !body.ends_with('\n') {
            buf.push('\n');
        }
        buf
    }

    pub fn format_diagnostic(
        &self,
        file: &str,
        line: usize,
        severity: &str,
        message: &str,
    ) -> String {
        format!("> **{severity}** `{file}:{line}` — {message}\n")
    }

    pub fn format_file_tree(&self, paths: &[&str]) -> String {
        let mut buf = String::new();
        let hashes = "#".repeat(self.heading_level as usize);
        let _ = writeln!(buf, "{hashes} File Tree\n");
        let _ = writeln!(buf, "```");
        for path in paths {
            let _ = writeln!(buf, "{path}");
        }
        buf.push_str("```\n");
        buf
    }
}

// --- Free functions used by the hybrid formatter ---

/// Format search results as a markdown summary with code blocks.
pub fn format_results_markdown(results: &[SearchResult]) -> String {
    if results.is_empty() {
        return "No results found.\n".to_string();
    }

    let mut out = String::new();
    let _ = writeln!(out, "## Search Results ({} matches)\n", results.len());

    for (i, result) in results.iter().enumerate() {
        let chunk = &result.chunk;
        let name = chunk.name.as_deref().unwrap_or("<anonymous>");
        let _ = writeln!(
            out,
            "### {i}. `{name}` ({kind}) — score: {score:.2}",
            i = i + 1,
            kind = chunk.kind,
            score = result.score,
        );
        let _ = writeln!(
            out,
            "**File:** `{}` (lines {}-{})\n",
            chunk.file_path, chunk.start_line, chunk.end_line
        );
        let _ = writeln!(out, "```{}", chunk.language);
        let _ = write!(out, "{}", chunk.content);
        if !chunk.content.ends_with('\n') {
            out.push('\n');
        }
        let _ = writeln!(out, "```\n");
    }

    out
}

/// Format a directory tree as indented plain text.
pub fn format_directory_tree(entries: &[(String, bool)]) -> String {
    let mut out = String::new();

    for (path, is_dir) in entries {
        let depth = path.matches('/').count();
        let indent = "  ".repeat(depth);
        let name = path.rsplit('/').next().unwrap_or(path);
        let suffix = if *is_dir { "/" } else { "" };
        let _ = writeln!(out, "{indent}{name}{suffix}");
    }

    out
}

/// Format a file's content with a path header and fenced code block.
pub fn format_file_content(path: &str, content: &str, language: &str) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "## `{path}`\n");
    let _ = writeln!(out, "```{language}");
    let _ = write!(out, "{content}");
    if !content.ends_with('\n') {
        out.push('\n');
    }
    let _ = writeln!(out, "```");
    out
}

/// Format diagnostics as markdown with severity badges.
pub fn format_diagnostics(diagnostics: &[(String, String, String)]) -> String {
    if diagnostics.is_empty() {
        return "No diagnostics.\n".to_string();
    }

    let mut out = String::new();
    let _ = writeln!(out, "## Diagnostics ({} issues)\n", diagnostics.len());

    for (file, severity, message) in diagnostics {
        let _ = writeln!(out, "- **[{severity}]** `{file}`: {message}");
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};

    fn sample_chunk() -> Chunk {
        Chunk {
            id: "id-main".to_string(),
            file_path: "src/main.rs".to_string(),
            start_line: 1,
            end_line: 3,
            kind: ChunkKind::Function,
            name: Some("main".to_string()),
            language: "rust".to_string(),
            content: "fn main() {\n    println!(\"hello\");\n}".to_string(),
            content_hash: "hash-main".to_string(),
            parent_name: None,
            signature: Some("fn main()".to_string()),
        }
    }

    #[test]
    fn test_format_chunk() {
        let formatter = MarkdownFormatter::new();
        let output = formatter.format_chunk(&sample_chunk());

        assert!(output.contains("## `main` (function)"));
        assert!(output.contains("**File:** `src/main.rs`"));
        assert!(output.contains("```rust"));
        assert!(output.contains("fn main()"));
    }

    #[test]
    fn test_format_rule() {
        let formatter = MarkdownFormatter::new();
        let output = formatter.format_rule("Code Style", "Use 4 spaces for indentation.");

        assert!(output.contains("## Code Style"));
        assert!(output.contains("Use 4 spaces"));
    }

    #[test]
    fn test_format_diagnostic() {
        let formatter = MarkdownFormatter::new();
        let output = formatter.format_diagnostic("src/lib.rs", 42, "error", "unused variable");

        assert!(output.contains("**error**"));
        assert!(output.contains("`src/lib.rs:42`"));
        assert!(output.contains("unused variable"));
    }

    #[test]
    fn test_format_file_tree() {
        let formatter = MarkdownFormatter::new();
        let paths = &["src/", "src/main.rs", "src/lib.rs"];
        let output = formatter.format_file_tree(paths);

        assert!(output.contains("## File Tree"));
        assert!(output.contains("src/main.rs"));
    }

    #[test]
    fn test_heading_level() {
        let formatter = MarkdownFormatter::with_heading_level(3);
        let output = formatter.format_chunk(&sample_chunk());
        assert!(output.contains("### `main`"));
    }

    #[test]
    fn test_free_fn_directory_tree() {
        let entries = vec![
            ("src".to_string(), true),
            ("src/lib.rs".to_string(), false),
            ("src/main.rs".to_string(), false),
            ("src/utils".to_string(), true),
            ("src/utils/helpers.rs".to_string(), false),
        ];

        let output = format_directory_tree(&entries);
        assert!(output.contains("src/"));
        assert!(output.contains("  lib.rs"));
        assert!(output.contains("  utils/"));
        assert!(output.contains("    helpers.rs"));
    }

    #[test]
    fn test_free_fn_file_content() {
        let output = format_file_content("src/lib.rs", "fn main() {}\n", "rust");
        assert!(output.contains("## `src/lib.rs`"));
        assert!(output.contains("```rust"));
        assert!(output.contains("fn main() {}"));
    }

    #[test]
    fn test_free_fn_diagnostics() {
        let diags = vec![
            (
                "src/lib.rs".into(),
                "error".into(),
                "unused variable `x`".into(),
            ),
            ("src/main.rs".into(), "warning".into(), "dead code".into()),
        ];

        let output = format_diagnostics(&diags);
        assert!(output.contains("## Diagnostics (2 issues)"));
        assert!(output.contains("**[error]**"));
        assert!(output.contains("**[warning]**"));
    }

    #[test]
    fn test_results_markdown_format() {
        let results = vec![SearchResult {
            chunk: sample_chunk(),
            score: 0.9,
            bm25_rank: Some(1),
            vector_rank: Some(1),
        }];

        let output = format_results_markdown(&results);
        assert!(output.contains("## Search Results (1 matches)"));
        assert!(output.contains("`main`"));
        assert!(output.contains("```rust"));
        assert!(output.contains("score: 0.90"));
    }
}
