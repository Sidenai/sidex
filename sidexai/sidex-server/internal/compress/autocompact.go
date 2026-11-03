package compress

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	MaxContextTokens   = 200000
	CompactTargetRatio = 0.6
	KeepRecentMessages = 6
	KeepRecentTools    = 3
)

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolCallFunc `json:"function"`
}

type ToolCallFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// AutoCompactIfNeeded checks if messages are approaching the given context
// budget and compresses old messages if necessary. Returns the (potentially
// compressed) message list and a boolean indicating if compaction occurred.
// This is Layer 5 of the compression pipeline — the most aggressive, last-resort
// strategy that summarizes old conversation history into a compact prefix.
// maxTokens <= 0 falls back to the package default MaxContextTokens.
func AutoCompactIfNeeded(messages []Message, maxTokens int, estimateTokensFn func(string) int) ([]Message, bool) {
	if maxTokens <= 0 {
		maxTokens = MaxContextTokens
	}
	total := 0
	for _, m := range messages {
		total += estimateTokensFn(m.Content)
		for _, tc := range m.ToolCalls {
			total += estimateTokensFn(tc.Function.Arguments)
		}
	}

	if total <= maxTokens {
		return messages, false
	}

	if len(messages) <= KeepRecentMessages {
		return messages, false
	}

	// Snap the keep-boundary so recentMessages never starts mid tool-exchange:
	// a tool-role message whose parent assistant tool_calls were summarized
	// away is an orphaned tool result → API 400.
	boundary := len(messages) - KeepRecentMessages
	for boundary > 0 && messages[boundary].Role == "tool" {
		boundary--
	}
	if boundary == 0 {
		return messages, false
	}

	oldMessages := messages[:boundary]
	recentMessages := messages[boundary:]

	editedFiles := collectEditedFiles(messages)
	toolResultCount := countToolResults(oldMessages)
	toolResultIndex := 0

	var summary strings.Builder
	summary.WriteString("[Previous conversation summary]\n\n")

	for _, m := range oldMessages {
		switch m.Role {
		case "user":
			text := m.Content
			if len(text) > 200 {
				text = text[:200] + "..."
			}
			fmt.Fprintf(&summary, "User: %s\n", text)
		case "assistant":
			text := m.Content
			if len(text) > 300 {
				text = text[:300] + "..."
			}
			if text != "" {
				fmt.Fprintf(&summary, "Assistant: %s\n", text)
			}
			if len(m.ToolCalls) > 0 {
				tools := make([]string, 0, len(m.ToolCalls))
				for _, tc := range m.ToolCalls {
					tools = append(tools, tc.Function.Name)
				}
				fmt.Fprintf(&summary, "  [Used tools: %s]\n", strings.Join(tools, ", "))
			}
		case "tool":
			toolResultIndex++
			if shouldRetainToolResult(m, toolResultIndex, toolResultCount, editedFiles) {
				retained := m.Content
				if len(retained) > 3000 {
					retained = SummarizeToolOutput(retained, 3000)
				}
				fmt.Fprintf(&summary, "  [Tool %s result (retained)]: %s\n", m.Name, retained)
			} else {
				oneLiner := summarizeToolCall(m.Name, m.Content)
				fmt.Fprintf(&summary, "  %s\n", oneLiner)
			}
		}
	}

	compacted := []Message{
		{Role: "user", Content: summary.String()},
		{Role: "assistant", Content: "[Conversation history compacted to save context. Continuing from here.]"},
	}
	compacted = append(compacted, recentMessages...)

	return compacted, true
}

// shouldRetainToolResult decides if a tool result should be kept in full
// rather than summarized during compaction.
func shouldRetainToolResult(m Message, index, total int, editedFiles map[string]bool) bool {
	if total-index < KeepRecentTools {
		return true
	}

	if containsError(m.Content) {
		return true
	}

	if m.Name == "read_file" && mentionsEditedFile(m.Content, editedFiles) {
		return true
	}

	return false
}

// containsError checks if tool output contains error indicators.
func containsError(content string) bool {
	lower := strings.ToLower(content)
	indicators := []string{
		"error:", "error :", "failed", "failure",
		"panic:", "traceback", "exception",
		"fatal", "exit code:", "stderr:",
		"FAILED", "FAIL",
	}
	for _, ind := range indicators {
		if strings.Contains(lower, strings.ToLower(ind)) {
			return true
		}
	}
	return false
}

// mentionsEditedFile checks if a read_file result references a file that was
// subsequently edited in the conversation.
func mentionsEditedFile(content string, editedFiles map[string]bool) bool {
	for file := range editedFiles {
		if strings.Contains(content, file) {
			return true
		}
	}
	return false
}

// collectEditedFiles scans the entire message history for edit_file/write_file
// calls and returns the set of file paths that were modified.
func collectEditedFiles(messages []Message) map[string]bool {
	files := make(map[string]bool)
	for _, m := range messages {
		for _, tc := range m.ToolCalls {
			switch tc.Function.Name {
			case "edit_file", "write_file", "multi_edit", "patch_file", "regex_replace":
				path := extractPathArg(tc.Function.Arguments)
				if path != "" {
					files[path] = true
				}
			}
		}
	}
	return files
}

// extractPathArg attempts to pull the "path" or "file_path" field from a JSON args string.
func extractPathArg(argsJSON string) string {
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return ""
	}
	for _, key := range []string{"path", "file_path", "filepath"} {
		if v, ok := args[key]; ok {
			if s, ok := v.(string); ok {
				return s
			}
		}
	}
	return ""
}

// countToolResults counts the number of tool-role messages in a slice.
func countToolResults(messages []Message) int {
	n := 0
	for _, m := range messages {
		if m.Role == "tool" {
			n++
		}
	}
	return n
}

// summarizeToolCall produces a one-line summary for a dropped tool result.
func summarizeToolCall(toolName, output string) string {
	switch toolName {
	case "read_file":
		lines := strings.Count(output, "\n") + 1
		funcSig := extractFirstFuncSignature(output)
		if funcSig != "" {
			return fmt.Sprintf("[read_file — %d lines, contains %s]", lines, funcSig)
		}
		return fmt.Sprintf("[read_file — %d lines]", lines)

	case "shell":
		return fmt.Sprintf("[shell — %s]", shellSummary(output))

	case "edit_file", "multi_edit", "patch_file", "regex_replace":
		return fmt.Sprintf("[%s — %s]", toolName, editSummary(output))

	case "write_file":
		lines := strings.Count(output, "\n") + 1
		return fmt.Sprintf("[write_file — wrote %d lines]", lines)

	case "grep", "search_files":
		matches := strings.Count(output, "\n")
		return fmt.Sprintf("[%s — %d matches]", toolName, matches)

	case "list_dir", "tree":
		entries := strings.Count(output, "\n")
		return fmt.Sprintf("[%s — %d entries]", toolName, entries)

	default:
		truncated := output
		if len(truncated) > 80 {
			truncated = truncated[:80] + "..."
		}
		truncated = strings.ReplaceAll(truncated, "\n", " ")
		return fmt.Sprintf("[%s — %s]", toolName, truncated)
	}
}

// extractFirstFuncSignature looks for the first function/method definition in file content.
func extractFirstFuncSignature(content string) string {
	prefixes := []string{"func ", "def ", "fn ", "class ", "export function ", "export default function "}
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		for _, p := range prefixes {
			if strings.HasPrefix(trimmed, p) {
				sig := trimmed
				if len(sig) > 60 {
					sig = sig[:60] + "..."
				}
				return sig
			}
		}
	}
	return ""
}

// shellSummary extracts a meaningful one-liner from shell output.
func shellSummary(output string) string {
	lower := strings.ToLower(output)

	if strings.Contains(lower, " passed") || strings.Contains(lower, " failed") {
		lines := strings.Split(strings.TrimSpace(output), "\n")
		for i := len(lines) - 1; i >= 0; i-- {
			l := strings.ToLower(lines[i])
			if strings.Contains(l, "passed") || strings.Contains(l, "failed") || strings.Contains(l, "ok") {
				summary := strings.TrimSpace(lines[i])
				if len(summary) > 80 {
					summary = summary[:80] + "..."
				}
				return summary
			}
		}
	}

	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) == 0 {
		return "(no output)"
	}
	last := strings.TrimSpace(lines[len(lines)-1])
	if len(last) > 80 {
		last = last[:80] + "..."
	}
	if last == "" && len(lines) > 1 {
		last = strings.TrimSpace(lines[len(lines)-2])
		if len(last) > 80 {
			last = last[:80] + "..."
		}
	}
	return last
}

// editSummary extracts a brief description from an edit tool result.
func editSummary(output string) string {
	if strings.Contains(output, "successfully") || strings.Contains(output, "Applied") {
		lines := strings.Split(output, "\n")
		for _, l := range lines {
			if strings.Contains(l, "successfully") || strings.Contains(l, "Applied") {
				s := strings.TrimSpace(l)
				if len(s) > 60 {
					s = s[:60] + "..."
				}
				return s
			}
		}
	}
	if len(output) > 60 {
		return output[:60] + "..."
	}
	return output
}
