package agent

import (
	"fmt"
	"sort"

	"github.com/sidex-ai/sidex-server/internal/tools"
)

// ParallelDecomposer analyzes a plan and identifies steps that can run concurrently.
type ParallelDecomposer struct {
	Config ParallelConfig
}

type ParallelConfig struct {
	Enabled       bool   `json:"enabled"`
	MaxParallel   int    `json:"max_parallel"`
	MinSteps      int    `json:"min_steps"`
	MergeStrategy string `json:"merge_strategy"` // "sequential", "best-of-n", "consensus"
}

func DefaultParallelConfig() ParallelConfig {
	return ParallelConfig{
		Enabled:       true,
		MaxParallel:   3,
		MinSteps:      3,
		MergeStrategy: "sequential",
	}
}

// DecompositionResult describes how to parallelize a plan.
type DecompositionResult struct {
	PlanID      string `json:"plan_id"`
	PlanTitle   string `json:"plan_title"`
	Waves       []Wave `json:"waves"`
	TotalTasks  int    `json:"total_tasks"`
	IsParallel  bool   `json:"is_parallel"` // true if any wave has >1 task
	Description string `json:"description"`
}

type Wave struct {
	Index int            `json:"index"`
	Tasks []ParallelTask `json:"tasks"`
}

type ParallelTask struct {
	ID          string   `json:"id"`
	StepIDs     []string `json:"step_ids"`
	Description string   `json:"description"`
	Files       []string `json:"files"`
	Worktree    string   `json:"worktree"`
	DependsOn   []string `json:"depends_on"`
}

func NewParallelDecomposer(cfg ParallelConfig) *ParallelDecomposer {
	if cfg.MaxParallel <= 0 {
		cfg.MaxParallel = 3
	}
	if cfg.MinSteps <= 0 {
		cfg.MinSteps = 3
	}
	if cfg.MergeStrategy == "" {
		cfg.MergeStrategy = "sequential"
	}
	return &ParallelDecomposer{Config: cfg}
}

// Decompose analyzes a plan's dependency structure and groups independent steps
// into waves that can execute concurrently.
func (d *ParallelDecomposer) Decompose(plan *tools.Plan) (*DecompositionResult, error) {
	if plan == nil {
		return nil, fmt.Errorf("plan is nil")
	}
	if len(plan.Steps) < d.Config.MinSteps {
		return nil, fmt.Errorf("plan has %d steps, minimum %d required for parallelization", len(plan.Steps), d.Config.MinSteps)
	}

	graph := d.buildDependencyGraph(plan)
	levels := d.topologicalLevels(plan, graph)
	waves := d.buildWaves(plan, levels)

	totalTasks := 0
	isParallel := false
	for _, w := range waves {
		totalTasks += len(w.Tasks)
		if len(w.Tasks) > 1 {
			isParallel = true
		}
	}

	desc := fmt.Sprintf("Plan '%s' decomposed into %d wave(s) with %d total task(s)", plan.Title, len(waves), totalTasks)
	if isParallel {
		desc += " (parallel execution possible)"
	} else {
		desc += " (fully sequential — all steps have dependencies)"
	}

	return &DecompositionResult{
		PlanID:      plan.ID,
		PlanTitle:   plan.Title,
		Waves:       waves,
		TotalTasks:  totalTasks,
		IsParallel:  isParallel,
		Description: desc,
	}, nil
}

// buildDependencyGraph creates an adjacency list: stepID → set of step IDs it depends on.
func (d *ParallelDecomposer) buildDependencyGraph(plan *tools.Plan) map[string]map[string]bool {
	graph := make(map[string]map[string]bool)
	for _, step := range plan.Steps {
		graph[step.ID] = make(map[string]bool)
		for _, dep := range step.DependsOn {
			graph[step.ID][dep] = true
		}
	}

	d.addImplicitSequentialDeps(plan, graph)
	return graph
}

// addImplicitSequentialDeps adds implicit sequential dependencies for steps
// without explicit DependsOn — each such step depends on the previous step.
// This preserves the natural ordering for steps that don't declare dependencies.
func (d *ParallelDecomposer) addImplicitSequentialDeps(plan *tools.Plan, graph map[string]map[string]bool) {
	for i, step := range plan.Steps {
		if len(step.DependsOn) == 0 && i > 0 {
			prevID := plan.Steps[i-1].ID
			graph[step.ID][prevID] = true
		}
	}
}

// topologicalLevels assigns each step to a "level" (0-based). Steps at the same
// level have no dependencies on each other and can execute in parallel.
func (d *ParallelDecomposer) topologicalLevels(plan *tools.Plan, graph map[string]map[string]bool) map[string]int {
	levels := make(map[string]int)
	visited := make(map[string]bool)

	var computeLevel func(id string) int
	computeLevel = func(id string) int {
		if l, ok := levels[id]; ok {
			return l
		}
		if visited[id] {
			return 0
		}
		visited[id] = true

		maxDepLevel := -1
		for dep := range graph[id] {
			depLevel := computeLevel(dep)
			if depLevel > maxDepLevel {
				maxDepLevel = depLevel
			}
		}

		level := maxDepLevel + 1
		levels[id] = level
		return level
	}

	for _, step := range plan.Steps {
		computeLevel(step.ID)
	}
	return levels
}

// buildWaves groups steps by their topological level into executable waves.
func (d *ParallelDecomposer) buildWaves(plan *tools.Plan, levels map[string]int) []Wave {
	maxLevel := 0
	for _, l := range levels {
		if l > maxLevel {
			maxLevel = l
		}
	}

	stepsByLevel := make(map[int][]tools.PlanStep)
	for _, step := range plan.Steps {
		l := levels[step.ID]
		stepsByLevel[l] = append(stepsByLevel[l], step)
	}

	var waves []Wave
	for level := 0; level <= maxLevel; level++ {
		steps := stepsByLevel[level]
		if len(steps) == 0 {
			continue
		}

		sort.Slice(steps, func(i, j int) bool {
			return steps[i].ID < steps[j].ID
		})

		tasks := d.stepsToTasks(steps, level)

		if len(tasks) > d.Config.MaxParallel {
			// Split into sub-waves respecting MaxParallel
			for i := 0; i < len(tasks); i += d.Config.MaxParallel {
				end := i + d.Config.MaxParallel
				if end > len(tasks) {
					end = len(tasks)
				}
				waves = append(waves, Wave{
					Index: len(waves),
					Tasks: tasks[i:end],
				})
			}
		} else {
			waves = append(waves, Wave{
				Index: len(waves),
				Tasks: tasks,
			})
		}
	}

	return waves
}

// stepsToTasks converts plan steps at the same level into ParallelTask entries.
func (d *ParallelDecomposer) stepsToTasks(steps []tools.PlanStep, level int) []ParallelTask {
	var tasks []ParallelTask
	for _, step := range steps {
		task := ParallelTask{
			ID:          fmt.Sprintf("wave%d_task_%s", level, step.ID),
			StepIDs:     []string{step.ID},
			Description: step.Description,
			Worktree:    fmt.Sprintf("parallel-%s-step%s", "plan", step.ID),
			DependsOn:   step.DependsOn,
		}
		tasks = append(tasks, task)
	}
	return tasks
}

// FileConflicts checks if two tasks would conflict by touching the same files.
func FileConflicts(a, b ParallelTask) bool {
	setA := make(map[string]bool, len(a.Files))
	for _, f := range a.Files {
		setA[f] = true
	}
	for _, f := range b.Files {
		if setA[f] {
			return true
		}
	}
	return false
}

// CanParallelize is a quick check: returns true if a plan has enough steps
// with independent dependencies to benefit from parallel execution.
func CanParallelize(plan *tools.Plan, cfg ParallelConfig) bool {
	if plan == nil || !cfg.Enabled {
		return false
	}
	if len(plan.Steps) < cfg.MinSteps {
		return false
	}

	// Check if any steps have explicit DependsOn declarations — if so,
	// there may be independent groups. If none do, all steps are assumed
	// sequential by default.
	hasExplicitDeps := false
	for _, step := range plan.Steps {
		if len(step.DependsOn) > 0 {
			hasExplicitDeps = true
			break
		}
	}

	return hasExplicitDeps
}
