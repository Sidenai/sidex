package ai

import (
	"os"
	"strings"
)

// Provider credentials supplied by the desktop app.
//
// When SideX runs the server itself (the normal case — no account, everything
// on-device), the app resolves the user's credentials and passes them down as
// environment variables rather than writing them to a config file:
//
//	SIDEX_PROVIDER_<PROVIDER>_KEY       e.g. SIDEX_PROVIDER_ANTHROPIC_KEY
//	SIDEX_PROVIDER_<PROVIDER>_BASE_URL  e.g. SIDEX_PROVIDER_OLLAMA_BASE_URL
//	SIDEX_PROVIDER_<PROVIDER>_AUTH      "api_key" (default) or "oauth"
//
// See src-tauri/src/commands/providers.rs for the resolution order that
// decides what ends up here.
const (
	envProviderPrefix  = "SIDEX_PROVIDER_"
	envKeySuffix       = "_KEY"
	envBaseURLSuffix   = "_BASE_URL"
	envAuthModeSuffix  = "_AUTH"
	envAccountIDSuffix = "_ACCOUNT_ID"
)

func envProviderVar(provider, suffix string) string {
	return envProviderPrefix + strings.ToUpper(provider) + suffix
}

// LocalProviderConfig builds a ProviderConfig for `provider` from the
// environment, or reports false when the app did not supply one.
//
// A provider with a base URL but no key is still valid: that is how a loopback
// server such as Ollama or LM Studio is configured.
func LocalProviderConfig(provider string) (ProviderConfig, bool) {
	if provider == "" {
		return ProviderConfig{}, false
	}

	baseURL := strings.TrimSpace(os.Getenv(envProviderVar(provider, envBaseURLSuffix)))
	apiKey := strings.TrimSpace(os.Getenv(envProviderVar(provider, envKeySuffix)))

	if baseURL == "" {
		// Fall back to the built-in endpoint so a key alone is enough.
		baseURL = DirectProviders[provider]
	}
	if baseURL == "" {
		return ProviderConfig{}, false
	}
	if apiKey == "" && !isLoopback(baseURL) {
		// A remote provider without a key cannot be called.
		return ProviderConfig{}, false
	}

	authMode := strings.TrimSpace(os.Getenv(envProviderVar(provider, envAuthModeSuffix)))
	if authMode == "" {
		authMode = AuthModeAPIKey
	}

	return ProviderConfig{
		Provider:  provider,
		APIKey:    apiKey,
		BaseURL:   strings.TrimRight(baseURL, "/"),
		AuthMode:  authMode,
		AccountID: strings.TrimSpace(os.Getenv(envProviderVar(provider, envAccountIDSuffix))),
		Enabled:   true,
	}, true
}

// isLoopback reports whether a base URL points at this machine, which is the
// only case where an empty API key is meaningful.
func isLoopback(baseURL string) bool {
	lowered := strings.ToLower(baseURL)
	for _, host := range []string{"//127.0.0.1", "//localhost", "//[::1]", "//0.0.0.0"} {
		if strings.Contains(lowered, host) {
			return true
		}
	}
	return false
}

// LocalProviderConfigured reports whether the app supplied credentials for the
// given provider, without building the full config.
func LocalProviderConfigured(provider string) bool {
	_, ok := LocalProviderConfig(provider)
	return ok
}
