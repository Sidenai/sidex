package agent

import (
	"encoding/json"
	"strings"
)

// PermissionMode controls how aggressively the agent asks for user approval.
type PermissionMode int

const (
	PermissionDefault   PermissionMode = iota // ask before edits + shell
	PermissionAutoEdits                       // auto-approve file edits, ask for shell
	PermissionPlanOnly                        // read-only tools only
	PermissionAutoAll                         // approve everything (yolo)
)

// PermissionDecision is the outcome of a permission check.
type PermissionDecision int

const (
	PermAllow PermissionDecision = iota
	PermDeny
	PermAsk
)

// PermissionRequest is sent to the client when user approval is needed.
type PermissionRequest struct {
	Type       string                 `json:"type"`
	ToolCallID string                 `json:"tool_call_id"`
	ToolName   string                 `json:"tool_name"`
	Args       map[string]interface{} `json:"args,omitempty"`
}

// PermissionResponse is received from the client.
type PermissionResponse struct {
	Type       string `json:"type"`
	ToolCallID string `json:"tool_call_id"`
	Approved   bool   `json:"approved"`
}

// CheckPermission decides whether a tool call should be allowed, denied,
// or needs user approval. This is called for every tool invocation and
// must be fast — no I/O, no allocations on the happy path.
func CheckPermission(toolName string, mode PermissionMode) PermissionDecision {
	if mode == PermissionPlanOnly {
		if IsReadOnlyTool(toolName) {
			return PermAllow
		}
		return PermDeny
	}

	if mode == PermissionAutoAll {
		return PermAllow
	}

	if IsReadOnlyTool(toolName) {
		return PermAllow
	}

	if isSafeMeta(toolName) {
		return PermAllow
	}

	if mode == PermissionAutoEdits {
		if isFileEdit(toolName) {
			return PermAllow
		}
		if isShellTool(toolName) {
			return PermAsk
		}
		if IsDangerousTool(toolName) {
			return PermAsk
		}
		return PermAllow
	}

	// PermissionDefault: ask for anything dangerous
	if IsDangerousTool(toolName) {
		return PermAsk
	}

	return PermAllow
}

// ParsePermissionMode converts a string from the client into a PermissionMode.
func ParsePermissionMode(s string) PermissionMode {
	switch strings.ToLower(s) {
	case "auto_edits", "autoedits", "auto-edits":
		return PermissionAutoEdits
	case "plan", "plan_only", "planonly":
		return PermissionPlanOnly
	case "auto", "auto_all", "autoall", "yolo":
		return PermissionAutoAll
	default:
		return PermissionDefault
	}
}

// PermissionModeString returns the wire name for a permission mode.
func PermissionModeString(m PermissionMode) string {
	switch m {
	case PermissionAutoEdits:
		return "auto_edits"
	case PermissionPlanOnly:
		return "plan_only"
	case PermissionAutoAll:
		return "auto_all"
	default:
		return "default"
	}
}

// NewPermissionRequest builds a PermissionRequest from a tool call.
// The args are parsed from the JSON arguments string; parse failures
// produce an empty map (the tool name alone is sufficient for the dialog).
func NewPermissionRequest(toolCallID, toolName, argsJSON string) PermissionRequest {
	var args map[string]interface{}
	if argsJSON != "" {
		_ = json.Unmarshal([]byte(argsJSON), &args)
	}
	return PermissionRequest{
		Type:       "permission_request",
		ToolCallID: toolCallID,
		ToolName:   toolName,
		Args:       args,
	}
}

// --- tool classification (all constant-time map lookups) ---

var fileEditTools = map[string]bool{
	"write_file":    true,
	"edit_file":     true,
	"multi_edit":    true,
	"patch_file":    true,
	"regex_replace": true,
	"notebook_edit": true,
}

var shellTools = map[string]bool{
	"shell":          true,
	"run_background": true,
	"kill_shell":     true,
}

var dangerousTools = map[string]bool{
	// File mutation
	"write_file":    true,
	"edit_file":     true,
	"multi_edit":    true,
	"patch_file":    true,
	"regex_replace": true,
	"notebook_edit": true,
	// Shell
	"shell":          true,
	"run_background": true,
	"kill_shell":     true,
	// Git writes
	"git_commit": true,
	// Worktree mutation
	"enter_worktree": true,
	"exit_worktree":  true,
	// Subagent orchestration: worker subagents get full write tools and
	// parallel_plan_execute merges branches — these must respect the
	// user's permission mode, never auto-approve.
	"spawn_agents":          true,
	"parallel_plan_execute": true,
}

// Safe meta-tools that should never require approval.
var safeMetaTools = map[string]bool{
	"todo_write":      true,
	"memory_store":    true,
	"ask_user":        true,
	"enter_plan_mode": true,
	"exit_plan_mode":  true,
	"brief":           true,
	"sleep":           true,
	"config":          true,
	"skill":           true,
	"tool_search":     true,
	"web_search":      true,
	"web_fetch":       true,
	"task_create":     true,
	"task_get":        true,
	"task_list":       true,
	"task_update":     true,
	"task_stop":       true,
	"task_output":     true,
	"send_message":    true,
	"agent_status":    true,
}

func IsReadOnlyTool(name string) bool  { return ReadOnlyTools[name] }
func IsDangerousTool(name string) bool { return dangerousTools[name] }
func isFileEdit(name string) bool      { return fileEditTools[name] }
func isShellTool(name string) bool     { return shellTools[name] }
func isSafeMeta(name string) bool      { return safeMetaTools[name] }
