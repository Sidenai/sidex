use std::collections::HashSet;
use std::path::Path;

use sidex_context::bm25::Bm25Index;
use sidex_context::graph::builder::build_graph;
use sidex_context::graph::EdgeKind;
use sidex_context::merkle;
use sidex_context::{chunk_directory, EmbeddingProvider};

fn sidex_agent_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("sidex-agent")
}

// =========================================================================
// (a) Index the sidex-agent crate
// =========================================================================

#[test]
fn index_sidex_agent_crate() {
    let dir = sidex_agent_dir();
    assert!(dir.exists(), "sidex-agent crate must exist at {:?}", dir);

    let chunks = chunk_directory(&dir, &dir).unwrap();
    let files: HashSet<&str> = chunks.iter().map(|c| c.file_path.as_str()).collect();

    eprintln!("=== Index Summary ===");
    eprintln!("  Chunks:    {}", chunks.len());
    eprintln!("  Files:     {}", files.len());

    let graph = build_graph(&chunks);
    eprintln!("  Graph nodes: {}", graph.node_count());
    eprintln!("  Graph edges: {}", graph.edge_count());

    assert!(
        chunks.len() > 50,
        "expected >50 chunks, got {}",
        chunks.len()
    );
    assert!(
        files.len() >= 10,
        "expected >=10 files, got {}",
        files.len()
    );
    assert!(graph.node_count() > 50);
    assert!(graph.edge_count() > 10);
}

// =========================================================================
// (b) BM25 search quality
// =========================================================================

#[test]
fn bm25_search_execute_tool_request() {
    let dir = sidex_agent_dir();
    let chunks = chunk_directory(&dir, &dir).unwrap();
    let index = Bm25Index::build(chunks);

    let results = index.search("execute tool request", 10);
    assert!(
        !results.is_empty(),
        "should find results for 'execute tool request'"
    );

    eprintln!("=== BM25: 'execute tool request' ===");
    for (i, (chunk, score)) in results.iter().enumerate().take(10) {
        eprintln!(
            "  #{}: {} (name={:?}, file={}, score={:.4})",
            i + 1,
            chunk.kind,
            chunk.name,
            chunk.file_path,
            score
        );
    }

    let found_execute = results
        .iter()
        .take(10)
        .any(|(c, _)| c.name.as_deref() == Some("execute") || c.content.contains("fn execute"));
    assert!(
        found_execute,
        "execute() should appear in top 10 results for 'execute tool request'"
    );

    let found_tool_request = results.iter().take(10).any(|(c, _)| {
        c.name.as_deref() == Some("ToolRequest") || c.content.contains("ToolRequest")
    });
    assert!(
        found_tool_request,
        "ToolRequest should appear in top 10 results"
    );
}

#[test]
fn bm25_search_read_file() {
    let dir = sidex_agent_dir();
    let chunks = chunk_directory(&dir, &dir).unwrap();
    let index = Bm25Index::build(chunks);

    let results = index.search("read file content", 10);
    assert!(
        !results.is_empty(),
        "should find results for 'read file content'"
    );

    eprintln!("=== BM25: 'read file content' ===");
    for (i, (chunk, score)) in results.iter().enumerate().take(5) {
        eprintln!(
            "  #{}: {} (name={:?}, file={}, score={:.4})",
            i + 1,
            chunk.kind,
            chunk.name,
            chunk.file_path,
            score
        );
    }

    let found_read_file = results.iter().take(5).any(|(c, _)| {
        c.name.as_deref() == Some("read_file")
            || c.file_path.contains("file_ops")
            || c.content.contains("fn read_file")
            || (c.content.contains("read") && c.content.contains("file"))
    });
    assert!(
        found_read_file,
        "file read functionality should appear in top 5 results for 'read file content'"
    );
}

#[test]
fn bm25_search_git_status() {
    let dir = sidex_agent_dir();
    let chunks = chunk_directory(&dir, &dir).unwrap();
    let index = Bm25Index::build(chunks);

    let results = index.search("git status", 10);
    assert!(!results.is_empty(), "should find results for 'git status'");

    eprintln!("=== BM25: 'git status' ===");
    for (i, (chunk, score)) in results.iter().enumerate().take(5) {
        eprintln!(
            "  #{}: {} (name={:?}, file={}, score={:.4})",
            i + 1,
            chunk.kind,
            chunk.name,
            chunk.file_path,
            score
        );
    }

    let top = &results[0].0;
    let found = top.name.as_deref() == Some("status") || top.file_path.contains("git");
    assert!(
        found,
        "top result for 'git status' should be status() in git.rs, got {:?} in {}",
        top.name, top.file_path
    );
}

#[test]
fn bm25_search_shell_command() {
    let dir = sidex_agent_dir();
    let chunks = chunk_directory(&dir, &dir).unwrap();
    let index = Bm25Index::build(chunks);

    let results = index.search("shell command", 10);
    assert!(
        !results.is_empty(),
        "should find results for 'shell command'"
    );

    eprintln!("=== BM25: 'shell command' ===");
    for (i, (chunk, score)) in results.iter().enumerate().take(5) {
        eprintln!(
            "  #{}: {} (name={:?}, file={}, score={:.4})",
            i + 1,
            chunk.kind,
            chunk.name,
            chunk.file_path,
            score
        );
    }

    let found_shell = results.iter().take(5).any(|(c, _)| {
        c.file_path.contains("shell")
            || c.name.as_deref() == Some("run")
            || c.content.contains("Command::new")
    });
    assert!(
        found_shell,
        "shell-related code should appear in top 5 results for 'shell command'"
    );
}

// =========================================================================
// (c) Knowledge graph quality
// =========================================================================

#[test]
fn graph_dispatch_calls_tools() {
    let dir = sidex_agent_dir();
    let chunks = chunk_directory(&dir, &dir).unwrap();
    let graph = build_graph(&chunks);

    let dispatch_node = graph.nodes.values().find(|n| n.name == "dispatch");

    assert!(
        dispatch_node.is_some(),
        "should find a 'dispatch' node in the graph"
    );
    let dispatch = dispatch_node.unwrap();

    eprintln!("=== dispatch node ===");
    eprintln!("  id:   {}", dispatch.chunk_id);
    eprintln!("  file: {}", dispatch.file_path);
    eprintln!("  edges: {}", dispatch.edges.len());

    let call_edges: Vec<_> = dispatch
        .edges
        .iter()
        .filter(|e| e.kind == EdgeKind::Calls)
        .collect();

    eprintln!("  Calls edges: {}", call_edges.len());
    for e in &call_edges {
        if let Some(target) = graph.nodes.get(&e.target_id) {
            eprintln!("    → {} ({})", target.name, target.file_path);
        }
    }

    assert!(
        !call_edges.is_empty(),
        "dispatch should have Calls edges to tool functions"
    );
}

#[test]
fn graph_contains_edges_for_modules() {
    let dir = sidex_agent_dir();
    let chunks = chunk_directory(&dir, &dir).unwrap();
    let graph = build_graph(&chunks);

    let contains_edges: Vec<_> = graph
        .nodes
        .values()
        .flat_map(|n| n.edges.iter().filter(|e| e.kind == EdgeKind::Contains))
        .collect();

    eprintln!("=== Contains edges ===");
    eprintln!("  Count: {}", contains_edges.len());

    for e in contains_edges.iter().take(10) {
        if let Some(target) = graph.nodes.get(&e.target_id) {
            eprintln!("    → {} ({})", target.name, target.kind);
        }
    }

    assert!(
        !contains_edges.is_empty(),
        "graph should have Contains edges (impl/struct/class → methods/fields)"
    );
}

// =========================================================================
// (d) Merkle tree tests on real codebase
// =========================================================================

#[test]
fn merkle_tree_no_change_produces_empty_diff() {
    let dir = sidex_agent_dir();
    assert!(dir.exists());

    let tree1 = merkle::build_tree(&dir).unwrap();
    let tree2 = merkle::build_tree(&dir).unwrap();

    assert_eq!(
        tree1.hash, tree2.hash,
        "two builds of the same dir should produce the same root hash"
    );

    let diff = merkle::diff_trees(&tree1, &tree2);
    assert!(
        !diff.has_changes(),
        "diff of identical trees should be empty, but got {} changed, {} deleted",
        diff.changed.len(),
        diff.deleted.len()
    );
}

#[test]
fn merkle_tree_detects_new_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();

    std::fs::write(root.join("main.rs"), "fn main() {}").unwrap();

    let tree1 = merkle::build_tree(root).unwrap();

    let new_file = root.join("added.rs");
    std::fs::write(&new_file, "fn added() {}").unwrap();

    let tree2 = merkle::build_tree(root).unwrap();

    assert_ne!(tree1.hash, tree2.hash);
    let diff = merkle::diff_trees(&tree1, &tree2);
    assert!(diff.has_changes(), "should detect the new file");
    assert!(
        diff.changed
            .iter()
            .any(|p| p.to_string_lossy().contains("added.rs")),
        "changed list should include added.rs, got: {:?}",
        diff.changed
    );
}

// =========================================================================
// (e) Embedding module compilation & graceful failures
// =========================================================================

#[test]
fn ollama_embedder_fails_gracefully_without_server() {
    std::env::set_var("OLLAMA_HOST", "http://127.0.0.1:19998");
    let result = sidex_context::embeddings::local::OllamaEmbedder::new("nomic-embed-code");
    assert!(
        result.is_err(),
        "OllamaEmbedder::new() should fail when Ollama is not running"
    );
    let err = result.err().unwrap();
    eprintln!("  OllamaEmbedder error: {err}");
    std::env::remove_var("OLLAMA_HOST");
}

#[test]
fn voyage_embedder_creates_without_error() {
    let embedder = sidex_context::embeddings::voyage::VoyageEmbedder::new("fake-key");
    assert_eq!(embedder.dimensions(), 1024);
    eprintln!(
        "  VoyageEmbedder created with fake key, dims={}",
        embedder.dimensions()
    );
}

// =========================================================================
// Bonus: end-to-end pipeline (chunk → index → search → graph expand)
// =========================================================================

#[test]
fn end_to_end_pipeline() {
    let dir = sidex_agent_dir();
    let chunks = chunk_directory(&dir, &dir).unwrap();

    eprintln!("=== End-to-End Pipeline ===");
    eprintln!("  Chunks: {}", chunks.len());

    let index = Bm25Index::build(chunks.clone());
    let graph = build_graph(&chunks);

    let results = index.search("dispatch tool", 5);
    assert!(!results.is_empty());

    let top_ids: Vec<String> = results.iter().map(|(c, _)| c.id.clone()).collect();

    let chunk_map: std::collections::HashMap<String, &sidex_context::Chunk> =
        chunks.iter().map(|c| (c.id.clone(), c)).collect();

    let expanded = sidex_context::graph::expansion::expand_results(&top_ids, &graph, &chunk_map, 5);

    eprintln!("  Search results: {}", results.len());
    eprintln!("  Expanded: {}", expanded.len());

    for (id, score) in &expanded {
        if let Some(node) = graph.nodes.get(id) {
            eprintln!(
                "    expanded: {} ({}) score={:.3}",
                node.name, node.file_path, score
            );
        }
    }

    let tree = merkle::build_tree(&dir).unwrap();
    let flat = merkle::flatten(&tree);
    eprintln!("  Merkle files: {}", flat.len());

    assert!(flat.len() >= 10, "Merkle tree should index >=10 files");
}
