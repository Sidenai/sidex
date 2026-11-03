package tools

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Plan represents a structured task plan with ordered steps.
type Plan struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Status    string     `json:"status"` // "active", "completed", "abandoned"
	Steps     []PlanStep `json:"steps"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// PlanStep is a single actionable step within a plan.
type PlanStep struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	Status      string   `json:"status"` // "pending", "in_progress", "completed", "blocked", "skipped"
	Notes       string   `json:"notes,omitempty"`
	DependsOn   []string `json:"depends_on,omitempty"`
}

// PlanStore manages in-memory plan state for a session, backed by persistence.
type PlanStore struct {
	mu     sync.Mutex
	plans  map[string]*Plan
	active string // ID of the currently active plan
}

func NewPlanStore() *PlanStore {
	return &PlanStore{plans: make(map[string]*Plan)}
}

func (ps *PlanStore) Create(title string, stepDescs []string) *Plan {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	p := &Plan{
		ID:        uuid.New().String()[:8],
		Title:     title,
		Status:    "active",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	for i, desc := range stepDescs {
		status := "pending"
		if i == 0 {
			status = "in_progress"
		}
		p.Steps = append(p.Steps, PlanStep{
			ID:          fmt.Sprintf("%d", i+1),
			Description: desc,
			Status:      status,
		})
	}

	// Deactivate any currently active plan.
	if ps.active != "" {
		if old, ok := ps.plans[ps.active]; ok && old.Status == "active" {
			old.Status = "abandoned"
			old.UpdatedAt = time.Now()
		}
	}

	ps.plans[p.ID] = p
	ps.active = p.ID
	return p
}

func (ps *PlanStore) GetActive() *Plan {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.active == "" {
		return nil
	}
	return ps.plans[ps.active]
}

func (ps *PlanStore) Get(id string) *Plan {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return ps.plans[id]
}

func (ps *PlanStore) UpdateStep(planID, stepID, status, notes string) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	p := ps.plans[planID]
	if p == nil {
		if ps.active != "" {
			p = ps.plans[ps.active]
		}
		if p == nil {
			return fmt.Errorf("no active plan")
		}
	}

	for i := range p.Steps {
		if p.Steps[i].ID == stepID {
			p.Steps[i].Status = status
			if notes != "" {
				p.Steps[i].Notes = notes
			}
			p.UpdatedAt = time.Now()

			// Auto-advance: if completed, mark next pending step as in_progress.
			if status == "completed" {
				ps.autoAdvance(p)
			}
			return nil
		}
	}
	return fmt.Errorf("step %s not found", stepID)
}

func (ps *PlanStore) autoAdvance(p *Plan) {
	for i := range p.Steps {
		if p.Steps[i].Status == "pending" {
			if ps.depsComplete(p, p.Steps[i]) {
				p.Steps[i].Status = "in_progress"
				return
			}
		}
	}
}

func (ps *PlanStore) depsComplete(p *Plan, step PlanStep) bool {
	if len(step.DependsOn) == 0 {
		return true
	}
	for _, depID := range step.DependsOn {
		for _, s := range p.Steps {
			if s.ID == depID && s.Status != "completed" && s.Status != "skipped" {
				return false
			}
		}
	}
	return true
}

func (ps *PlanStore) Complete(planID string) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	p := ps.plans[planID]
	if p == nil {
		if ps.active != "" {
			p = ps.plans[ps.active]
		}
		if p == nil {
			return fmt.Errorf("no active plan")
		}
	}

	p.Status = "completed"
	p.UpdatedAt = time.Now()
	if ps.active == p.ID {
		ps.active = ""
	}
	return nil
}

func (ps *PlanStore) Abandon(planID string) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	p := ps.plans[planID]
	if p == nil {
		return fmt.Errorf("plan not found")
	}
	p.Status = "abandoned"
	p.UpdatedAt = time.Now()
	if ps.active == p.ID {
		ps.active = ""
	}
	return nil
}

// FormatCompact renders the active plan in a compact markdown format suitable
// for injection into the system prompt. Returns empty string if no active plan.
func (ps *PlanStore) FormatCompact() string {
	p := ps.GetActive()
	if p == nil {
		return ""
	}
	return FormatPlan(p)
}

// FormatPlan renders a plan in compact markdown. Exported for use by the loop.
func FormatPlan(p *Plan) string {
	var b strings.Builder
	b.WriteString("## Active Plan: ")
	b.WriteString(p.Title)
	b.WriteByte('\n')

	for _, step := range p.Steps {
		marker := "[ ]"
		suffix := ""
		switch step.Status {
		case "in_progress":
			marker = "[>]"
			suffix = "  ← current"
		case "completed":
			marker = "[x]"
		case "blocked":
			marker = "[!]"
			suffix = "  (blocked)"
		case "skipped":
			marker = "[-]"
		}
		b.WriteString(fmt.Sprintf("%s %s. %s%s\n", marker, step.ID, step.Description, suffix))
		if step.Notes != "" {
			b.WriteString(fmt.Sprintf("    note: %s\n", step.Notes))
		}
	}
	return b.String()
}

// Marshal serializes the plan store for persistence.
func (ps *PlanStore) Marshal() ([]byte, error) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	data := struct {
		Plans  map[string]*Plan `json:"plans"`
		Active string           `json:"active"`
	}{Plans: ps.plans, Active: ps.active}
	return json.Marshal(data)
}

// Unmarshal restores plan store state from persisted bytes.
func (ps *PlanStore) Unmarshal(data []byte) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	var state struct {
		Plans  map[string]*Plan `json:"plans"`
		Active string           `json:"active"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}
	if state.Plans != nil {
		ps.plans = state.Plans
	}
	ps.active = state.Active
	return nil
}

// --- Tool registrations ---

func init_plan_create(r *Registry) {
	r.tools["plan_create"] = Tool{
		Name: "plan_create",
		Description: `Create a structured plan to decompose a complex task into ordered, trackable steps. Use this when a task has 3+ steps, dependencies between sub-tasks, or you want the user to see your intended approach before executing.

Creating a plan replaces any existing active plan (the old one is marked "abandoned"). The first step is automatically set to in_progress. Keep step descriptions short and imperative ("Fix the query", "Add tests", "Update docs").`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"title": map[string]interface{}{
					"type":        "string",
					"description": "Short imperative title for the plan (e.g. 'Fix auth bug', 'Add caching layer').",
				},
				"steps": map[string]interface{}{
					"type": "array",
					"items": map[string]interface{}{
						"type": "string",
					},
					"description": "Ordered list of step descriptions. Keep each step concise and actionable.",
				},
			},
			"required": []string{"title", "steps"},
		},
	}
}

func init_plan_update(r *Registry) {
	r.tools["plan_update"] = Tool{
		Name: "plan_update",
		Description: `Update the status or notes of a plan step. Use this to advance through the plan as you complete work — marking steps completed, blocked, or skipped.

When a step is marked 'completed', the next pending step with satisfied dependencies is automatically advanced to 'in_progress'. Valid statuses: pending, in_progress, completed, blocked, skipped. Add notes to record findings, results, or reasons for blocking/skipping.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"step_id": map[string]interface{}{
					"type":        "string",
					"description": "The numeric step ID to update (e.g. '1', '2').",
				},
				"status": map[string]interface{}{
					"type":        "string",
					"description": "New status: pending | in_progress | completed | blocked | skipped.",
				},
				"notes": map[string]interface{}{
					"type":        "string",
					"description": "Optional progress notes or findings for this step.",
				},
				"plan_id": map[string]interface{}{
					"type":        "string",
					"description": "Plan ID (optional — defaults to the active plan).",
				},
			},
			"required": []string{"step_id", "status"},
		},
	}
}

func init_plan_get(r *Registry) {
	r.tools["plan_get"] = Tool{
		Name:        "plan_get",
		Description: `Retrieve the current active plan with all step statuses and notes. Use this to re-orient after a long conversation, after context was compacted, or to review progress before reporting to the user. Returns the full plan including title, step descriptions, and per-step notes.`,
		Parameters: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
	}
}

func init_plan_complete(r *Registry) {
	r.tools["plan_complete"] = Tool{
		Name:        "plan_complete",
		Description: `Mark the active plan as completed and archive it. Use this when all meaningful steps are done and the user's request has been fulfilled. If some steps were skipped, that's fine — completing the plan indicates the overall goal is achieved. The plan remains visible but is no longer "active".`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"plan_id": map[string]interface{}{
					"type":        "string",
					"description": "Plan ID (optional — defaults to the active plan).",
				},
			},
		},
	}
}

// --- Tool implementations ---

func (r *Registry) planCreate(args map[string]interface{}) ExecutionResult {
	title := str(args, "title")
	if title == "" {
		return ExecutionResult{Error: "title is required"}
	}

	stepsRaw, ok := args["steps"].([]interface{})
	if !ok || len(stepsRaw) == 0 {
		return ExecutionResult{Error: "steps must be a non-empty array of strings"}
	}

	var steps []string
	for _, s := range stepsRaw {
		if desc, ok := s.(string); ok && desc != "" {
			steps = append(steps, desc)
		}
	}
	if len(steps) == 0 {
		return ExecutionResult{Error: "steps must contain at least one non-empty string"}
	}

	p := r.Plans.Create(title, steps)
	r.persistPlans()

	return ExecutionResult{Output: fmt.Sprintf("Plan created (id=%s):\n%s", p.ID, FormatPlan(p))}
}

func (r *Registry) planUpdate(args map[string]interface{}) ExecutionResult {
	stepID := str(args, "step_id")
	status := str(args, "status")
	notes := str(args, "notes")
	planID := str(args, "plan_id")

	if stepID == "" || status == "" {
		return ExecutionResult{Error: "step_id and status are required"}
	}

	validStatuses := map[string]bool{
		"pending": true, "in_progress": true, "completed": true, "blocked": true, "skipped": true,
	}
	if !validStatuses[status] {
		return ExecutionResult{Error: fmt.Sprintf("invalid status %q; must be one of: pending, in_progress, completed, blocked, skipped", status)}
	}

	if err := r.Plans.UpdateStep(planID, stepID, status, notes); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	r.persistPlans()

	p := r.Plans.GetActive()
	if p == nil {
		return ExecutionResult{Output: "Step updated (plan no longer active)."}
	}
	return ExecutionResult{Output: FormatPlan(p)}
}

func (r *Registry) planGet(args map[string]interface{}) ExecutionResult {
	p := r.Plans.GetActive()
	if p == nil {
		return ExecutionResult{Output: "No active plan."}
	}
	return ExecutionResult{Output: FormatPlan(p)}
}

func (r *Registry) planComplete(args map[string]interface{}) ExecutionResult {
	planID := str(args, "plan_id")
	if err := r.Plans.Complete(planID); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	r.persistPlans()
	return ExecutionResult{Output: "Plan marked as completed."}
}

// persistPlans saves the plan store to the BoltDB backend (if available).
func (r *Registry) persistPlans() {
	if r.store == nil || r.Plans == nil {
		return
	}
	data, err := r.Plans.Marshal()
	if err != nil {
		return
	}
	_ = r.store.SaveFact("plan_store", string(data))
}

// RestorePlans loads persisted plan state from the store.
func (r *Registry) RestorePlans() {
	if r.store == nil || r.Plans == nil {
		return
	}
	data, err := r.store.GetFact("plan_store")
	if err != nil {
		return
	}
	_ = r.Plans.Unmarshal([]byte(data))
}

// ActivePlanContext returns the compact plan string for context injection.
// Returns empty string if no active plan.
func (r *Registry) ActivePlanContext() string {
	if r.Plans == nil {
		return ""
	}
	return r.Plans.FormatCompact()
}
