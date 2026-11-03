package ai

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseCodexModelsCacheVersion(t *testing.T) {
	if got := parseCodexModelsCacheVersion([]byte(`{"client_version":"0.146.0"}`)); got != "0.146.0" {
		t.Fatalf("got %q", got)
	}
	if got := parseCodexModelsCacheVersion([]byte(`{}`)); got != "" {
		t.Fatalf("empty cache version = %q", got)
	}
}

func TestIsOpenAICodex(t *testing.T) {
	if isOpenAICodex(&Client{provider: "openai", authMode: AuthModeOAuth, apiKey: "t", baseURL: "https://chatgpt.com/backend-api/codex"}) != true {
		t.Fatal("chatgpt host + oauth should use the Codex path")
	}
	if isOpenAICodex(&Client{provider: "openai", authMode: AuthModeAPIKey, apiKey: "sk", baseURL: "https://api.openai.com/v1"}) {
		t.Fatal("a platform key must stay on the OpenAI-compatible path")
	}
	if isOpenAICodex(&Client{provider: "openai", authMode: AuthModeOAuth, apiKey: "t", baseURL: "https://api.openai.com/v1"}) {
		t.Fatal("oauth against api.openai.com is not the Codex host")
	}
}

func TestParseCodexSSEEmitsTextDeltas(t *testing.T) {
	body := strings.NewReader(strings.Join([]string{
		"event: response.output_text.delta",
		`data: {"type":"response.output_text.delta","delta":"po"}`,
		"",
		"event: response.output_text.delta",
		`data: {"type":"response.output_text.delta","delta":"ng"}`,
		"",
		"event: response.completed",
		`data: {"type":"response.completed"}`,
		"",
	}, "\n"))
	var got strings.Builder
	if err := parseCodexSSE(body, func(c StreamChunk) {
		if c.Type == "text" {
			got.WriteString(c.Content)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if got.String() != "pong" {
		t.Fatalf("text = %q", got.String())
	}
}

func TestStreamCodexHTTPContract(t *testing.T) {
	var gotPath, gotOrigin, gotAccount, gotAuth, gotBeta string
	var gotBody map[string]interface{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotOrigin = r.Header.Get("originator")
		gotAccount = r.Header.Get("ChatGPT-Account-ID")
		gotAuth = r.Header.Get("Authorization")
		gotBeta = r.Header.Get("OpenAI-Beta")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n"))
	}))
	defer srv.Close()

	c := &Client{
		apiKey:     "tok",
		baseURL:    srv.URL,
		authMode:   AuthModeOAuth,
		provider:   "openai",
		accountID:  "acct-1",
		model:      "gpt-5.4-mini",
		httpClient: srv.Client(),
	}
	var text string
	if err := c.streamCodex([]Message{{Role: RoleUser, Content: "hi"}}, nil, "sys", nil, func(ch StreamChunk) {
		if ch.Type == "text" {
			text += ch.Content
		}
	}); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/responses" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotOrigin != codexOriginator {
		t.Fatalf("originator = %q, want %q", gotOrigin, codexOriginator)
	}
	if gotAccount != "acct-1" || gotAuth != "Bearer tok" || gotBeta != "responses=v1" {
		t.Fatalf("headers auth=%q account=%q beta=%q", gotAuth, gotAccount, gotBeta)
	}
	if gotBody["stream"] != true || gotBody["store"] != false {
		t.Fatalf("body flags = %#v", gotBody)
	}
	if gotBody["reasoning"] != nil {
		t.Fatalf("nil opts must not send reasoning, got %#v", gotBody["reasoning"])
	}
	if text != "ok" {
		t.Fatalf("text = %q", text)
	}
}

func TestStreamCodexSendsReasoningEffort(t *testing.T) {
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n"))
	}))
	defer srv.Close()

	c := &Client{
		apiKey:     "tok",
		baseURL:    srv.URL,
		authMode:   AuthModeOAuth,
		provider:   "openai",
		model:      "gpt-5.4-mini",
		httpClient: srv.Client(),
	}
	if err := c.streamCodex([]Message{{Role: RoleUser, Content: "hi"}}, nil, "", &StreamOptions{Effort: "high"}, func(StreamChunk) {}); err != nil {
		t.Fatal(err)
	}
	reasoning, _ := gotBody["reasoning"].(map[string]interface{})
	if reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v", gotBody["reasoning"])
	}
}
