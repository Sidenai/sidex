package tools

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// TaskV2 represents a structured task in the V2 system.
type TaskV2 struct {
	ID          string    `json:"id"`
	Subject     string    `json:"subject"`
	Description string    `json:"description,omitempty"`
	ActiveForm  string    `json:"active_form,omitempty"`
	Status      string    `json:"status"`
	Owner       string    `json:"owner,omitempty"`
	BlockedBy   []string  `json:"blocked_by,omitempty"`
	Blocks      []string  `json:"blocks,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Metadata    string    `json:"metadata,omitempty"`
}

// TaskStore is a session-scoped task manager.
type TaskStore struct {
	mu    sync.Mutex
	tasks map[string]*TaskV2
	order []string
	seq   int
}

func NewTaskStore() *TaskStore {
	return &TaskStore{tasks: make(map[string]*TaskV2)}
}

func (s *TaskStore) Create(subject, description, activeForm, status, owner, metadata string, blockedBy []string) *TaskV2 {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.seq++
	id := fmt.Sprintf("t%d", s.seq)
	if status == "" {
		status = "pending"
	}
	now := time.Now()
	t := &TaskV2{
		ID:          id,
		Subject:     subject,
		Description: description,
		ActiveForm:  activeForm,
		Status:      status,
		Owner:       owner,
		BlockedBy:   blockedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
		Metadata:    metadata,
	}
	s.tasks[id] = t
	s.order = append(s.order, id)
	return t
}

func (s *TaskStore) Get(id string) *TaskV2 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tasks[id]
}

func (s *TaskStore) ListAll() []*TaskV2 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*TaskV2, 0, len(s.order))
	for _, id := range s.order {
		if t, ok := s.tasks[id]; ok {
			out = append(out, t)
		}
	}
	return out
}

func (s *TaskStore) ListByStatus(status string) []*TaskV2 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*TaskV2
	for _, id := range s.order {
		if t, ok := s.tasks[id]; ok && t.Status == status {
			out = append(out, t)
		}
	}
	return out
}

var validStatuses = map[string]bool{
	"pending":     true,
	"in_progress": true,
	"completed":   true,
	"failed":      true,
	"deleted":     true,
}

var validTransitions = map[string]map[string]bool{
	"pending":     {"in_progress": true, "completed": true, "failed": true, "deleted": true},
	"in_progress": {"completed": true, "failed": true, "pending": true, "deleted": true},
	"completed":   {"pending": true, "deleted": true},
	"failed":      {"pending": true, "deleted": true},
	"deleted":     {},
}

func taskToJSON(t *TaskV2) string {
	b, _ := json.MarshalIndent(t, "", "  ")
	return string(b)
}

// ---------- tool registration ----------

func init_task_create(r *Registry) {
	r.tools["task_create"] = Tool{
		Name: "task_create",
		Description: `Create a new task in the session task list.

When to use:
- You are starting work that has multiple distinct steps.
- The user gave you a multi-part request (numbered list, comma-separated items, complex feature).
- You want to make the plan visible so the user can track progress.
- You need to model dependencies between work items (blocked_by).

When NOT to use:
- Single trivial actions that take one tool call (e.g. "add a comment").
- Pure Q&A, explanations, or informational responses.

Rules:
- Keep subjects short and imperative: "Run tests", "Add caching layer".
- Set active_form to present-continuous for UI display: "Running tests", "Adding caching layer".
- Use blocked_by to express ordering constraints between tasks.
- Only one task should be in_progress at a time unless they are truly parallel.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"subject":     map[string]interface{}{"type": "string", "description": "Short imperative description of the task."},
				"description": map[string]interface{}{"type": "string", "description": "Longer explanation of what the task involves."},
				"active_form": map[string]interface{}{"type": "string", "description": "Present-continuous form shown while running (e.g. 'Running tests')."},
				"status":      map[string]interface{}{"type": "string", "description": "Initial status: pending (default), in_progress, completed, failed.", "default": "pending"},
				"metadata":    map[string]interface{}{"type": "string", "description": "Arbitrary metadata or output associated with the task."},
				"blocked_by":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Array of task IDs that must complete before this task can start."},
			},
			"required": []string{"subject"},
		},
	}
}

func init_task_get(r *Registry) {
	r.tools["task_get"] = Tool{
		Name: "task_get",
		Description: `Retrieve the full details of a single task by its ID.

When to use:
- You need to inspect a specific task's description, metadata, blockers, or timestamps.
- You want to check whether a task has been updated by another agent (multi-agent scenarios).

When NOT to use:
- You want an overview of all tasks — use task_list instead.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"task_id": map[string]interface{}{"type": "string", "description": "The task ID to retrieve (e.g. 't1')."},
			},
			"required": []string{"task_id"},
		},
	}
}

func init_task_list(r *Registry) {
	r.tools["task_list"] = Tool{
		Name: "task_list",
		Description: `List all tasks in this session, in creation order.

When to use:
- You want a quick overview of the plan and what's done vs. remaining.
- You need to find a task ID to update or inspect.
- You want to check overall progress before reporting to the user.

When NOT to use:
- You need full details on a specific task — use task_get instead.

Supports an optional status filter to show only tasks in a given state.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"status": map[string]interface{}{"type": "string", "description": "Filter by status: pending, in_progress, completed, failed, deleted. Omit to list all."},
			},
		},
	}
}

func init_task_update(r *Registry) {
	r.tools["task_update"] = Tool{
		Name: "task_update",
		Description: `Update one or more fields on an existing task.

When to use:
- Transitioning a task to a new status (pending → in_progress → completed).
- Updating subject, description, or metadata as work reveals new information.
- Assigning an owner in multi-agent workflows.
- Adding/removing dependency links (blocked_by, blocks).

When NOT to use:
- Creating a new task — use task_create instead.
- Stopping a task due to failure — use task_stop for a quick fail-and-note shorthand.

Rules:
- Status transitions are validated. Deleted tasks cannot be reactivated.
- Only supply the fields you want to change; omitted fields are left untouched.
- Mark tasks completed the moment work finishes — do not batch completions.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"task_id":     map[string]interface{}{"type": "string", "description": "The task ID to update."},
				"subject":     map[string]interface{}{"type": "string", "description": "New subject line."},
				"description": map[string]interface{}{"type": "string", "description": "New description."},
				"active_form": map[string]interface{}{"type": "string", "description": "New active-form text."},
				"status":      map[string]interface{}{"type": "string", "description": "New status (validated transition)."},
				"owner":       map[string]interface{}{"type": "string", "description": "Agent or user ID that owns this task."},
				"blocked_by":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Replace the blocked_by list."},
				"blocks":      map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Replace the blocks list."},
				"metadata":    map[string]interface{}{"type": "string", "description": "Updated metadata/output."},
			},
			"required": []string{"task_id"},
		},
	}
}

func init_task_stop(r *Registry) {
	r.tools["task_stop"] = Tool{
		Name: "task_stop",
		Description: `Mark a task as failed and record a reason. This is a shorthand for task_update with status=failed + metadata note.

When to use:
- A task hit an unrecoverable error and you want to record why.
- You need to abandon a task quickly and move on.
- The user asked you to stop working on something.

When NOT to use:
- The task succeeded — use task_update with status=completed.
- You want to pause and come back later — set status to pending via task_update.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"task_id": map[string]interface{}{"type": "string", "description": "The task ID to stop."},
				"reason":  map[string]interface{}{"type": "string", "description": "Why the task was stopped/failed."},
			},
			"required": []string{"task_id"},
		},
	}
}

func init_task_output(r *Registry) {
	r.tools["task_output"] = Tool{
		Name: "task_output",
		Description: `Retrieve the metadata/output field of a task.

When to use:
- You stored results in a task's metadata field and need to read them back.
- A background or sub-agent task has completed and you want its output.
- You need to inspect what was recorded during a task's execution.

When NOT to use:
- You need the full task object (status, timestamps, etc.) — use task_get.
- You want to list tasks — use task_list.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"task_id": map[string]interface{}{"type": "string", "description": "The task ID whose output to retrieve."},
			},
			"required": []string{"task_id"},
		},
	}
}

// ---------- tool implementations ----------

func (r *Registry) taskCreate(args map[string]interface{}) ExecutionResult {
	subject := str(args, "subject")
	if subject == "" {
		return ExecutionResult{Error: "subject is required"}
	}
	description := str(args, "description")
	activeForm := str(args, "active_form")
	status := strOr(args, "status", "pending")
	if !validStatuses[status] {
		return ExecutionResult{Error: fmt.Sprintf("invalid status %q; must be one of: pending, in_progress, completed, failed, deleted", status)}
	}
	owner := str(args, "owner")
	metadata := str(args, "metadata")

	var blockedBy []string
	if raw, ok := args["blocked_by"].([]interface{}); ok {
		for _, v := range raw {
			if s, ok := v.(string); ok {
				blockedBy = append(blockedBy, s)
			}
		}
	}

	t := r.TaskStore.Create(subject, description, activeForm, status, owner, metadata, blockedBy)
	return ExecutionResult{Output: taskToJSON(t)}
}

func (r *Registry) taskGet(args map[string]interface{}) ExecutionResult {
	id := str(args, "task_id")
	if id == "" {
		return ExecutionResult{Error: "task_id is required"}
	}
	t := r.TaskStore.Get(id)
	if t == nil {
		return ExecutionResult{Error: fmt.Sprintf("task %q not found", id)}
	}
	return ExecutionResult{Output: taskToJSON(t)}
}

func (r *Registry) taskList(args map[string]interface{}) ExecutionResult {
	statusFilter := str(args, "status")
	var tasks []*TaskV2
	if statusFilter != "" {
		if !validStatuses[statusFilter] {
			return ExecutionResult{Error: fmt.Sprintf("invalid status filter %q", statusFilter)}
		}
		tasks = r.TaskStore.ListByStatus(statusFilter)
	} else {
		tasks = r.TaskStore.ListAll()
	}

	if len(tasks) == 0 {
		return ExecutionResult{Output: "(no tasks)"}
	}

	var b strings.Builder
	for _, t := range tasks {
		marker := "[ ]"
		display := t.Subject
		switch t.Status {
		case "in_progress":
			marker = "[~]"
			if t.ActiveForm != "" {
				display = t.ActiveForm
			}
		case "completed":
			marker = "[x]"
		case "failed":
			marker = "[!]"
		case "deleted":
			marker = "[-]"
		}
		ownerSuffix := ""
		if t.Owner != "" {
			ownerSuffix = fmt.Sprintf("  (owner: %s)", t.Owner)
		}
		fmt.Fprintf(&b, "%s %s: %s%s\n", marker, t.ID, display, ownerSuffix)
	}
	return ExecutionResult{Output: b.String()}
}

func (r *Registry) taskUpdate(args map[string]interface{}) ExecutionResult {
	id := str(args, "task_id")
	if id == "" {
		return ExecutionResult{Error: "task_id is required"}
	}

	r.TaskStore.mu.Lock()
	defer r.TaskStore.mu.Unlock()

	t, ok := r.TaskStore.tasks[id]
	if !ok {
		return ExecutionResult{Error: fmt.Sprintf("task %q not found", id)}
	}

	if newStatus := str(args, "status"); newStatus != "" {
		if !validStatuses[newStatus] {
			return ExecutionResult{Error: fmt.Sprintf("invalid status %q", newStatus)}
		}
		allowed, exists := validTransitions[t.Status]
		if !exists || !allowed[newStatus] {
			return ExecutionResult{Error: fmt.Sprintf("cannot transition from %q to %q", t.Status, newStatus)}
		}
		t.Status = newStatus
	}

	if v, ok := args["subject"].(string); ok && v != "" {
		t.Subject = v
	}
	if v, ok := args["description"].(string); ok {
		t.Description = v
	}
	if v, ok := args["active_form"].(string); ok {
		t.ActiveForm = v
	}
	if v, ok := args["owner"].(string); ok {
		t.Owner = v
	}
	if v, ok := args["metadata"].(string); ok {
		t.Metadata = v
	}
	if raw, ok := args["blocked_by"].([]interface{}); ok {
		t.BlockedBy = nil
		for _, v := range raw {
			if s, ok := v.(string); ok {
				t.BlockedBy = append(t.BlockedBy, s)
			}
		}
	}
	if raw, ok := args["blocks"].([]interface{}); ok {
		t.Blocks = nil
		for _, v := range raw {
			if s, ok := v.(string); ok {
				t.Blocks = append(t.Blocks, s)
			}
		}
	}

	t.UpdatedAt = time.Now()
	return ExecutionResult{Output: taskToJSON(t)}
}

func (r *Registry) taskStop(args map[string]interface{}) ExecutionResult {
	id := str(args, "task_id")
	if id == "" {
		return ExecutionResult{Error: "task_id is required"}
	}
	reason := strOr(args, "reason", "stopped")

	r.TaskStore.mu.Lock()
	defer r.TaskStore.mu.Unlock()

	t, ok := r.TaskStore.tasks[id]
	if !ok {
		return ExecutionResult{Error: fmt.Sprintf("task %q not found", id)}
	}

	if t.Status == "deleted" {
		return ExecutionResult{Error: fmt.Sprintf("task %q is deleted and cannot be modified", id)}
	}

	t.Status = "failed"
	t.Metadata = reason
	t.UpdatedAt = time.Now()
	return ExecutionResult{Output: fmt.Sprintf("task %s marked failed: %s", id, reason)}
}

func (r *Registry) taskOutput(args map[string]interface{}) ExecutionResult {
	id := str(args, "task_id")
	if id == "" {
		return ExecutionResult{Error: "task_id is required"}
	}
	t := r.TaskStore.Get(id)
	if t == nil {
		return ExecutionResult{Error: fmt.Sprintf("task %q not found", id)}
	}
	if t.Metadata == "" {
		return ExecutionResult{Output: "(no output)"}
	}
	return ExecutionResult{Output: t.Metadata}
}
