package tools

import (
	"github.com/sidex-ai/sidex-server/internal/memory"
)

// NewRegistry creates a Registry with all tools registered and default state.
func NewRegistry(cwd string) *Registry {
	return NewRegistryForUser(cwd, "", nil)
}

func NewRegistryForUser(cwd, userID string, store *memory.Store) *Registry {
	r := &Registry{
		tools:       make(map[string]Tool),
		cwd:         cwd,
		UserID:      userID,
		store:       store,
		readState:   make(map[string]fileReadState),
		bg:          NewBackgroundMgr(),
		TaskStore:   NewTaskStore(),
		Plans:       NewPlanStore(),
		checkpoints: newCheckpointStore(),
	}
	r.registerAll()
	r.RestorePlans()
	return r
}

// NewRegistryWithStore creates a Registry backed by the given memory store.
func NewRegistryWithStore(cwd string, store *memory.Store) *Registry {
	return NewRegistryForUser(cwd, "", store)
}

// registerAll calls every per-tool init function to populate the registry.
func (r *Registry) registerAll() {
	// --- Core tools sent to the LLM (~25 tools) ---

	// File ops
	init_read_file(r)
	init_write_file(r)
	init_edit_file(r)
	init_multi_edit(r)
	init_list_dir(r)
	init_grep(r)
	init_glob(r)
	init_tree(r)

	// Shell
	init_shell(r)

	// Git
	init_git(r)

	// LSP
	init_lsp(r)
	init_read_lints(r)

	// Browser (navigate, screenshot, read)
	// init_browser(r) // removed for non-CGO builds

	// Context
	init_context(r)

	// Memory
	init_memory(r)

	// Meta
	init_checkpoint(r)

	// MCP
	init_mcp(r)

	// Web
	init_web_fetch(r)
	init_web_search(r)

	// Productivity
	init_todo_write(r)
	init_search_files(r)
	init_diff(r)
	init_batch_read(r)
	init_file_info(r)
	init_regex_replace(r)
	init_patch_file(r)
	init_cwd(r)
	init_notebook(r)
	init_ask_user(r)
	init_skill(r)
	init_brief(r)

	// Planning & Tasks
	init_plan_create(r)
	init_plan_update(r)
	init_plan_get(r)
	init_plan_complete(r)
	init_enter_plan_mode(r)
	init_exit_plan_mode(r)
	init_task_create(r)
	init_task_get(r)
	init_task_list(r)
	init_task_update(r)
	init_task_stop(r)
	init_task_output(r)

	// Worktree & Background
	init_worktree(r)
	init_background(r)

	// Meta / utility
	init_config(r)
	init_tool_search(r)
	init_sleep(r)
	init_synthetic_output(r)
}
