package cost

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ModelPricing struct {
	InputPer1K      float64 `json:"inputPer1K"`
	OutputPer1K     float64 `json:"outputPer1K"`
	CacheWritePer1K float64 `json:"cacheWritePer1K"`
	CacheReadPer1K  float64 `json:"cacheReadPer1K"`
}

type ModelInfo struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Provider         string `json:"provider"`
	ContextWindow    int    `json:"context_window"`
	MaxOutput        int    `json:"max_output"`
	SupportsTools    bool   `json:"supports_tools"`
	SupportsThinking bool   `json:"supports_thinking"`
	// Default marks models enabled out-of-the-box. Clients derive their
	// default-enabled set from this flag instead of hardcoding ID lists.
	Default bool         `json:"default"`
	Pricing ModelPricing `json:"pricing"`
}

var (
	modelsMu sync.RWMutex
	Models   = []ModelInfo{
		// Default structure, but prices will be overwritten by OpenRouter
		// Offline fallback only. The picker is filled from each connected
		// provider's /models list at runtime — do not grow this with every
		// new Claude / Codex / Gemini snapshot.
		{ID: "anthropic/claude-sonnet-4.6", Name: "Claude Sonnet 4.6", Provider: "anthropic", ContextWindow: 200_000, MaxOutput: 64_000, SupportsTools: true, SupportsThinking: true, Default: true},
		{ID: "anthropic/claude-opus-4.6", Name: "Claude Opus 4.6", Provider: "anthropic", ContextWindow: 200_000, MaxOutput: 32_000, SupportsTools: true, SupportsThinking: true, Default: true},
		{ID: "anthropic/claude-haiku-4.5", Name: "Claude Haiku 4.5", Provider: "anthropic", ContextWindow: 200_000, MaxOutput: 8_192, SupportsTools: true, SupportsThinking: false, Default: true},
		{ID: "openai/gpt-5.4-mini", Name: "GPT-5.4 mini", Provider: "openai", ContextWindow: 400_000, MaxOutput: 16_000, SupportsTools: true, SupportsThinking: true, Default: true},
		{ID: "google/gemini-3.5-flash", Name: "Gemini 3.5 Flash", Provider: "google", ContextWindow: 1_000_000, MaxOutput: 65_536, SupportsTools: true, SupportsThinking: true, Default: true},
	}
	Pricing = make(map[string]ModelPricing)

	// liveModels holds metadata for EVERY model OpenRouter advertises, so
	// custom/BYO model IDs get real pricing and context windows instead of
	// fabricated defaults.
	liveModels = make(map[string]liveModelMeta)

	startOnce sync.Once
)

type liveModelMeta struct {
	pricing       ModelPricing
	contextWindow int
	maxOutput     int
}

func init() {
	// Seed ACCURATE per-model pricing so usage is billed correctly even
	// before (or without) a successful OpenRouter live refresh. A single
	// flat default would bill Opus at ~1/5 of its real rate and Haiku at 4x.
	Pricing["default"] = ModelPricing{InputPer1K: 0.003, OutputPer1K: 0.015, CacheWritePer1K: 0.00375, CacheReadPer1K: 0.0003}

	seed := map[string]ModelPricing{
		"anthropic/claude-sonnet-4.6":   perMTok(3, 15, 3.75, 0.30),
		"anthropic/claude-opus-4.6":     perMTok(5, 25, 6.25, 0.50),
		"anthropic/claude-haiku-4.5":    perMTok(1, 5, 1.25, 0.10),
		"google/gemini-3.1-pro-preview": perMTok(1.25, 10, 0, 0),
		"google/gemini-3.5-flash":       perMTok(0.30, 2.5, 0, 0),
		"z-ai/glm-5":                    perMTok(0.60, 2.2, 0, 0),
	}
	for _, m := range Models {
		if p, ok := seed[m.ID]; ok {
			Pricing[m.ID] = p
		} else {
			Pricing[m.ID] = Pricing["default"]
		}
	}
}

// Start launches the background live-pricing refresh. Call once from main.
func Start() {
	startOnce.Do(func() {
		go RefreshLivePricing()
		go func() {
			for {
				time.Sleep(1 * time.Hour)
				RefreshLivePricing()
			}
		}()
	})
}

func RefreshLivePricing() {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://openrouter.ai/api/v1/models")
	if err != nil {
		log.Printf("cost: failed to fetch OpenRouter pricing: %v", err)
		return
	}
	defer resp.Body.Close()

	var data struct {
		Data []struct {
			ID            string `json:"id"`
			ContextLength int    `json:"context_length"`
			TopProvider   struct {
				MaxCompletionTokens int `json:"max_completion_tokens"`
			} `json:"top_provider"`
			Pricing struct {
				Prompt          string `json:"prompt"`
				Completion      string `json:"completion"`
				InputCacheWrite string `json:"input_cache_write"`
				InputCacheRead  string `json:"input_cache_read"`
			} `json:"pricing"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		log.Printf("cost: failed to decode OpenRouter pricing: %v", err)
		return
	}

	modelsMu.Lock()
	defer modelsMu.Unlock()

	for _, apiModel := range data.Data {
		// OpenRouter prices are per-token strings. Multiply by 1000.
		input, _ := strconv.ParseFloat(apiModel.Pricing.Prompt, 64)
		output, _ := strconv.ParseFloat(apiModel.Pricing.Completion, 64)
		write, _ := strconv.ParseFloat(apiModel.Pricing.InputCacheWrite, 64)
		read, _ := strconv.ParseFloat(apiModel.Pricing.InputCacheRead, 64)

		newPricing := ModelPricing{
			InputPer1K:      input * 1000,
			OutputPer1K:     output * 1000,
			CacheWritePer1K: write * 1000,
			CacheReadPer1K:  read * 1000,
		}

		// Record metadata for every model so custom IDs work correctly.
		liveModels[apiModel.ID] = liveModelMeta{
			pricing:       newPricing,
			contextWindow: apiModel.ContextLength,
			maxOutput:     apiModel.TopProvider.MaxCompletionTokens,
		}

		// OpenRouter's Anthropic rates lag or disagree with console.anthropic.com.
		// Keep first-party list prices for spend in Settings → Usage.
		if !strings.HasPrefix(apiModel.ID, "anthropic/") {
			for i, m := range Models {
				if m.ID == apiModel.ID {
					Models[i].Pricing = newPricing
					if apiModel.ContextLength > 0 {
						Models[i].ContextWindow = apiModel.ContextLength
					}
					Pricing[apiModel.ID] = newPricing
					break
				}
			}
		} else {
			for i, m := range Models {
				if m.ID == apiModel.ID && apiModel.ContextLength > 0 {
					Models[i].ContextWindow = apiModel.ContextLength
					break
				}
			}
		}
	}
	log.Printf("cost: successfully updated live pricing from OpenRouter (%d models)", len(data.Data))
}

// ContextWindowForModel returns the context window size for a given model ID.
func ContextWindowForModel(modelID string) int {
	modelsMu.RLock()
	defer modelsMu.RUnlock()
	for _, m := range Models {
		if m.ID == modelID {
			return m.ContextWindow
		}
	}
	if meta, ok := liveModels[modelID]; ok && meta.contextWindow > 0 {
		return meta.contextWindow
	}
	slug := modelID
	if i := strings.LastIndex(modelID, "/"); i >= 0 {
		slug = modelID[i+1:]
	}
	for id, meta := range liveModels {
		if meta.contextWindow <= 0 {
			continue
		}
		if strings.HasSuffix(id, "/"+slug) || strings.EqualFold(id, slug) {
			return meta.contextWindow
		}
	}
	if n := inferredContextWindow(modelID); n > 0 {
		return n
	}
	return 200_000
}

func inferredContextWindow(modelID string) int {
	id := strings.ToLower(modelID)
	switch {
	case strings.Contains(id, "gemini"), strings.Contains(id, "fable"), strings.Contains(id, "mythos"):
		return 1_000_000
	case strings.Contains(id, "gpt-4.1"):
		return 1_048_576
	case strings.Contains(id, "gpt-4o"):
		return 128_000
	case strings.Contains(id, "gpt-5"), strings.Contains(id, "codex"):
		return 400_000
	case strings.Contains(id, "o3"), strings.Contains(id, "o4-mini"):
		return 200_000
	case strings.Contains(id, "1m") && strings.Contains(id, "claude"):
		return 1_000_000
	case strings.Contains(id, "claude"), strings.Contains(id, "sonnet"), strings.Contains(id, "opus"), strings.Contains(id, "haiku"):
		return 200_000
	default:
		return 0
	}
}

// MaxOutputForModel returns the maximum completion tokens for a model,
// or 0 when unknown (caller should apply its own default).
func MaxOutputForModel(modelID string) int {
	modelsMu.RLock()
	defer modelsMu.RUnlock()
	for _, m := range Models {
		if m.ID == modelID {
			return m.MaxOutput
		}
	}
	if meta, ok := liveModels[modelID]; ok && meta.maxOutput > 0 {
		return meta.maxOutput
	}
	return 0
}

// SupportsThinking reports whether a model supports extended reasoning.
// Catalog models use the explicit flag; unknown models fall back to a
// conservative name heuristic.
func SupportsThinking(modelID string) bool {
	modelsMu.RLock()
	for _, m := range Models {
		if m.ID == modelID {
			modelsMu.RUnlock()
			return m.SupportsThinking
		}
	}
	modelsMu.RUnlock()

	lower := strings.ToLower(modelID)
	for _, marker := range []string{"opus", "sonnet", "gemini-3", "o3", "o4", "r1", "reasoning", "thinking", "gpt-5"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// IsKnownModel reports whether the model is in the curated catalog or the
// live OpenRouter list.
func IsKnownModel(modelID string) bool {
	modelsMu.RLock()
	defer modelsMu.RUnlock()
	for _, m := range Models {
		if m.ID == modelID {
			return true
		}
	}
	_, ok := liveModels[modelID]
	return ok
}

// LiveModelCount returns how many models we have live metadata for.
// Zero means the OpenRouter refresh has not completed yet.
func LiveModelCount() int {
	modelsMu.RLock()
	defer modelsMu.RUnlock()
	return len(liveModels)
}

func lookupPricingLocked(model string) (ModelPricing, bool) {
	if p, ok := anthropicListPrice(model); ok {
		return p, true
	}
	if p, ok := Pricing[model]; ok {
		return p, true
	}
	if meta, ok := liveModels[model]; ok {
		return meta.pricing, true
	}
	return Pricing["default"], false
}

// perMTok converts official $/million-token rates into the per-1K units the
// tracker uses: cost = tokens/1000 * Per1K.
func perMTok(input, output, cacheWrite, cacheRead float64) ModelPricing {
	return ModelPricing{
		InputPer1K:      input / 1000,
		OutputPer1K:     output / 1000,
		CacheWritePer1K: cacheWrite / 1000,
		CacheReadPer1K:  cacheRead / 1000,
	}
}

func normalizeModelID(model string) string {
	id := strings.ToLower(strings.TrimSpace(model))
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	return strings.ReplaceAll(id, ".", "-")
}

// anthropicListPrice is the first-party rate card from
// platform.claude.com/docs/en/about-claude/pricing (USD per million tokens).
func anthropicListPrice(model string) (ModelPricing, bool) {
	id := normalizeModelID(model)
	if id == "" || (!strings.Contains(id, "claude") && !strings.Contains(id, "opus") && !strings.Contains(id, "sonnet") && !strings.Contains(id, "haiku") && !strings.Contains(id, "fable") && !strings.Contains(id, "mythos")) {
		return ModelPricing{}, false
	}
	switch {
	case strings.Contains(id, "fable"), strings.Contains(id, "mythos"):
		return perMTok(10, 50, 12.50, 1), true
	case strings.Contains(id, "opus-4-1") || strings.HasSuffix(id, "opus-4"):
		return perMTok(15, 75, 18.75, 1.50), true
	case strings.Contains(id, "opus"):
		return perMTok(5, 25, 6.25, 0.50), true
	case strings.Contains(id, "sonnet-5"):
		return perMTok(2, 10, 2.50, 0.20), true
	case strings.Contains(id, "sonnet"):
		return perMTok(3, 15, 3.75, 0.30), true
	case strings.Contains(id, "haiku-3"):
		return perMTok(0.80, 4, 1, 0.08), true
	case strings.Contains(id, "haiku"):
		return perMTok(1, 5, 1.25, 0.10), true
	default:
		return ModelPricing{}, false
	}
}

// TurnCost is input/output/cache tokens billed at the model's list price.
func TurnCost(model string, input, output, cacheWrite, cacheRead int) float64 {
	p := GetPricing(model)
	return float64(input)/1000*p.InputPer1K +
		float64(output)/1000*p.OutputPer1K +
		float64(cacheWrite)/1000*p.CacheWritePer1K +
		float64(cacheRead)/1000*p.CacheReadPer1K
}

// LookupPricing returns a rate without logging. Used when building the live
// picker so unknown-but-reachable models (a new Claude snapshot, a Codex
// slug) don't spam the log on every /v1/models call.
func LookupPricing(model string) ModelPricing {
	modelsMu.RLock()
	defer modelsMu.RUnlock()
	p, _ := lookupPricingLocked(model)
	return p
}

func GetPricing(model string) ModelPricing {
	modelsMu.RLock()
	defer modelsMu.RUnlock()
	p, known := lookupPricingLocked(model)
	if !known {
		// Unknown model with no live metadata: billing falls back to the flat
		// default rate, which is almost certainly wrong — make it observable.
		log.Printf("cost: WARNING unknown model %q billed at default rate (no live pricing yet)", model)
	}
	return p
}

func ListModels() []ModelInfo {
	modelsMu.RLock()
	defer modelsMu.RUnlock()

	// Return a copy to avoid race conditions when marshaling
	copy := make([]ModelInfo, len(Models))
	for i, m := range Models {
		copy[i] = m
	}
	return copy
}
