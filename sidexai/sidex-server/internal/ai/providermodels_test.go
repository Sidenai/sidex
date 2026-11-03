package ai

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseProviderModelListAnthropicAndCodex(t *testing.T) {
	anth := []byte(`{"data":[{"type":"model","id":"claude-opus-5","display_name":"Claude Opus 5"},{"id":"claude-sonnet-4-6","display_name":"Claude Sonnet 4.6"}]}`)
	got, err := parseProviderModelList("anthropic", anth)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "anthropic/claude-opus-5" || got[0].Name != "Claude Opus 5" {
		t.Fatalf("anthropic parse = %#v", got)
	}

	codex := []byte(`{"models":[{"slug":"gpt-5.6-terra","context_window":400000},{"slug":"gpt-5.4-mini","display_name":"GPT-5.4 mini"}]}`)
	got, err = parseProviderModelList("openai", json.RawMessage(codex))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "openai/gpt-5.6-terra" || got[0].ContextWindow != 400000 || got[1].Name != "GPT-5.4 mini" {
		t.Fatalf("codex parse = %#v", got)
	}
}

func TestListRemoteModelsUsesProviderHeaders(t *testing.T) {
	var gotAuth, gotBeta, gotVersion, gotUA, gotXApp string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotBeta = r.Header.Get("anthropic-beta")
		gotVersion = r.Header.Get("anthropic-version")
		gotUA = r.Header.Get("User-Agent")
		gotXApp = r.Header.Get("x-app")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-opus-5","display_name":"Claude Opus 5"}]}`))
	}))
	defer srv.Close()

	got, err := ListRemoteModels(ProviderConfig{
		Provider: "anthropic",
		APIKey:   "tok",
		BaseURL:  srv.URL,
		AuthMode: AuthModeOAuth,
		Enabled:  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer tok" || gotBeta != anthropicClaudeCodeBetas || gotVersion != anthropicVersion {
		t.Fatalf("headers auth=%q beta=%q ver=%q", gotAuth, gotBeta, gotVersion)
	}
	// OAuth listing must also carry Claude Code's first-party identity so the
	// gateway treats the list call the same way it treats /v1/messages.
	if gotUA != anthropicClaudeCodeUserAgent {
		t.Errorf("User-Agent = %q, want %q", gotUA, anthropicClaudeCodeUserAgent)
	}
	if gotXApp != "cli" {
		t.Errorf("x-app = %q, want %q", gotXApp, "cli")
	}
	if len(got) != 1 || got[0].ID != "anthropic/claude-opus-5" {
		t.Fatalf("models = %#v", got)
	}
}

func TestConfiguredLocalProvidersReadsEnv(t *testing.T) {
	t.Setenv("SIDEX_PROVIDER_ANTHROPIC_KEY", "tok")
	t.Setenv("SIDEX_PROVIDER_ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1")
	t.Setenv("SIDEX_PROVIDER_ANTHROPIC_AUTH", AuthModeOAuth)

	cfgs := ConfiguredLocalProviders()
	var found bool
	for _, c := range cfgs {
		if c.Provider == "anthropic" && c.AuthMode == AuthModeOAuth {
			found = true
		}
	}
	if !found {
		t.Fatalf("anthropic oauth missing from %#v", cfgs)
	}
}
