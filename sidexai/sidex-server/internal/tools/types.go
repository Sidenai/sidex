package tools

import (
	"time"

	"github.com/sidex-ai/sidex-server/internal/apply"
	"github.com/sidex-ai/sidex-server/internal/index"
	"github.com/sidex-ai/sidex-server/internal/mcp"
	"github.com/sidex-ai/sidex-server/internal/memory"
)

// Tool defines a tool that the AI agent can invoke.
type Tool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
	Dangerous   bool                   `json:"dangerous"`
}

// ExecutionResult holds the output or error from running a tool.
type ExecutionResult struct {
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

type fileReadState struct {
	mtime  time.Time
	readAt time.Time
}

// TodoItem represents a task in the agent's working todo list.
type TodoItem struct {
	ID         string `json:"id"`
	Content    string `json:"content"`
	ActiveForm string `json:"activeForm,omitempty"`
	Status     string `json:"status"`
}

// WorktreeState tracks an active git worktree session.
type WorktreeState struct {
	OriginalCwd string // workspace root before entering the worktree
	WorktreeCwd string // absolute path to the worktree directory
	Branch      string // branch name created for the worktree
}

// Registry holds all registered tools and shared state for a session.
type Registry struct {
	tools        map[string]Tool
	cwd          string
	UserID       string
	store        *memory.Store
	readState    map[string]fileReadState
	Todos        []TodoItem
	Plans        *PlanStore
	bg           *BackgroundMgr
	TaskStore    *TaskStore
	Sandbox      *Sandbox       // non-nil enables Docker-isolated shell execution
	Worktree     *WorktreeState // non-nil when inside an active worktree
	MCP          *mcp.MCPManager
	checkpoints  *CheckpointStore
	FastApply    *apply.ApplyModel // optional fast-apply model for fuzzy edits
	IndexService interface {
		Search(namespace string, query string, topK int) ([]index.SearchResult, error)
		HybridSearch(namespace string, query string, topK int, workDir string) ([]index.SearchResult, error)
		RecordRead(namespace, path string)
		Status(namespace string) index.IndexStatus
	}

	// Bug-fix quality tracking
	hasEditedSourceFile bool
	testOnlyEditCount   int
}
