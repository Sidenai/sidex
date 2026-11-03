package agent

import (
	"fmt"
	"strings"
)

// DebugSession tracks the state of a debug investigation across turns.
type DebugSession struct {
	BugDescription string
	Hypotheses     []Hypothesis
	LogsAdded      []LogEntry
	RuntimeResults []RuntimeResult
	RootCause      string
	FixApplied     bool
	Phase          DebugPhase
}

type DebugPhase int

const (
	DebugPhaseHypothesize DebugPhase = iota
	DebugPhaseInstrument
	DebugPhaseAnalyze
	DebugPhaseFix
	DebugPhaseVerify
	DebugPhaseCleanup
	DebugPhaseDone
)

func (p DebugPhase) String() string {
	switch p {
	case DebugPhaseHypothesize:
		return "hypothesize"
	case DebugPhaseInstrument:
		return "instrument"
	case DebugPhaseAnalyze:
		return "analyze"
	case DebugPhaseFix:
		return "fix"
	case DebugPhaseVerify:
		return "verify"
	case DebugPhaseCleanup:
		return "cleanup"
	case DebugPhaseDone:
		return "done"
	default:
		return "unknown"
	}
}

// Hypothesis represents a ranked guess about the bug's root cause.
type Hypothesis struct {
	ID          string  `json:"id"`
	Description string  `json:"description"`
	Confidence  float64 `json:"confidence"`
	Status      string  `json:"status"`
	Evidence    string  `json:"evidence"`
}

// LogEntry tracks a debug log statement added during instrumentation.
type LogEntry struct {
	FilePath string `json:"file_path"`
	Line     int    `json:"line"`
	LogStmt  string `json:"log_stmt"`
}

// RuntimeResult captures output from running the failing scenario.
type RuntimeResult struct {
	Command string `json:"command"`
	Output  string `json:"output"`
	LogData string `json:"log_data"`
}

// ParseDebug extracts the bug description from a "/debug" user message.
// Returns the description and ok=true if the message is a debug command.
func ParseDebug(msg string) (bugDesc string, ok bool) {
	trimmed := strings.TrimSpace(msg)

	lower := strings.ToLower(trimmed)
	if !strings.HasPrefix(lower, "/debug") {
		return "", false
	}

	rest := strings.TrimSpace(trimmed[len("/debug"):])
	if rest == "" {
		return "", false
	}

	return rest, true
}

// DebugModePromptSuffix is appended to the system prompt when in debug mode.
// It guides the model through a structured debugging methodology.
func DebugModePromptSuffix(bugDesc string) string {
	return fmt.Sprintf(`

# Current Mode: Debug

You are in DEBUG mode investigating a reported bug. Follow this structured debugging methodology rigorously. Stream your progress at each phase.

## Bug Report
%s

## Methodology — follow these phases IN ORDER:

### Phase 1: Hypothesize
Generate 3-5 ranked hypotheses for the root cause. For each hypothesis:
- Assign a confidence score (0.0-1.0)
- Describe what evidence would confirm or reject it
- Identify the code paths to investigate

Present hypotheses in a numbered list sorted by confidence. Use read_file, grep, and search_files to gather initial context. Do NOT guess — look at the actual code.

### Phase 2: Instrument
Starting with the highest-confidence hypothesis:
- Identify the key code paths that would reveal the bug
- Add strategic log/print statements at critical points (function entry/exit, branch conditions, variable values)
- Keep instrumentation minimal — only add logs that would differentiate between hypotheses
- Use edit_file to add the log statements

IMPORTANT: Track every log statement you add (file path + line) so you can remove them later.

### Phase 3: Run & Analyze
- Run the failing test, command, or scenario using shell
- Capture and analyze the output, paying special attention to your added log statements
- Based on the evidence, either:
  - CONFIRM the hypothesis → proceed to Phase 4
  - REJECT the hypothesis → remove its log statements, move to next hypothesis, go back to Phase 2

### Phase 4: Fix
Once the root cause is confirmed:
- Make a targeted, minimal fix — change only what's necessary
- Explain WHY this fix resolves the root cause
- Do NOT refactor unrelated code

### Phase 5: Verify
- Re-run the originally failing test/command to confirm the fix works
- Run any related tests to check for regressions
- If the fix doesn't work, go back to Phase 3

### Phase 6: Cleanup
- Remove ALL debug log statements you added in Phase 2
- Leave only the fix
- Run the test one final time to confirm clean state

### Phase 7: Summary
Present a structured investigation summary:
`+"```"+`
## Debug Investigation Summary

**Bug:** <one-line description>
**Root Cause:** <what was actually wrong>
**Hypotheses Tested:** <N tested, which confirmed>
**Fix:** <what you changed and why>
**Files Modified:** <list>
**Tests Passed:** <yes/no>
`+"```"+`

## Rules
- NEVER skip phases. If you can identify the bug immediately, still instrument and verify.
- ALWAYS clean up debug instrumentation before finishing.
- Prefer printf/log debugging over debugger attachment.
- If you run out of hypotheses without finding the bug, say so honestly.
- Use diff or git_diff_file to review your changes before finishing.`, bugDesc)
}
