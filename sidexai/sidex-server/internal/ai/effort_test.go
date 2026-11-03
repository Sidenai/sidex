package ai

import "testing"

func TestParseEffort(t *testing.T) {
	cases := []struct {
		s, want string
		budget  int
	}{
		{"", "none", 0},
		{"Low", "low", 0},
		{"MEDIUM", "medium", 0},
		{"high", "high", 0},
		{"ultra", "ultra", 0},
		{"max", "ultra", 0},
		{"", "low", 2000},
		{"", "medium", 4000},
		{"", "high", 8000},
		{"", "ultra", 16000},
	}
	for _, c := range cases {
		if got := ParseEffort(c.s, c.budget); string(got) != c.want {
			t.Errorf("ParseEffort(%q,%d)=%s want %s", c.s, c.budget, got, c.want)
		}
	}
}

func TestThinkingForAnthropicSonnet46(t *testing.T) {
	model := "anthropic/claude-sonnet-4.6"

	none := thinkingForAnthropic(model, &StreamOptions{Effort: "none"})
	if none.Thinking != nil {
		t.Fatalf("none should not enable thinking, got %+v", none.Thinking)
	}
	if none.OutputConfig == nil || none.OutputConfig.Effort != "low" {
		t.Fatalf("none on 4.6 must pin effort=low so the API does not default to high: %+v", none.OutputConfig)
	}

	low := thinkingForAnthropic(model, &StreamOptions{Effort: "low"})
	if low.Thinking == nil || low.Thinking.Type != "adaptive" {
		t.Fatalf("low should use adaptive thinking: %+v", low.Thinking)
	}
	if low.OutputConfig == nil || low.OutputConfig.Effort != "low" {
		t.Fatalf("low effort: %+v", low.OutputConfig)
	}

	high := thinkingForAnthropic(model, &StreamOptions{Effort: "high"})
	if high.OutputConfig == nil || high.OutputConfig.Effort != "high" {
		t.Fatalf("high: %+v", high.OutputConfig)
	}

	ultra := thinkingForAnthropic(model, &StreamOptions{Effort: "ultra"})
	if ultra.OutputConfig == nil || ultra.OutputConfig.Effort != "max" {
		t.Fatalf("ultra should map to max on sonnet 4.6: %+v", ultra.OutputConfig)
	}
	if ultra.Thinking == nil || ultra.Thinking.Type != "adaptive" {
		t.Fatalf("ultra thinking: %+v", ultra.Thinking)
	}
}

func TestThinkingForAnthropicBudgetModels(t *testing.T) {
	model := "anthropic/claude-sonnet-4.5"
	got := thinkingForAnthropic(model, &StreamOptions{Effort: "high"})
	if got.OutputConfig != nil {
		t.Fatalf("sonnet 4.5 should not send output_config: %+v", got.OutputConfig)
	}
	if got.Thinking == nil || got.Thinking.Type != "enabled" || got.Thinking.BudgetTokens != 8000 {
		t.Fatalf("sonnet 4.5 should use budget_tokens: %+v", got.Thinking)
	}

	none := thinkingForAnthropic(model, &StreamOptions{Effort: "none"})
	if none.Thinking != nil || none.OutputConfig != nil {
		t.Fatalf("none on 4.5 should omit thinking: %+v %+v", none.Thinking, none.OutputConfig)
	}
}

func TestReasoningForOpenAI(t *testing.T) {
	if reasoningForOpenAI("openai/gpt-5.4-mini", &StreamOptions{Effort: "none"}) != nil {
		t.Fatal("none should omit reasoning")
	}
	got := reasoningForOpenAI("openai/gpt-5.4-mini", &StreamOptions{Effort: "medium"})
	if got["effort"] != "medium" {
		t.Fatalf("got %#v", got)
	}
}
