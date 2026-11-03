package agent

import (
	"fmt"
	"strings"
	"sync"
)

// SecurityGateHook blocks dangerous shell commands that could cause
// irreversible damage. Fires on before_shell and before_tool_use events.
func SecurityGateHook(ctx *HookContext) *HookResult {
	cmd := ctx.Command
	if cmd == "" {
		if raw, ok := ctx.ToolArgs["command"].(string); ok {
			cmd = raw
		}
	}
	if cmd == "" {
		return DefaultHookResult()
	}

	lower := strings.ToLower(cmd)
	for _, pattern := range dangerousPatterns {
		if strings.Contains(lower, pattern) {
			return &HookResult{
				Allow:  false,
				Inject: "Hook [SecurityGate] blocked this command: matches dangerous pattern \"" + pattern + "\". Refusing to execute.",
			}
		}
	}
	return DefaultHookResult()
}

var dangerousPatterns = []string{
	"rm -rf /",
	"rm -rf /*",
	"rm -rf ~",
	"mkfs.",
	"dd if=/dev/zero",
	"dd if=/dev/random",
	":(){:|:&};:",
	"> /dev/sda",
	"chmod -r 777 /",
	"drop table",
	"drop database",
	"truncate table",
	"delete from",
	"format c:",
	"del /f /s /q c:",
	"shutdown",
	"halt",
	"init 0",
	"kill -9 1",
}

// MakeAutoFormatHook returns a hook that injects a formatting reminder
// after file edits. If formatter is empty, it defaults to detecting
// the project's configured formatter.
func MakeAutoFormatHook(formatter string) HookHandler {
	return func(ctx *HookContext) *HookResult {
		if ctx.FilePath == "" {
			return DefaultHookResult()
		}
		if formatter == "" {
			formatter = detectFormatter(ctx.FilePath)
		}
		if formatter == "" {
			return DefaultHookResult()
		}
		return &HookResult{
			Allow:  true,
			Inject: "Note: file " + ctx.FilePath + " was edited. Consider running formatter: " + formatter,
		}
	}
}

func detectFormatter(path string) string {
	lower := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lower, ".go"):
		return "gofmt"
	case strings.HasSuffix(lower, ".rs"):
		return "rustfmt"
	case strings.HasSuffix(lower, ".py"):
		return "black"
	case strings.HasSuffix(lower, ".ts"), strings.HasSuffix(lower, ".tsx"),
		strings.HasSuffix(lower, ".js"), strings.HasSuffix(lower, ".jsx"):
		return "prettier"
	default:
		return ""
	}
}

// MakeCostAlertHook returns a hook that fires a warning when the session
// cost exceeds the given threshold (in dollars).
func MakeCostAlertHook(threshold float64) HookHandler {
	var once sync.Once
	var alerted bool
	var mu sync.Mutex

	return func(ctx *HookContext) *HookResult {
		costVal, ok := ctx.Metadata["session_cost"]
		if !ok {
			return DefaultHookResult()
		}
		cost, ok := costVal.(float64)
		if !ok {
			return DefaultHookResult()
		}

		mu.Lock()
		wasAlerted := alerted
		mu.Unlock()

		if wasAlerted {
			return DefaultHookResult()
		}

		if cost >= threshold {
			once.Do(func() {
				mu.Lock()
				alerted = true
				mu.Unlock()
			})
			return &HookResult{
				Allow:  true,
				Inject: formatCostAlert(cost, threshold),
			}
		}
		return DefaultHookResult()
	}
}

func formatCostAlert(cost, threshold float64) string {
	return fmt.Sprintf(
		"[CostAlert] Session cost ($%.2f) has exceeded the configured threshold ($%.2f). Consider wrapping up or starting a new session.",
		cost, threshold,
	)
}

// LoopBreakerHook detects repetitive tool call patterns that indicate
// the agent is stuck in a loop. It enhances the existing DetectLoop
// mechanism by looking at broader patterns beyond identical consecutive calls.
func LoopBreakerHook(ctx *HookContext) *HookResult {
	if len(ctx.Messages) < 6 {
		return DefaultHookResult()
	}

	recent := make([]loopCallSig, 0, 12)
	for i := len(ctx.Messages) - 1; i >= 0 && len(recent) < 12; i-- {
		m := ctx.Messages[i]
		if m.Role != "assistant" || len(m.ToolCalls) == 0 {
			continue
		}
		for _, tc := range m.ToolCalls {
			recent = append(recent, loopCallSig{
				name: tc.Function.Name,
				args: NormalizeArgs(tc.Function.Arguments),
			})
		}
	}

	if pattern := detectAlternatingPattern(recent); pattern != "" {
		return &HookResult{
			Allow:  true,
			Inject: "[LoopBreaker] Detected repetitive pattern: " + pattern + ". You appear to be stuck in a loop. Stop and try a completely different approach.",
		}
	}

	return DefaultHookResult()
}

type loopCallSig struct {
	name string
	args string
}

func detectAlternatingPattern(calls []loopCallSig) string {
	if len(calls) < 6 {
		return ""
	}

	// Check for A-B-A-B-A-B pattern (period=2)
	if len(calls) >= 6 {
		a, b := calls[0], calls[1]
		matches := 0
		for i := 2; i+1 < len(calls); i += 2 {
			if calls[i] == a && calls[i+1] == b {
				matches++
			}
		}
		if matches >= 2 {
			return a.name + " <-> " + b.name + " (alternating)"
		}
	}

	// Check for same tool with different args repeated many times
	if len(calls) >= 5 {
		name := calls[0].name
		sameToolCount := 0
		for _, c := range calls[:5] {
			if c.name == name {
				sameToolCount++
			}
		}
		if sameToolCount >= 4 {
			return fmt.Sprintf("%s called %d of last 5 turns", name, sameToolCount)
		}
	}

	return ""
}

// ExplorationNudgeHook is a safety net that fires only when the agent has
// used an unusually large number of turns (20+) without making any edits.
// This catches pathological exploration loops, not normal behavior.
func ExplorationNudgeHook(ctx *HookContext) *HookResult {
	if ctx.Event != HookBeforeTurn {
		return DefaultHookResult()
	}
	if ctx.TurnNumber < 20 {
		return DefaultHookResult()
	}

	editTools := map[string]bool{
		"edit_file": true, "write_file": true, "create_file": true,
	}

	totalToolTurns := 0
	hasEdit := false
	for _, m := range ctx.Messages {
		if m.Role != "assistant" || len(m.ToolCalls) == 0 {
			continue
		}
		totalToolTurns++
		for _, tc := range m.ToolCalls {
			if editTools[tc.Function.Name] {
				hasEdit = true
			}
		}
	}

	if !hasEdit && totalToolTurns >= 20 {
		return &HookResult{
			Allow:  true,
			Inject: fmt.Sprintf("[SYSTEM] %d tool calls with no edits. Commit to a fix now — state which file to edit and make the change.", totalToolTurns),
		}
	}

	return DefaultHookResult()
}

// VerifyAfterEditHook reminds the agent to run tests after making edits,
// only if it's been 3+ turns since the last edit with no test execution.
func VerifyAfterEditHook(ctx *HookContext) *HookResult {
	if ctx.Event != HookBeforeTurn {
		return DefaultHookResult()
	}

	editTools := map[string]bool{
		"edit_file": true, "write_file": true, "create_file": true,
	}

	hasEdit := false
	lastEditTurn := -1
	ranTestAfterEdit := false
	turnIdx := 0

	for _, m := range ctx.Messages {
		if m.Role != "assistant" || len(m.ToolCalls) == 0 {
			continue
		}
		for _, tc := range m.ToolCalls {
			if editTools[tc.Function.Name] {
				hasEdit = true
				lastEditTurn = turnIdx
				ranTestAfterEdit = false
			}
			if tc.Function.Name == "shell" && lastEditTurn >= 0 && turnIdx > lastEditTurn {
				args := tc.Function.Arguments
				if strings.Contains(args, "test") || strings.Contains(args, "pytest") || strings.Contains(args, "runtests") {
					ranTestAfterEdit = true
				}
			}
		}
		turnIdx++
	}

	if hasEdit && !ranTestAfterEdit && turnIdx-lastEditTurn >= 3 {
		return &HookResult{
			Allow:  true,
			Inject: "[SYSTEM] You edited files but haven't verified. Run the tests now.",
		}
	}

	return DefaultHookResult()
}
