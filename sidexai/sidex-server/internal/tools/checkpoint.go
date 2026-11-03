package tools

import (
	"fmt"
	"os"
	"sync"
)

const maxCheckpoints = 5

type checkpointEntry struct {
	label string
	files map[string][]byte
}

type CheckpointStore struct {
	mu     sync.Mutex
	stack  []checkpointEntry
	labels map[string]int // label → index in stack
}

func newCheckpointStore() *CheckpointStore {
	return &CheckpointStore{
		labels: make(map[string]int),
	}
}

func (cs *CheckpointStore) save(label string, paths []string, resolver func(string) string) error {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	files := make(map[string][]byte, len(paths))
	for _, p := range paths {
		resolved := resolver(p)
		data, err := os.ReadFile(resolved)
		if err != nil {
			return fmt.Errorf("cannot checkpoint %s: %w", p, err)
		}
		files[resolved] = data
	}

	if idx, exists := cs.labels[label]; exists {
		cs.stack[idx].files = files
		return nil
	}

	if len(cs.stack) >= maxCheckpoints {
		evicted := cs.stack[0]
		delete(cs.labels, evicted.label)
		cs.stack = cs.stack[1:]
		for l, i := range cs.labels {
			cs.labels[l] = i - 1
		}
	}

	cs.stack = append(cs.stack, checkpointEntry{label: label, files: files})
	cs.labels[label] = len(cs.stack) - 1
	return nil
}

func (cs *CheckpointStore) restore(label string) (map[string][]byte, error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	idx, exists := cs.labels[label]
	if !exists {
		available := make([]string, 0, len(cs.labels))
		for l := range cs.labels {
			available = append(available, l)
		}
		return nil, fmt.Errorf("no checkpoint with label %q (available: %v)", label, available)
	}
	return cs.stack[idx].files, nil
}

func (cs *CheckpointStore) hasFile(path string) bool {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	for _, entry := range cs.stack {
		if _, ok := entry.files[path]; ok {
			return true
		}
	}
	return false
}

func init_checkpoint(r *Registry) {
	r.tools["checkpoint"] = Tool{
		Name: "checkpoint",
		Description: `Save the current contents of specified files to an in-memory snapshot you can roll back to later. Use this before risky edits (large refactors, experimental changes) so you can restore the files if tests fail or the approach doesn't work.

Up to 5 checkpoints per session (oldest evicted automatically). If the label already exists, the snapshot is overwritten with current file contents. Auto-checkpoints are also created by edit_file/write_file, but explicit checkpoints let you name and control the restore points.`,
		Dangerous: false,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"label": map[string]interface{}{"type": "string", "description": "A short name for this checkpoint (e.g. 'before-refactor')."},
				"files": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "List of file paths to snapshot.",
				},
			},
			"required": []string{"label", "files"},
		},
	}

	r.tools["rollback"] = Tool{
		Name: "rollback",
		Description: `Restore files to a previously saved checkpoint, reverting any changes made since the snapshot was taken. All files in the named checkpoint are overwritten on disk with their saved contents.

Use this when an edit broke things and you want to return to a known-good state. The checkpoint itself is preserved after rollback — you can roll back multiple times to the same label if needed.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"label": map[string]interface{}{"type": "string", "description": "The checkpoint label to restore."},
			},
			"required": []string{"label"},
		},
	}
}

func (r *Registry) checkpoint(args map[string]interface{}) ExecutionResult {
	label := str(args, "label")
	if label == "" {
		return ExecutionResult{Error: "label is required"}
	}

	filesRaw, ok := args["files"]
	if !ok {
		return ExecutionResult{Error: "files is required"}
	}
	filesArr, ok := filesRaw.([]interface{})
	if !ok || len(filesArr) == 0 {
		return ExecutionResult{Error: "files must be a non-empty array of paths"}
	}

	paths := make([]string, 0, len(filesArr))
	for _, f := range filesArr {
		s, ok := f.(string)
		if !ok || s == "" {
			continue
		}
		paths = append(paths, s)
	}

	if err := r.checkpoints.save(label, paths, r.resolvePath); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	return ExecutionResult{Output: fmt.Sprintf("checkpoint %q saved (%d file(s))", label, len(paths))}
}

func (r *Registry) rollback(args map[string]interface{}) ExecutionResult {
	label := str(args, "label")
	if label == "" {
		return ExecutionResult{Error: "label is required"}
	}

	files, err := r.checkpoints.restore(label)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	var restored int
	for path, data := range files {
		if err := os.WriteFile(path, data, 0644); err != nil {
			return ExecutionResult{Error: fmt.Sprintf("failed to restore %s: %v", path, err)}
		}
		r.trackRead(path)
		restored++
	}
	return ExecutionResult{Output: fmt.Sprintf("rolled back to %q (%d file(s) restored)", label, restored)}
}

// AutoCheckpoint is called before edit_file/write_file to automatically
// snapshot a file that hasn't been checkpointed yet in this session.
func (r *Registry) AutoCheckpoint(path string) {
	resolved := r.resolvePath(path)
	if r.checkpoints.hasFile(resolved) {
		return
	}
	if _, err := os.Stat(resolved); err != nil {
		return
	}
	_ = r.checkpoints.save("pre-edit", []string{path}, r.resolvePath)
}
