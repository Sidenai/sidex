package agent

import (
	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/usage"
)

// Conn abstracts a thread-safe websocket writer so the agent loop
// has no direct dependency on gorilla/websocket.
type Conn interface {
	WriteJSON(v interface{})
	// ReadJSON blocks until a JSON message arrives from the client.
	// Used for bidirectional flows like permission approval.
	ReadJSON(v interface{}) error
}

type Config struct {
	MaxTurns         int
	MaxSubTurns      int
	MaxConcurrency   int
	MaxContextTokens int
	ThinkingBudget   int
	Effort           string
	PermMode         PermissionMode
	Racing           RaceConfig
	Parallel         ParallelConfig
	PromptMode       string
	// SessionAllowed tracks tools the user chose "always allow" for this session.
	// Keyed by tool name. Nil means no session overrides.
	SessionAllowed map[string]bool
	// Hooks is the hook registry for this agent session. If nil, no hooks fire.
	Hooks *HookRegistry
	// AutoMode holds the safety classifier that auto-approves or blocks tool calls.
	// If nil, falls back to the standard permission system.
	AutoMode *AutoMode
	// Analytics provides optional event tracking (PostHog).
	// If nil, no analytics events are fired.
	Analytics AnalyticsTracker
	// UserID is the distinct_id used for analytics events.
	UserID string
	// SessionID is the session identifier for analytics events.
	SessionID string
	// LocalUsage records token spend on this machine for Settings → Usage.
	LocalUsage *usage.Service
	// CreditLimitUSD is the maximum credits for this session's billing period.
	// A value <= 0 means unlimited (no enforcement in RunLoop).
	CreditLimitUSD float64
	// CreditChecker is an optional callback that returns credits used so far.
	// If non-nil, RunLoop will call this each turn and stop when the limit is hit.
	CreditChecker func() (float64, error)
}

// AnalyticsTracker is an optional interface for firing analytics events
// from the agent loop without importing the analytics package directly.
type AnalyticsTracker interface {
	TrackAgentRequest(userID string, props map[string]interface{})
	TrackToolExecution(userID string, props map[string]interface{})
	TrackSessionEnd(userID string, props map[string]interface{})
	TrackError(userID string, props map[string]interface{})
}

func DefaultConfig() Config {
	return Config{
		MaxTurns:         25,
		MaxSubTurns:      15,
		MaxConcurrency:   10,
		MaxContextTokens: 180000,
		PermMode:         PermissionDefault,
		Racing:           DefaultRaceConfig(),
		Parallel:         DefaultParallelConfig(),
	}
}

type ToolExecutor interface {
	Execute(name string, argsJSON string) ToolResult
}

type ToolResult struct {
	Output string
	Error  string
}

// LocalExecRouter decides whether a tool call should be forwarded to the
// IDE client for local execution rather than running on the server.
type LocalExecRouter interface {
	ShouldRunLocal(toolName string) bool
	RunViaClient(tc ai.ToolCall) (output string, errStr string)
}

// AgentType defines a built-in subagent specialization.
type AgentType struct {
	Name        string
	Description string
	Model       string // empty = inherit parent model
	ReadOnly    bool
	MaxTurns    int
}

var BuiltInAgentTypes = map[string]AgentType{
	"general-purpose": {
		Name:        "general-purpose",
		Description: "Default agent. Full tool access. Use for research, search, and multi-step implementation.",
		MaxTurns:    15,
	},
	"explore": {
		Name:        "explore",
		Description: "Fast read-only codebase exploration. Cheap model, no write tools. Use for broad research when a simple grep isn't enough.",
		Model:       "fast",
		ReadOnly:    true,
		MaxTurns:    10,
	},
	"plan": {
		Name:        "plan",
		Description: "Architecture and implementation planning. Read-only. Produces a structured plan.",
		ReadOnly:    true,
		MaxTurns:    10,
	},
	"worker": {
		Name:        "worker",
		Description: "Focused implementation. Gets a specific task and full write tools. Cannot spawn sub-subagents.",
		MaxTurns:    15,
	},
	"verification": {
		Name:        "verification",
		Description: "Adversarial verification. Read-only. Reviews work done by other agents, runs tests, checks for regressions.",
		ReadOnly:    true,
		MaxTurns:    10,
	},
	"debug": {
		Name:        "debug",
		Description: "Structured debugging. Full tool access. Follows hypothesis-driven methodology: hypothesize, instrument, analyze, fix, verify, cleanup.",
		MaxTurns:    30,
	},
}

// ActiveSubAgent tracks a running subagent so it can be continued with send_message.
type ActiveSubAgent struct {
	ID       string
	Task     SubAgentTask
	Messages []ai.Message
	ToolReg  interface{} // *tools.Registry
	Done     bool
	Output   string
}

type SubAgentTask struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Context     string `json:"context,omitempty"`
	Type        string `json:"type,omitempty"`
}

type SubAgentResult struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Output      string `json:"output"`
	Error       string `json:"error,omitempty"`
	ToolCalls   int    `json:"tool_calls"`
	Turns       int    `json:"turns"`
}

var ReadOnlyTools = map[string]bool{
	"read_file": true, "list_dir": true, "search_files": true, "grep": true,
	"glob": true, "tree": true, "diff": true, "batch_read": true, "file_info": true,
	"git_status": true, "git_log": true, "git_diff_file": true,
	"web_fetch": true, "memory_search": true,
	"shell_output": true, "list_shells": true, "cwd": true,
	"lsp_hover": true, "lsp_definition": true,
	"lsp_references": true, "lsp_diagnostics": true,
	"read_lints":     true,
	"context_search": true, "context_status": true,
	"list_worktrees": true,
	"plan_get":       true,
}

var IdempotentTools = map[string]bool{
	"cwd": true, "git_status": true, "list_shells": true,
}

var LocalExecTools = map[string]bool{
	"cwd": true, "read_file": true, "write_file": true, "edit_file": true,
	"multi_edit": true, "regex_replace": true, "patch_file": true,
	"list_dir": true, "tree": true, "search_files": true, "glob": true,
	"grep": true, "batch_read": true, "file_info": true,
	"shell": true, "run_background": true, "shell_output": true,
	"kill_shell": true, "list_shells": true,
	"git_status": true, "git_log": true, "git_commit": true,
	"git_diff_file": true, "diff": true,
	"lsp_hover": true, "lsp_definition": true,
	"lsp_references": true, "lsp_diagnostics": true,
	"read_lints":    true,
	"context_index": true, "context_search": true, "context_status": true,
	"enter_worktree": true, "exit_worktree": true, "list_worktrees": true,
	"checkpoint": true, "rollback": true,
}
