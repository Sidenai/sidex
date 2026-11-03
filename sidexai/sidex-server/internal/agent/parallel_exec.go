package agent

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/tools"
)

// WaveResult aggregates the outcomes of all tasks in a single wave.
type WaveResult struct {
	WaveIndex int           `json:"wave_index"`
	Tasks     []TaskResult  `json:"tasks"`
	Duration  time.Duration `json:"duration"`
}

func (wr WaveResult) HasFailures() bool {
	for _, t := range wr.Tasks {
		if t.Error != "" {
			return true
		}
	}
	return false
}

func (wr WaveResult) Summary() string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Wave %d (%s):\n", wr.WaveIndex, wr.Duration.Round(time.Millisecond)))
	for _, t := range wr.Tasks {
		status := "done"
		if t.Error != "" {
			status = "FAILED"
		}
		sb.WriteString(fmt.Sprintf("  [%s] %s — %s (%d tools, %s)\n",
			t.TaskID, status, t.Description, t.ToolCalls, t.Duration.Round(time.Millisecond)))
	}
	return sb.String()
}

// TaskResult holds the outcome of a single parallel task execution.
type TaskResult struct {
	TaskID      string        `json:"task_id"`
	StepIDs     []string      `json:"step_ids"`
	Description string        `json:"description"`
	Output      string        `json:"output"`
	Diff        string        `json:"diff"`
	Error       string        `json:"error,omitempty"`
	Branch      string        `json:"branch"`
	WorktreeDir string        `json:"worktree_dir"`
	ToolCalls   int           `json:"tool_calls"`
	Duration    time.Duration `json:"duration"`
}

// ExecuteParallel runs a decomposed plan using parallel subagents in worktrees.
func ExecuteParallel(
	ctx context.Context,
	conn Conn,
	result *DecompositionResult,
	cwd string,
	cfg *Config,
	aiClient *ai.Client,
	store *memory.Store,
) ([]WaveResult, error) {
	if result == nil {
		return nil, fmt.Errorf("decomposition result is nil")
	}
	if len(result.Waves) == 0 {
		return nil, fmt.Errorf("no waves to execute")
	}

	conn.WriteJSON(ai.StreamChunk{
		Type:    "parallel_status",
		Content: fmt.Sprintf("Starting parallel execution: %d wave(s), %d total task(s)", len(result.Waves), result.TotalTasks),
	})

	var allResults []WaveResult

	for _, wave := range result.Waves {
		select {
		case <-ctx.Done():
			return allResults, ctx.Err()
		default:
		}

		conn.WriteJSON(map[string]interface{}{
			"type":  "parallel_status",
			"wave":  wave.Index,
			"tasks": buildTaskStatusList(wave.Tasks, "starting"),
		})

		waveResult := executeWave(ctx, conn, wave, cwd, cfg, aiClient, store)
		allResults = append(allResults, waveResult)

		conn.WriteJSON(ai.StreamChunk{
			Type:    "parallel_status",
			Content: waveResult.Summary(),
		})

		if waveResult.HasFailures() && DefaultParallelConfig().MergeStrategy != "best-of-n" {
			conn.WriteJSON(ai.StreamChunk{
				Type:    "parallel_status",
				Content: fmt.Sprintf("Wave %d had failures — stopping parallel execution", wave.Index),
			})
			break
		}
	}

	mergeErr := mergeWorktrees(conn, cwd, allResults)
	if mergeErr != nil {
		conn.WriteJSON(ai.StreamChunk{
			Type:    "parallel_status",
			Content: fmt.Sprintf("Merge warning: %s", mergeErr.Error()),
		})
	}

	return allResults, mergeErr
}

func executeWave(
	ctx context.Context,
	conn Conn,
	wave Wave,
	cwd string,
	cfg *Config,
	aiClient *ai.Client,
	store *memory.Store,
) WaveResult {
	start := time.Now()
	results := make([]TaskResult, len(wave.Tasks))
	var wg sync.WaitGroup

	sem := make(chan struct{}, cfg.MaxConcurrency)

	for i, task := range wave.Tasks {
		wg.Add(1)
		go func(idx int, t ParallelTask) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			conn.WriteJSON(map[string]interface{}{
				"type":    "parallel_status",
				"wave":    wave.Index,
				"task_id": t.ID,
				"status":  "running",
			})

			taskResult := executeParallelTask(ctx, conn, t, cwd, cfg, aiClient, store)
			results[idx] = taskResult

			status := "done"
			if taskResult.Error != "" {
				status = "failed"
			}
			conn.WriteJSON(map[string]interface{}{
				"type":    "parallel_status",
				"wave":    wave.Index,
				"task_id": t.ID,
				"status":  status,
			})
		}(i, task)
	}

	wg.Wait()

	return WaveResult{
		WaveIndex: wave.Index,
		Tasks:     results,
		Duration:  time.Since(start),
	}
}

func executeParallelTask(
	ctx context.Context,
	conn Conn,
	task ParallelTask,
	cwd string,
	cfg *Config,
	aiClient *ai.Client,
	store *memory.Store,
) TaskResult {
	_ = ctx // reserved for future cancellation support
	start := time.Now()

	wtDir, branch, err := createWorktreeForTask(cwd, task)
	if err != nil {
		return TaskResult{
			TaskID:      task.ID,
			StepIDs:     task.StepIDs,
			Description: task.Description,
			Error:       fmt.Sprintf("worktree creation failed: %s", err),
			Duration:    time.Since(start),
		}
	}

	subTask := SubAgentTask{
		ID:          task.ID,
		Description: task.Description,
		Type:        "worker",
		Context: fmt.Sprintf(
			"You are executing step(s) %s of a parallel plan.\n"+
				"Your worktree branch: %s\nWorktree path: %s\n\n"+
				"Focus exclusively on this task. Other steps are running in parallel.",
			strings.Join(task.StepIDs, ", "), branch, wtDir,
		),
	}

	subResult, _ := RunSubAgent(conn, wtDir, subTask, aiClient, store, *cfg, nil)

	diff := getWorktreeDiff(wtDir)

	return TaskResult{
		TaskID:      task.ID,
		StepIDs:     task.StepIDs,
		Description: task.Description,
		Output:      subResult.Output,
		Diff:        diff,
		Error:       subResult.Error,
		Branch:      branch,
		WorktreeDir: wtDir,
		ToolCalls:   subResult.ToolCalls,
		Duration:    time.Since(start),
	}
}

func createWorktreeForTask(repoDir string, task ParallelTask) (wtDir, branch string, err error) {
	branch = "sidex/parallel-" + task.Worktree + "-" + time.Now().Format("20060102-150405")
	wtDir = filepath.Join(os.TempDir(), "sidex-parallel", task.ID)

	if err := os.MkdirAll(filepath.Dir(wtDir), 0o755); err != nil {
		return "", "", fmt.Errorf("mkdir: %w", err)
	}

	cmd := exec.Command("git", "worktree", "add", wtDir, "-b", branch)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", "", fmt.Errorf("git worktree add: %s — %s", err, string(out))
	}

	return wtDir, branch, nil
}

func getWorktreeDiff(wtDir string) string {
	cmd := exec.Command("git", "add", "-A")
	cmd.Dir = wtDir
	cmd.Run()

	cmd = exec.Command("git", "diff", "--cached", "--stat")
	cmd.Dir = wtDir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}

	stat := strings.TrimSpace(string(out))

	cmd = exec.Command("git", "diff", "--cached")
	cmd.Dir = wtDir
	fullDiff, _ := cmd.Output()

	if len(fullDiff) > 50000 {
		return stat + "\n\n(diff truncated — exceeds 50KB)"
	}
	return string(fullDiff)
}

func mergeWorktrees(conn Conn, repoDir string, results []WaveResult) error {
	var mergeErrors []string

	for _, wave := range results {
		for _, task := range wave.Tasks {
			if task.Error != "" || task.Branch == "" {
				continue
			}

			// Commit any pending changes in the worktree
			commitCmd := exec.Command("git", "add", "-A")
			commitCmd.Dir = task.WorktreeDir
			commitCmd.Run()

			commitCmd = exec.Command("git", "commit", "-m",
				fmt.Sprintf("parallel task %s: %s", task.TaskID, task.Description))
			commitCmd.Dir = task.WorktreeDir
			commitCmd.CombinedOutput()

			// Merge the branch back
			mergeCmd := exec.Command("git", "merge", "--no-ff", task.Branch,
				"-m", fmt.Sprintf("Merge parallel task: %s", task.Description))
			mergeCmd.Dir = repoDir
			out, err := mergeCmd.CombinedOutput()
			if err != nil {
				// Abort the failed merge
				abortCmd := exec.Command("git", "merge", "--abort")
				abortCmd.Dir = repoDir
				abortCmd.Run()

				mergeErrors = append(mergeErrors,
					fmt.Sprintf("task %s: merge conflict — branch %s preserved for manual resolution. %s",
						task.TaskID, task.Branch, strings.TrimSpace(string(out))))

				conn.WriteJSON(ai.StreamChunk{
					Type:    "parallel_status",
					Content: fmt.Sprintf("Merge conflict for task %s (branch %s preserved)", task.TaskID, task.Branch),
				})
				continue
			}

			// Clean up the worktree
			cleanupParallelWorktree(repoDir, task.WorktreeDir, task.Branch)
		}
	}

	if len(mergeErrors) > 0 {
		return fmt.Errorf("merge issues:\n%s", strings.Join(mergeErrors, "\n"))
	}
	return nil
}

func cleanupParallelWorktree(repoDir, wtDir, branch string) {
	cmd := exec.Command("git", "worktree", "remove", "--force", wtDir)
	cmd.Dir = repoDir
	cmd.CombinedOutput()
	os.RemoveAll(wtDir)

	cmd = exec.Command("git", "branch", "-d", branch)
	cmd.Dir = repoDir
	cmd.CombinedOutput()
}

func buildTaskStatusList(tasks []ParallelTask, status string) []map[string]string {
	var list []map[string]string
	for _, t := range tasks {
		list = append(list, map[string]string{
			"id":     t.ID,
			"status": status,
		})
	}
	return list
}

// FormatParallelResults produces a human-readable summary of parallel execution.
func FormatParallelResults(results []WaveResult) string {
	var sb strings.Builder
	sb.WriteString("=== Parallel Execution Results ===\n\n")

	totalTasks := 0
	totalSuccess := 0
	var totalDuration time.Duration

	for _, wave := range results {
		totalDuration += wave.Duration
		sb.WriteString(wave.Summary())
		sb.WriteByte('\n')
		for _, t := range wave.Tasks {
			totalTasks++
			if t.Error == "" {
				totalSuccess++
			}
		}
	}

	sb.WriteString(fmt.Sprintf("\nTotal: %d/%d tasks succeeded in %s\n",
		totalSuccess, totalTasks, totalDuration.Round(time.Millisecond)))

	return sb.String()
}

// HandleParallelPlanExecute is the tool handler for "parallel_plan_execute".
func HandleParallelPlanExecute(
	conn Conn,
	tc ai.ToolCall,
	cwd string,
	aiClient *ai.Client,
	store *memory.Store,
	planStore *tools.PlanStore,
	cfg Config,
) string {
	plan := planStore.GetActive()
	if plan == nil {
		return "ERROR: no active plan to execute in parallel"
	}

	parallelCfg := DefaultParallelConfig()
	decomposer := NewParallelDecomposer(parallelCfg)

	decomposition, err := decomposer.Decompose(plan)
	if err != nil {
		return fmt.Sprintf("ERROR: decomposition failed: %s", err)
	}

	if !decomposition.IsParallel {
		return fmt.Sprintf("Plan '%s' has no independent steps — all steps are sequential. Use normal execution.", plan.Title)
	}

	conn.WriteJSON(ai.StreamChunk{
		Type:    "text",
		Content: fmt.Sprintf("## Parallel Plan Execution\n\n%s\n\n", decomposition.Description),
	})

	ctx := context.Background()
	results, err := ExecuteParallel(ctx, conn, decomposition, cwd, &cfg, aiClient, store)

	summary := FormatParallelResults(results)
	if err != nil {
		summary += fmt.Sprintf("\nMerge issues: %s\n", err.Error())
	}

	// Mark completed steps in the plan
	for _, wave := range results {
		for _, task := range wave.Tasks {
			if task.Error == "" {
				for _, stepID := range task.StepIDs {
					planStore.UpdateStep(plan.ID, stepID, "completed", "completed via parallel execution")
				}
			}
		}
	}

	log.Printf("parallel execution complete: %d waves", len(results))
	return summary
}
