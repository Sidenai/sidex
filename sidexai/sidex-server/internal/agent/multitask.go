package agent

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/compress"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/tools"
)

const (
	defaultMaxWorkers = 4
	subtaskTimeout    = 5 * time.Minute
	maxSubtasks       = 6
	minSubtasks       = 2
	multitaskMaxTurns = 15
)

type MultitaskConfig struct {
	Task        string
	MaxWorkers  int
	UseWorktree bool
}

type Subtask struct {
	ID          string    `json:"id"`
	Description string    `json:"description"`
	Status      string    `json:"status"`
	WorkerID    int       `json:"worker_id"`
	Branch      string    `json:"branch,omitempty"`
	WorktreeDir string    `json:"worktree_dir,omitempty"`
	StartedAt   time.Time `json:"started_at,omitempty"`
	CompletedAt time.Time `json:"completed_at,omitempty"`
	Output      string    `json:"output,omitempty"`
	Error       string    `json:"error,omitempty"`
	FilesEdited []string  `json:"files_edited,omitempty"`
	Diff        string    `json:"diff,omitempty"`
}

type multitaskStatusUpdate struct {
	Type     string    `json:"type"`
	Subtasks []Subtask `json:"subtasks"`
}

// ParseMultitask extracts the task from a "/multitask" user message.
func ParseMultitask(msg string) (MultitaskConfig, bool) {
	trimmed := strings.TrimSpace(msg)
	lower := strings.ToLower(trimmed)
	if !strings.HasPrefix(lower, "/multitask") {
		return MultitaskConfig{}, false
	}

	rest := strings.TrimSpace(trimmed[len("/multitask"):])
	if rest == "" {
		return MultitaskConfig{}, false
	}

	cfg := MultitaskConfig{
		Task:        rest,
		MaxWorkers:  defaultMaxWorkers,
		UseWorktree: true,
	}

	if strings.HasPrefix(rest, "--no-worktree ") {
		cfg.UseWorktree = false
		cfg.Task = strings.TrimSpace(rest[len("--no-worktree"):])
	}

	return cfg, true
}

// RunMultitask breaks a large task into subtasks and runs them in parallel.
func RunMultitask(
	cfg MultitaskConfig,
	conn Conn,
	cwd string,
	aiClient *ai.Client,
	store *memory.Store,
	baseCfg Config,
) {
	conn.WriteJSON(ai.StreamChunk{
		Type:    "text",
		Content: "## Multitask: analyzing task...\n\n",
	})

	// Phase 1: Plan — ask the model to decompose the task
	subtasks, err := breakIntoSubtasks(cfg.Task, aiClient, cwd)
	if err != nil {
		conn.WriteJSON(ai.StreamChunk{
			Type:    "text",
			Content: fmt.Sprintf("Failed to decompose task: %s\n", err.Error()),
		})
		conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
		return
	}

	if len(subtasks) == 0 {
		conn.WriteJSON(ai.StreamChunk{
			Type:    "text",
			Content: "Could not identify independent subtasks. Try running the task directly.\n",
		})
		conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
		return
	}

	conn.WriteJSON(ai.StreamChunk{
		Type:    "text",
		Content: fmt.Sprintf("Decomposed into **%d subtasks**:\n\n", len(subtasks)),
	})
	for i, st := range subtasks {
		conn.WriteJSON(ai.StreamChunk{
			Type:    "text",
			Content: fmt.Sprintf("%d. %s\n", i+1, st.Description),
		})
	}
	conn.WriteJSON(ai.StreamChunk{
		Type:    "text",
		Content: fmt.Sprintf("\nLaunching %d parallel workers...\n\n", len(subtasks)),
	})

	broadcastStatus(conn, subtasks)

	// Phase 2: Launch — run each subtask in a goroutine
	maxWorkers := cfg.MaxWorkers
	if maxWorkers <= 0 {
		maxWorkers = defaultMaxWorkers
	}
	sem := make(chan struct{}, maxWorkers)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for i := range subtasks {
		subtasks[i].WorkerID = i
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			mu.Lock()
			subtasks[idx].Status = "running"
			subtasks[idx].StartedAt = time.Now()
			mu.Unlock()
			broadcastStatus(conn, copySubtasks(&mu, subtasks))

			conn.WriteJSON(ai.StreamChunk{
				Type:    "multitask_worker",
				Content: fmt.Sprintf("[Worker %d] Starting: %s", idx+1, subtasks[idx].Description),
			})

			result := runMultitaskWorker(subtasks[idx], cfg.UseWorktree, cwd, conn, aiClient, store, baseCfg, idx)

			mu.Lock()
			subtasks[idx] = result
			mu.Unlock()
			broadcastStatus(conn, copySubtasks(&mu, subtasks))

			status := "completed"
			if result.Error != "" {
				status = "failed"
			}
			conn.WriteJSON(ai.StreamChunk{
				Type:    "multitask_worker",
				Content: fmt.Sprintf("[Worker %d] %s: %s", idx+1, status, subtasks[idx].Description),
			})
		}(i)
	}

	wg.Wait()

	// Phase 3: Collect — report results
	conn.WriteJSON(ai.StreamChunk{
		Type:    "text",
		Content: "\n## Multitask Results\n\n",
	})

	allSuccess := true
	for i, st := range subtasks {
		icon := "done"
		if st.Error != "" {
			icon = "failed"
			allSuccess = false
		}
		duration := st.CompletedAt.Sub(st.StartedAt).Round(time.Millisecond)
		conn.WriteJSON(ai.StreamChunk{
			Type:    "text",
			Content: fmt.Sprintf("### %d. %s [%s] (%s)\n", i+1, st.Description, icon, duration),
		})
		if st.Error != "" {
			conn.WriteJSON(ai.StreamChunk{
				Type:    "text",
				Content: fmt.Sprintf("**Error:** %s\n\n", st.Error),
			})
		} else if st.Output != "" {
			out := st.Output
			if len(out) > 2000 {
				out = out[:2000] + "\n... (truncated)"
			}
			conn.WriteJSON(ai.StreamChunk{
				Type:    "text",
				Content: fmt.Sprintf("%s\n\n", out),
			})
		}
	}

	// Phase 4: Verify — detect conflicts if worktrees were used
	if cfg.UseWorktree && allSuccess {
		conflicts := detectConflicts(subtasks, cwd)
		if len(conflicts) > 0 {
			conn.WriteJSON(ai.StreamChunk{
				Type:    "text",
				Content: "\n## Conflicts Detected\n\nThe following files were edited by multiple workers:\n\n",
			})
			for _, c := range conflicts {
				conn.WriteJSON(ai.StreamChunk{
					Type:    "text",
					Content: fmt.Sprintf("- **%s** (edited by workers %s)\n", c.File, formatWorkerList(c.Workers)),
				})
			}
			conn.WriteJSON(ai.StreamChunk{
				Type:    "text",
				Content: "\nManual resolution may be needed. Worktree branches are preserved for inspection.\n",
			})
		} else {
			conn.WriteJSON(ai.StreamChunk{
				Type:    "text",
				Content: "\nNo conflicts detected between subtask outputs.\n",
			})

			mergeWorktreeBranches(subtasks, cwd, conn)
		}

		conn.WriteJSON(ai.StreamChunk{
			Type:    "text",
			Content: "\n### Worktree Branches\n\n",
		})
		for i, st := range subtasks {
			if st.Branch != "" {
				conn.WriteJSON(ai.StreamChunk{
					Type:    "text",
					Content: fmt.Sprintf("- `%s` — Worker %d: %s\n", st.Branch, i+1, st.Description),
				})
			}
		}
	}

	broadcastStatus(conn, subtasks)
	conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
}

func runMultitaskWorker(
	st Subtask,
	useWorktree bool,
	cwd string,
	conn Conn,
	aiClient *ai.Client,
	store *memory.Store,
	baseCfg Config,
	idx int,
) Subtask {
	start := time.Now()
	result := st
	result.Status = "running"
	result.StartedAt = start

	done := make(chan struct{})
	go func() {
		defer close(done)

		reg := tools.NewRegistryWithStore(cwd, store)
		defer reg.Cleanup()

		if useWorktree {
			wtResult := reg.Execute("enter_worktree", fmt.Sprintf(`{"branch":"multitask-%d"}`, idx))
			if wtResult.Error != "" {
				result.Error = "worktree creation failed: " + wtResult.Error
				result.Status = "failed"
				result.CompletedAt = time.Now()
				return
			}
			result.Branch = extractBranch(wtResult.Output)
			result.WorktreeDir = extractWorktreeDir(wtResult.Output)

			conn.WriteJSON(ai.StreamChunk{
				Type:    "multitask_worker",
				Content: fmt.Sprintf("[Worker %d] worktree ready on branch %s", idx+1, result.Branch),
			})
		}

		allToolDefs := BuildToolDefsFromRegistry(reg)
		sysPrompt := buildMultitaskWorkerPrompt(cwd, idx)

		messages := []ai.Message{{Role: ai.RoleUser, Content: st.Description}}

		maxTurns := baseCfg.MaxSubTurns
		if maxTurns <= 0 {
			maxTurns = multitaskMaxTurns
		}

		var lastText string
		var totalToolCalls int

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
					blockedTools := map[string]bool{
						"spawn_agents": true, "send_message": true,
						"agent_status": true, "exit_worktree": true,
					}
					if blockedTools[tc.Function.Name] {
						messages = append(messages, ai.Message{
							Role: ai.RoleTool, Content: "ERROR: multitask workers cannot use " + tc.Function.Name,
							ToolCallID: tc.ID, Name: tc.Function.Name,
						})
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

					if isFileEditTool(tc.Function.Name) {
						if f := extractFileArg(tc.Function.Arguments); f != "" {
							result.FilesEdited = appendUnique(result.FilesEdited, f)
						}
					}

					conn.WriteJSON(ai.StreamChunk{
						Type:    "multitask_tool",
						Content: fmt.Sprintf("[Worker %d] %s", idx+1, tc.Function.Name),
					})

					messages = append(messages, ai.Message{
						Role: ai.RoleTool, Content: output,
						ToolCallID: tc.ID, Name: tc.Function.Name,
					})
				}
				continue
			}

			break
		}

		result.Output = lastText
		result.Status = "completed"
		if result.Error != "" {
			result.Status = "failed"
		}
		result.CompletedAt = time.Now()

		if useWorktree && result.Error == "" {
			result.Diff = captureWorktreeDiff(result.WorktreeDir)
		}
	}()

	select {
	case <-done:
		return result
	case <-time.After(subtaskTimeout):
		result.Error = fmt.Sprintf("subtask timed out after %s", subtaskTimeout)
		result.Status = "failed"
		result.CompletedAt = time.Now()
		return result
	}
}

// breakIntoSubtasks asks the model to decompose the task into parallel subtasks.
func breakIntoSubtasks(task string, aiClient *ai.Client, cwd string) ([]Subtask, error) {
	planPrompt := `You are a task decomposition engine. Your job is to break a complex coding task into 2-6 independent subtasks that can run in parallel.

Rules:
- Each subtask must be self-contained (can run without the others' results).
- Each subtask should ideally touch different files to avoid merge conflicts.
- If the task is too simple to decompose, return a single subtask.
- Be specific in descriptions — include file names and what to do.
- Output ONLY valid JSON, no markdown fences, no explanation.

Output format:
[{"description": "detailed subtask description"}, ...]`

	messages := []ai.Message{
		{Role: ai.RoleUser, Content: fmt.Sprintf("Working directory: %s\n\nTask to decompose:\n%s", cwd, task)},
	}

	var responseText string
	err := aiClient.StreamChat(messages, nil, planPrompt, func(chunk ai.StreamChunk) {
		if chunk.Type == "text" {
			responseText += chunk.Content
		}
	})
	if err != nil {
		return nil, fmt.Errorf("planning API error: %w", err)
	}

	responseText = cleanJSONResponse(responseText)

	var raw []struct {
		Description string `json:"description"`
	}
	if err := json.Unmarshal([]byte(responseText), &raw); err != nil {
		return nil, fmt.Errorf("failed to parse subtask JSON: %w (response: %.200s)", err, responseText)
	}

	if len(raw) < minSubtasks {
		return nil, fmt.Errorf("model returned %d subtask(s), need at least %d", len(raw), minSubtasks)
	}
	if len(raw) > maxSubtasks {
		raw = raw[:maxSubtasks]
	}

	subtasks := make([]Subtask, len(raw))
	for i, r := range raw {
		subtasks[i] = Subtask{
			ID:          fmt.Sprintf("subtask_%d", i+1),
			Description: r.Description,
			Status:      "pending",
		}
	}

	return subtasks, nil
}

// cleanJSONResponse strips markdown fences and leading/trailing whitespace.
func cleanJSONResponse(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```json") {
		s = strings.TrimPrefix(s, "```json")
	}
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
	}
	if strings.HasSuffix(s, "```") {
		s = strings.TrimSuffix(s, "```")
	}
	return strings.TrimSpace(s)
}

func buildMultitaskWorkerPrompt(cwd string, workerIdx int) string {
	return fmt.Sprintf(`You are Worker %d in a parallel multitask execution. Complete your assigned subtask autonomously.

# Rules
- Focus ONLY on your specific subtask. Do not go beyond scope.
- Use tools to read files before editing them.
- Be thorough but efficient.
- You are working in an isolated git worktree. All changes are safe.
- You cannot spawn subagents, exit the worktree, or send messages.
- When done, provide a brief summary of what you did and the result.

Working directory: %s`, workerIdx+1, cwd)
}

type fileConflict struct {
	File    string
	Workers []int
}

func detectConflicts(subtasks []Subtask, cwd string) []fileConflict {
	fileWorkers := make(map[string][]int)
	for i, st := range subtasks {
		if st.Status != "completed" {
			continue
		}
		for _, f := range st.FilesEdited {
			fileWorkers[f] = append(fileWorkers[f], i+1)
		}
	}

	var conflicts []fileConflict
	for file, workers := range fileWorkers {
		if len(workers) > 1 {
			conflicts = append(conflicts, fileConflict{File: file, Workers: workers})
		}
	}
	return conflicts
}

func mergeWorktreeBranches(subtasks []Subtask, cwd string, conn Conn) {
	for _, st := range subtasks {
		if st.Branch == "" || st.Status != "completed" || st.Diff == "" {
			continue
		}
		cmd := exec.Command("git", "merge", "--no-edit", st.Branch)
		cmd.Dir = cwd
		out, err := cmd.CombinedOutput()
		if err != nil {
			conn.WriteJSON(ai.StreamChunk{
				Type:    "multitask_merge",
				Content: fmt.Sprintf("Merge of branch %s failed: %s\n%s", st.Branch, err.Error(), string(out)),
			})
			undoCmd := exec.Command("git", "merge", "--abort")
			undoCmd.Dir = cwd
			_ = undoCmd.Run()
		} else {
			conn.WriteJSON(ai.StreamChunk{
				Type:    "multitask_merge",
				Content: fmt.Sprintf("Merged branch %s successfully", st.Branch),
			})
		}
	}
}

func broadcastStatus(conn Conn, subtasks []Subtask) {
	conn.WriteJSON(multitaskStatusUpdate{
		Type:     "multitask_status",
		Subtasks: subtasks,
	})
}

func copySubtasks(mu *sync.Mutex, subtasks []Subtask) []Subtask {
	mu.Lock()
	defer mu.Unlock()
	cp := make([]Subtask, len(subtasks))
	copy(cp, subtasks)
	return cp
}

func extractFileArg(argsJSON string) string {
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return ""
	}
	for _, key := range []string{"path", "file", "file_path", "filename"} {
		if v, ok := args[key]; ok {
			if s, ok := v.(string); ok {
				return s
			}
		}
	}
	return ""
}

func appendUnique(slice []string, item string) []string {
	for _, s := range slice {
		if s == item {
			return slice
		}
	}
	return append(slice, item)
}

func formatWorkerList(workers []int) string {
	parts := make([]string, len(workers))
	for i, w := range workers {
		parts[i] = fmt.Sprintf("%d", w)
	}
	return strings.Join(parts, ", ")
}
