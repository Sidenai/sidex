package agent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/ai"
)

// DetectLoop scans recent messages for identical (name + arguments) tool calls.
// If the model is about to call the same thing a 4th consecutive time, returns
// a loud error string and true. The caller should short-circuit the tool execution.
func DetectLoop(messages []ai.Message, tc ai.ToolCall) (string, bool) {
	repeats := 0
	for i := len(messages) - 1; i >= 0 && i >= len(messages)-12; i-- {
		m := messages[i]
		if m.Role != ai.RoleAssistant || len(m.ToolCalls) == 0 {
			continue
		}
		matched := false
		for _, prev := range m.ToolCalls {
			if prev.Function.Name == tc.Function.Name && NormalizeArgs(prev.Function.Arguments) == NormalizeArgs(tc.Function.Arguments) {
				matched = true
				break
			}
		}
		if !matched {
			break
		}
		repeats++
	}
	if repeats >= 3 {
		return fmt.Sprintf("ERROR: loop detected — you have already called %q with these exact arguments %d times in a row. STOP calling this tool. Change your approach: try a different tool, different arguments, or answer the user based on what you already know. If a path or working directory does not exist, tell the user instead of retrying.", tc.Function.Name, repeats), true
	}
	return "", false
}

// NormalizeArgs canonicalizes JSON arguments for comparison. Empty strings
// are treated as "{}".
func NormalizeArgs(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "{}"
	}
	var v interface{}
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return s
	}
	return string(b)
}
