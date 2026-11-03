package context

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// FlowTracker records real-time IDE actions to build dynamic context.
// It maintains a sliding window of recent events and provides formatted
// context for injection into the agent's prompt at priority 600-700.
type FlowTracker struct {
	mu        sync.RWMutex
	events    []FlowEvent
	maxEvents int
}

// FlowEvent represents a single IDE action captured in real time.
type FlowEvent struct {
	Type      string            `json:"type"` // "file_edit", "file_open", "file_close", "terminal_run", "terminal_output", "navigation", "search"
	FilePath  string            `json:"file_path"`
	Content   string            `json:"content"` // snippet of what changed, command run, or output
	Timestamp time.Time         `json:"timestamp"`
	Metadata  map[string]string `json:"metadata"` // extra context (line number, language, exit code)
}

// NewFlowTracker creates a per-session flow tracker with a default capacity of 200 events.
func NewFlowTracker() *FlowTracker {
	return &FlowTracker{
		events:    make([]FlowEvent, 0, 200),
		maxEvents: 200,
	}
}

// Record adds a new IDE action event, evicting the oldest if at capacity.
func (ft *FlowTracker) Record(event FlowEvent) {
	ft.mu.Lock()
	defer ft.mu.Unlock()

	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now()
	}

	if len(ft.events) >= ft.maxEvents {
		copy(ft.events, ft.events[1:])
		ft.events = ft.events[:ft.maxEvents-1]
	}
	ft.events = append(ft.events, event)
}

// GetRecentContext returns a formatted string of recent IDE activity for injection
// into the agent's context window. Output is capped to approximately maxTokens
// (estimated at 3 runes/token, consistent with the context engine's estimateTokens).
func (ft *FlowTracker) GetRecentContext(maxTokens int) string {
	ft.mu.RLock()
	defer ft.mu.RUnlock()

	if len(ft.events) == 0 {
		return ""
	}

	maxChars := maxTokens * 3
	var b strings.Builder
	b.WriteString("<flow_context>\n")

	// Group by type for more coherent presentation
	recentEdits := ft.filterByType("file_edit", 10)
	recentTerminal := ft.filterByType("terminal_run", 5)
	recentOutput := ft.filterByType("terminal_output", 3)
	recentNav := ft.filterByType("navigation", 5)
	recentSearch := ft.filterByType("search", 3)

	if len(recentEdits) > 0 {
		b.WriteString("## Recent Edits\n")
		for _, e := range recentEdits {
			line := ft.formatEvent(e)
			if b.Len()+len(line) > maxChars {
				break
			}
			b.WriteString(line)
		}
	}

	if len(recentTerminal) > 0 {
		b.WriteString("## Terminal Activity\n")
		for _, e := range recentTerminal {
			line := ft.formatEvent(e)
			if b.Len()+len(line) > maxChars {
				break
			}
			b.WriteString(line)
		}
		for _, e := range recentOutput {
			line := ft.formatEvent(e)
			if b.Len()+len(line) > maxChars {
				break
			}
			b.WriteString(line)
		}
	}

	if len(recentNav) > 0 {
		b.WriteString("## Navigation\n")
		for _, e := range recentNav {
			line := ft.formatEvent(e)
			if b.Len()+len(line) > maxChars {
				break
			}
			b.WriteString(line)
		}
	}

	if len(recentSearch) > 0 {
		b.WriteString("## Searches\n")
		for _, e := range recentSearch {
			line := ft.formatEvent(e)
			if b.Len()+len(line) > maxChars {
				break
			}
			b.WriteString(line)
		}
	}

	b.WriteString("</flow_context>")
	return b.String()
}

// GetRecentFiles returns paths of recently touched files, ordered by recency (most recent first).
func (ft *FlowTracker) GetRecentFiles(limit int) []string {
	ft.mu.RLock()
	defer ft.mu.RUnlock()

	seen := make(map[string]bool)
	var files []string

	for i := len(ft.events) - 1; i >= 0 && len(files) < limit; i-- {
		e := ft.events[i]
		if e.FilePath == "" || seen[e.FilePath] {
			continue
		}
		if e.Type == "file_edit" || e.Type == "file_open" || e.Type == "navigation" {
			seen[e.FilePath] = true
			files = append(files, e.FilePath)
		}
	}
	return files
}

// GetRecentEdits returns formatted diffs/snippets of recent file edits.
func (ft *FlowTracker) GetRecentEdits(limit int) string {
	ft.mu.RLock()
	defer ft.mu.RUnlock()

	edits := ft.filterByType("file_edit", limit)
	if len(edits) == 0 {
		return ""
	}

	var b strings.Builder
	for _, e := range edits {
		elapsed := time.Since(e.Timestamp)
		b.WriteString(fmt.Sprintf("- %s (%s ago)", e.FilePath, formatFlowDuration(elapsed)))
		if line, ok := e.Metadata["line"]; ok {
			b.WriteString(fmt.Sprintf(" L%s", line))
		}
		b.WriteByte('\n')
		if e.Content != "" {
			snippet := e.Content
			if len(snippet) > 200 {
				snippet = snippet[:200] + "..."
			}
			b.WriteString("  " + strings.ReplaceAll(snippet, "\n", "\n  ") + "\n")
		}
	}
	return b.String()
}

// EventCount returns the number of events currently tracked.
func (ft *FlowTracker) EventCount() int {
	ft.mu.RLock()
	defer ft.mu.RUnlock()
	return len(ft.events)
}

// filterByType returns the last N events of a given type (most recent first).
// Must be called with ft.mu held.
func (ft *FlowTracker) filterByType(eventType string, limit int) []FlowEvent {
	var result []FlowEvent
	for i := len(ft.events) - 1; i >= 0 && len(result) < limit; i-- {
		if ft.events[i].Type == eventType {
			result = append(result, ft.events[i])
		}
	}
	return result
}

func (ft *FlowTracker) formatEvent(e FlowEvent) string {
	elapsed := time.Since(e.Timestamp)
	var b strings.Builder

	switch e.Type {
	case "file_edit":
		b.WriteString(fmt.Sprintf("- edited %s", e.FilePath))
		if line, ok := e.Metadata["line"]; ok {
			b.WriteString(fmt.Sprintf(":L%s", line))
		}
		b.WriteString(fmt.Sprintf(" (%s ago)\n", formatFlowDuration(elapsed)))
		if e.Content != "" {
			snippet := e.Content
			if len(snippet) > 150 {
				snippet = snippet[:150] + "..."
			}
			b.WriteString("  " + strings.ReplaceAll(snippet, "\n", "\n  ") + "\n")
		}

	case "file_open":
		b.WriteString(fmt.Sprintf("- opened %s (%s ago)\n", e.FilePath, formatFlowDuration(elapsed)))

	case "terminal_run":
		b.WriteString(fmt.Sprintf("- $ %s", e.Content))
		if code, ok := e.Metadata["exit_code"]; ok && code != "0" {
			b.WriteString(fmt.Sprintf(" [exit %s]", code))
		}
		b.WriteString(fmt.Sprintf(" (%s ago)\n", formatFlowDuration(elapsed)))

	case "terminal_output":
		output := e.Content
		if len(output) > 200 {
			output = output[:200] + "..."
		}
		b.WriteString(fmt.Sprintf("  output: %s\n", strings.ReplaceAll(output, "\n", "\n  ")))

	case "navigation":
		b.WriteString(fmt.Sprintf("- navigated to %s", e.FilePath))
		if line, ok := e.Metadata["line"]; ok {
			b.WriteString(fmt.Sprintf(":L%s", line))
		}
		b.WriteString(fmt.Sprintf(" (%s ago)\n", formatFlowDuration(elapsed)))

	case "search":
		b.WriteString(fmt.Sprintf("- searched: %q (%s ago)\n", e.Content, formatFlowDuration(elapsed)))

	default:
		b.WriteString(fmt.Sprintf("- [%s] %s (%s ago)\n", e.Type, e.FilePath, formatFlowDuration(elapsed)))
	}

	return b.String()
}

func formatFlowDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%dh", int(d.Hours()))
}
