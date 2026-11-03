package tools

// Context tools — definitions only. Execution is handled by the Rust
// sidex-agent crate via local exec (Tauri IPC). These registrations
// make the tools visible to the AI model.

func init_context(r *Registry) {
	r.tools["context_index"] = Tool{
		Name: "context_index",
		Description: `Build or rebuild the workspace's BM25 search index by parsing all supported source files into AST-based chunks. Call this once when first starting work on a codebase, or after significant file changes (e.g. pulling new code).

Returns chunk/file counts and timing. The index persists for the session — subsequent context_search calls use it. If you haven't indexed yet and try to search, you'll get an error reminding you to index first.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{
					"type":        "string",
					"description": "Optional workspace root path to index. Defaults to session cwd.",
				},
			},
		},
	}

	r.tools["context_search"] = Tool{
		Name: "context_search",
		Description: `Semantic codebase search: find code relevant to a natural-language or conceptual query ("where is authentication handled?") when you don't know the exact text to grep for. Returns ranked code chunks with file paths, line numbers, and snippets.

Uses the workspace's semantic index when available (built locally via context_index, or server-side via workspace sync) combined with keyword matching. If the workspace hasn't been indexed yet the search may return no results — fall back to grep/glob in that case. For exact symbols or strings, grep is faster and more precise.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{
					"type":        "string",
					"description": "Natural language or keyword query to search for.",
				},
				"limit": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum number of results to return (default: 20).",
				},
				"budget": map[string]interface{}{
					"type":        "integer",
					"description": "Token budget for assembled context (default: 8000).",
				},
			},
			"required": []string{"query"},
		},
	}

	r.tools["context_status"] = Tool{
		Name:        "context_status",
		Description: `Check whether the workspace context index has been built and return its stats: chunk count, file count, and last-indexed timestamp. Use this to decide whether you need to call context_index before searching.`,
		Parameters: map[string]interface{}{
			"type": "object", "properties": map[string]interface{}{},
		},
	}
}
