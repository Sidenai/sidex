use std::collections::{HashMap, HashSet};

use super::{CodeGraph, EdgeKind, GraphNode};
use crate::chunker::{Chunk, ChunkKind};
/// Build a `CodeGraph` from parsed chunks.
///
/// Phase 1: every chunk becomes a node.
/// Phase 2: build a name→chunk_id lookup.
/// Phase 3: infer edges (Contains, Imports, Calls) from chunk metadata and content.
pub fn build_graph(chunks: &[Chunk]) -> CodeGraph {
    let mut graph = CodeGraph::new();

    // Phase 1 — nodes
    for chunk in chunks {
        graph.add_node(GraphNode {
            chunk_id: chunk.id.clone(),
            name: chunk.name.clone().unwrap_or_default(),
            kind: chunk.kind.to_string(),
            file_path: chunk.file_path.clone(),
            edges: Vec::new(),
            edge_set: std::collections::HashSet::new(),
        });
    }

    // Phase 2 — name→ids lookup (only named chunks)
    let mut name_to_ids: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in chunks {
        if let Some(name) = &chunk.name {
            if !name.is_empty() {
                name_to_ids
                    .entry(name.clone())
                    .or_default()
                    .push(chunk.id.clone());
            }
        }
    }

    // Phase 3 — edges
    for chunk in chunks {
        // Contains: link parent→child via parent_name
        if let Some(parent) = &chunk.parent_name {
            if let Some(parent_ids) = name_to_ids.get(parent) {
                for pid in parent_ids {
                    if pid != &chunk.id {
                        graph.add_edge(pid, &chunk.id, EdgeKind::Contains);
                    }
                }
            }
        }

        // Imports: import chunks reference the symbols they import
        if chunk.kind == ChunkKind::Import {
            find_import_edges(chunk, &name_to_ids, &mut graph);
        }

        // Calls: scan function/method bodies for known identifiers
        if matches!(
            chunk.kind,
            ChunkKind::Function | ChunkKind::Method | ChunkKind::Block
        ) {
            find_call_edges(chunk, &name_to_ids, &mut graph);
        }
    }

    graph.shrink_to_fit();
    graph
}

/// Heuristic: for import chunks, extract identifiers that match known chunk names.
fn find_import_edges(
    chunk: &Chunk,
    name_lookup: &HashMap<String, Vec<String>>,
    graph: &mut CodeGraph,
) {
    for ident in extract_identifiers(&chunk.content) {
        if let Some(ids) = name_lookup.get(ident) {
            for target_id in ids {
                if target_id != &chunk.id {
                    graph.add_edge(&chunk.id, target_id, EdgeKind::Imports);
                }
            }
        }
    }
}

/// Heuristic: scan content for `identifier(` patterns matching known function/method names.
///
/// Instead of checking every known name against the content (O(names * content)),
/// we scan the content once to extract identifiers followed by `(`, then do
/// HashMap lookups (O(content + matches)).
fn find_call_edges(
    chunk: &Chunk,
    name_lookup: &HashMap<String, Vec<String>>,
    graph: &mut CodeGraph,
) {
    let self_name = chunk.name.as_deref().unwrap_or("");

    for called in extract_call_identifiers(&chunk.content) {
        if called.len() < 2 || called == self_name {
            continue;
        }
        if let Some(target_ids) = name_lookup.get(called) {
            for target_id in target_ids {
                if target_id != &chunk.id {
                    graph.add_edge(&chunk.id, target_id, EdgeKind::Calls);
                }
            }
        }
    }
}

/// Extract all unique identifiers from source text.
fn extract_identifiers(content: &str) -> HashSet<&str> {
    let bytes = content.as_bytes();
    let mut result = HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if is_ident_start(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_ident_byte(bytes[i]) {
                i += 1;
            }
            result.insert(&content[start..i]);
        } else {
            i += 1;
        }
    }
    result
}

/// Extract unique identifiers that are followed by `(` (with optional whitespace).
fn extract_call_identifiers(content: &str) -> HashSet<&str> {
    let bytes = content.as_bytes();
    let mut result = HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if is_ident_start(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_ident_byte(bytes[i]) {
                i += 1;
            }
            let mut j = i;
            while j < bytes.len() && matches!(bytes[j], b' ' | b'\t' | b'\n' | b'\r') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'(' {
                result.insert(&content[start..i]);
            }
        } else {
            i += 1;
        }
    }
    result
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};

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
    fn test_build_graph_creates_nodes() {
        let chunks = vec![
            make_chunk("c1", Some("foo"), ChunkKind::Function, "fn foo() {}", None),
            make_chunk("c2", Some("bar"), ChunkKind::Function, "fn bar() {}", None),
        ];
        let graph = build_graph(&chunks);

        assert_eq!(graph.node_count(), 2);
        assert!(graph.nodes.contains_key("c1"));
        assert!(graph.nodes.contains_key("c2"));
    }

    #[test]
    fn test_contains_edges_from_impl() {
        let chunks = vec![
            make_chunk(
                "impl_point",
                Some("Point"),
                ChunkKind::Impl,
                "impl Point {\n    fn new() -> Self { Point { x: 0 } }\n    fn distance(&self) -> f64 { 0.0 }\n}",
                None,
            ),
            make_chunk(
                "fn_new",
                Some("new"),
                ChunkKind::Function,
                "fn new() -> Self { Point { x: 0 } }",
                Some("Point"),
            ),
            make_chunk(
                "fn_distance",
                Some("distance"),
                ChunkKind::Function,
                "fn distance(&self) -> f64 { 0.0 }",
                Some("Point"),
            ),
        ];
        let graph = build_graph(&chunks);

        let impl_node = graph.nodes.get("impl_point").unwrap();
        let contains_targets: Vec<&str> = impl_node
            .edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Contains)
            .map(|e| e.target_id.as_str())
            .collect();
        assert!(contains_targets.contains(&"fn_new"));
        assert!(contains_targets.contains(&"fn_distance"));
    }

    #[test]
    fn test_call_edges_between_functions() {
        let chunks = vec![
            make_chunk(
                "c_main",
                Some("main"),
                ChunkKind::Function,
                "fn main() {\n    let x = compute(42);\n    println!(\"{}\", x);\n}",
                None,
            ),
            make_chunk(
                "c_compute",
                Some("compute"),
                ChunkKind::Function,
                "fn compute(n: i32) -> i32 { n * 2 }",
                None,
            ),
        ];
        let graph = build_graph(&chunks);

        let main_node = graph.nodes.get("c_main").unwrap();
        let call_targets: Vec<&str> = main_node
            .edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Calls)
            .map(|e| e.target_id.as_str())
            .collect();
        assert!(
            call_targets.contains(&"c_compute"),
            "main should call compute, got: {:?}",
            call_targets
        );
    }

    #[test]
    fn test_no_self_call_edges() {
        let chunks = vec![make_chunk(
            "c_rec",
            Some("recurse"),
            ChunkKind::Function,
            "fn recurse(n: i32) { if n > 0 { recurse(n - 1); } }",
            None,
        )];
        let graph = build_graph(&chunks);

        let node = graph.nodes.get("c_rec").unwrap();
        let self_calls: Vec<_> = node
            .edges
            .iter()
            .filter(|e| e.target_id == "c_rec")
            .collect();
        assert!(self_calls.is_empty(), "should not create self-call edges");
    }

    #[test]
    fn test_neighbors_returns_both_directions() {
        let chunks = vec![
            make_chunk(
                "c_a",
                Some("alpha"),
                ChunkKind::Function,
                "fn alpha() { beta(); }",
                None,
            ),
            make_chunk(
                "c_b",
                Some("beta"),
                ChunkKind::Function,
                "fn beta() {}",
                None,
            ),
        ];
        let graph = build_graph(&chunks);

        // From beta's perspective: alpha calls beta, so beta should see alpha as a neighbor
        let beta_neighbors = graph.neighbors("c_b");
        let neighbor_ids: Vec<&str> = beta_neighbors
            .iter()
            .map(|(n, _)| n.chunk_id.as_str())
            .collect();
        assert!(
            neighbor_ids.contains(&"c_a"),
            "beta should see alpha as a neighbor via reverse edge"
        );

        // From alpha's perspective: alpha calls beta
        let alpha_neighbors = graph.neighbors("c_a");
        let neighbor_ids: Vec<&str> = alpha_neighbors
            .iter()
            .map(|(n, _)| n.chunk_id.as_str())
            .collect();
        assert!(
            neighbor_ids.contains(&"c_b"),
            "alpha should see beta as a neighbor via outgoing edge"
        );
    }

    #[test]
    fn test_neighborhood_depth_limit() {
        // A → B → C (chain of calls)
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
                "fn func_b() { func_c(); }",
                None,
            ),
            make_chunk(
                "c_c",
                Some("func_c"),
                ChunkKind::Function,
                "fn func_c() {}",
                None,
            ),
        ];
        let graph = build_graph(&chunks);

        let depth_1 = graph.neighborhood("c_a", 1);
        let ids_1: Vec<&str> = depth_1.iter().map(|n| n.chunk_id.as_str()).collect();
        assert!(ids_1.contains(&"c_b"), "depth 1 should include B");
        assert!(!ids_1.contains(&"c_c"), "depth 1 should NOT include C");

        let depth_2 = graph.neighborhood("c_a", 2);
        let ids_2: Vec<&str> = depth_2.iter().map(|n| n.chunk_id.as_str()).collect();
        assert!(ids_2.contains(&"c_b"), "depth 2 should include B");
        assert!(ids_2.contains(&"c_c"), "depth 2 should include C");
    }

    #[test]
    fn test_import_edges() {
        let chunks = vec![
            make_chunk(
                "c_import",
                Some("use std::collections::HashMap"),
                ChunkKind::Import,
                "use std::collections::HashMap;",
                None,
            ),
            make_chunk(
                "c_hashmap_user",
                Some("HashMap"),
                ChunkKind::Struct,
                "struct HashMap { ... }",
                None,
            ),
        ];
        let graph = build_graph(&chunks);

        let import_node = graph.nodes.get("c_import").unwrap();
        let import_targets: Vec<&str> = import_node
            .edges
            .iter()
            .filter(|e| e.kind == EdgeKind::Imports)
            .map(|e| e.target_id.as_str())
            .collect();
        assert!(
            import_targets.contains(&"c_hashmap_user"),
            "import should link to HashMap definition"
        );
    }

    #[test]
    fn test_edge_count() {
        let chunks = vec![
            make_chunk(
                "c1",
                Some("setup"),
                ChunkKind::Function,
                "fn setup() { run(); }",
                None,
            ),
            make_chunk("c2", Some("run"), ChunkKind::Function, "fn run() {}", None),
        ];
        let graph = build_graph(&chunks);
        assert!(graph.edge_count() >= 1);
    }
}
