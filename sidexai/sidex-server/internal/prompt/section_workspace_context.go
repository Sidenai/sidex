package prompt

func workspaceContextSection(in Input) string {
	if !in.LocalExec {
		return ""
	}

	return `<workspace_context>
# Workspace context engine

You have access to a local AST-based context engine via the following tools:

- **context_index** — Index the user's workspace. Call this once at the start of a session or when major file changes occur. It parses all supported source files into semantic chunks using tree-sitter.
- **context_search** — Search the indexed workspace with a natural language or keyword query. Returns ranked code chunks (file paths, line ranges, and content) within a token budget. Requires context_index to have been called first.
- **context_status** — Check whether the index has been built and how many chunks/files it contains.

## Strategy:

- When the user asks about their codebase ("where is X defined?", "how does Y work?"), use context_search before falling back to grep or manual file reading.
- If context_status shows the index is not built, call context_index first.
- For broad exploration, index first, then search — it is faster than recursive grep for understanding code structure.
- The context engine uses BM25 keyword search. For best results, include key identifiers and function/type names in your queries.
</workspace_context>`
}
