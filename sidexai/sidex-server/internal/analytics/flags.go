package analytics

import (
	"os"
	"strings"
)

// Flags holds the current feature flag state for A/B testing.
// Values are read from environment variables on startup.
// Every session tracks which flags were active via PostHog events.
type Flags struct {
	UseReranker  bool
	RAGEnabled   bool
	ModelVersion string // "opus-4.6", "sonnet-4.6", etc.
}

// LoadFlags reads feature flags from environment variables.
func LoadFlags() *Flags {
	return &Flags{
		UseReranker:  envBool("SIDEX_FLAG_USE_RERANKER", true),
		RAGEnabled:   envBool("SIDEX_FLAG_RAG_ENABLED", true),
		ModelVersion: envString("SIDEX_FLAG_MODEL_VERSION", "opus-4.6"),
	}
}

// ToMap returns the flags as a map for PostHog event properties.
func (f *Flags) ToMap() map[string]interface{} {
	return map[string]interface{}{
		"$feature/use_reranker":  f.UseReranker,
		"$feature/rag_enabled":   f.RAGEnabled,
		"$feature/model_version": f.ModelVersion,
	}
}

func envBool(key string, defaultVal bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	return strings.ToLower(v) == "true" || v == "1"
}

func envString(key, defaultVal string) string {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	return v
}
