package cost

import (
	"strings"
	"testing"
)

func TestAddDefaultPricing(t *testing.T) {
	tr := NewTracker("default")
	turnCost := tr.Add("default", 1000, 0, 0, 0)

	const want = 0.003
	if turnCost != want {
		t.Errorf("Add() returned %f, want %f", turnCost, want)
	}
	if tr.TotalCost() != want {
		t.Errorf("TotalCost() = %f, want %f", tr.TotalCost(), want)
	}
}

func TestAddOutputTokens(t *testing.T) {
	tr := NewTracker("default")
	tr.Add("default", 0, 1000, 0, 0)

	const want = 0.015
	if tr.TotalCost() != want {
		t.Errorf("TotalCost() = %f, want %f", tr.TotalCost(), want)
	}
}

func TestAddCacheWriteTokens(t *testing.T) {
	tr := NewTracker("default")
	tr.Add("default", 0, 0, 1000, 0)

	const want = 0.00375
	if tr.TotalCost() != want {
		t.Errorf("TotalCost() = %f, want %f", tr.TotalCost(), want)
	}
}

func TestAddCacheReadTokens(t *testing.T) {
	tr := NewTracker("default")
	tr.Add("default", 0, 0, 0, 1000)

	const want = 0.0003
	if tr.TotalCost() != want {
		t.Errorf("TotalCost() = %f, want %f", tr.TotalCost(), want)
	}
}

func TestAddAccumulates(t *testing.T) {
	tr := NewTracker("default")
	tr.Add("default", 1000, 0, 0, 0)
	tr.Add("default", 1000, 0, 0, 0)

	const want = 0.006
	if tr.TotalCost() != want {
		t.Errorf("TotalCost() = %f, want %f", tr.TotalCost(), want)
	}
	u := tr.TotalUsage()
	if u.InputTokens != 2000 {
		t.Errorf("InputTokens = %d, want 2000", u.InputTokens)
	}
}

func TestAddMultipleModels(t *testing.T) {
	tr := NewTracker("default")
	c1 := tr.Add("some/unlisted-model", 1000, 0, 0, 0) // falls back to default pricing
	c2 := tr.Add("default", 1000, 0, 0, 0)

	if want := c1 + c2; tr.TotalCost() != want {
		t.Errorf("TotalCost() = %f, want %f", tr.TotalCost(), want)
	}
	if u := tr.TotalUsage(); u.InputTokens != 2000 {
		t.Errorf("InputTokens = %d, want 2000", u.InputTokens)
	}
}

func TestAddUnknownModelFallsBackToDefault(t *testing.T) {
	tr := NewTracker("unknown-model")
	turnCost := tr.Add("unknown-model", 1000, 0, 0, 0)

	const want = 0.003
	if turnCost != want {
		t.Errorf("Add() returned %f, want %f", turnCost, want)
	}
}

func TestTotalUsage(t *testing.T) {
	tr := NewTracker("default")
	tr.Add("default", 100, 200, 50, 30)
	u := tr.TotalUsage()

	if u.InputTokens != 100 || u.OutputTokens != 200 || u.CacheWriteTokens != 50 || u.CacheReadTokens != 30 {
		t.Errorf("TotalUsage() = %+v, want {100 200 50 30}", u)
	}
}

func TestSummaryFormat(t *testing.T) {
	tr := NewTracker("default")
	tr.Add("default", 1000, 500, 0, 0)
	s := tr.Summary()

	if !strings.Contains(s, "Cost: $") {
		t.Errorf("Summary() missing cost prefix: %s", s)
	}
	if !strings.Contains(s, "1000 in") {
		t.Errorf("Summary() missing input tokens: %s", s)
	}
	if !strings.Contains(s, "500 out") {
		t.Errorf("Summary() missing output tokens: %s", s)
	}
	if !strings.Contains(s, "Duration:") {
		t.Errorf("Summary() missing duration: %s", s)
	}
}

func TestToJSON(t *testing.T) {
	tr := NewTracker("default")
	tr.Add("default", 1000, 500, 200, 100)
	j := tr.ToJSON()

	if j["input_tokens"] != 1000 {
		t.Errorf("input_tokens = %v, want 1000", j["input_tokens"])
	}
	if j["output_tokens"] != 500 {
		t.Errorf("output_tokens = %v, want 500", j["output_tokens"])
	}
	if j["cache_write_tokens"] != 200 {
		t.Errorf("cache_write_tokens = %v, want 200", j["cache_write_tokens"])
	}
	if j["cache_read_tokens"] != 100 {
		t.Errorf("cache_read_tokens = %v, want 100", j["cache_read_tokens"])
	}
	if _, ok := j["total_cost"]; !ok {
		t.Error("ToJSON() missing total_cost key")
	}
	if _, ok := j["elapsed_ms"]; !ok {
		t.Error("ToJSON() missing elapsed_ms key")
	}
}

func TestGetPricingKnownModel(t *testing.T) {
	// Live prices are refreshed from OpenRouter at runtime, so the table's
	// values are not fixed. Verify lookup with a deterministic fixture entry.
	const id = "test/pricing-fixture"
	modelsMu.Lock()
	Pricing[id] = ModelPricing{InputPer1K: 0.015}
	modelsMu.Unlock()
	defer func() {
		modelsMu.Lock()
		delete(Pricing, id)
		modelsMu.Unlock()
	}()

	if p := GetPricing(id); p.InputPer1K != 0.015 {
		t.Errorf("InputPer1K = %f, want 0.015", p.InputPer1K)
	}
}

func TestGetPricingUnknownModel(t *testing.T) {
	p := GetPricing("nonexistent-model")
	def := Pricing["default"]
	if p != def {
		t.Errorf("GetPricing(unknown) = %+v, want default %+v", p, def)
	}
}
