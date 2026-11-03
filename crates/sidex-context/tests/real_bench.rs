use sidex_context::{chunk_directory, ChunkKind};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

#[test]
fn bench_chunk_sidex_agent_crate() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("sidex-agent");

    if !crate_dir.exists() {
        eprintln!("sidex-agent crate not found, skipping");
        return;
    }

    let start = Instant::now();
    let chunks = chunk_directory(&crate_dir, &crate_dir).unwrap();
    let elapsed = start.elapsed();

    let mut kind_counts: HashMap<ChunkKind, usize> = HashMap::new();
    let mut lang_counts: HashMap<String, usize> = HashMap::new();
    let mut total_lines = 0usize;

    for c in &chunks {
        *kind_counts.entry(c.kind.clone()).or_default() += 1;
        *lang_counts.entry(c.language.clone()).or_default() += 1;
        total_lines += c.end_line - c.start_line + 1;
    }

    eprintln!("=== sidex-agent benchmark ===");
    eprintln!("  Time:       {:?}", elapsed);
    eprintln!("  Chunks:     {}", chunks.len());
    eprintln!("  Total lines covered: {}", total_lines);
    eprintln!("  Languages:  {:?}", lang_counts);
    eprintln!("  Kinds:      {:?}", kind_counts);
    eprintln!(
        "  Files:      {}",
        chunks
            .iter()
            .map(|c| &c.file_path)
            .collect::<std::collections::HashSet<_>>()
            .len()
    );

    assert!(!chunks.is_empty(), "should find chunks in sidex-agent");
    assert!(elapsed.as_millis() < 5000, "should complete in under 5s");

    for chunk in &chunks {
        assert!(!chunk.content.is_empty());
        assert!(!chunk.content_hash.is_empty());
        assert!(chunk.start_line <= chunk.end_line);
    }
}

#[test]
fn bench_chunk_go_server() {
    let server_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("sidexai/sidex-server");

    if !server_dir.exists() {
        eprintln!("go server not found, skipping");
        return;
    }

    let start = Instant::now();
    let chunks = chunk_directory(&server_dir, &server_dir).unwrap();
    let elapsed = start.elapsed();

    let mut kind_counts: HashMap<ChunkKind, usize> = HashMap::new();
    for c in &chunks {
        *kind_counts.entry(c.kind.clone()).or_default() += 1;
    }

    eprintln!("=== Go server benchmark ===");
    eprintln!("  Time:       {:?}", elapsed);
    eprintln!("  Chunks:     {}", chunks.len());
    eprintln!("  Kinds:      {:?}", kind_counts);
    eprintln!(
        "  Files:      {}",
        chunks
            .iter()
            .map(|c| &c.file_path)
            .collect::<std::collections::HashSet<_>>()
            .len()
    );

    assert!(!chunks.is_empty(), "should find chunks in Go server");
    assert!(elapsed.as_millis() < 10000, "should complete in under 10s");
}
