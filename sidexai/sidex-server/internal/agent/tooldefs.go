package agent

import (
	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/tools"
)

// BuildToolDefs creates the full tool definition list for the AI model,
// combining tools from the registry with server-managed tools like spawn_agents.
func BuildToolDefs(reg *tools.Registry) []ai.ToolDef {
	defs := BuildToolDefsFromRegistry(reg)
	defs = append(defs, spawnAgentsDef(), sendMessageDef(), agentStatusDef(), parallelPlanExecuteDef())
	return defs
}

// BuildToolDefsFromRegistry converts the tool registry into API-ready ToolDef
// structs. Includes MCP tools if an MCP manager is attached.
func BuildToolDefsFromRegistry(reg *tools.Registry) []ai.ToolDef {
	var defs []ai.ToolDef
	for _, t := range reg.ListWithMCP() {
		defs = append(defs, ai.ToolDef{
			Type: "function",
			Function: ai.ToolFuncDef{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.Parameters,
			},
		})
	}
	return defs
}

func spawnAgentsDef() ai.ToolDef {
	return ai.ToolDef{
		Type: "function",
		Function: ai.ToolFuncDef{
			Name: "spawn_agents",
			Description: `Fan out work across parallel subagents. Each subagent runs its own AI conversation with full tool access and returns only a summary, keeping your main context clean.

Use this for: large multi-file research, bulk edits across many files, parallel searches, or independent subtasks that can run at the same time.

Do NOT use this for: tasks you can finish in one or two tool calls, or work where each step depends on the previous step's result.

Agent types: 'general-purpose' (default, full tools), 'explore' (fast read-only), 'plan' (architecture), 'worker' (focused implementation), 'verification' (adversarial review).

Limits: up to 100 tasks, 10 running concurrently. Subagents CANNOT spawn sub-subagents.`,
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"tasks": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"id":          map[string]interface{}{"type": "string", "description": "Short unique ID for this agent"},
								"description": map[string]interface{}{"type": "string", "description": "What this agent should do"},
								"context":     map[string]interface{}{"type": "string", "description": "Optional context/background info"},
								"type":        map[string]interface{}{"type": "string", "description": "Agent type: 'general-purpose' (default), 'explore' (fast read-only), 'plan' (architecture), 'worker' (focused implementation), 'verification' (adversarial review)."},
							},
							"required": []string{"description"},
						},
						"description": "Array of tasks to run in parallel",
					},
				},
				"required": []string{"tasks"},
			},
		},
	}
}

func sendMessageDef() ai.ToolDef {
	return ai.ToolDef{
		Type: "function",
		Function: ai.ToolFuncDef{
			Name: "send_message",
			Description: `Send a follow-up message to a previously spawned subagent. The agent continues its conversation from where it left off, preserving its full context and tool state.

Use this to: ask a subagent for clarification, give it additional instructions, or have it do more work based on its previous results.`,
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"agent_id": map[string]interface{}{"type": "string", "description": "The ID of the subagent to send a message to (from spawn_agents)"},
					"message":  map[string]interface{}{"type": "string", "description": "The follow-up message or instruction to send"},
				},
				"required": []string{"agent_id", "message"},
			},
		},
	}
}

func agentStatusDef() ai.ToolDef {
	return ai.ToolDef{
		Type: "function",
		Function: ai.ToolFuncDef{
			Name:        "agent_status",
			Description: `Check the status of one or all previously spawned subagents. Returns their current state, type, turn count, and output length.`,
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"agent_id": map[string]interface{}{"type": "string", "description": "Optional: ID of a specific agent to check. If omitted, returns status of all agents."},
				},
			},
		},
	}
}

func parallelPlanExecuteDef() ai.ToolDef {
	return ai.ToolDef{
		Type: "function",
		Function: ai.ToolFuncDef{
			Name: "parallel_plan_execute",
			Description: `Execute the active plan in parallel using git worktrees. Analyzes the plan's dependency graph to identify independent steps that can run concurrently.

Steps are grouped into "waves" — within each wave, all tasks run in parallel in isolated git worktrees. Waves execute sequentially (wave 2 starts after wave 1 finishes).

Requirements:
- An active plan must exist (created via plan_create)
- The plan must have 3+ steps with explicit depends_on declarations to identify parallelism
- Steps with no dependencies on each other run in the same wave
- After execution, worktree changes are merged back to the main branch

Use this when your plan has clearly independent work streams (e.g., "implement auth" and "add logging" don't touch the same files).`,
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"merge_strategy": map[string]interface{}{
						"type":        "string",
						"description": "How to merge results: 'sequential' (default, stop on failure), 'best-of-n' (continue despite failures), 'consensus' (require agreement).",
					},
					"max_parallel": map[string]interface{}{
						"type":        "number",
						"description": "Maximum concurrent tasks per wave (default: 3).",
					},
				},
			},
		},
	}
}
