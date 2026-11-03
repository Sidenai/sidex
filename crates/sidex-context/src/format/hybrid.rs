//! Hybrid context assembler that picks the optimal format per data region.
//!
//! Different types of context data benefit from different representations:
//! - Structured data (search results, chunks) → TOON for density
//! - Prose (rules, messages) → Markdown for readability
//! - Code content → Fenced code blocks
//! - File trees → Indented text

use std::any::Any;
use std::fmt::Write;

use crate::chunker::Chunk;
use crate::search::SearchResult;

use super::markdown::MarkdownFormatter;
use super::toon::{self, ToonSerializer};

/// Identifies the type of context region being formatted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContextRegion {
    /// Project rules, coding standards, conventions.
    Rules,
    /// Search results from BM25/hybrid search.
    SearchResults,
    /// Raw code content (fenced blocks).
    CodeContent,
    /// Directory/file tree listing.
    FileTree,
    /// Compiler errors, lint warnings, diagnostics.
    Diagnostics,
    /// Messages from/to the agent.
    AgentMessage,
    /// Prior conversation turns.
    ConversationHistory,
}

/// A single diagnostic entry for formatting.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub file: String,
    pub line: usize,
    pub severity: String,
    pub message: String,
}

/// A conversation message for formatting.
#[derive(Debug, Clone)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
}

/// Assembler that selects the best serialization format for each data type.
#[derive(Debug)]
pub struct HybridAssembler {
    toon: ToonSerializer,
    markdown: MarkdownFormatter,
}

impl Default for HybridAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl HybridAssembler {
    pub fn new() -> Self {
        Self {
            toon: ToonSerializer::new(),
            markdown: MarkdownFormatter::new(),
        }
    }

    /// Format a context region, selecting the optimal representation.
    ///
    /// The `data` parameter is type-erased; the method downcasts based on
    /// the declared `region` variant. Returns `None` if the data type doesn't
    /// match expectations for the given region.
    pub fn format_region(&self, region: ContextRegion, data: &dyn Any) -> Option<String> {
        match region {
            ContextRegion::SearchResults => {
                if let Some(results) = data.downcast_ref::<Vec<SearchResult>>() {
                    Some(self.toon.serialize(results))
                } else if let Some(chunks) = data.downcast_ref::<Vec<Chunk>>() {
                    Some(self.toon.serialize(chunks))
                } else {
                    None
                }
            }
            ContextRegion::CodeContent => {
                if let Some(chunks) = data.downcast_ref::<Vec<Chunk>>() {
                    Some(toon::to_toon_nested(chunks))
                } else if let Some(chunk) = data.downcast_ref::<Chunk>() {
                    Some(toon::to_toon_nested(std::slice::from_ref(chunk)))
                } else {
                    None
                }
            }
            ContextRegion::Rules => {
                if let Some((title, body)) = data.downcast_ref::<(&str, &str)>() {
                    Some(self.markdown.format_rule(title, body))
                } else if let Some((title, body)) = data.downcast_ref::<(String, String)>() {
                    Some(self.markdown.format_rule(title, body))
                } else {
                    None
                }
            }
            ContextRegion::FileTree => {
                if let Some(paths) = data.downcast_ref::<Vec<String>>() {
                    let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
                    Some(self.markdown.format_file_tree(&refs))
                } else {
                    None
                }
            }
            ContextRegion::Diagnostics => {
                if let Some(diags) = data.downcast_ref::<Vec<Diagnostic>>() {
                    Some(format_diagnostics(diags))
                } else {
                    None
                }
            }
            ContextRegion::AgentMessage => {
                if let Some(msg) = data.downcast_ref::<String>() {
                    Some(msg.clone())
                } else if let Some(msg) = data.downcast_ref::<&str>() {
                    Some((*msg).to_string())
                } else {
                    None
                }
            }
            ContextRegion::ConversationHistory => {
                if let Some(messages) = data.downcast_ref::<Vec<ConversationMessage>>() {
                    Some(format_conversation(messages))
                } else {
                    None
                }
            }
        }
    }
}

/// Estimate token count using chars/4 approximation.
pub fn estimate_tokens(text: &str) -> usize {
    (text.len() + 3) / 4
}

/// Estimate tokens for a formatted region without materializing the full string.
pub fn estimate_region_tokens(region: ContextRegion, data: &dyn Any) -> usize {
    let assembler = HybridAssembler::new();
    match assembler.format_region(region, data) {
        Some(text) => estimate_tokens(&text),
        None => 0,
    }
}

fn format_diagnostics(diags: &[Diagnostic]) -> String {
    let mut buf = String::new();
    let _ = writeln!(buf, "## Diagnostics\n");
    for d in diags {
        let _ = writeln!(
            buf,
            "> **{}** `{}:{}` — {}",
            d.severity, d.file, d.line, d.message
        );
    }
    buf
}

fn format_conversation(messages: &[ConversationMessage]) -> String {
    let mut buf = String::new();
    for msg in messages {
        let _ = writeln!(buf, "**{}:** {}\n", msg.role, msg.content);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};
    use crate::search::SearchResult;

    fn sample_chunk() -> Chunk {
        Chunk {
            id: "id-test".to_string(),
            file_path: "src/test.rs".to_string(),
            start_line: 1,
            end_line: 5,
            kind: ChunkKind::Function,
            name: Some("test_fn".to_string()),
            language: "rust".to_string(),
            content: "fn test_fn() {\n    42\n}".to_string(),
            content_hash: "hash-test".to_string(),
            parent_name: None,
            signature: Some("fn test_fn()".to_string()),
        }
    }

    #[test]
    fn test_format_search_results() {
        let assembler = HybridAssembler::new();
        let results = vec![SearchResult {
            chunk: sample_chunk(),
            score: 0.9,
            bm25_rank: Some(1),
            vector_rank: None,
        }];

        let output = assembler
            .format_region(ContextRegion::SearchResults, &results)
            .expect("should format search results");

        assert!(output.contains("results[1]"));
        assert!(output.contains("src/test.rs"));
    }

    #[test]
    fn test_format_code_content() {
        let assembler = HybridAssembler::new();
        let chunks = vec![sample_chunk()];

        let output = assembler
            .format_region(ContextRegion::CodeContent, &chunks)
            .expect("should format code content");

        assert!(output.contains("chunks_nested[1]"));
        assert!(output.contains("|fn test_fn()"));
    }

    #[test]
    fn test_format_file_tree() {
        let assembler = HybridAssembler::new();
        let paths: Vec<String> = vec!["src/".into(), "src/main.rs".into()];

        let output = assembler
            .format_region(ContextRegion::FileTree, &paths)
            .expect("should format file tree");

        assert!(output.contains("File Tree"));
        assert!(output.contains("src/main.rs"));
    }

    #[test]
    fn test_format_diagnostics() {
        let assembler = HybridAssembler::new();
        let diags = vec![Diagnostic {
            file: "src/lib.rs".to_string(),
            line: 10,
            severity: "error".to_string(),
            message: "mismatched types".to_string(),
        }];

        let output = assembler
            .format_region(ContextRegion::Diagnostics, &diags)
            .expect("should format diagnostics");

        assert!(output.contains("**error**"));
        assert!(output.contains("mismatched types"));
    }

    #[test]
    fn test_type_mismatch_returns_none() {
        let assembler = HybridAssembler::new();
        let bad_data = 42u32;
        let result = assembler.format_region(ContextRegion::SearchResults, &bad_data);
        assert!(result.is_none());
    }

    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("a"), 1);
    }

    #[test]
    fn test_conversation_history() {
        let assembler = HybridAssembler::new();
        let msgs = vec![
            ConversationMessage {
                role: "user".to_string(),
                content: "How does auth work?".to_string(),
            },
            ConversationMessage {
                role: "assistant".to_string(),
                content: "It uses JWT tokens.".to_string(),
            },
        ];

        let output = assembler
            .format_region(ContextRegion::ConversationHistory, &msgs)
            .expect("should format conversation");

        assert!(output.contains("**user:**"));
        assert!(output.contains("**assistant:**"));
    }
}
