use crate::chunker::Chunk;
use crate::search::hybrid::SearchResult;

/// Approximate tokens from byte length (rough heuristic: 1 token ≈ 3 bytes).
fn estimate_tokens(content: &str) -> usize {
    content.len() / 3
}

/// Assembles chunks from ranked search results within a token budget.
///
/// Walks results in score order, adding chunks until the budget is exhausted.
pub fn assemble_context<'a>(results: &'a [SearchResult], max_tokens: usize) -> Vec<&'a Chunk> {
    let mut selected = Vec::new();
    let mut used_tokens = 0;

    for result in results {
        let tokens = estimate_tokens(&result.chunk.content);
        if used_tokens + tokens > max_tokens {
            if selected.is_empty() {
                selected.push(&result.chunk);
            }
            break;
        }
        used_tokens += tokens;
        selected.push(&result.chunk);
    }

    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunker::ChunkKind;
    use crate::search::hybrid::SearchResult;

    fn make_result(name: &str, content: &str, score: f64) -> SearchResult {
        SearchResult {
            chunk: Chunk {
                id: format!("id-{name}"),
                file_path: format!("src/{name}.rs"),
                start_line: 1,
                end_line: 1,
                kind: ChunkKind::Function,
                name: Some(name.to_string()),
                language: "rust".to_string(),
                content: content.to_string(),
                content_hash: format!("hash-{name}"),
                parent_name: None,
                signature: None,
            },
            score,
            bm25_rank: Some(1),
            vector_rank: Some(1),
        }
    }

    #[test]
    fn test_budget_respects_token_limit() {
        // Each "x" repeated 300 times ≈ 100 tokens (300 / 3)
        let results = vec![
            make_result("a", &"x".repeat(300), 3.0),
            make_result("b", &"y".repeat(300), 2.0),
            make_result("c", &"z".repeat(300), 1.0),
        ];

        let selected = assemble_context(&results, 200);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].id, "id-a");
        assert_eq!(selected[1].id, "id-b");
    }

    #[test]
    fn test_budget_always_includes_at_least_one() {
        let results = vec![make_result("big", &"x".repeat(9000), 1.0)];
        let selected = assemble_context(&results, 10);
        assert_eq!(selected.len(), 1, "should include at least the first chunk");
    }

    #[test]
    fn test_budget_empty_results() {
        let results: Vec<SearchResult> = vec![];
        let selected = assemble_context(&results, 1000);
        assert!(selected.is_empty());
    }

    #[test]
    fn test_budget_fits_all() {
        let results = vec![
            make_result("a", "short content", 3.0),
            make_result("b", "also short", 2.0),
        ];
        let selected = assemble_context(&results, 10000);
        assert_eq!(selected.len(), 2);
    }
}
