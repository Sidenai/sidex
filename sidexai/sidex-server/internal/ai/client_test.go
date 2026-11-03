package ai

import (
	"encoding/json"
	"strings"
	"testing"
)

// OpenRouter is one of many providers a session can pick (see
// WithProviderConfig); NewClient must build a usable client whether or not
// its key is set, and must not fail or panic when it's absent.
func TestNewClientWithoutOpenRouterKey(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	c := NewClient()
	if c.apiKey != "" {
		t.Fatalf("expected empty apiKey when OPENROUTER_API_KEY is unset, got %q", c.apiKey)
	}
	if c.baseURL == "" {
		t.Fatalf("expected a default baseURL even without an API key")
	}
	if c.model == "" {
		t.Fatalf("expected a default model even without an API key")
	}
}

// Regression: when a model calls a no-arg tool, Arguments comes back as "".
// We must produce valid tool_calls with non-null arguments in the request body.
func TestBuildBodyHandlesEmptyToolArguments(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: "what is the cwd"},
		{Role: RoleAssistant, Content: "", ToolCalls: []ToolCall{{
			ID: "t1", Type: "function",
			Function: ToolCallFunc{Name: "cwd", Arguments: ""},
		}}},
		{Role: RoleTool, Content: "cwd: /root", ToolCallID: "t1", Name: "cwd"},
	}

	body := mustBuildRequestBody(t, msgs)
	var parsed map[string]interface{}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("built body not valid JSON: %v\n%s", err, body)
	}
	if strings.Contains(string(body), `"arguments":null`) {
		t.Fatalf("found null arguments in body: %s", body)
	}
	// Empty arguments should be serialized as "{}"
	if !strings.Contains(string(body), `"arguments":"{}"`) {
		t.Fatalf("expected arguments:\"{}\" in body, got: %s", body)
	}
}

func TestBuildBodyPreservesNonEmptyToolArguments(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: "read it"},
		{Role: RoleAssistant, Content: "", ToolCalls: []ToolCall{{
			ID: "t1", Function: ToolCallFunc{Name: "read_file", Arguments: `{"path":"a.txt"}`},
		}}},
		{Role: RoleTool, Content: "contents", ToolCallID: "t1", Name: "read_file"},
	}
	body := mustBuildRequestBody(t, msgs)
	// Arguments are stored as a JSON string in the OpenAI format
	if !strings.Contains(string(body), `a.txt`) {
		t.Fatalf("expected path preserved, got: %s", body)
	}
}

func TestBuildBodyHandlesEmptyToolResult(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: "check"},
		{Role: RoleAssistant, Content: "", ToolCalls: []ToolCall{{
			ID: "t1", Function: ToolCallFunc{Name: "shell", Arguments: `{"command":"true"}`},
		}}},
		{Role: RoleTool, Content: "", ToolCallID: "t1", Name: "shell"},
	}
	body := mustBuildRequestBody(t, msgs)
	if strings.Contains(string(body), `"content":null`) {
		t.Fatalf("empty tool result should not produce null content: %s", body)
	}
}

func TestBuildBodyConvertsImageReadToVisionMessage(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: "what is in the attached image?"},
		{Role: RoleAssistant, Content: "", ToolCalls: []ToolCall{{
			ID: "img1", Function: ToolCallFunc{Name: "image_read", Arguments: `{"path":"Unknown.jpeg"}`},
		}}},
		{Role: RoleTool, Name: "image_read", ToolCallID: "img1", Content: `{"mime_type":"image/jpeg","base64_data":"ZmFrZQ==","file_size":4,"dimensions":{"width":1,"height":1}}`},
	}

	body := mustBuildRequestBody(t, msgs)
	var parsed struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("built body not valid JSON: %v\n%s", err, body)
	}

	foundVision := false
	for _, m := range parsed.Messages {
		if m.Role != "user" || len(m.Content) == 0 || m.Content[0] != '[' {
			continue
		}
		var parts []map[string]interface{}
		if err := json.Unmarshal(m.Content, &parts); err != nil {
			t.Fatalf("vision content did not parse: %v", err)
		}
		for _, p := range parts {
			if p["type"] == "image_url" {
				foundVision = true
			}
		}
	}
	if !foundVision {
		t.Fatalf("expected image_read output to become image_url vision input: %s", body)
	}
	if strings.Contains(string(body), `"base64_data"`) {
		t.Fatalf("raw image_read JSON should not be sent as tool text: %s", body)
	}
	if !strings.Contains(string(body), `data:image/jpeg;base64,ZmFrZQ==`) {
		t.Fatalf("expected data URL image payload: %s", body)
	}
}

func TestBuildBodyConvertsReadFileImageToVisionMessage(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: "what is in the attached image?"},
		{Role: RoleAssistant, Content: "", ToolCalls: []ToolCall{{
			ID: "img1", Function: ToolCallFunc{Name: "read_file", Arguments: `{"path":"Unknown.png"}`},
		}}},
		{Role: RoleTool, Name: "read_file", ToolCallID: "img1", Content: `{"mime_type":"image/png","base64_data":"ZmFrZQ==","file_size":4,"dimensions":{"width":1,"height":1}}`},
	}

	body := mustBuildRequestBody(t, msgs)
	bodyText := string(body)
	if !strings.Contains(bodyText, `data:image/png;base64,ZmFrZQ==`) {
		t.Fatalf("expected data URL image payload: %s", body)
	}
	if strings.Contains(bodyText, `"base64_data"`) {
		t.Fatalf("raw read_file image JSON should not be sent as tool text: %s", body)
	}
	if !strings.Contains(bodyText, `Analyze the attached image from read_file directly`) {
		t.Fatalf("expected read_file image instruction in vision message: %s", body)
	}
}

// mustBuildRequestBody builds the exact message array that would be POSTed to
// OpenRouter (OpenAI-compatible format), by reconstructing the same serialization
// logic as StreamChatWithOptions.
func mustBuildRequestBody(t *testing.T, messages []Message) []byte {
	t.Helper()
	oaiMsgs := buildOpenAIMessages(messages, "")

	reqBody := map[string]interface{}{
		"model":    "test-model",
		"messages": oaiMsgs,
		"stream":   true,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return body
}
