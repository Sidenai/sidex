package tools

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Execute dispatches a tool call by name, parsing the JSON arguments and
// routing to the correct method. Every case here must have a matching
// init_* registration in registry.go and an implementation in its own file.
func (r *Registry) Execute(name string, argsJSON string) ExecutionResult {
	argsJSON = strings.TrimSpace(argsJSON)
	if argsJSON == "" {
		argsJSON = "{}"
	}
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return ExecutionResult{Error: "invalid arguments: " + err.Error()}
	}

	switch name {
	// --- File operations ---
	case "read_file":
		return r.readFile(args)
	case "write_file":
		return r.writeFile(args)
	case "edit_file":
		return r.editFile(args)
	case "multi_edit":
		return r.multiEdit(args)
	case "patch_file":
		return r.patchFile(args)
	case "regex_replace":
		return r.regexReplace(args)
	case "batch_read":
		return r.batchRead(args)
	case "file_info":
		return r.fileInfo(args)
	case "notebook_edit":
		return r.notebookEdit(args)

	// --- Directory / search ---
	case "list_dir":
		return r.listDir(args)
	case "search_files":
		return r.searchFiles(args)
	case "grep":
		return r.grep(args)
	case "glob":
		return r.globFiles(args)
	case "tree":
		return r.tree(args)
	case "diff":
		return r.diff(args)
	case "cwd":
		return r.getCwd(args)

	// --- Shell / background ---
	case "shell":
		return r.shell(args)
	case "run_background":
		return r.runBackground(args)
	case "shell_output":
		return r.shellOutput(args)
	case "kill_shell":
		return r.killShell(args)
	case "list_shells":
		return r.listShells(args)
	case "repl":
		return ExecutionResult{Error: "repl tool is disabled; use shell instead"}
	case "powershell":
		return ExecutionResult{Error: "powershell tool is disabled; use shell instead"}

	// --- Git ---
	case "git_status":
		return r.gitStatus(args)
	case "git_log":
		return r.gitLog(args)
	case "git_commit":
		return r.gitCommit(args)
	case "git_diff_file":
		return r.gitDiffFile(args)

	// --- Web ---
	case "web_fetch":
		return r.webFetch(args)
	case "web_search":
		return r.webSearch(args)

	// --- Memory / persistence ---
	case "memory_store":
		return r.memoryStore(args)
	case "memory_search":
		return r.memorySearch(args)
	case "todo_write":
		return r.todoWrite(args)

	// --- Plan management ---
	case "plan_create":
		return r.planCreate(args)
	case "plan_update":
		return r.planUpdate(args)
	case "plan_get":
		return r.planGet(args)
	case "plan_complete":
		return r.planComplete(args)

	// --- LSP ---
	case "lsp_hover":
		return r.lspHover(args)
	case "lsp_definition":
		return r.lspDefinition(args)
	case "lsp_references":
		return r.lspReferences(args)
	case "lsp_diagnostics":
		return r.lspDiagnostics(args)
	case "read_lints":
		return r.readLints(args)

	// --- Task management ---
	case "task_create":
		return r.taskCreate(args)
	case "task_get":
		return r.taskGet(args)
	case "task_list":
		return r.taskList(args)
	case "task_update":
		return r.taskUpdate(args)
	case "task_stop":
		return r.taskStop(args)
	case "task_output":
		return r.taskOutput(args)

	// --- Agent modes / meta ---
	case "enter_plan_mode":
		return r.enterPlanMode(args)
	case "exit_plan_mode":
		return r.exitPlanMode(args)
	case "enter_worktree":
		return r.enterWorktree(args)
	case "exit_worktree":
		return r.exitWorktree(args)
	case "list_worktrees":
		return r.listWorktrees(args)
	case "skill":
		return r.invokeSkill(args)
	case "brief":
		return r.brief(args)
	case "structured_output":
		return r.structuredOutput(args)
	case "tool_search":
		return r.toolSearch(args)
	case "config":
		return r.config(args)
	case "sleep":
		return r.sleep(args)
	case "image_read":
		return r.imageRead(args)
	case "ask_user":
		return r.askUser(args)

	// --- Teams (disabled) ---
	case "team_create", "team_delete":
		return ExecutionResult{Error: "team tools are disabled"}

	// --- Context (local-exec preferred; full server fallbacks) ---
	case "context_search":
		return r.contextSearchFallback(args)
	case "context_status":
		return r.contextStatusFallback()
	case "context_index":
		return r.contextIndexFallback()

	// --- Checkpoint / rollback ---
	case "checkpoint":
		return r.checkpoint(args)
	case "rollback":
		return r.rollback(args)

	// --- MCP client ---
	case "mcp_connect":
		return r.mcpConnect(args)
	case "mcp_disconnect":
		return r.mcpDisconnect(args)
	case "mcp_list_tools":
		return r.mcpListTools(args)
	case "mcp_call_tool":
		return r.mcpCallTool(args)

	default:
		if r.MCP != nil && r.MCP.HasTool(name) {
			return r.executeMCPTool(name, args)
		}
		return ExecutionResult{Error: "unknown tool: " + name}
	}
}

// executeMCPTool marshals arguments back to JSON and routes through the MCP manager.
func (r *Registry) executeMCPTool(name string, args map[string]interface{}) ExecutionResult {
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return ExecutionResult{Error: "mcp: marshal args: " + err.Error()}
	}

	// Trigger lazy schema fetch on first invocation to populate full schema
	// for future tool definition rebuilds.
	if r.MCP != nil {
		r.MCP.GetToolSchema(name) //nolint:errcheck
	}

	output, err := r.MCP.CallTool(name, argsJSON)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	if output == "" {
		output = "(no output)"
	}
	return ExecutionResult{Output: output}
}

// contextStatusFallback reports the server-side semantic index state for the
// current workspace when local execution is unavailable.
func (r *Registry) contextStatusFallback() ExecutionResult {
	if r.IndexService == nil {
		return ExecutionResult{Error: "no index service configured (set TURBOPUFFER_API_KEY)"}
	}
	st := r.IndexService.Status(r.cwd)
	if !st.Indexed {
		return ExecutionResult{Output: "Workspace is not indexed yet. The IDE syncs it automatically shortly after opening; context_search will start returning results once the first sync completes. Use grep/glob in the meantime."}
	}
	return ExecutionResult{Output: fmt.Sprintf(
		"Workspace index ready: %d files, %d chunks, code graph %d symbols / %d relations, last synced %s. context_search is available.",
		st.Files, st.Chunks, st.GraphNodes, st.GraphEdges, st.LastSynced)}
}

// contextIndexFallback explains that server-side indexing is sync-driven and
// reports current state — the model must never stall waiting on a manual
// index step that doesn't exist on this path.
func (r *Registry) contextIndexFallback() ExecutionResult {
	if r.IndexService == nil {
		return ExecutionResult{Error: "no index service configured (set TURBOPUFFER_API_KEY)"}
	}
	st := r.IndexService.Status(r.cwd)
	if st.Indexed {
		return ExecutionResult{Output: fmt.Sprintf(
			"Index is already up to date (%d files, %d chunks, last synced %s) — the IDE re-syncs automatically on changes. Proceed with context_search.",
			st.Files, st.Chunks, st.LastSynced)}
	}
	return ExecutionResult{Output: "Indexing happens automatically via IDE workspace sync; there is no manual build step on this connection. If context_search returns nothing yet, use grep/glob for now and retry later."}
}

// contextSearchFallback performs a server-side code search when local exec
// is not available by falling back to the IndexService.
func (r *Registry) contextSearchFallback(args map[string]interface{}) ExecutionResult {
	if r.IndexService == nil {
		return ExecutionResult{Error: "context_search requires either local execution or a configured IndexService (set TURBOPUFFER_API_KEY)"}
	}

	query, _ := args["query"].(string)
	if query == "" {
		return ExecutionResult{Error: "query parameter is required"}
	}

	limit := 20
	if l, ok := args["limit"].(float64); ok && int(l) > 0 {
		limit = int(l)
	}

	// Token budget for the assembled output (default 8000 tokens ≈ 32k chars).
	// Results are packed greedily in relevance order until the budget is
	// spent, so one query can't blow the agent's context window.
	budgetTokens := 8000
	if b, ok := args["budget"].(float64); ok && int(b) > 0 {
		budgetTokens = int(b)
	}
	budgetChars := budgetTokens * 4

	// Hybrid retrieval: vector + ripgrep + RRF fusion + rerank + recency.
	// The grep stage activates automatically when the cwd exists on this
	// machine.
	results, err := r.IndexService.HybridSearch(r.cwd, query, limit, r.cwd)
	if err != nil {
		return ExecutionResult{Error: "search failed: " + err.Error()}
	}

	if len(results) == 0 {
		return ExecutionResult{Output: "No results found for query: " + query}
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Found %d results for: %s\n\n", len(results), query))
	included := 0
	for i, res := range results {
		var entry strings.Builder
		entry.WriteString(fmt.Sprintf("--- Result %d (score: %.2f) ---\n", i+1, res.Score))
		entry.WriteString(fmt.Sprintf("File: %s:%d-%d", res.File, res.StartLine, res.EndLine))
		if res.Symbol != "" {
			entry.WriteString(fmt.Sprintf(" (%s)", res.Symbol))
		}
		entry.WriteString("\n")
		if res.Snippet != "" {
			entry.WriteString(res.Snippet)
			entry.WriteString("\n")
		}
		entry.WriteString("\n")

		if sb.Len()+entry.Len() > budgetChars {
			// Budget spent: lower-ranked results are dropped, not truncated
			// mid-snippet. Tell the model what was omitted.
			sb.WriteString(fmt.Sprintf(
				"[%d more results omitted by the %d-token budget — refine the query or raise `budget` to see them]\n",
				len(results)-included, budgetTokens))
			break
		}
		sb.WriteString(entry.String())
		included++
	}

	return ExecutionResult{Output: sb.String()}
}
