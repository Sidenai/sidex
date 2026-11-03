use std::collections::HashMap;
use std::path::Path;

use crate::graph::{CodeGraph, EdgeKind};

/// A file the predictor believes the agent will need next.
#[derive(Debug, Clone)]
pub struct PredictedFile {
    pub file_path: String,
    pub reason: PredictionReason,
    pub confidence: f64,
}

/// Why a file was predicted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PredictionReason {
    Import,
    Caller,
    TestFile,
    SameDirectory,
    RecentAccess,
    GraphNeighbor,
}

impl std::fmt::Display for PredictionReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Import => write!(f, "import"),
            Self::Caller => write!(f, "caller"),
            Self::TestFile => write!(f, "test_file"),
            Self::SameDirectory => write!(f, "same_directory"),
            Self::RecentAccess => write!(f, "recent_access"),
            Self::GraphNeighbor => write!(f, "graph_neighbor"),
        }
    }
}

/// Predicts which files the agent will request next based on graph topology,
/// file-system heuristics, and recent access patterns.
pub struct ContextPredictor {
    graph: CodeGraph,
    access_history: Vec<String>,
    /// Co-occurrence counts: when file A was accessed, what was accessed within
    /// the next 3 accesses? `(file_a, file_b) → count`.
    cooccurrence: HashMap<(String, String), u32>,
}

impl ContextPredictor {
    pub fn new(graph: CodeGraph) -> Self {
        Self {
            graph,
            access_history: Vec::new(),
            cooccurrence: HashMap::new(),
        }
    }

    /// Predict what files will be needed after `accessed_file` was read.
    pub fn predict_next(&self, accessed_file: &str, top_k: usize) -> Vec<PredictedFile> {
        let mut scored: HashMap<String, (f64, PredictionReason)> = HashMap::new();

        self.score_graph_neighbors(accessed_file, &mut scored);
        self.score_test_files(accessed_file, &mut scored);
        self.score_same_directory(accessed_file, &mut scored);
        self.score_cooccurrence(accessed_file, &mut scored);

        let mut candidates: Vec<PredictedFile> = scored
            .into_iter()
            .filter(|(path, _)| path != accessed_file)
            .map(|(file_path, (confidence, reason))| PredictedFile {
                file_path,
                reason,
                confidence,
            })
            .collect();

        candidates.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(top_k);
        candidates
    }

    /// Record that a file was accessed and update co-occurrence statistics.
    pub fn record_access(&mut self, file_path: &str) {
        let window = 3usize;
        let start = self.access_history.len().saturating_sub(window);
        for prev in &self.access_history[start..] {
            if prev != file_path {
                *self
                    .cooccurrence
                    .entry((prev.clone(), file_path.to_string()))
                    .or_default() += 1;
            }
        }

        self.access_history.push(file_path.to_string());
        if self.access_history.len() > 200 {
            self.access_history.drain(..100);
        }

        // Cap cooccurrence map to prevent unbounded growth
        const MAX_COOCCURRENCE_ENTRIES: usize = 5_000;
        if self.cooccurrence.len() > MAX_COOCCURRENCE_ENTRIES {
            let mut entries: Vec<((String, String), u32)> = self.cooccurrence.drain().collect();
            entries.sort_by(|a, b| b.1.cmp(&a.1));
            entries.truncate(MAX_COOCCURRENCE_ENTRIES / 2);
            self.cooccurrence = entries.into_iter().collect();
        }
    }

    /// Replace the backing graph (e.g. after re-indexing).
    pub fn update_graph(&mut self, graph: CodeGraph) {
        self.graph = graph;
    }

    /// Read-only access to the graph.
    pub fn graph(&self) -> &CodeGraph {
        &self.graph
    }

    // ---- scoring strategies ----

    /// 1. Graph-based: find all chunks in `accessed_file`, walk their edges,
    ///    and score the *files* those neighbors belong to.
    fn score_graph_neighbors(
        &self,
        accessed_file: &str,
        scored: &mut HashMap<String, (f64, PredictionReason)>,
    ) {
        let chunks_in_file: Vec<&str> = self
            .graph
            .nodes
            .values()
            .filter(|n| n.file_path == accessed_file)
            .map(|n| n.chunk_id.as_str())
            .collect();

        for chunk_id in &chunks_in_file {
            for (neighbor, edge_kind) in self.graph.neighbors(chunk_id) {
                if neighbor.file_path == accessed_file {
                    continue;
                }
                let (weight, reason) = match edge_kind {
                    EdgeKind::Imports => (0.90, PredictionReason::Import),
                    EdgeKind::Calls => (0.85, PredictionReason::Caller),
                    EdgeKind::Inherits | EdgeKind::Implements => {
                        (0.80, PredictionReason::GraphNeighbor)
                    }
                    EdgeKind::Contains => (0.70, PredictionReason::GraphNeighbor),
                    EdgeKind::References => (0.50, PredictionReason::GraphNeighbor),
                };

                let entry = scored
                    .entry(neighbor.file_path.clone())
                    .or_insert((0.0, reason.clone()));
                if weight > entry.0 {
                    *entry = (weight, reason);
                }
            }
        }
    }

    /// 2. Test-file heuristic: given `foo.rs`, look for `foo_test.rs`, `test_foo.rs`,
    ///    `foo.test.ts`, `foo_test.go`, etc. — and vice-versa.
    fn score_test_files(
        &self,
        accessed_file: &str,
        scored: &mut HashMap<String, (f64, PredictionReason)>,
    ) {
        let test_companions = infer_test_companions(accessed_file);
        let known_files: std::collections::HashSet<&str> = self
            .graph
            .nodes
            .values()
            .map(|n| n.file_path.as_str())
            .collect();

        for companion in test_companions {
            if known_files.contains(companion.as_str()) {
                let entry = scored
                    .entry(companion)
                    .or_insert((0.0, PredictionReason::TestFile));
                if 0.80 > entry.0 {
                    *entry = (0.80, PredictionReason::TestFile);
                }
            }
        }
    }

    /// 3. Same-directory siblings — lower confidence.
    fn score_same_directory(
        &self,
        accessed_file: &str,
        scored: &mut HashMap<String, (f64, PredictionReason)>,
    ) {
        let dir = match Path::new(accessed_file).parent() {
            Some(p) => p.to_string_lossy().to_string(),
            None => return,
        };

        let siblings: Vec<&str> = self
            .graph
            .nodes
            .values()
            .filter(|n| {
                n.file_path != accessed_file
                    && Path::new(&n.file_path)
                        .parent()
                        .map_or(false, |p| p.to_string_lossy() == dir)
            })
            .map(|n| n.file_path.as_str())
            .collect();

        for sib in siblings {
            scored
                .entry(sib.to_string())
                .or_insert((0.30, PredictionReason::SameDirectory));
        }
    }

    /// 4. Co-occurrence boost: if past sessions show these two files are
    ///    frequently accessed together, raise confidence.
    fn score_cooccurrence(
        &self,
        accessed_file: &str,
        scored: &mut HashMap<String, (f64, PredictionReason)>,
    ) {
        for ((a, b), count) in &self.cooccurrence {
            if a != accessed_file {
                continue;
            }
            let boost = (*count as f64 * 0.10).min(0.40);
            let entry = scored
                .entry(b.clone())
                .or_insert((0.0, PredictionReason::RecentAccess));
            entry.0 = (entry.0 + boost).min(1.0);
        }
    }
}

/// Generate plausible test-companion paths for a source file.
fn infer_test_companions(file_path: &str) -> Vec<String> {
    let p = Path::new(file_path);
    let stem = match p.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s,
        None => return vec![],
    };
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    let dir = p
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();

    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };

    let mut companions = Vec::new();

    // If this IS a test file, point back at the source
    if let Some(base) = stem.strip_suffix("_test") {
        companions.push(format!("{prefix}{base}.{ext}"));
        return companions;
    }
    if let Some(base) = stem.strip_prefix("test_") {
        companions.push(format!("{prefix}{base}.{ext}"));
        return companions;
    }
    if let Some(base) = stem.strip_suffix(".test") {
        companions.push(format!("{prefix}{base}.{ext}"));
        return companions;
    }
    if let Some(base) = stem.strip_suffix(".spec") {
        companions.push(format!("{prefix}{base}.{ext}"));
        return companions;
    }

    // Source → possible test patterns
    match ext {
        "go" => {
            companions.push(format!("{prefix}{stem}_test.go"));
        }
        "rs" => {
            companions.push(format!("{prefix}{stem}_test.rs"));
            // Rust also uses tests/ directory
            companions.push(format!("tests/{stem}.rs"));
        }
        "py" => {
            companions.push(format!("{prefix}test_{stem}.py"));
            companions.push(format!("{prefix}{stem}_test.py"));
        }
        "ts" | "tsx" => {
            companions.push(format!("{prefix}{stem}.test.{ext}"));
            companions.push(format!("{prefix}{stem}.spec.{ext}"));
        }
        "js" | "jsx" => {
            companions.push(format!("{prefix}{stem}.test.{ext}"));
            companions.push(format!("{prefix}{stem}.spec.{ext}"));
        }
        "java" => {
            companions.push(format!("{prefix}{stem}Test.java"));
        }
        "rb" => {
            companions.push(format!("{prefix}{stem}_spec.rb"));
            companions.push(format!("{prefix}test_{stem}.rb"));
        }
        _ => {
            companions.push(format!("{prefix}{stem}_test.{ext}"));
            companions.push(format!("{prefix}test_{stem}.{ext}"));
        }
    }

    companions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::{Chunk, ChunkKind};
    use crate::graph::builder::build_graph;

    fn make_chunk(id: &str, name: &str, file: &str, content: &str) -> Chunk {
        Chunk {
            id: id.to_string(),
            file_path: file.to_string(),
            start_line: 1,
            end_line: 1,
            kind: ChunkKind::Function,
            name: Some(name.to_string()),
            language: "go".to_string(),
            content: content.to_string(),
            content_hash: format!("hash-{id}"),
            parent_name: None,
            signature: None,
        }
    }

    #[test]
    fn predict_imports_and_callers() {
        let chunks = vec![
            make_chunk(
                "h1",
                "HandleAuth",
                "src/auth/handler.go",
                "func HandleAuth() { ValidateToken(); }",
            ),
            make_chunk(
                "v1",
                "ValidateToken",
                "src/auth/token.go",
                "func ValidateToken() {}",
            ),
            make_chunk(
                "m1",
                "Middleware",
                "src/middleware.go",
                "func Middleware() { HandleAuth(); }",
            ),
        ];
        let graph = build_graph(&chunks);
        let predictor = ContextPredictor::new(graph);

        let predictions = predictor.predict_next("src/auth/handler.go", 10);
        let paths: Vec<&str> = predictions.iter().map(|p| p.file_path.as_str()).collect();

        assert!(
            paths.contains(&"src/auth/token.go"),
            "should predict import target: {paths:?}"
        );
        assert!(
            paths.contains(&"src/middleware.go"),
            "should predict caller: {paths:?}"
        );
    }

    #[test]
    fn predict_test_files() {
        let chunks = vec![
            make_chunk(
                "h1",
                "HandleAuth",
                "src/auth/handler.go",
                "func HandleAuth() {}",
            ),
            make_chunk(
                "t1",
                "TestHandleAuth",
                "src/auth/handler_test.go",
                "func TestHandleAuth() {}",
            ),
        ];
        let graph = build_graph(&chunks);
        let predictor = ContextPredictor::new(graph);

        let predictions = predictor.predict_next("src/auth/handler.go", 10);
        let paths: Vec<&str> = predictions.iter().map(|p| p.file_path.as_str()).collect();

        assert!(
            paths.contains(&"src/auth/handler_test.go"),
            "should predict test file: {paths:?}"
        );
        let test_pred = predictions
            .iter()
            .find(|p| p.file_path == "src/auth/handler_test.go")
            .unwrap();
        assert_eq!(test_pred.reason, PredictionReason::TestFile);
    }

    #[test]
    fn predict_same_directory_siblings() {
        let chunks = vec![
            make_chunk("h1", "Handler", "src/auth/handler.go", "func Handler() {}"),
            make_chunk("c1", "Config", "src/auth/config.go", "func Config() {}"),
            make_chunk("u1", "Unrelated", "src/payment/pay.go", "func Pay() {}"),
        ];
        let graph = build_graph(&chunks);
        let predictor = ContextPredictor::new(graph);

        let predictions = predictor.predict_next("src/auth/handler.go", 10);
        let paths: Vec<&str> = predictions.iter().map(|p| p.file_path.as_str()).collect();

        assert!(
            paths.contains(&"src/auth/config.go"),
            "should predict sibling: {paths:?}"
        );
    }

    #[test]
    fn confidence_ordering_imports_above_siblings() {
        let chunks = vec![
            make_chunk(
                "h1",
                "Handler",
                "src/auth/handler.go",
                "func Handler() { Validate(); }",
            ),
            make_chunk(
                "v1",
                "Validate",
                "src/auth/validate.go",
                "func Validate() {}",
            ),
            make_chunk("c1", "Config", "src/auth/config.go", "func Config() {}"),
        ];
        let graph = build_graph(&chunks);
        let predictor = ContextPredictor::new(graph);

        let predictions = predictor.predict_next("src/auth/handler.go", 10);

        let validate_conf = predictions
            .iter()
            .find(|p| p.file_path == "src/auth/validate.go")
            .map(|p| p.confidence)
            .unwrap_or(0.0);
        let config_conf = predictions
            .iter()
            .find(|p| p.file_path == "src/auth/config.go")
            .map(|p| p.confidence)
            .unwrap_or(0.0);

        assert!(
            validate_conf > config_conf,
            "graph neighbor ({validate_conf}) should rank above mere sibling ({config_conf})"
        );
    }

    #[test]
    fn record_access_builds_cooccurrence() {
        let graph = CodeGraph::new();
        let mut predictor = ContextPredictor::new(graph);

        predictor.record_access("a.go");
        predictor.record_access("b.go");
        predictor.record_access("a.go");
        predictor.record_access("b.go");

        assert!(
            predictor
                .cooccurrence
                .get(&("a.go".into(), "b.go".into()))
                .copied()
                .unwrap_or(0)
                >= 2
        );
    }

    #[test]
    fn top_k_truncation() {
        let mut chunks = Vec::new();
        for i in 0..20 {
            chunks.push(make_chunk(
                &format!("c{i}"),
                &format!("Func{i}"),
                &format!("src/f{i}.go"),
                &format!("func Func{i}() {{}}"),
            ));
        }
        // Make a hub that calls all of them
        chunks.push(make_chunk(
            "hub",
            "Hub",
            "src/hub.go",
            &(0..20)
                .map(|i| format!("Func{i}()"))
                .collect::<Vec<_>>()
                .join("; "),
        ));

        let graph = build_graph(&chunks);
        let predictor = ContextPredictor::new(graph);

        let predictions = predictor.predict_next("src/hub.go", 5);
        assert!(predictions.len() <= 5, "should respect top_k");
    }

    #[test]
    fn test_infer_test_companions_go() {
        let companions = infer_test_companions("src/auth/handler.go");
        assert!(companions.contains(&"src/auth/handler_test.go".to_string()));
    }

    #[test]
    fn test_infer_test_companions_ts() {
        let companions = infer_test_companions("src/components/Button.tsx");
        assert!(companions.contains(&"src/components/Button.test.tsx".to_string()));
        assert!(companions.contains(&"src/components/Button.spec.tsx".to_string()));
    }

    #[test]
    fn test_infer_test_companions_python() {
        let companions = infer_test_companions("src/utils.py");
        assert!(companions.contains(&"src/test_utils.py".to_string()));
        assert!(companions.contains(&"src/utils_test.py".to_string()));
    }

    #[test]
    fn test_infer_reverse_from_test_file() {
        let companions = infer_test_companions("src/auth/handler_test.go");
        assert!(companions.contains(&"src/auth/handler.go".to_string()));
    }

    #[test]
    fn excludes_accessed_file_from_predictions() {
        let chunks = vec![make_chunk(
            "h1",
            "Handler",
            "src/handler.go",
            "func Handler() {}",
        )];
        let graph = build_graph(&chunks);
        let predictor = ContextPredictor::new(graph);

        let predictions = predictor.predict_next("src/handler.go", 10);
        let paths: Vec<&str> = predictions.iter().map(|p| p.file_path.as_str()).collect();
        assert!(
            !paths.contains(&"src/handler.go"),
            "should never predict the file itself"
        );
    }
}
