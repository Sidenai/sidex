package agent

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/compress"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/tools"
)

// HandleSpawnAgents parses the spawn_agents tool call, fans out N subagent
// goroutines, collects results, and returns a summarized output string for
// the parent agent's context.
func HandleSpawnAgents(conn Conn, parentCWD string, tc ai.ToolCall, aiClient *ai.Client, store *memory.Store, activeAgents map[string]*ActiveSubAgent, cfg Config, local LocalExecRouter) string {
	var args struct {
		Tasks []SubAgentTask `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
		return "ERROR: invalid spawn_agents arguments: " + err.Error()
	}
	if len(args.Tasks) == 0 {
		return "ERROR: no tasks provided"
	}
	if len(args.Tasks) > 100 {
		args.Tasks = args.Tasks[:100]
	}

	conn.WriteJSON(ai.StreamChunk{
		Type:    "subagent_start",
		Content: fmt.Sprintf("Spawning %d subagents...", len(args.Tasks)),
	})

	for i := range args.Tasks {
		if args.Tasks[i].ID == "" {
			args.Tasks[i].ID = fmt.Sprintf("agent_%d", i+1)
		}
	}

	results := make([]SubAgentResult, len(args.Tasks))
	var wg sync.WaitGroup
	sem := make(chan struct{}, cfg.MaxConcurrency)

	for i, task := range args.Tasks {
		wg.Add(1)
		go func(idx int, t SubAgentTask) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			agentType := resolveAgentType(t.Type)
			conn.WriteJSON(ai.StreamChunk{
				Type:    "subagent_running",
				Content: fmt.Sprintf("[%s] (%s) %s", t.ID, agentType.Name, t.Description),
			})

			res, active := RunSubAgent(conn, parentCWD, t, aiClient, store, cfg, local)
			results[idx] = res

			if activeAgents != nil {
				activeAgents[t.ID] = active
			}

			status := "done"
			if res.Error != "" {
				status = "failed"
			}
			conn.WriteJSON(ai.StreamChunk{
				Type:    "subagent_done",
				Content: fmt.Sprintf("[%s] %s %s (%d tools, %d turns)", t.ID, status, t.Description, res.ToolCalls, res.Turns),
			})
		}(i, task)
	}

	wg.Wait()

	conn.WriteJSON(ai.StreamChunk{
		Type:    "subagent_complete",
		Content: fmt.Sprintf("All %d subagents finished.", len(args.Tasks)),
	})

	var summary strings.Builder
	summary.WriteString(fmt.Sprintf("=== %d Subagent Results ===\n\n", len(results)))
	for _, r := range results {
		summary.WriteString(fmt.Sprintf("--- [%s] %s ---\n", r.ID, r.Description))
		if r.Error != "" {
			summary.WriteString(fmt.Sprintf("ERROR: %s\n", r.Error))
		} else {
			out := r.Output
			if len(out) > 2000 {
				out = compress.SummarizeToolOutput(out, 2000)
			}
			summary.WriteString(out)
		}
		summary.WriteString(fmt.Sprintf("\n(tools: %d, turns: %d)\n\n", r.ToolCalls, r.Turns))
	}

	return summary.String()
}

// RunSubAgent executes a single subagent's AI conversation loop with its own
// isolated message history, tool registry, and system prompt.
// It returns both the result and an ActiveSubAgent that can be continued via send_message.
func RunSubAgent(conn Conn, cwd string, task SubAgentTask, aiClient *ai.Client, store *memory.Store, cfg Config, local LocalExecRouter) (SubAgentResult, *ActiveSubAgent) {
	agentType := resolveAgentType(task.Type)
	reg := tools.NewRegistryWithStore(cwd, store)
	sysPrompt := buildSubAgentPrompt(cwd, agentType)

	userMsg := task.Description
	if task.Context != "" {
		userMsg = task.Context + "\n\nTask: " + task.Description
	}

	messages := []ai.Message{{Role: ai.RoleUser, Content: userMsg}}

	allToolDefs := BuildToolDefsFromRegistry(reg)
	if agentType.ReadOnly {
		allToolDefs = filterReadOnlyDefs(allToolDefs)
	}

	maxTurns := agentType.MaxTurns
	if maxTurns <= 0 {
		maxTurns = cfg.MaxSubTurns
	}

	var totalToolCalls int
	var lastText string

	for turn := 0; turn < maxTurns; turn++ {
		var text string
		var pendingCalls []ai.ToolCall
		hadCalls := false

		compressed := compressPipeline(messages, compress.MaxContextTokens)

		err := aiClient.StreamChat(compressed, allToolDefs, sysPrompt, func(chunk ai.StreamChunk) {
			switch chunk.Type {
			case "text":
				text += chunk.Content
			case "tool_call":
				hadCalls = true
				pendingCalls = append(pendingCalls, chunk.ToolCalls...)
			}
		})

		if err != nil {
			return SubAgentResult{ID: task.ID, Description: task.Description, Error: err.Error(), ToolCalls: totalToolCalls, Turns: turn + 1},
				&ActiveSubAgent{ID: task.ID, Task: task, Messages: messages, ToolReg: reg, Done: true}
		}

		if text != "" && !hadCalls {
			messages = append(messages, ai.Message{Role: ai.RoleAssistant, Content: text})
			return SubAgentResult{ID: task.ID, Description: task.Description, Output: text, ToolCalls: totalToolCalls, Turns: turn + 1},
				&ActiveSubAgent{ID: task.ID, Task: task, Messages: messages, ToolReg: reg, Done: true, Output: text}
		}

		if hadCalls {
			messages = append(messages, ai.Message{Role: ai.RoleAssistant, Content: text, ToolCalls: pendingCalls})
			lastText = text

			for _, tc := range pendingCalls {
				if tc.Function.Name == "spawn_agents" || tc.Function.Name == "send_message" || tc.Function.Name == "agent_status" {
					messages = append(messages, ai.Message{Role: ai.RoleTool, Content: "ERROR: subagents cannot use " + tc.Function.Name, ToolCallID: tc.ID, Name: tc.Function.Name})
					continue
				}

				if agentType.ReadOnly && !ReadOnlyTools[tc.Function.Name] {
					messages = append(messages, ai.Message{Role: ai.RoleTool, Content: "ERROR: this agent type is read-only and cannot use " + tc.Function.Name, ToolCallID: tc.ID, Name: tc.Function.Name})
					continue
				}

				totalToolCalls++
				var output string
				if local != nil && local.ShouldRunLocal(tc.Function.Name) {
					out, errStr := local.RunViaClient(tc)
					if errStr != "" {
						output = "ERROR: " + errStr
					} else {
						output = out
					}
				} else {
					result := reg.Execute(tc.Function.Name, tc.Function.Arguments)
					output = result.Output
					if result.Error != "" {
						output = "ERROR: " + result.Error
					}
				}
				if len(output) > 30000 {
					output = compress.SummarizeToolOutput(output, 30000)
				}

				conn.WriteJSON(ai.StreamChunk{
					Type:    "subagent_tool",
					Content: fmt.Sprintf("[%s] %s", task.ID, tc.Function.Name),
				})

				messages = append(messages, ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
			}
			continue
		}

		break
	}

	output := lastText
	if output == "" {
		return SubAgentResult{ID: task.ID, Description: task.Description, Error: "no output produced", ToolCalls: totalToolCalls, Turns: maxTurns},
			&ActiveSubAgent{ID: task.ID, Task: task, Messages: messages, ToolReg: reg, Done: true}
	}
	return SubAgentResult{ID: task.ID, Description: task.Description, Output: output, ToolCalls: totalToolCalls, Turns: maxTurns},
		&ActiveSubAgent{ID: task.ID, Task: task, Messages: messages, ToolReg: reg, Done: true, Output: output}
}

// HandleSendMessage continues a previously-spawned subagent's conversation.
func HandleSendMessage(conn Conn, tc ai.ToolCall, aiClient *ai.Client, store *memory.Store, activeAgents map[string]*ActiveSubAgent, cfg Config) string {
	var args struct {
		AgentID string `json:"agent_id"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
		return "ERROR: invalid send_message arguments: " + err.Error()
	}
	if args.AgentID == "" {
		return "ERROR: agent_id is required"
	}
	if args.Message == "" {
		return "ERROR: message is required"
	}

	agent, ok := activeAgents[args.AgentID]
	if !ok {
		return fmt.Sprintf("ERROR: no agent found with id %q", args.AgentID)
	}

	agentType := resolveAgentType(agent.Task.Type)
	reg, ok := agent.ToolReg.(*tools.Registry)
	if !ok {
		return "ERROR: agent has invalid tool registry"
	}

	agent.Messages = append(agent.Messages, ai.Message{Role: ai.RoleUser, Content: args.Message})
	agent.Done = false

	sysPrompt := buildSubAgentPrompt(".", agentType)

	allToolDefs := BuildToolDefsFromRegistry(reg)
	if agentType.ReadOnly {
		allToolDefs = filterReadOnlyDefs(allToolDefs)
	}

	maxTurns := agentType.MaxTurns
	if maxTurns <= 0 {
		maxTurns = cfg.MaxSubTurns
	}

	conn.WriteJSON(ai.StreamChunk{
		Type:    "subagent_running",
		Content: fmt.Sprintf("[%s] continuing: %s", args.AgentID, args.Message),
	})

	var totalToolCalls int
	var lastText string

	for turn := 0; turn < maxTurns; turn++ {
		var text string
		var pendingCalls []ai.ToolCall
		hadCalls := false

		compressedMsgs := compressPipeline(agent.Messages, compress.MaxContextTokens)

		err := aiClient.StreamChat(compressedMsgs, allToolDefs, sysPrompt, func(chunk ai.StreamChunk) {
			switch chunk.Type {
			case "text":
				text += chunk.Content
			case "tool_call":
				hadCalls = true
				pendingCalls = append(pendingCalls, chunk.ToolCalls...)
			}
		})

		if err != nil {
			agent.Done = true
			return fmt.Sprintf("ERROR: agent %s API error: %s", args.AgentID, err.Error())
		}

		if text != "" && !hadCalls {
			agent.Messages = append(agent.Messages, ai.Message{Role: ai.RoleAssistant, Content: text})
			agent.Done = true
			agent.Output = text
			return text
		}

		if hadCalls {
			agent.Messages = append(agent.Messages, ai.Message{Role: ai.RoleAssistant, Content: text, ToolCalls: pendingCalls})
			lastText = text

			for _, tc := range pendingCalls {
				if tc.Function.Name == "spawn_agents" || tc.Function.Name == "send_message" || tc.Function.Name == "agent_status" {
					agent.Messages = append(agent.Messages, ai.Message{Role: ai.RoleTool, Content: "ERROR: subagents cannot use " + tc.Function.Name, ToolCallID: tc.ID, Name: tc.Function.Name})
					continue
				}

				if agentType.ReadOnly && !ReadOnlyTools[tc.Function.Name] {
					agent.Messages = append(agent.Messages, ai.Message{Role: ai.RoleTool, Content: "ERROR: read-only agent cannot use " + tc.Function.Name, ToolCallID: tc.ID, Name: tc.Function.Name})
					continue
				}

				totalToolCalls++
				result := reg.Execute(tc.Function.Name, tc.Function.Arguments)
				output := result.Output
				if result.Error != "" {
					output = "ERROR: " + result.Error
				}
				if len(output) > 30000 {
					output = compress.SummarizeToolOutput(output, 30000)
				}

				conn.WriteJSON(ai.StreamChunk{
					Type:    "subagent_tool",
					Content: fmt.Sprintf("[%s] %s", args.AgentID, tc.Function.Name),
				})

				agent.Messages = append(agent.Messages, ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
			}
			continue
		}

		break
	}

	agent.Done = true
	if lastText != "" {
		agent.Output = lastText
		return lastText
	}
	return fmt.Sprintf("Agent %s produced no new output after %d turns.", args.AgentID, maxTurns)
}

// HandleAgentStatus returns the status of one or all active subagents.
func HandleAgentStatus(tc ai.ToolCall, activeAgents map[string]*ActiveSubAgent) string {
	var args struct {
		AgentID string `json:"agent_id"`
	}
	_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)

	if args.AgentID != "" {
		agent, ok := activeAgents[args.AgentID]
		if !ok {
			return fmt.Sprintf("ERROR: no agent found with id %q", args.AgentID)
		}
		status := "idle"
		if agent.Done {
			status = "done"
		}
		return fmt.Sprintf("Agent %s (%s): status=%s, type=%s, turns=%d, output_len=%d",
			agent.ID, agent.Task.Description, status, agent.Task.Type, len(agent.Messages)/2, len(agent.Output))
	}

	if len(activeAgents) == 0 {
		return "No active subagents."
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%d subagent(s):\n", len(activeAgents)))
	for id, agent := range activeAgents {
		status := "idle"
		if agent.Done {
			status = "done"
		}
		sb.WriteString(fmt.Sprintf("  [%s] %s (type=%s, status=%s)\n", id, agent.Task.Description, agent.Task.Type, status))
	}
	return sb.String()
}

func resolveAgentType(typeName string) AgentType {
	if typeName == "" {
		typeName = "general-purpose"
	}
	if at, ok := BuiltInAgentTypes[typeName]; ok {
		return at
	}
	return BuiltInAgentTypes["general-purpose"]
}

func filterReadOnlyDefs(defs []ai.ToolDef) []ai.ToolDef {
	var filtered []ai.ToolDef
	for _, d := range defs {
		if ReadOnlyTools[d.Function.Name] {
			filtered = append(filtered, d)
		}
	}
	return filtered
}

func buildSubAgentPrompt(cwd string, agentType AgentType) string {
	switch agentType.Name {
	case "explore":
		return fmt.Sprintf(`You are a fast, read-only exploration agent for the Sidex AI coding assistant. Your job is to find information in the codebase quickly and report back.

# Rules
- Use read-only tools only: read_file, grep, glob, tree, list_dir, search_files, batch_read, file_info, git_status, git_log, git_diff_file, web_fetch, memory_search.
- Be thorough but fast. Search broadly, then narrow down.
- Return a concise summary of what you found.
- You cannot modify files or run commands.

Working directory: %s`, cwd)

	case "plan":
		return fmt.Sprintf(`You are an architecture and planning agent for the Sidex AI coding assistant. Your job is to analyze the codebase and produce a structured implementation plan.

# Rules
- Use read-only tools to understand the codebase. Do NOT modify any files.
- Produce a clear, actionable plan with numbered steps.
- Identify files that need to change, what changes are needed, and any risks.
- Consider edge cases and testing requirements.

Working directory: %s`, cwd)

	case "verification":
		return fmt.Sprintf(`You are an adversarial verification agent for the Sidex AI coding assistant. Your job is to critically review work done by other agents.

# Rules
- Use read-only tools to inspect the codebase.
- Look for bugs, regressions, missing edge cases, and style issues.
- Run tests if available (you can read test files and check if they pass via grep/search).
- Be skeptical. Assume changes might have introduced problems.
- Report issues clearly with file paths and line numbers.
- You cannot modify files.

Working directory: %s`, cwd)

	case "worker":
		return fmt.Sprintf(`You are a focused worker agent for the Sidex AI coding assistant. Complete the assigned task autonomously and return only the result.

# Rules
- Use tools to accomplish the task. Do not just describe what you would do.
- Read files before editing them so you can provide exact old_string matches for edit_file.
- Be concise in your final response. Summarize what you did and the result.
- If a tool fails, try a different approach. Do not give up after one failure.
- You cannot spawn sub-subagents. Do the work directly.
- Focus on your specific task. Do not go beyond scope.

Working directory: %s`, cwd)

	default:
		return fmt.Sprintf(`You are a focused subagent for the Sidex AI coding assistant. Complete the assigned task autonomously and return only the result.

# Rules
- Use tools to accomplish the task. Do not just describe what you would do.
- Read files before editing them so you can provide exact old_string matches for edit_file.
- Be concise in your final response. Summarize what you did and the result.
- If a tool fails, try a different approach. Do not give up after one failure.
- You cannot spawn sub-subagents. Do the work directly.

# Tools Available
File ops: read_file, write_file, edit_file, multi_edit, batch_read, file_info
Search: grep, glob, search_files
Navigation: list_dir, tree, cwd
Execution: shell (30s timeout), run_background / shell_output / kill_shell
Git: git_status, git_log, git_commit, git_diff_file, diff
Web: web_fetch
Memory: memory_store, memory_search

Working directory: %s`, cwd)
	}
}
