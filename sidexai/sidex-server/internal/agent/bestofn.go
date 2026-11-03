package agent

import (
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/compress"
	"github.com/sidex-ai/sidex-server/internal/cost"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/tools"
)

type BestOfNConfig struct {
	Task   string
	Models []string
}

type BestOfNResult struct {
	Model       string
	ModelName   string
	Branch      string
	WorktreeDir string
	Output      string
	Diff        string
	Duration    time.Duration
	TokensUsed  int
	Cost        float64
	Success     bool
	Error       string
}

// ResolveModelID maps a short alias (e.g. "opus", "sonnet-4.6") to the full
// model ID from cost.Models.  If no match is found the input is
// returned as-is so callers can pass full IDs directly.
func ResolveModelID(alias string) (id string, displayName string) {
	lower := strings.ToLower(strings.TrimSpace(alias))
	for _, m := range cost.Models {
		nameLower := strings.ToLower(m.Name)
		idLower := strings.ToLower(m.ID)

		if lower == idLower || lower == nameLower {
			return m.ID, m.Name
		}
		// Substring match: "opus" matches "Claude Opus 4.7", "sonnet-4.6" etc.
		normalized := strings.ReplaceAll(lower, "-", " ")
		normalized = strings.ReplaceAll(normalized, ".", " ")
		nameNorm := strings.ReplaceAll(nameLower, ".", " ")
		nameNorm = strings.ReplaceAll(nameNorm, "-", " ")
		if strings.Contains(nameNorm, normalized) {
			return m.ID, m.Name
		}
		if strings.Contains(idLower, lower) {
			return m.ID, m.Name
		}
	}
	return alias, alias
}

// ParseBestOfN extracts the model list and task from a "/best-of-n" user
// message. Returns ok=false if the message is not a best-of-n command.
func ParseBestOfN(msg string) (cfg BestOfNConfig, ok bool) {
	trimmed := strings.TrimSpace(msg)
	if !strings.HasPrefix(strings.ToLower(trimmed), "/best-of-n") {
		return BestOfNConfig{}, false
	}

	rest := strings.TrimSpace(trimmed[len("/best-of-n"):])
	if rest == "" {
		return BestOfNConfig{}, false
	}

	parts := strings.SplitN(rest, " ", 2)
	if len(parts) < 2 || parts[1] == "" {
		return BestOfNConfig{}, false
	}

	modelCSV := parts[0]
	task := strings.TrimSpace(parts[1])

	var models []string
	for _, raw := range strings.Split(modelCSV, ",") {
		raw = strings.TrimSpace(raw)
		if raw != "" {
			models = append(models, raw)
		}
	}
	if len(models) == 0 {
		return BestOfNConfig{}, false
	}

	return BestOfNConfig{Task: task, Models: models}, true
}

// RunBestOfN creates isolated git worktrees for each model, runs the task in
// parallel, collects results, and streams a comparison table to the client.
func RunBestOfN(
	cfg BestOfNConfig,
	conn Conn,
	cwd string,
	aiClient *ai.Client,
	store *memory.Store,
	baseCfg Config,
) []BestOfNResult {
	results := make([]BestOfNResult, len(cfg.Models))
	var wg sync.WaitGroup

	conn.WriteJSON(ai.StreamChunk{
		Type:    "text",
		Content: fmt.Sprintf("## Best-of-N: launching %d parallel attempts\n\n", len(cfg.Models)),
	})

	for i, rawModel := range cfg.Models {
		modelID, displayName := ResolveModelID(rawModel)
		results[i].Model = modelID
		results[i].ModelName = displayName

		conn.WriteJSON(ai.StreamChunk{
			Type:    "bestofn_start",
			Content: fmt.Sprintf("[%d/%d] %s — creating worktree...", i+1, len(cfg.Models), displayName),
		})

		wg.Add(1)
		go func(idx int, modelID, displayName string) {
			defer wg.Done()
			results[idx] = runSingleAttempt(cfg.Task, modelID, displayName, cwd, conn, aiClient, store, baseCfg, idx)
		}(i, modelID, displayName)
	}

	wg.Wait()

	conn.WriteJSON(ai.StreamChunk{
		Type:    "bestofn_all_done",
		Content: fmt.Sprintf("All %d attempts finished.", len(cfg.Models)),
	})

	comparison := FormatComparison(results)
	conn.WriteJSON(ai.StreamChunk{Type: "text", Content: comparison})
	conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})

	return results
}

func runSingleAttempt(
	task, modelID, displayName, cwd string,
	conn Conn,
	aiClient *ai.Client,
	store *memory.Store,
	baseCfg Config,
	idx int,
) BestOfNResult {
	start := time.Now()
	result := BestOfNResult{
		Model:     modelID,
		ModelName: displayName,
	}

	reg := tools.NewRegistryWithStore(cwd, store)
	defer reg.Cleanup()

	wtResult := reg.Execute("enter_worktree", fmt.Sprintf(`{"branch":"bestofn-%d"}`, idx))
	if wtResult.Error != "" {
		result.Error = "worktree creation failed: " + wtResult.Error
		result.Duration = time.Since(start)
		conn.WriteJSON(ai.StreamChunk{
			Type:    "bestofn_error",
			Content: fmt.Sprintf("[%s] %s", displayName, result.Error),
		})
		return result
	}
	result.Branch = extractBranch(wtResult.Output)
	result.WorktreeDir = extractWorktreeDir(wtResult.Output)

	conn.WriteJSON(ai.StreamChunk{
		Type:    "bestofn_running",
		Content: fmt.Sprintf("[%s] worktree ready, running task with %s...", displayName, displayName),
	})

	client := aiClient.WithModel(modelID)
	tracker := cost.NewTracker(modelID)

	allToolDefs := BuildToolDefsFromRegistry(reg)
	sysPrompt := buildBestOfNPrompt(cwd, displayName)

	messages := []ai.Message{{Role: ai.RoleUser, Content: task}}

	maxTurns := baseCfg.MaxSubTurns
	if maxTurns <= 0 {
		maxTurns = 15
	}

	var lastText string
	var totalToolCalls int

	for turn := 0; turn < maxTurns; turn++ {
		var text string
		var pendingCalls []ai.ToolCall
		hadCalls := false

		compressed := compressPipeline(messages, compress.MaxContextTokens)

		err := client.StreamChat(compressed, allToolDefs, sysPrompt, func(chunk ai.StreamChunk) {
			switch chunk.Type {
			case "text":
				text += chunk.Content
			case "tool_call":
				hadCalls = true
				pendingCalls = append(pendingCalls, chunk.ToolCalls...)
			case "usage":
				if chunk.TokensUsed != nil {
					tracker.Add(modelID, chunk.TokensUsed.PromptTokens, chunk.TokensUsed.CompletionTokens, chunk.TokensUsed.CacheCreationInputTokens, chunk.TokensUsed.CacheReadInputTokens)
				}
			}
		})

		if err != nil {
			result.Error = err.Error()
			break
		}

		if text != "" && !hadCalls {
			messages = append(messages, ai.Message{Role: ai.RoleAssistant, Content: text})
			lastText = text
			break
		}

		if hadCalls {
			messages = append(messages, ai.Message{Role: ai.RoleAssistant, Content: text, ToolCalls: pendingCalls})
			lastText = text

			for _, tc := range pendingCalls {
				if tc.Function.Name == "spawn_agents" || tc.Function.Name == "send_message" || tc.Function.Name == "agent_status" {
					messages = append(messages, ai.Message{Role: ai.RoleTool, Content: "ERROR: best-of-n runners cannot use " + tc.Function.Name, ToolCallID: tc.ID, Name: tc.Function.Name})
					continue
				}
				if tc.Function.Name == "exit_worktree" {
					messages = append(messages, ai.Message{Role: ai.RoleTool, Content: "ERROR: cannot exit worktree during best-of-n run", ToolCallID: tc.ID, Name: tc.Function.Name})
					continue
				}

				totalToolCalls++
				execResult := reg.Execute(tc.Function.Name, tc.Function.Arguments)
				output := execResult.Output
				if execResult.Error != "" {
					output = "ERROR: " + execResult.Error
				}
				if len(output) > 30000 {
					output = compress.SummarizeToolOutput(output, 30000)
				}

				conn.WriteJSON(ai.StreamChunk{
					Type:    "bestofn_tool",
					Content: fmt.Sprintf("[%s] %s", displayName, tc.Function.Name),
				})

				messages = append(messages, ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
			}
			continue
		}

		break
	}

	result.Output = lastText
	result.Duration = time.Since(start)
	result.TokensUsed = tracker.TotalUsage().InputTokens + tracker.TotalUsage().OutputTokens
	result.Cost = tracker.TotalCost()
	result.Success = result.Error == ""

	if result.Success {
		result.Diff = captureWorktreeDiff(result.WorktreeDir)
	}

	status := "completed"
	if !result.Success {
		status = "failed"
	}
	conn.WriteJSON(ai.StreamChunk{
		Type: "bestofn_done",
		Content: fmt.Sprintf("[%s] %s in %s ($%.4f, %d tokens, %d tools)",
			displayName, status, result.Duration.Round(time.Millisecond), result.Cost, result.TokensUsed, totalToolCalls),
	})

	return result
}

func captureWorktreeDiff(wtDir string) string {
	if wtDir == "" {
		return ""
	}
	cmd := exec.Command("git", "diff", "HEAD")
	cmd.Dir = wtDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		staged := exec.Command("git", "diff", "--cached")
		staged.Dir = wtDir
		sOut, _ := staged.CombinedOutput()
		return string(sOut)
	}
	return string(out)
}

func extractBranch(output string) string {
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "branch:") {
			return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "branch:"))
		}
	}
	return ""
}

func extractWorktreeDir(output string) string {
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "path:") {
			return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "path:"))
		}
	}
	return ""
}

func buildBestOfNPrompt(cwd, modelName string) string {
	return fmt.Sprintf(`You are a focused coding agent running as part of a best-of-N comparison. Your output will be compared against other models attempting the same task.

# Rules
- Complete the task fully and correctly. Quality matters — your work will be judged.
- Use tools to read files before editing them.
- Be thorough but efficient. Don't waste tokens on narration.
- You are working in an isolated git worktree. All changes are safe to make.
- You cannot spawn subagents, exit the worktree, or send messages to other agents.
- When done, provide a brief summary of what you did.

Working directory: %s
Model: %s`, cwd, modelName)
}

// FormatComparison builds the markdown comparison table sent to the client.
func FormatComparison(results []BestOfNResult) string {
	var sb strings.Builder
	sb.WriteString("\n\n## Best-of-N Results\n\n")
	sb.WriteString("| # | Model | Time | Tokens | Cost | Status |\n")
	sb.WriteString("|---|-------|------|--------|------|--------|\n")

	var bestIdx int
	var bestScore float64 = -1

	for i, r := range results {
		status := "Completed"
		if !r.Success {
			status = fmt.Sprintf("Failed (%s)", truncateError(r.Error, 40))
		}
		sb.WriteString(fmt.Sprintf("| %d | %s | %s | %s | $%.4f | %s |\n",
			i+1,
			r.ModelName,
			r.Duration.Round(time.Millisecond).String(),
			formatTokens(r.TokensUsed),
			r.Cost,
			status,
		))

		if r.Success {
			score := scoreResult(r)
			if score > bestScore {
				bestScore = score
				bestIdx = i
			}
		}
	}

	sb.WriteString("\n")

	if bestScore >= 0 {
		best := results[bestIdx]
		sb.WriteString(fmt.Sprintf("**Recommendation:** %s produced the best result (completed in %s for $%.4f).\n\n",
			best.ModelName, best.Duration.Round(time.Millisecond), best.Cost))

		sb.WriteString("### Worktree branches\n\n")
		for i, r := range results {
			if r.Branch != "" {
				action := "inspect"
				if i == bestIdx {
					action = "**recommended**"
				}
				sb.WriteString(fmt.Sprintf("- `%s` (%s) — %s\n", r.Branch, r.ModelName, action))
			}
		}

		sb.WriteString("\n### Diffs\n\n")
		for _, r := range results {
			if r.Diff != "" {
				sb.WriteString(fmt.Sprintf("<details><summary>%s diff</summary>\n\n```diff\n%s\n```\n\n</details>\n\n", r.ModelName, truncateDiff(r.Diff, 5000)))
			}
		}
	} else {
		sb.WriteString("**All attempts failed.** Review errors above.\n")
	}

	return sb.String()
}

func scoreResult(r BestOfNResult) float64 {
	if !r.Success {
		return -1
	}
	hasDiff := 0.0
	if r.Diff != "" {
		hasDiff = 50
	}
	hasOutput := 0.0
	if r.Output != "" {
		hasOutput = 30
	}
	speed := 20.0 / (1.0 + r.Duration.Seconds()/60.0)
	costEff := 10.0 / (1.0 + r.Cost*10)
	return hasDiff + hasOutput + speed + costEff
}

func formatTokens(n int) string {
	if n >= 1000 {
		return fmt.Sprintf("%dk", n/1000)
	}
	return fmt.Sprintf("%d", n)
}

func truncateError(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func truncateDiff(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n... (truncated)"
}
