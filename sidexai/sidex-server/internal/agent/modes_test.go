package agent

import (
	"testing"

	"github.com/sidex-ai/sidex-server/internal/ai"
)

func makeSampleToolDefs() []ai.ToolDef {
	names := []string{
		"read_file", "write_file", "edit_file", "shell", "grep", "glob",
		"tree", "diff", "batch_read", "file_info", "git_status", "git_log",
		"git_diff_file", "git_commit", "web_fetch", "memory_search",
		"shell_output", "list_shells", "cwd", "spawn_agents",
		"exit_plan_mode", "enter_plan_mode",
	}
	var defs []ai.ToolDef
	for _, n := range names {
		defs = append(defs, ai.ToolDef{
			Type:     "function",
			Function: ai.ToolFuncDef{Name: n, Description: n + " tool"},
		})
	}
	return defs
}

func TestFilterToolDefs_AgentModeReturnsAll(t *testing.T) {
	defs := makeSampleToolDefs()
	filtered := FilterToolDefs(defs, ModeAgent)
	if len(filtered) != len(defs) {
		t.Fatalf("agent mode should return all %d tools, got %d", len(defs), len(filtered))
	}
}

func TestFilterToolDefs_PlanModeFiltersWriteTools(t *testing.T) {
	defs := makeSampleToolDefs()
	filtered := FilterToolDefs(defs, ModePlan)

	allowed := make(map[string]bool)
	for _, d := range filtered {
		allowed[d.Function.Name] = true
	}

	for _, mustHave := range []string{"read_file", "grep", "glob", "cwd", "git_status", "exit_plan_mode"} {
		if !allowed[mustHave] {
			t.Errorf("plan mode should include %q", mustHave)
		}
	}

	for _, mustNot := range []string{"write_file", "edit_file", "shell", "git_commit", "spawn_agents", "enter_plan_mode"} {
		if allowed[mustNot] {
			t.Errorf("plan mode should NOT include %q", mustNot)
		}
	}
}

func TestFilterToolDefs_AskModeCannotSelfEscalate(t *testing.T) {
	defs := makeSampleToolDefs()
	askFiltered := FilterToolDefs(defs, ModeAsk)

	allowed := make(map[string]bool)
	for _, d := range askFiltered {
		allowed[d.Function.Name] = true
	}
	// Ask mode must never include mode-switching tools — an "ask"
	// conversation must not silently become a full agent.
	if allowed["exit_plan_mode"] || allowed["enter_plan_mode"] {
		t.Error("ask mode must not include mode-switching tools")
	}
	for _, mustHave := range []string{"read_file", "grep", "glob"} {
		if !allowed[mustHave] {
			t.Errorf("ask mode should include %q", mustHave)
		}
	}
}

func TestFilterToolDefs_DebugAndProactiveGetWriteTools(t *testing.T) {
	defs := makeSampleToolDefs()
	for _, mode := range []AgentMode{ModeDebug, ModeProactive} {
		filtered := FilterToolDefs(defs, mode)
		if len(filtered) != len(defs) {
			t.Errorf("%s mode should return all %d tools (it must be able to write), got %d", mode, len(defs), len(filtered))
		}
	}
}

func TestPlanModePromptSuffixNonEmpty(t *testing.T) {
	s := PlanModePromptSuffix()
	if s == "" {
		t.Fatal("PlanModePromptSuffix should not be empty")
	}
	if len(s) < 50 {
		t.Fatal("PlanModePromptSuffix seems too short")
	}
}

func TestAskModePromptSuffixNonEmpty(t *testing.T) {
	s := AskModePromptSuffix()
	if s == "" {
		t.Fatal("AskModePromptSuffix should not be empty")
	}
	if len(s) < 20 {
		t.Fatal("AskModePromptSuffix seems too short")
	}
}

func TestModeConstants(t *testing.T) {
	if ModeAgent != "agent" {
		t.Errorf("ModeAgent = %q, want %q", ModeAgent, "agent")
	}
	if ModePlan != "plan" {
		t.Errorf("ModePlan = %q, want %q", ModePlan, "plan")
	}
	if ModeAsk != "ask" {
		t.Errorf("ModeAsk = %q, want %q", ModeAsk, "ask")
	}
}
