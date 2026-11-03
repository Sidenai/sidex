use std::collections::HashMap;

use anyhow::{Context, Result};

use crate::chunker::Chunk;
use crate::embeddings::EmbeddingProvider;
use crate::search::bm25::Bm25Index;

const RRF_K: f64 = 60.0;

pub struct HybridSearcher {
    bm25: Bm25Index,
    embedder: Box<dyn EmbeddingProvider>,
    chunks: Vec<Chunk>,
    vectors: Vec<Vec<f32>>,
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub chunk: Chunk,
    pub score: f64,
    pub bm25_rank: Option<usize>,
    pub vector_rank: Option<usize>,
}

impl HybridSearcher {
    pub fn new(chunks: Vec<Chunk>, embedder: Box<dyn EmbeddingProvider>) -> Result<Self> {
        let bm25 = Bm25Index::build(chunks.clone());

        let texts: Vec<String> = chunks.iter().map(|c| c.content.clone()).collect();
        let vectors = if texts.is_empty() {
            Vec::new()
        } else {
            embedder
                .embed_batch(&texts)
                .context("failed to embed chunks")?
        };

        Ok(Self {
            bm25,
            embedder,
            chunks,
            vectors,
        })
    }

    /// Build a searcher from pre-computed data (skips embedding generation).
    pub fn from_precomputed(
        chunks: Vec<Chunk>,
        vectors: Vec<Vec<f32>>,
        embedder: Box<dyn EmbeddingProvider>,
    ) -> Self {
        let bm25 = Bm25Index::build(chunks.clone());
        Self {
            bm25,
            embedder,
            chunks,
            vectors,
        }
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let retrieve_n = 50;

        // BM25 results
        let bm25_results = self.bm25.search(query, retrieve_n);
        let mut bm25_ranks: HashMap<String, usize> = HashMap::new();
        for (rank, (chunk, _score)) in bm25_results.iter().enumerate() {
            bm25_ranks.insert(chunk.id.clone(), rank + 1);
        }

        // Vector results
        let query_vec = self.embedder.embed_query(query)?;
        let mut vector_scores: Vec<(usize, f64)> = self
            .vectors
            .iter()
            .enumerate()
            .map(|(i, v)| (i, cosine_similarity(&query_vec, v)))
            .collect();
        vector_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        vector_scores.truncate(retrieve_n);

        let mut vector_ranks: HashMap<String, usize> = HashMap::new();
        for (rank, &(idx, _)) in vector_scores.iter().enumerate() {
            vector_ranks.insert(self.chunks[idx].id.clone(), rank + 1);
        }

        // Reciprocal Rank Fusion
        let mut all_ids: HashMap<String, f64> = HashMap::new();
        for (id, rank) in &bm25_ranks {
            *all_ids.entry(id.clone()).or_default() += 1.0 / (RRF_K + *rank as f64);
        }
        for (id, rank) in &vector_ranks {
            *all_ids.entry(id.clone()).or_default() += 1.0 / (RRF_K + *rank as f64);
        }

        let chunk_map: HashMap<&str, &Chunk> =
            self.chunks.iter().map(|c| (c.id.as_str(), c)).collect();

        let mut fused: Vec<SearchResult> = all_ids
            .into_iter()
            .filter_map(|(id, score)| {
                chunk_map.get(id.as_str()).map(|&chunk| SearchResult {
                    chunk: chunk.clone(),
                    score,
                    bm25_rank: bm25_ranks.get(&id).copied(),
                    vector_rank: vector_ranks.get(&id).copied(),
                })
            })
            .collect();

        fused.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        fused.truncate(limit);

        Ok(fused)
    }

    pub fn add_chunks(&mut self, new_chunks: Vec<Chunk>) -> Result<()> {
        let texts: Vec<String> = new_chunks.iter().map(|c| c.content.clone()).collect();
        let new_vectors = if texts.is_empty() {
            Vec::new()
        } else {
            self.embedder
                .embed_batch(&texts)
                .context("failed to embed new chunks")?
        };

        self.chunks.extend(new_chunks.clone());
        self.vectors.extend(new_vectors);
        self.bm25.add_chunks(new_chunks);

        Ok(())
    }

    pub fn remove_file(&mut self, file_path: &str) -> Result<()> {
        let mut keep_indices: Vec<usize> = Vec::new();
        for (i, chunk) in self.chunks.iter().enumerate() {
            if chunk.file_path != file_path {
                keep_indices.push(i);
            }
        }

        self.chunks = keep_indices
            .iter()
            .map(|&i| self.chunks[i].clone())
            .collect();
        self.vectors = keep_indices
            .iter()
            .map(|&i| self.vectors[i].clone())
            .collect();
        self.bm25.remove_file(file_path);

        Ok(())
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let mut dot = 0.0_f64;
    let mut norm_a = 0.0_f64;
    let mut norm_b = 0.0_f64;

    for (x, y) in a.iter().zip(b.iter()) {
        let x = f64::from(*x);
        let y = f64::from(*y);
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::ChunkKind;
    use crate::embeddings::EmbeddingProvider;

    struct MockEmbedder {
        dims: usize,
    }

    impl MockEmbedder {
        fn new(dims: usize) -> Self {
            Self { dims }
        }
    }

    impl EmbeddingProvider for MockEmbedder {
        fn embed_batch(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
            Ok(texts.iter().map(|t| text_to_vec(t, self.dims)).collect())
        }
        fn embed_query(&self, query: &str) -> anyhow::Result<Vec<f32>> {
            Ok(text_to_vec(query, self.dims))
        }
        fn dimensions(&self) -> usize {
            self.dims
        }
    }

    /// Deterministic pseudo-embedding: hash characters into a fixed-size vector.
    fn text_to_vec(text: &str, dims: usize) -> Vec<f32> {
        let mut vec = vec![0.0_f32; dims];
        for (i, byte) in text.bytes().enumerate() {
            vec[i % dims] += f32::from(byte) / 255.0;
        }
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in &mut vec {
                *v /= norm;
            }
        }
        vec
    }

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
    fn test_rrf_fusion_combines_both_sources() {
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
                "connect_db",
                "fn connect_database(url: &str) -> Connection { Database::connect(url) }",
                "src/db.rs",
            ),
        ];

        let embedder = Box::new(MockEmbedder::new(16));
        let searcher = HybridSearcher::from_precomputed(
            chunks.clone(),
            chunks.iter().map(|c| text_to_vec(&c.content, 16)).collect(),
            embedder,
        );

        let results = searcher.search("parse json data", 10).unwrap();
        assert!(!results.is_empty());

        // Every result should have a fused score > 0
        for r in &results {
            assert!(r.score > 0.0);
        }

        // At least one result should appear in both BM25 and vector rankings
        let has_both = results
            .iter()
            .any(|r| r.bm25_rank.is_some() && r.vector_rank.is_some());
        assert!(has_both, "expected at least one result from both rankers");
    }

    #[test]
    fn test_rrf_with_single_chunk() {
        let chunks = vec![make_chunk("only", "fn only() { hello() }", "src/only.rs")];
        let embedder = Box::new(MockEmbedder::new(8));
        let searcher = HybridSearcher::from_precomputed(
            chunks.clone(),
            chunks.iter().map(|c| text_to_vec(&c.content, 8)).collect(),
            embedder,
        );

        let results = searcher.search("only hello", 5).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].chunk.id, "id-only");
    }

    #[test]
    fn test_add_and_remove_chunks() {
        let chunks = vec![
            make_chunk("foo", "fn foo() { alpha() }", "a.rs"),
            make_chunk("bar", "fn bar() { beta() }", "b.rs"),
        ];
        let embedder = Box::new(MockEmbedder::new(8));
        let mut searcher = HybridSearcher::from_precomputed(
            chunks.clone(),
            chunks.iter().map(|c| text_to_vec(&c.content, 8)).collect(),
            embedder,
        );

        assert_eq!(searcher.chunk_count(), 2);

        searcher
            .add_chunks(vec![make_chunk("baz", "fn baz() { gamma() }", "c.rs")])
            .unwrap();
        assert_eq!(searcher.chunk_count(), 3);

        searcher.remove_file("a.rs").unwrap();
        assert_eq!(searcher.chunk_count(), 2);
    }

    #[test]
    fn test_cosine_similarity_identical() {
        let v = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&v, &v);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-6);
    }
}
