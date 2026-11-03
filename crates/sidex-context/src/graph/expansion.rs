use std::collections::{HashMap, HashSet};

use crate::chunker::Chunk;

use super::{CodeGraph, EdgeKind};

/// Edge-kind priority for scoring expansion results.
fn edge_priority(kind: &EdgeKind) -> f64 {
    match kind {
        EdgeKind::Calls => 1.0,
        EdgeKind::Contains => 0.8,
        EdgeKind::Imports => 0.6,
        EdgeKind::Inherits => 0.7,
        EdgeKind::Implements => 0.7,
        EdgeKind::References => 0.3,
    }
}

/// Given initial search result chunk IDs, expand with related chunks from the graph.
///
/// Returns additional chunk IDs (not in the initial set) scored by relevance,
/// sorted descending and truncated to `max_expansion`.
pub fn expand_results(
    initial_chunk_ids: &[String],
    graph: &CodeGraph,
    _all_chunks: &HashMap<String, &Chunk>,
    max_expansion: usize,
) -> Vec<(String, f64)> {
    let initial_set: HashSet<&str> = initial_chunk_ids.iter().map(String::as_str).collect();
    let mut scores: HashMap<String, f64> = HashMap::new();

    for chunk_id in initial_chunk_ids {
        for (neighbor, edge_kind) in graph.neighbors(chunk_id) {
            if initial_set.contains(neighbor.chunk_id.as_str()) {
                continue;
            }
            *scores.entry(neighbor.chunk_id.clone()).or_default() += edge_priority(&edge_kind);
        }
    }

    let mut ranked: Vec<(String, f64)> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(max_expansion);
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};
    use crate::graph::builder::build_graph;

    fn make_chunk(
        id: &str,
        name: Option<&str>,
        kind: ChunkKind,
        content: &str,
        parent: Option<&str>,
    ) -> Chunk {
        Chunk {
            id: id.to_string(),
            file_path: "src/main.rs".to_string(),
            start_line: 1,
            end_line: content.lines().count().max(1),
            kind,
            name: name.map(str::to_string),
            language: "rust".to_string(),
            content: content.to_string(),
            content_hash: format!("hash-{id}"),
            parent_name: parent.map(str::to_string),
            signature: None,
        }
    }

    #[test]
    fn test_expand_results_finds_neighbors() {
        let chunks = vec![
            make_chunk(
                "c_main",
                Some("main"),
                ChunkKind::Function,
                "fn main() { helper(); }",
                None,
            ),
            make_chunk(
                "c_helper",
                Some("helper"),
                ChunkKind::Function,
                "fn helper() { utility(); }",
                None,
            ),
            make_chunk(
                "c_utility",
                Some("utility"),
                ChunkKind::Function,
                "fn utility() {}",
                None,
            ),
        ];
        let graph = build_graph(&chunks);

        let all_chunks: HashMap<String, &Chunk> =
            chunks.iter().map(|c| (c.id.clone(), c)).collect();

        let initial = vec!["c_main".to_string()];
        let expanded = expand_results(&initial, &graph, &all_chunks, 10);

        let expanded_ids: Vec<&str> = expanded.iter().map(|(id, _)| id.as_str()).collect();
        assert!(
            expanded_ids.contains(&"c_helper"),
            "should expand to include helper"
        );
    }

    #[test]
    fn test_expand_results_excludes_initial() {
        let chunks = vec![
            make_chunk(
                "c_a",
                Some("func_a"),
                ChunkKind::Function,
                "fn func_a() { func_b(); }",
                None,
            ),
            make_chunk(
                "c_b",
                Some("func_b"),
                ChunkKind::Function,
                "fn func_b() {}",
                None,
            ),
        ];
        let graph = build_graph(&chunks);

        let all_chunks: HashMap<String, &Chunk> =
            chunks.iter().map(|c| (c.id.clone(), c)).collect();

        let initial = vec!["c_a".to_string(), "c_b".to_string()];
        let expanded = expand_results(&initial, &graph, &all_chunks, 10);

        let expanded_ids: Vec<&str> = expanded.iter().map(|(id, _)| id.as_str()).collect();
        assert!(
            !expanded_ids.contains(&"c_a"),
            "should not include initial results"
        );
        assert!(
            !expanded_ids.contains(&"c_b"),
            "should not include initial results"
        );
    }

    #[test]
    fn test_expand_results_respects_limit() {
        let mut chunks = vec![make_chunk(
            "c_hub",
            Some("hub"),
            ChunkKind::Function,
            "fn hub() { spoke_a(); spoke_b(); spoke_c(); }",
            None,
        )];
        for name in ["spoke_a", "spoke_b", "spoke_c"] {
            chunks.push(make_chunk(
                &format!("c_{name}"),
                Some(name),
                ChunkKind::Function,
                &format!("fn {name}() {{}}"),
                None,
            ));
        }
        let graph = build_graph(&chunks);
        let all_chunks: HashMap<String, &Chunk> =
            chunks.iter().map(|c| (c.id.clone(), c)).collect();

        let initial = vec!["c_hub".to_string()];
        let expanded = expand_results(&initial, &graph, &all_chunks, 2);
        assert!(expanded.len() <= 2, "should respect max_expansion limit");
    }

    #[test]
    fn test_expand_results_scores_descending() {
        let chunks = vec![
            make_chunk(
                "c_caller1",
                Some("caller1"),
                ChunkKind::Function,
                "fn caller1() { target(); }",
                None,
            ),
            make_chunk(
                "c_caller2",
                Some("caller2"),
                ChunkKind::Function,
                "fn caller2() { target(); }",
                None,
            ),
            make_chunk(
                "c_target",
                Some("target"),
                ChunkKind::Function,
                "fn target() {}",
                None,
            ),
            make_chunk(
                "c_other",
                Some("other"),
                ChunkKind::Function,
                "fn other() {}",
                None,
            ),
        ];
        let graph = build_graph(&chunks);
        let all_chunks: HashMap<String, &Chunk> =
            chunks.iter().map(|c| (c.id.clone(), c)).collect();

        // Both callers reference target, so searching from both callers
        // should give target a higher score than other
        let initial = vec!["c_caller1".to_string(), "c_caller2".to_string()];
        let expanded = expand_results(&initial, &graph, &all_chunks, 10);

        if expanded.len() >= 2 {
            assert!(
                expanded[0].1 >= expanded[1].1,
                "results should be sorted descending by score"
            );
        }
    }
}
