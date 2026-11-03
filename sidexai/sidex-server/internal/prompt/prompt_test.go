package prompt

import (
	"strings"
	"testing"
)

func TestBuildIncludesAllCoreSections(t *testing.T) {
	out := Build(Input{
		CWD:      "/home/alice/proj",
		Model:    "claude-sonnet-4-6",
		IsGit:    true,
		Platform: "darwin",
		Shell:    "zsh",
	})

	required := []string{
		"<system-communication>",
		"<doing_tasks>",
		"<making_code_changes>",
		"<no_thinking_in_code_or_commands>",
		"<linter_errors>",
		"<inline_line_numbers>",
		"<executing_actions>",
		"<committing_changes_with_git>",
		"<tool_calling>",
		"<tone_and_style>",
		"<mode_selection>",
		"<output_efficiency>",
		"<environment>",
		"<session_guidance>",
		"SideX",
		"/home/alice/proj",
	}
	for _, s := range required {
		if !strings.Contains(out, s) {
			t.Errorf("prompt missing %q", s)
		}
	}
}

func TestBuildOmitsIDEContextWhenNil(t *testing.T) {
	out := Build(Input{CWD: "/tmp"})
	if strings.Contains(out, "<ide_context>") {
		t.Fatalf("should not include IDE context when nil")
	}
}

func TestBuildOmitsIDEContextWhenEmpty(t *testing.T) {
	out := Build(Input{CWD: "/tmp", Context: &IDEContext{}})
	if strings.Contains(out, "<ide_context>") {
		t.Fatalf("should not include IDE context when empty: %s", out)
	}
}

func TestBuildIncludesIDEContextFields(t *testing.T) {
	out := Build(Input{
		CWD: "/tmp",
		Context: &IDEContext{
			ActiveFile:       "/p/src/a.ts",
			Language:         "typescript",
			Selection:        "const x = 1",
			WorkspaceFolders: []string{"/p"},
			OpenFiles:        []string{"/p/a.ts", "/p/b.ts"},
		},
	})
	for _, s := range []string{"/p/src/a.ts", "typescript", "const x = 1", "/p/a.ts"} {
		if !strings.Contains(out, s) {
			t.Errorf("expected context to include %q\n%s", s, out)
		}
	}
}

func TestBuildTruncatesLongSelection(t *testing.T) {
	long := strings.Repeat("x", 3000)
	out := Build(Input{Context: &IDEContext{Selection: long}})
	if !strings.Contains(out, "...(truncated)") {
		t.Fatalf("expected long selection to be truncated")
	}
}

func TestBuildCapsOpenFilesAt15(t *testing.T) {
	files := make([]string, 30)
	for i := range files {
		files[i] = "/p/f" + string(rune('0'+i%10)) + ".ts"
	}
	out := Build(Input{Context: &IDEContext{OpenFiles: files}})
	if !strings.Contains(out, "Open files (up to 15)") {
		t.Fatalf("expected cap message: %s", out)
	}
}

func TestBuildOpenFilesSectionExplainsCurrentFileResolution(t *testing.T) {
	out := Build(Input{
		OpenFiles: []OpenFileInfo{
			{Path: "/p/package.json", IsFocused: true},
		},
	})
	for _, s := range []string{"currently focused file", "If the user says \"current file\"", "ask one direct clarifying question"} {
		if !strings.Contains(out, s) {
			t.Fatalf("expected open file guidance %q in prompt:\n%s", s, out)
		}
	}
}

func TestBuildIncludesMemory(t *testing.T) {
	out := Build(Input{
		CWD: "/tmp",
		Memories: []Memory{
			{Key: "stack", Value: "Go + OpenRouter"},
			{Key: "style", Value: "no gold-plating"},
		},
	})
	if !strings.Contains(out, "<project_memory>") {
		t.Fatalf("missing memory section")
	}
	if !strings.Contains(out, "stack") || !strings.Contains(out, "Go + OpenRouter") {
		t.Fatalf("memory content missing: %s", out)
	}
}

func TestBuildOmitsMemoryWhenEmpty(t *testing.T) {
	out := Build(Input{CWD: "/tmp"})
	if strings.Contains(out, "<project_memory>") {
		t.Fatalf("should not include memory when empty")
	}
}

func TestAntiLoopLanguageIsPresent(t *testing.T) {
	out := Build(Input{})
	phrases := []string{
		"do NOT retry",
		"materially different",
		"does not exist",
		"tell the user",
	}
	for _, p := range phrases {
		if !strings.Contains(strings.ToLower(out), strings.ToLower(p)) {
			t.Errorf("anti-loop language missing: %q", p)
		}
	}
}

func TestToolPreferenceIsPresent(t *testing.T) {
	out := Build(Input{})
	must := []string{
		"read_file", "edit_file", "write_file", "grep", "glob",
		"run_background", "todo_write", "spawn_agents",
	}
	for _, m := range must {
		if !strings.Contains(out, m) {
			t.Errorf("tool mention missing: %q", m)
		}
	}
}

func TestSystemReminderProducesTagWhenNonEmpty(t *testing.T) {
	r := SystemReminder(&IDEContext{ActiveFile: "/a.ts", Language: "ts"})
	if !strings.HasPrefix(r, "<system-reminder>") || !strings.HasSuffix(r, "</system-reminder>") {
		t.Fatalf("bad reminder: %q", r)
	}
	if !strings.Contains(r, "active_file=/a.ts") || !strings.Contains(r, "language=ts") {
		t.Fatalf("reminder content wrong: %q", r)
	}
}

func TestSystemReminderEmptyForNil(t *testing.T) {
	if SystemReminder(nil) != "" {
		t.Fatalf("nil should produce empty")
	}
	if SystemReminder(&IDEContext{}) != "" {
		t.Fatalf("empty should produce empty")
	}
}

func TestBuildIsStable(t *testing.T) {
	in := Input{CWD: "/tmp", Model: "m", IsGit: false, Platform: "linux", Shell: "bash"}
	a := Build(in)
	b := Build(in)
	if a != b {
		t.Fatalf("Build should be deterministic for identical input")
	}
}

func TestNoWorkspaceHandling(t *testing.T) {
	out := Build(Input{CWD: "", Platform: "darwin"})
	if !strings.Contains(out, "No workspace is currently open") {
		t.Fatalf("should include no-workspace warning when CWD is empty")
	}
	if !strings.Contains(out, "Do NOT explore random directories") {
		t.Fatalf("should include anti-exploration warning")
	}
}

func TestMinimalPromptNoWorkspace(t *testing.T) {
	out := MinimalSystemPrompt(Input{CWD: "", Platform: "darwin", PromptMode: "minimal"})
	if !strings.Contains(out, "no workspace open") {
		t.Fatalf("minimal prompt should handle empty CWD: %s", out)
	}
}
