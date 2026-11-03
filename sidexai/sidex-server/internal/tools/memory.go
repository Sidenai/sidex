package tools

import (
	"fmt"
	"strings"
	"time"

	"github.com/sidex-ai/sidex-server/internal/memory"
)

func init_memory(r *Registry) {
	r.tools["memory_store"] = Tool{
		Name: "memory_store",
		Description: `Store a durable memory about this project. Memories persist across sessions and are re-injected into the system prompt on future turns.

Use this for: tech stack, key directories, conventions, commands the user prefers, non-obvious constraints.

Do NOT use for short-term task state (use todo_write for that), transient facts, or things the user might want to forget.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"key":   map[string]interface{}{"type": "string", "description": "Short identifier, e.g. 'stack', 'lint_command', 'entrypoint'."},
				"value": map[string]interface{}{"type": "string", "description": "The content to remember."},
				"tags":  map[string]interface{}{"type": "string", "description": "Optional comma-separated tags to help search."},
			},
			"required": []string{"key", "value"},
		},
	}

	r.tools["memory_search"] = Tool{
		Name:        "memory_search",
		Description: `Search stored memories by keyword. Use this to recall user preferences, project conventions, or prior decisions saved in earlier sessions. Returns matching entries with their keys, values, and tags. Only searches memories explicitly stored via memory_store — not chat history.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string", "description": "Search term."},
			},
			"required": []string{"query"},
		},
	}
}

func (r *Registry) memoryStore(args map[string]interface{}) ExecutionResult {
	if r.store == nil {
		return ExecutionResult{Error: "memory store not available"}
	}
	key := str(args, "key")
	value := str(args, "value")
	tags := str(args, "tags")

	var tagList []string
	if tags != "" {
		for _, t := range strings.Split(tags, ",") {
			tagList = append(tagList, strings.TrimSpace(t))
		}
	}

	entry := memory.MemoryEntry{
		ID:        key,
		UserID:    r.UserID,
		Key:       key,
		Value:     value,
		Tags:      tagList,
		CreatedAt: time.Now(),
	}
	if err := r.store.SaveMemory(entry); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	return ExecutionResult{Output: fmt.Sprintf("stored memory: %s", key)}
}

func (r *Registry) memorySearch(args map[string]interface{}) ExecutionResult {
	if r.store == nil {
		return ExecutionResult{Error: "memory store not available"}
	}
	query := str(args, "query")
	results, err := r.store.SearchMemoryForUser(query, r.UserID)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	if len(results) == 0 {
		return ExecutionResult{Output: "no memories found"}
	}

	var out strings.Builder
	for _, m := range results {
		fmt.Fprintf(&out, "**%s**: %s\n", m.Key, m.Value)
		if len(m.Tags) > 0 {
			fmt.Fprintf(&out, "  tags: %s\n", strings.Join(m.Tags, ", "))
		}
	}
	return ExecutionResult{Output: out.String()}
}
