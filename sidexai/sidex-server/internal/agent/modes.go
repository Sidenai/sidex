package agent

import "github.com/sidex-ai/sidex-server/internal/ai"

type AgentMode string

const (
	ModeAgent     AgentMode = "agent"     // Default — full tool access, autonomous execution
	ModePlan      AgentMode = "plan"      // Read-only — explore and propose, no writes
	ModeAsk       AgentMode = "ask"       // Read-only — answer questions, minimal tool use
	ModeProactive AgentMode = "proactive" // Autonomous — agent stays alive and ticks periodically
	ModeDebug     AgentMode = "debug"     // Structured debugging — hypothesize, instrument, fix
)

// PlanModeReadOnlyTools are the ONLY tools available in plan mode.
// Plan mode must be able to use the planner tools and semantic search —
// the plan prompt mandates them.
var PlanModeReadOnlyTools = map[string]bool{
	"read_file": true, "list_dir": true, "search_files": true, "grep": true,
	"glob": true, "tree": true, "diff": true, "batch_read": true, "file_info": true,
	"git_status": true, "git_log": true, "git_diff_file": true,
	"web_fetch": true, "web_search": true, "memory_search": true,
	"shell_output": true, "list_shells": true, "cwd": true,
	// Semantic codebase search + status
	"context_search": true, "context_status": true,
	// LSP and diagnostics (read-only)
	"lsp_hover": true, "lsp_definition": true, "lsp_references": true,
	"lsp_diagnostics": true, "read_lints": true,
	// Planning tools — required to actually produce/update a plan
	"plan_create": true, "plan_update": true, "plan_get": true,
	"todo_write": true, "ask_user": true,
	// Exiting plan mode is gated by user approval in the handler
	"exit_plan_mode": true,
}

// askModeExcluded are tools removed from ASK mode on top of the read-only
// filter. Ask mode must never self-escalate to write access.
var askModeExcluded = map[string]bool{
	"exit_plan_mode": true,
	"plan_create":    true,
	"plan_update":    true,
}

// FilterToolDefs returns only the tools allowed in the given mode.
// Agent, debug, and proactive modes get full tool access (debug/proactive
// must be able to instrument and fix); plan and ask are read-only.
func FilterToolDefs(defs []ai.ToolDef, mode AgentMode) []ai.ToolDef {
	switch mode {
	case ModeAgent, ModeDebug, ModeProactive:
		return defs
	}
	filtered := make([]ai.ToolDef, 0)
	for _, d := range defs {
		if !PlanModeReadOnlyTools[d.Function.Name] {
			continue
		}
		if mode == ModeAsk && askModeExcluded[d.Function.Name] {
			continue
		}
		filtered = append(filtered, d)
	}
	return filtered
}

// IsToolAllowedInMode enforces mode restrictions at execution time. Tool
// definitions are only a prompt hint; model/tool-call bugs must not bypass
// read-only modes.
func IsToolAllowedInMode(toolName string, mode AgentMode) bool {
	switch mode {
	case ModeAgent, ModeDebug, ModeProactive, "":
		return true
	case ModeAsk:
		return PlanModeReadOnlyTools[toolName] && !askModeExcluded[toolName]
	case ModePlan:
		return PlanModeReadOnlyTools[toolName]
	default:
		return false
	}
}

// PlanModePromptSuffix is appended to the system prompt when in plan mode.
func PlanModePromptSuffix() string {
	return `

# Current Mode: Plan

You are in PLAN mode. You can read, search, and analyze the codebase, but you CANNOT modify files, run commands, or make commits. Your job is to:
1. Understand the codebase thoroughly using read-only tools (read_file, grep, glob, context_search, lsp_*)
2. Propose a clear, step-by-step plan with specific files and changes
3. Call exit_plan_mode with your final plan in the "plan" parameter — the user will be shown the plan and asked to approve it

Do NOT describe what you would do hypothetically — use tools to gather real information, then propose based on what you found. If the user rejects your plan, refine it based on their feedback and call exit_plan_mode again when ready.`
}

// AskModePromptSuffix is appended when in ask mode.
func AskModePromptSuffix() string {
	return `

# Current Mode: Ask

You are in ASK mode. Answer the user's question using read-only tools if needed for context. Do NOT modify files or run commands, and do not attempt to switch modes — the user controls the mode. Be direct and concise.`
}
