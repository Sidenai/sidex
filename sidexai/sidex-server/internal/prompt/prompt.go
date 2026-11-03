// Package prompt builds Sidex's system prompt out of composable sections,
// directly inspired by Claude Code's layered prompt architecture:
// intro -> system -> doing-tasks -> actions-with-care -> using-tools ->
// tone -> output-efficiency -> env -> session-specific -> memory -> IDE context.
//
// The goal is a single source of truth that is readable, testable, and keeps
// the model from blind-retrying, over-exploring, or narrating every action.
package prompt

import (
	"fmt"
	"strings"
)

// IDEContext carries what the editor client forwards per request.
type IDEContext struct {
	ActiveFile       string
	Language         string
	Selection        string
	SelectionRange   *SelectionRange
	WorkspaceFolders []string
	OpenFiles        []string
}

type SelectionRange struct {
	StartLine   int
	StartColumn int
	EndLine     int
	EndColumn   int
}

// Memory is a single project-memory entry.
type Memory struct {
	Key   string
	Value string
}

// Input drives prompt assembly.
type Input struct {
	CWD          string
	Model        string
	IsGit        bool
	Platform     string
	Shell        string
	Context      *IDEContext
	Memories     []Memory
	LocalExec    bool
	MemdirPrompt string         // file-based MEMORY.md content, appended after BoltDB memories
	RulesPrompt  string         // custom workspace rules (.sidexrules or .sidex/rules/)
	PromptMode   string         // "full" (default) or "minimal"
	UserInfo     *UserInfoBlock // client-provided user info (like Cursor's <user_info>)
	RecentFiles  []OpenFileInfo // recently viewed files, most recent first
	OpenFiles    []OpenFileInfo // currently open/visible files in the IDE
}

type UserInfoBlock struct {
	OS              string
	Shell           string
	WorkspacePath   string
	IsGitRepo       bool
	GitRepoRoot     string // path to the git root (e.g. "/Users/foo/project")
	Date            string
	TerminalsFolder string // path to IDE terminal state files, if available
}

// Build assembles the full system prompt. Sections are joined with blank
// lines and null sections are skipped — matching Claude Code's compose style.
// Respects Input.PromptMode: "minimal" uses the stripped-down prompt variant.
func Build(in Input) string {
	if in.PromptMode == "minimal" {
		return MinimalSystemPrompt(in)
	}

	sections := []string{
		intro(in.Model),
		systemSection(),
		maximizeContextUnderstandingSection(),
		doingTasksSection(),
		codeChangesSection(),
		citingCodeSection(),
		actionsWithCareSection(),
		gitSafetySection(),
		usingYourToolsSection(),
		toneAndStyleSection(),
		modeSelectionSection(),
		outputEfficiencySection(),
		environmentSection(in),
		terminalFilesSection(in),
		workspaceContextSection(in),
		openFilesSection(in),
		sessionSpecificGuidance(),
		ideContextSection(in.Context),
		memorySection(in.Memories),
		in.MemdirPrompt,
		in.RulesPrompt,
	}

	out := make([]string, 0, len(sections))
	for _, s := range sections {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, "\n\n")
}

// SystemReminder wraps ephemeral IDE context into an inline reminder that
// accompanies the user message, mirroring Claude Code's <system-reminder> pattern.
// The server prepends this to the user's message content when ctx is non-empty.
func SystemReminder(ctx *IDEContext) string {
	if ctx == nil {
		return ""
	}
	parts := []string{}
	if ctx.ActiveFile != "" {
		parts = append(parts, fmt.Sprintf("active_file=%s", ctx.ActiveFile))
	}
	if ctx.Language != "" {
		parts = append(parts, fmt.Sprintf("language=%s", ctx.Language))
	}
	if ctx.Selection != "" {
		parts = append(parts, fmt.Sprintf("selection_len=%d", len(ctx.Selection)))
	}
	if len(parts) == 0 {
		return ""
	}
	return fmt.Sprintf("<system-reminder>%s</system-reminder>", strings.Join(parts, " "))
}
