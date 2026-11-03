use std::collections::HashMap;

use crate::chunker::{Chunk, ChunkKind};

/// BM25 parameters.
const K1: f64 = 1.2;
const B: f64 = 0.75;

/// Hard cap on total chunks to prevent unbounded memory growth.
const MAX_CHUNKS: usize = 50_000;

/// In-memory BM25 index for keyword search over chunks.
#[derive(Debug)]
pub struct Bm25Index {
    /// chunk_id → Chunk reference index
    chunks: Vec<Chunk>,
    /// term → list of (chunk_index, term_frequency)
    inverted: HashMap<String, Vec<(usize, f64)>>,
    /// Average document length (in tokens)
    avg_dl: f64,
    /// Number of documents
    n: usize,
}

impl Bm25Index {
    pub fn new() -> Self {
        Self {
            chunks: Vec::new(),
            inverted: HashMap::new(),
            avg_dl: 0.0,
            n: 0,
        }
    }

    pub fn build(chunks: Vec<Chunk>) -> Self {
        let mut chunks = chunks;
        if chunks.len() > MAX_CHUNKS {
            chunks.truncate(MAX_CHUNKS);
        }
        let n = chunks.len();
        if n == 0 {
            return Self::new();
        }

        let mut inverted: HashMap<String, Vec<(usize, f64)>> = HashMap::new();
        let mut total_len = 0usize;

        for (idx, chunk) in chunks.iter().enumerate() {
            let tokens = tokenize(
                &chunk.content,
                chunk.name.as_deref(),
                &chunk.file_path,
                &chunk.kind,
            );
            let doc_len = tokens.len();
            let effective_len = if matches!(chunk.kind, ChunkKind::Module | ChunkKind::Import) {
                doc_len.max(30)
            } else {
                doc_len
            };
            total_len += effective_len;

            let mut term_freq: HashMap<String, usize> = HashMap::new();
            for token in &tokens {
                *term_freq.entry(token.clone()).or_default() += 1;
            }

            for (term, count) in term_freq {
                let tf = count as f64 / effective_len.max(1) as f64;
                inverted.entry(term).or_default().push((idx, tf));
            }
        }

        let avg_dl = total_len as f64 / n as f64;

        Self {
            chunks,
            inverted,
            avg_dl,
            n,
        }
    }

    /// Search the index with a query string, returning (chunk, score) pairs
    /// sorted by relevance (highest first).
    pub fn search(&self, query: &str, limit: usize) -> Vec<(&Chunk, f64)> {
        if self.n == 0 {
            return vec![];
        }

        let query_tokens = tokenize_query(query);
        let mut scores: HashMap<usize, f64> = HashMap::new();

        for token in &query_tokens {
            let Some(postings) = self.inverted.get(token) else {
                continue;
            };

            let df = postings.len() as f64;
            let idf = ((self.n as f64 - df + 0.5) / (df + 0.5) + 1.0).ln();

            for &(chunk_idx, tf) in postings {
                let doc_len = self.chunks[chunk_idx].content.split_whitespace().count() as f64;
                let numerator = tf * (K1 + 1.0);
                let denominator = tf + K1 * (1.0 - B + B * doc_len / self.avg_dl);
                let score = idf * numerator / denominator;

                *scores.entry(chunk_idx).or_default() += score;
            }
        }

        let mut results: Vec<(usize, f64)> = scores.into_iter().collect();
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);

        results
            .into_iter()
            .map(|(idx, score)| (&self.chunks[idx], score))
            .collect()
    }

    pub fn chunk_count(&self) -> usize {
        self.n
    }

    pub fn chunks(&self) -> &[Chunk] {
        &self.chunks
    }

    /// Remove all chunks for a given file and rebuild affected postings.
    /// This requires a rebuild since chunk indices shift, but it's rare
    /// compared to adds (only happens on file deletion or before re-add).
    pub fn remove_file(&mut self, file_path: &str) {
        let had_any = self.chunks.iter().any(|c| c.file_path == file_path);
        if !had_any {
            return;
        }
        self.chunks.retain(|c| c.file_path != file_path);
        *self = Self::build(std::mem::take(&mut self.chunks));
    }

    /// Add new chunks incrementally without a full index rebuild.
    pub fn add_chunks(&mut self, new_chunks: Vec<Chunk>) {
        if new_chunks.is_empty() {
            return;
        }

        // Enforce cap
        let room = MAX_CHUNKS.saturating_sub(self.chunks.len());
        if room == 0 {
            return;
        }
        let new_chunks: Vec<Chunk> = if new_chunks.len() > room {
            new_chunks.into_iter().take(room).collect()
        } else {
            new_chunks
        };

        let base = self.chunks.len();

        for (offset, chunk) in new_chunks.iter().enumerate() {
            let idx = base + offset;
            let tokens = tokenize(
                &chunk.content,
                chunk.name.as_deref(),
                &chunk.file_path,
                &chunk.kind,
            );
            let doc_len = tokens.len();
            let effective_len = if matches!(chunk.kind, ChunkKind::Module | ChunkKind::Import) {
                doc_len.max(30)
            } else {
                doc_len
            };

            let mut term_freq: HashMap<String, usize> = HashMap::new();
            for token in &tokens {
                *term_freq.entry(token.clone()).or_default() += 1;
            }

            for (term, count) in term_freq {
                let tf = count as f64 / effective_len.max(1) as f64;
                self.inverted.entry(term).or_default().push((idx, tf));
            }
        }

        self.chunks.extend(new_chunks);
        self.n = self.chunks.len();
        if self.n > 0 {
            let total_len: usize = self
                .chunks
                .iter()
                .map(|c| {
                    let toks = c
                        .content
                        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
                        .filter(|w| w.len() >= 2)
                        .count();
                    if matches!(c.kind, ChunkKind::Module | ChunkKind::Import) {
                        toks.max(30)
                    } else {
                        toks
                    }
                })
                .sum();
            self.avg_dl = total_len as f64 / self.n as f64;
        }
    }
}

fn tokenize(content: &str, name: Option<&str>, file_path: &str, kind: &ChunkKind) -> Vec<String> {
    let mut tokens = Vec::new();

    for word in content.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if word.len() >= 2 {
            tokens.push(word.to_lowercase());
            split_camel_snake(word, &mut tokens);
        }
    }

    let is_definition = !matches!(kind, ChunkKind::Module | ChunkKind::Import);

    if is_definition {
        if let Some(name) = name {
            let n = name.to_lowercase();
            split_camel_snake(name, &mut tokens);
            tokens.push(n.clone());
            tokens.push(n.clone());
            tokens.push(n);
        }
    }

    if is_definition {
        for part in file_path.split('/') {
            let p = part.to_lowercase();
            if p.len() >= 2 && !p.contains('.') {
                tokens.push(p);
            }
        }
    }

    tokens
}

fn tokenize_query(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for word in query.split(|c: char| !c.is_alphanumeric() && c != '_') {
        let w = word.to_lowercase();
        if w.len() >= 2 {
            tokens.push(w.clone());
            split_camel_snake(&w, &mut tokens);
        }
    }
    tokens
}

fn split_camel_snake(word: &str, out: &mut Vec<String>) {
    if word.contains('_') {
        for part in word.split('_') {
            if part.len() >= 2 {
                out.push(part.to_string());
            }
        }
        return;
    }

    if !word.bytes().any(|b| b.is_ascii_uppercase()) {
        return;
    }

    let bytes = word.as_bytes();
    let mut start = 0;
    for i in 1..bytes.len() {
        if bytes[i].is_ascii_uppercase() && !bytes[i - 1].is_ascii_uppercase() {
            let part = &word[start..i];
            if part.len() >= 2 {
                out.push(part.to_lowercase());
            }
            start = i;
        }
    }
    let last = &word[start..];
    if last.len() >= 2 && last != word {
        out.push(last.to_lowercase());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};

    fn make_chunk(name: &str, content: &str, file: &str) -> Chunk {
        Chunk {
            id: format!("id-{name}"),
            file_path: file.to_string(),
            start_line: 1,
            end_line: content.lines().count(),
            kind: ChunkKind::Function,
            name: Some(name.to_string()),
            language: "rust".to_string(),
            content: content.to_string(),
            content_hash: format!("hash-{name}"),
            parent_name: None,
            signature: Some(format!("fn {name}()")),
        }
    }

    #[test]
    fn test_basic_search() {
        let chunks = vec![
            make_chunk(
                "parse_json",
                "fn parse_json(data: &str) -> Value { serde_json::from_str(data) }",
                "src/parser.rs",
            ),
            make_chunk(
                "render_html",
                "fn render_html(template: &str) -> String { format!(\"<div>{}</div>\", template) }",
                "src/renderer.rs",
            ),
            make_chunk(
                "connect_database",
                "fn connect_database(url: &str) -> Connection { Database::connect(url) }",
                "src/db.rs",
            ),
        ];

        let index = Bm25Index::build(chunks);
        let results = index.search("parse json data", 10);

        assert!(!results.is_empty());
        assert_eq!(results[0].0.name.as_deref(), Some("parse_json"));
    }

    #[test]
    fn test_camel_case_search() {
        let chunks = vec![
            make_chunk("getUserById", "function getUserById(id) { return db.query('SELECT * FROM users WHERE id = ?', id) }", "src/users.js"),
            make_chunk("createOrder", "function createOrder(items) { return db.insert('orders', items) }", "src/orders.js"),
        ];

        let index = Bm25Index::build(chunks);
        let results = index.search("user id", 10);
        assert!(!results.is_empty());
        assert_eq!(results[0].0.name.as_deref(), Some("getUserById"));
    }

    #[test]
    fn test_empty_index() {
        let index = Bm25Index::new();
        let results = index.search("anything", 10);
        assert!(results.is_empty());
    }

    #[test]
    fn test_file_path_boosts() {
        let chunks = vec![
            make_chunk(
                "handler",
                "fn handler() { process_auth() }",
                "src/auth/handler.rs",
            ),
            make_chunk(
                "handler2",
                "fn handler2() { process_payment() }",
                "src/payment/handler.rs",
            ),
        ];

        let index = Bm25Index::build(chunks);
        let results = index.search("auth handler", 10);
        assert!(!results.is_empty());
        assert!(results[0].0.file_path.contains("auth"));
    }

    #[test]
    fn test_remove_and_add() {
        let chunks = vec![
            make_chunk("foo", "fn foo() {}", "a.rs"),
            make_chunk("bar", "fn bar() {}", "b.rs"),
        ];

        let mut index = Bm25Index::build(chunks);
        assert_eq!(index.chunk_count(), 2);

        index.remove_file("a.rs");
        assert_eq!(index.chunk_count(), 1);

        let results = index.search("foo", 10);
        assert!(results.is_empty());

        index.add_chunks(vec![make_chunk("baz", "fn baz() {}", "c.rs")]);
        assert_eq!(index.chunk_count(), 2);
    }
}
