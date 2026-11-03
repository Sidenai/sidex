package analytics

import (
	"log"
	"os"
	"time"

	"github.com/posthog/posthog-go"
)

type Analytics struct {
	client  posthog.Client
	enabled bool
}

func NewAnalytics() *Analytics {
	apiKey := os.Getenv("POSTHOG_API_KEY")
	if apiKey == "" {
		log.Println("PostHog: disabled (no POSTHOG_API_KEY)")
		return &Analytics{enabled: false}
	}

	host := os.Getenv("POSTHOG_HOST")
	if host == "" {
		host = "https://us.i.posthog.com"
	}

	client, err := posthog.NewWithConfig(apiKey, posthog.Config{
		Endpoint:  host,
		BatchSize: 100,
		Interval:  5 * time.Second,
	})
	if err != nil {
		log.Printf("PostHog: failed to init: %v", err)
		return &Analytics{enabled: false}
	}

	log.Printf("PostHog: enabled (key=%s..., host=%s)", apiKey[:10], host)
	return &Analytics{
		client:  client,
		enabled: true,
	}
}

func (a *Analytics) Close() {
	if a.enabled && a.client != nil {
		a.client.Close()
	}
}

func (a *Analytics) IsEnabled() bool {
	return a.enabled
}

// --- User Identification ---

func (a *Analytics) Identify(userID, email, plan string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	properties := posthog.NewProperties()
	properties.Set("email", email)
	properties.Set("plan", plan)
	for k, v := range props {
		properties.Set(k, v)
	}
	a.client.Enqueue(posthog.Identify{
		DistinctId: userID,
		Properties: properties,
	})
}

// --- Agent Events ---

func (a *Analytics) TrackAgentRequest(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "agent_request", props)
}

func (a *Analytics) TrackSessionStart(userID, sessionID, model string) {
	if !a.enabled {
		return
	}
	a.capture(userID, "session_start", map[string]interface{}{
		"session_id": sessionID,
		"model":      model,
	})
}

func (a *Analytics) TrackSessionEnd(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "session_end", props)
}

func (a *Analytics) TrackAgentTurn(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "agent_turn", props)
}

// --- Tool Execution ---

func (a *Analytics) TrackToolExecution(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "tool_execution", props)
}

func (a *Analytics) TrackToolError(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "tool_error", props)
}

// --- AI Observability (PostHog LLM Analytics) ---
// These emit $ai_generation and $ai_trace events for PostHog's AI Observability dashboard.
// See: https://posthog.com/docs/llm-analytics/traces

func (a *Analytics) TrackAIGeneration(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "$ai_generation", props)
}

func (a *Analytics) TrackAISpan(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "$ai_span", props)
}

func (a *Analytics) TrackAIEmbedding(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "$ai_embedding", props)
}

// TrackLLMCall sends a complete $ai_generation event with all PostHog AI properties.
// Call this after every LLM request completes.
func (a *Analytics) TrackLLMCall(userID string, traceID string, model string, inputTokens, outputTokens int, costUSD float64, latencySeconds float64, input, output string, tools []string, isError bool, errorMsg string) {
	if !a.enabled {
		return
	}
	props := map[string]interface{}{
		"$ai_trace_id":       traceID,
		"$ai_model":          model,
		"$ai_input_tokens":   inputTokens,
		"$ai_output_tokens":  outputTokens,
		"$ai_total_cost_usd": costUSD,
		"$ai_latency":        latencySeconds,
		"$ai_provider":       "anthropic",
		"$ai_is_error":       isError,
	}
	if input != "" {
		props["$ai_input"] = input
	}
	if output != "" {
		props["$ai_output_choices"] = output
	}
	if errorMsg != "" {
		props["$ai_error"] = errorMsg
	}
	if len(tools) > 0 {
		props["$ai_tools"] = tools
	}
	a.capture(userID, "$ai_generation", props)
}

// TrackEmbeddingCall sends a $ai_embedding event for vector embedding API calls.
func (a *Analytics) TrackEmbeddingCall(userID, traceID, model string, inputTokens int, latencySeconds float64, dimensions int) {
	if !a.enabled {
		return
	}
	a.capture(userID, "$ai_embedding", map[string]interface{}{
		"$ai_trace_id":     traceID,
		"$ai_model":        model,
		"$ai_input_tokens": inputTokens,
		"$ai_latency":      latencySeconds,
		"$ai_provider":     "voyage",
		"dimensions":       dimensions,
	})
}

// --- Context Engine / RAG ---

func (a *Analytics) TrackIndexSync(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "index_sync", props)
}

func (a *Analytics) TrackSemanticSearch(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "semantic_search", props)
}

func (a *Analytics) TrackEmbedding(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "embedding_generated", props)
}

func (a *Analytics) TrackRerank(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "rerank_executed", props)
}

func (a *Analytics) TrackContextAssembly(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "context_assembly", props)
}

func (a *Analytics) TrackMemoryLearned(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "memory_learned", props)
}

func (a *Analytics) TrackMemoryRecalled(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "memory_recalled", props)
}

// --- Cost & Usage ---

func (a *Analytics) TrackCost(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "cost_incurred", props)
}

func (a *Analytics) TrackModelSwitch(userID, fromModel, toModel, sessionID string) {
	if !a.enabled {
		return
	}
	a.capture(userID, "model_switch", map[string]interface{}{
		"from_model": fromModel,
		"to_model":   toModel,
		"session_id": sessionID,
	})
}

func (a *Analytics) TrackCompletion(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "completion", props)
}

func (a *Analytics) TrackPlanEvent(userID, eventType string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	if props == nil {
		props = map[string]interface{}{}
	}
	props["event_type"] = eventType
	a.capture(userID, "plan_event", props)
}

func (a *Analytics) TrackFeatureUsage(userID, feature string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	if props == nil {
		props = map[string]interface{}{}
	}
	props["feature"] = feature
	a.capture(userID, "feature_usage", props)
}

// --- Errors & Performance ---

func (a *Analytics) TrackError(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "agent_error", props)
}

func (a *Analytics) TrackLatency(userID, operation string, durationMs int64, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	if props == nil {
		props = map[string]interface{}{}
	}
	props["operation"] = operation
	props["duration_ms"] = durationMs
	a.capture(userID, "latency", props)
}

func (a *Analytics) TrackRateLimitHit(userID string, props map[string]interface{}) {
	if !a.enabled {
		return
	}
	a.capture(userID, "rate_limit_hit", props)
}

// --- Internal ---

func (a *Analytics) capture(distinctID, event string, props map[string]interface{}) {
	if distinctID == "" {
		distinctID = "anonymous"
	}
	properties := posthog.NewProperties()
	for k, v := range props {
		properties.Set(k, v)
	}
	err := a.client.Enqueue(posthog.Capture{
		DistinctId: distinctID,
		Event:      event,
		Properties: properties,
	})
	if err != nil {
		log.Printf("PostHog enqueue error: %v", err)
	}
}
