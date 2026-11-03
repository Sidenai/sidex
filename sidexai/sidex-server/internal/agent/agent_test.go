package agent

import (
	"strings"
	"testing"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/session"
)

func TestNormalizeArgsStable(t *testing.T) {
	a := NormalizeArgs(`{"b":2,"a":1}`)
	b := NormalizeArgs(`{"a":1,"b":2}`)
	if a != b {
		t.Fatalf("normalized args should match: %q vs %q", a, b)
	}
}

func TestNormalizeArgsEmptyIsObject(t *testing.T) {
	if NormalizeArgs("") != "{}" {
		t.Fatalf("empty should be {}")
	}
	if NormalizeArgs("  ") != "{}" {
		t.Fatalf("whitespace should be {}")
	}
}

func testSession(t *testing.T) *session.Session {
	t.Helper()
	store, err := memory.NewBoltStore(t.TempDir() + "/mem.db")
	if err != nil {
		t.Fatalf("memory: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return session.NewManager(store).Create(t.TempDir())
}

func TestDetectLoopTriggersAfterThreeRepeats(t *testing.T) {
	sess := testSession(t)
	tc := ai.ToolCall{ID: "1", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"ls /fake"}`}}

	for i := 0; i < 3; i++ {
		sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: "", ToolCalls: []ai.ToolCall{tc}})
		sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: "error", ToolCallID: tc.ID, Name: tc.Function.Name})
	}

	msg, looped := DetectLoop(sess.GetMessages(), tc)
	if !looped {
		t.Fatalf("expected loop detection after 3 repeats")
	}
	if !strings.Contains(msg, "loop detected") {
		t.Fatalf("unexpected message: %q", msg)
	}
}

func TestDetectLoopNoFalsePositive(t *testing.T) {
	sess := testSession(t)
	tc1 := ai.ToolCall{ID: "1", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"ls"}`}}
	tc2 := ai.ToolCall{ID: "2", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"pwd"}`}}

	sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: "", ToolCalls: []ai.ToolCall{tc1}})
	sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: "ok", ToolCallID: "1", Name: "shell"})
	sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: "", ToolCalls: []ai.ToolCall{tc2}})
	sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: "ok", ToolCallID: "2", Name: "shell"})

	_, looped := DetectLoop(sess.GetMessages(), ai.ToolCall{ID: "3", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"ls"}`}})
	if looped {
		t.Fatalf("should not flag loop when calls differ")
	}
}

func TestDedupeCollapsesCwdCalls(t *testing.T) {
	a := ai.ToolCall{ID: "1", Function: ai.ToolCallFunc{Name: "cwd", Arguments: ""}}
	b := ai.ToolCall{ID: "2", Function: ai.ToolCallFunc{Name: "cwd", Arguments: "{}"}}
	c := ai.ToolCall{ID: "3", Function: ai.ToolCallFunc{Name: "cwd", Arguments: "{}"}}
	out := DedupeIdempotentCalls([]ai.ToolCall{a, b, c})
	if len(out) != 1 {
		t.Fatalf("expected 1, got %d", len(out))
	}
}

func TestDedupeKeepsNonIdempotent(t *testing.T) {
	s1 := ai.ToolCall{ID: "1", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"echo hi"}`}}
	s2 := ai.ToolCall{ID: "2", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"echo hi"}`}}
	out := DedupeIdempotentCalls([]ai.ToolCall{s1, s2})
	if len(out) != 2 {
		t.Fatalf("shell must NOT be deduped: %d", len(out))
	}
}

func TestDedupePreservesOrder(t *testing.T) {
	s := ai.ToolCall{ID: "1", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"ls"}`}}
	c1 := ai.ToolCall{ID: "2", Function: ai.ToolCallFunc{Name: "cwd", Arguments: "{}"}}
	c2 := ai.ToolCall{ID: "3", Function: ai.ToolCallFunc{Name: "cwd", Arguments: "{}"}}
	g := ai.ToolCall{ID: "4", Function: ai.ToolCallFunc{Name: "grep", Arguments: `{"pattern":"x"}`}}
	out := DedupeIdempotentCalls([]ai.ToolCall{s, c1, c2, g})
	if len(out) != 3 {
		t.Fatalf("expected 3, got %d", len(out))
	}
	if out[0].Function.Name != "shell" || out[1].Function.Name != "cwd" || out[2].Function.Name != "grep" {
		t.Fatalf("wrong order: %+v", out)
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.MaxTurns != 25 || cfg.MaxSubTurns != 15 || cfg.MaxConcurrency != 10 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestReadOnlyToolsCatalog(t *testing.T) {
	for _, name := range []string{"read_file", "grep", "cwd", "git_status"} {
		if !ReadOnlyTools[name] {
			t.Errorf("expected %q in ReadOnlyTools", name)
		}
	}
	for _, name := range []string{"shell", "write_file", "edit_file", "git_commit"} {
		if ReadOnlyTools[name] {
			t.Errorf("%q should NOT be read-only", name)
		}
	}
}

func TestLocalExecToolsCatalog(t *testing.T) {
	for _, name := range []string{"cwd", "read_file", "shell", "grep", "git_status"} {
		if !LocalExecTools[name] {
			t.Errorf("expected %q in LocalExecTools", name)
		}
	}
	for _, name := range []string{"web_fetch", "memory_store", "spawn_agents"} {
		if LocalExecTools[name] {
			t.Errorf("%q must NOT be local", name)
		}
	}
}

func TestModeExecutionAllowList(t *testing.T) {
	if IsToolAllowedInMode("write_file", ModePlan) {
		t.Fatalf("write_file must not execute in plan mode")
	}
	if IsToolAllowedInMode("exit_plan_mode", ModeAsk) {
		t.Fatalf("exit_plan_mode must not execute in ask mode")
	}
	if !IsToolAllowedInMode("read_file", ModeAsk) {
		t.Fatalf("read_file should execute in ask mode")
	}
	if !IsToolAllowedInMode("write_file", ModeAgent) {
		t.Fatalf("write_file should execute in agent mode")
	}
}
