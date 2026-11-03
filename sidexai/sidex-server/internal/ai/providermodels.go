package ai

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// RemoteModel is one entry a provider advertised on its /models endpoint.
type RemoteModel struct {
	ID             string
	Name           string
	ContextWindow  int
}

// ConfiguredLocalProviders returns every provider the desktop app handed us
// via SIDEX_PROVIDER_* env vars. The picker uses this instead of a hardcoded
// catalog — Claude Code, Codex, Ollama, etc. each advertise their own list.
func ConfiguredLocalProviders() []ProviderConfig {
	seen := make(map[string]struct{})
	var out []ProviderConfig

	add := func(id string) {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		cfg, ok := LocalProviderConfig(id)
		if !ok {
			return
		}
		seen[id] = struct{}{}
		out = append(out, cfg)
	}

	for _, e := range os.Environ() {
		key, _, ok := strings.Cut(e, "=")
		if !ok || !strings.HasPrefix(key, envProviderPrefix) {
			continue
		}
		rest := strings.TrimPrefix(key, envProviderPrefix)
		for _, suf := range []string{envKeySuffix, envBaseURLSuffix, envAuthModeSuffix, envAccountIDSuffix} {
			if strings.HasSuffix(rest, suf) {
				add(strings.TrimSuffix(rest, suf))
				break
			}
		}
	}
	for id := range DirectProviders {
		add(id)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Provider < out[j].Provider })
	return out
}

// ListRemoteModels asks a configured provider what it can run right now.
func ListRemoteModels(cfg ProviderConfig) ([]RemoteModel, error) {
	if cfg.BaseURL == "" {
		return nil, fmt.Errorf("no base URL for %s", cfg.Provider)
	}

	url := strings.TrimRight(cfg.BaseURL, "/") + "/models"
	if isCodexHost(cfg) {
		url += "?client_version=" + resolvedCodexClientVersion()
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	applyListHeaders(req, cfg)

	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned HTTP %d", cfg.Provider, resp.StatusCode)
	}

	var raw json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return parseProviderModelList(cfg.Provider, raw)
}

func isCodexHost(cfg ProviderConfig) bool {
	return cfg.Provider == "openai" && cfg.AuthMode == AuthModeOAuth &&
		(strings.Contains(cfg.BaseURL, "chatgpt.com") || strings.Contains(cfg.BaseURL, "backend-api/codex"))
}

func applyListHeaders(req *http.Request, cfg ProviderConfig) {
	if cfg.Provider == "anthropic" {
		req.Header.Set("anthropic-version", anthropicVersion)
		if cfg.AuthMode == AuthModeOAuth && cfg.APIKey != "" {
			applyClaudeCodeIdentity(req, cfg.APIKey, "")
			return
		}
		if cfg.APIKey != "" {
			req.Header.Set("x-api-key", cfg.APIKey)
		}
		return
	}
	if isCodexHost(cfg) {
		applyCodexIdentity(req, cfg.APIKey, cfg.AccountID)
		return
	}
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
}

func parseProviderModelList(provider string, raw json.RawMessage) ([]RemoteModel, error) {
	var envelope struct {
		Data []struct {
			ID              string `json:"id"`
			DisplayName     string `json:"display_name"`
			Name            string `json:"name"`
			ContextWindow   int    `json:"context_window"`
			ContextLength   int    `json:"context_length"`
			MaxInputTokens  int    `json:"max_input_tokens"`
			MaxContext      int    `json:"max_context_length"`
		} `json:"data"`
		Models []struct {
			Slug            string `json:"slug"`
			ID              string `json:"id"`
			Name            string `json:"name"`
			DisplayName     string `json:"display_name"`
			ContextWindow   int    `json:"context_window"`
			ContextLength   int    `json:"context_length"`
			MaxInputTokens  int    `json:"max_input_tokens"`
			MaxContext      int    `json:"max_context_length"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}

	out := make([]RemoteModel, 0, len(envelope.Data)+len(envelope.Models))
	seen := make(map[string]struct{})
	add := func(id, name string, window int) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if !strings.Contains(id, "/") {
			id = provider + "/" + id
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		if strings.TrimSpace(name) == "" {
			name = id
			if parts := strings.SplitN(id, "/", 2); len(parts) == 2 {
				name = parts[1]
			}
		}
		out = append(out, RemoteModel{ID: id, Name: name, ContextWindow: window})
	}

	pickWindow := func(vals ...int) int {
		for _, n := range vals {
			if n > 0 {
				return n
			}
		}
		return 0
	}

	for _, m := range envelope.Data {
		name := m.DisplayName
		if name == "" {
			name = m.Name
		}
		add(m.ID, name, pickWindow(m.ContextWindow, m.ContextLength, m.MaxInputTokens, m.MaxContext))
	}
	for _, m := range envelope.Models {
		id := m.Slug
		if id == "" {
			id = m.ID
		}
		name := m.DisplayName
		if name == "" {
			name = m.Name
		}
		add(id, name, pickWindow(m.ContextWindow, m.ContextLength, m.MaxInputTokens, m.MaxContext))
	}
	return out, nil
}
