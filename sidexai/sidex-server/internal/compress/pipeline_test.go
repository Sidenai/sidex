package compress

import (
	"fmt"
	"strings"
	"testing"
)

func makeMsg(role, content, name string) Message {
	return Message{
		Role:       role,
		Content:    content,
		Name:       name,
		ToolCallID: fmt.Sprintf("tc_%s", name),
	}
}

func bigString(n int) string {
	return strings.Repeat("x", n)
}

// --- Layer 1: BudgetReduce ---

func TestBudgetReduce_SmallMessages_Untouched(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "hi"},
		{Role: "tool", Content: "short result", ToolCallID: "tc1", Name: "read_file"},
	}
	result := BudgetReduce(msgs, 100000)
	if result[2].Content != "short result" {
		t.Errorf("expected small tool result untouched, got %q", result[2].Content)
	}
}

func TestBudgetReduce_TrimsOldLargeOutputs(t *testing.T) {
	large := bigString(90000)
	msgs := []Message{
		{Role: "user", Content: "do something"},
		{Role: "assistant", Content: "ok"},
		{Role: "tool", Content: large, ToolCallID: "tc1", Name: "read_file"},
		{Role: "assistant", Content: "next"},
		{Role: "tool", Content: large, ToolCallID: "tc2", Name: "grep"},
		{Role: "assistant", Content: "more"},
		{Role: "tool", Content: large, ToolCallID: "tc3", Name: "search"},
		{Role: "assistant", Content: "latest"},
		{Role: "tool", Content: "recent result", ToolCallID: "tc4", Name: "list_dir"},
	}
	result := BudgetReduce(msgs, 50000)
	if len(result[2].Content) >= len(large) {
		t.Errorf("expected old large tool result trimmed, got len=%d", len(result[2].Content))
	}
	if result[8].Content != "recent result" {
		t.Errorf("expected most recent tool result protected, got %q", result[8].Content)
	}
}

func TestBudgetReduce_NoToolResults(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "world"},
	}
	result := BudgetReduce(msgs, 100)
	if len(result) != 2 {
		t.Errorf("expected 2 messages, got %d", len(result))
	}
}

// --- Layer 2: Snip ---

func TestSnip_LargeMessageTruncated(t *testing.T) {
	large := bigString(20000)
	msgs := []Message{
		{Role: "tool", Content: large, ToolCallID: "tc1"},
		{Role: "user", Content: "question"},
	}
	result := Snip(msgs, 50000)
	if len(result[0].Content) >= len(large) {
		t.Errorf("expected large tool result snipped, got len=%d", len(result[0].Content))
	}
	if !strings.Contains(result[0].Content, "snipped") {
		t.Error("expected snip marker in truncated content")
	}
}

func TestSnip_ProtectsMostRecentUserAndAssistant(t *testing.T) {
	large := bigString(20000)
	msgs := []Message{
		{Role: "tool", Content: "small", ToolCallID: "tc1"},
		{Role: "assistant", Content: large},
		{Role: "user", Content: large},
	}
	result := Snip(msgs, 50000)
	if result[1].Content != large {
		t.Error("expected most recent assistant message protected")
	}
	if result[2].Content != large {
		t.Error("expected most recent user message protected")
	}
}

func TestSnip_SmallMessages_Untouched(t *testing.T) {
	msgs := []Message{
		{Role: "tool", Content: "short", ToolCallID: "tc1"},
		{Role: "user", Content: "hello"},
	}
	result := Snip(msgs, 50000)
	if result[0].Content != "short" {
		t.Errorf("expected short content untouched, got %q", result[0].Content)
	}
}

// --- Layer 3: Microcompact ---

func TestMicrocompact_ReplacesOldToolResults(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "start"},
		{Role: "assistant", Content: "step 1"},
		{Role: "tool", Content: bigString(500), ToolCallID: "tc1", Name: "read_file"},
		{Role: "assistant", Content: "step 2"},
		{Role: "tool", Content: bigString(500), ToolCallID: "tc2", Name: "grep"},
		{Role: "assistant", Content: "step 3"},
		{Role: "tool", Content: bigString(500), ToolCallID: "tc3", Name: "list_dir"},
		{Role: "assistant", Content: "step 4 (recent)"},
		{Role: "tool", Content: bigString(500), ToolCallID: "tc4", Name: "search"},
	}
	result := Microcompact(msgs)
	if !strings.HasPrefix(result[2].Content, "[tool: read_file]") {
		t.Errorf("expected old tool result to be microcompacted, got %q", result[2].Content)
	}
	if strings.HasPrefix(result[8].Content, "[tool:") {
		t.Error("expected recent tool result to be preserved")
	}
}

func TestMicrocompact_ShortToolResultsUnchanged(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "start"},
		{Role: "assistant", Content: "step 1"},
		{Role: "tool", Content: "ok", ToolCallID: "tc1", Name: "cwd"},
		{Role: "assistant", Content: "step 2"},
		{Role: "assistant", Content: "step 3"},
		{Role: "assistant", Content: "step 4"},
	}
	result := Microcompact(msgs)
	if result[2].Content != "ok" {
		t.Errorf("expected short tool result unchanged, got %q", result[2].Content)
	}
}

// --- Layer 4: Collapse ---

func TestCollapse_PreservesToolResultsAndIDs(t *testing.T) {
	// Tool results must NEVER be merged: each tool message has to keep its
	// unique ToolCallID to match the tool_use block in the assistant message,
	// or the provider API rejects the conversation.
	msgs := []Message{
		{Role: "user", Content: "do stuff"},
		{Role: "assistant", Content: "ok"},
		{Role: "tool", Content: "result A", ToolCallID: "tc1"},
		{Role: "tool", Content: "result B", ToolCallID: "tc2"},
		{Role: "tool", Content: "result C", ToolCallID: "tc3"},
		{Role: "user", Content: "thanks"},
	}
	result := Collapse(msgs)
	if len(result) != len(msgs) {
		t.Fatalf("expected all %d messages preserved, got %d", len(msgs), len(result))
	}
	for i, want := range []string{"", "", "tc1", "tc2", "tc3", ""} {
		if result[i].ToolCallID != want {
			t.Errorf("message %d: ToolCallID = %q, want %q", i, result[i].ToolCallID, want)
		}
	}
}

func TestCollapse_DoesNotMergeUserMessages(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "msg1"},
		{Role: "user", Content: "msg2"},
	}
	result := Collapse(msgs)
	if len(result) != 2 {
		t.Errorf("expected user messages not collapsed, got %d messages", len(result))
	}
}

func TestCollapse_ProtectsLastAssistant(t *testing.T) {
	msgs := []Message{
		{Role: "assistant", Content: "old"},
		{Role: "assistant", Content: "latest"},
	}
	result := Collapse(msgs)
	found := false
	for _, m := range result {
		if m.Content == "latest" {
			found = true
		}
	}
	if !found {
		t.Error("expected last assistant message preserved")
	}
}

func TestCollapse_SingleMessage(t *testing.T) {
	msgs := []Message{{Role: "user", Content: "hello"}}
	result := Collapse(msgs)
	if len(result) != 1 {
		t.Errorf("expected 1 message, got %d", len(result))
	}
}

// --- Layer 5: Autocompact ---

func TestAutocompact_UnderLimit_NoChange(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "world"},
	}
	result, did := AutoCompactIfNeeded(msgs, MaxContextTokens, EstimateTokens)
	if did {
		t.Error("expected no compaction for small context")
	}
	if len(result) != 2 {
		t.Errorf("expected 2 messages, got %d", len(result))
	}
}

func TestAutocompact_OverLimit_Compacts(t *testing.T) {
	large := bigString(MaxContextTokens * 4)
	msgs := []Message{
		{Role: "user", Content: large},
		{Role: "assistant", Content: "step 1"},
		{Role: "user", Content: "more"},
		{Role: "assistant", Content: "step 2"},
		{Role: "user", Content: "again"},
		{Role: "assistant", Content: "step 3"},
		{Role: "user", Content: "and more"},
		{Role: "assistant", Content: "step 4"},
		{Role: "user", Content: "keep going"},
		{Role: "assistant", Content: "step 5"},
		{Role: "user", Content: "latest question"},
		{Role: "assistant", Content: "latest answer"},
	}
	result, did := AutoCompactIfNeeded(msgs, MaxContextTokens, EstimateTokens)
	if !did {
		t.Error("expected compaction for oversized context")
	}
	if len(result) >= len(msgs) {
		t.Errorf("expected fewer messages after compaction, got %d (original %d)", len(result), len(msgs))
	}
	if result[len(result)-1].Content != "latest answer" {
		t.Error("expected recent messages preserved")
	}
}

// --- Pipeline orchestrator ---

func TestRunPipeline_SmallContext_Passthrough(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "hi there"},
	}
	result := RunPipeline(msgs, 100000)
	if len(result) != 2 {
		t.Errorf("expected passthrough for small context, got %d messages", len(result))
	}
	if result[0].Content != "hello" {
		t.Errorf("expected content unchanged, got %q", result[0].Content)
	}
}

func TestRunPipeline_EmptyMessages(t *testing.T) {
	result := RunPipeline(nil, 100000)
	if len(result) != 0 {
		t.Errorf("expected empty result for nil input, got %d", len(result))
	}
}

func TestRunPipeline_LargeContext_Compresses(t *testing.T) {
	large := bigString(60000)
	msgs := []Message{
		{Role: "user", Content: "start"},
		{Role: "assistant", Content: "working"},
		{Role: "tool", Content: large, ToolCallID: "tc1", Name: "read_file"},
		{Role: "assistant", Content: "next step"},
		{Role: "tool", Content: large, ToolCallID: "tc2", Name: "grep"},
		{Role: "assistant", Content: "continuing"},
		{Role: "tool", Content: large, ToolCallID: "tc3", Name: "search"},
		{Role: "user", Content: "what now?"},
		{Role: "assistant", Content: "latest"},
	}

	totalBefore := EstimateMessagesTokens(msgs)
	result := RunPipeline(msgs, 50000)
	totalAfter := EstimateMessagesTokens(result)

	if totalAfter >= totalBefore {
		t.Errorf("expected token reduction, before=%d after=%d", totalBefore, totalAfter)
	}
}

func TestEstimateMessagesTokens(t *testing.T) {
	msgs := []Message{
		{Role: "user", Content: "hello world"},
		{Role: "assistant", Content: "hi", ToolCalls: []ToolCall{
			{Function: ToolCallFunc{Arguments: `{"path": "/foo"}`}},
		}},
	}
	tokens := EstimateMessagesTokens(msgs)
	if tokens <= 0 {
		t.Errorf("expected positive token count, got %d", tokens)
	}
}
