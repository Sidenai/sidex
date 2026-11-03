package cost

import "testing"

func TestAnthropicListPriceMatchesOfficialCard(t *testing.T) {
	cases := []struct {
		model        string
		inputPerMTok float64
		outPerMTok   float64
	}{
		{"anthropic/claude-sonnet-4.6", 3, 15},
		{"claude-sonnet-4-6", 3, 15},
		{"anthropic/claude-opus-4.6", 5, 25},
		{"anthropic/claude-opus-5", 5, 25},
		{"anthropic/claude-haiku-4.5", 1, 5},
		{"anthropic/claude-sonnet-5", 2, 10},
		{"anthropic/claude-fable-5", 10, 50},
	}
	for _, c := range cases {
		p := GetPricing(c.model)
		if p.InputPer1K != c.inputPerMTok/1000 || p.OutputPer1K != c.outPerMTok/1000 {
			t.Errorf("%s: got input=%v output=%v per 1K, want %v/%v",
				c.model, p.InputPer1K, p.OutputPer1K, c.inputPerMTok/1000, c.outPerMTok/1000)
		}
	}
}

func TestTurnCostUsesRealTokenCounts(t *testing.T) {
	// 2000 uncached in + 500 out on Sonnet 4.6: 2000/1e6*3 + 500/1e6*15
	got := TurnCost("anthropic/claude-sonnet-4.6", 2000, 500, 0, 0)
	want := 2000.0/1_000_000*3 + 500.0/1_000_000*15
	if abs(got-want) > 1e-12 {
		t.Fatalf("got %v want %v", got, want)
	}

	// Cache read is 10% of input: 10_000 cache-read on Sonnet = 10000/1e6*0.30
	cached := TurnCost("anthropic/claude-sonnet-4.6", 0, 0, 0, 10_000)
	wantCached := 10_000.0 / 1_000_000 * 0.30
	if abs(cached-wantCached) > 1e-12 {
		t.Fatalf("cache read got %v want %v", cached, wantCached)
	}
}

func TestContextWindowForModelByFamily(t *testing.T) {
	if ContextWindowForModel("anthropic/claude-sonnet-4.6") != 200_000 {
		t.Fatal("sonnet")
	}
	if ContextWindowForModel("openai/gpt-5.6-terra") != 400_000 {
		t.Fatal("gpt-5")
	}
	if ContextWindowForModel("google/gemini-3.5-flash") != 1_000_000 {
		t.Fatal("gemini")
	}
	if ContextWindowForModel("anthropic/claude-mythos") != 1_000_000 {
		t.Fatal("mythos")
	}
}

func abs(n float64) float64 {
	if n < 0 {
		return -n
	}
	return n
}
