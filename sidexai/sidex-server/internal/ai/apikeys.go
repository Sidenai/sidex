package ai

import "strings"

// ProviderConfig holds API key configuration for a direct (BYOK) provider.
type ProviderConfig struct {
	Provider string `json:"provider"`
	APIKey   string `json:"api_key"`
	BaseURL  string `json:"base_url,omitempty"`
	// AuthMode is "api_key" (default) or "oauth", for providers where the
	// credential kind changes the header scheme.
	AuthMode string `json:"auth_mode,omitempty"`
	// AccountID is the ChatGPT account UUID from a Codex login. Required
	// as ChatGPT-Account-ID on the Codex Responses host.
	AccountID string `json:"account_id,omitempty"`
	Enabled   bool   `json:"enabled"`
}

// DirectProviders maps provider names that require user-supplied API keys
// to their default base URLs.
var DirectProviders = map[string]string{
	"anthropic": "https://api.anthropic.com/v1",
	"openai":    "https://api.openai.com/v1",
	"google":    "https://generativelanguage.googleapis.com/v1beta/openai",
	"zhipu":     "https://open.bigmodel.cn/api/paas/v4",
	"moonshot":  "https://api.moonshot.cn/v1",
}

// RequiresAPIKey returns true if the provider requires user-supplied API keys.
func RequiresAPIKey(provider string) bool {
	_, ok := DirectProviders[provider]
	return ok
}

// ProviderFromModelID extracts the provider name from a model ID.
func ProviderFromModelID(modelID string) string {
	parts := strings.SplitN(modelID, "/", 2)
	if len(parts) >= 2 {
		return parts[0]
	}
	parts = strings.SplitN(modelID, ".", 2)
	if len(parts) < 2 {
		return ""
	}
	provider := parts[0]
	if provider == "moonshotai" {
		return "moonshot"
	}
	if provider == "z-ai" {
		return "zhipu"
	}
	return provider
}

// DirectModelID strips OpenRouter-style provider prefixes for OpenAI-compatible
// direct provider endpoints.
func DirectModelID(modelID string) string {
	if parts := strings.SplitN(modelID, "/", 2); len(parts) == 2 {
		return parts[1]
	}
	return modelID
}
