package ai

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/sidex-ai/sidex-server/internal/compress"
	"github.com/sidex-ai/sidex-server/internal/cost"
)

type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

type Message struct {
	Role       Role       `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
	TokenCount int        `json:"token_count,omitempty"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolCallFunc `json:"function"`
}

type ToolCallFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ToolDef struct {
	Type     string      `json:"type"`
	Function ToolFuncDef `json:"function"`
}

type ToolFuncDef struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
}

type StreamChunk struct {
	Type       string     `json:"type"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	Done       bool       `json:"done,omitempty"`
	TokensUsed *Usage     `json:"tokens_used,omitempty"`
	Error      string     `json:"error,omitempty"`
}

type Usage struct {
	PromptTokens             int `json:"prompt_tokens"`
	CompletionTokens         int `json:"completion_tokens"`
	TotalTokens              int `json:"total_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
}

type Client struct {
	apiKey  string
	baseURL string
	model   string
	// authMode selects the header scheme for providers that need one; only
	// Anthropic distinguishes (api_key vs an existing CLI login).
	authMode string
	// provider is the resolved provider id. Recorded explicitly because
	// WithProviderConfig strips the prefix from the model id, so it can no
	// longer be recovered from the model string alone.
	provider string
	// accountID is the ChatGPT account UUID for a Codex OAuth login.
	accountID  string
	httpClient *http.Client
}

// NewClient builds the default OpenRouter-backed client. OpenRouter is just
// one of many providers a session can select (see WithProviderConfig), so an
// unset key here is a routine state — not something worth warning about at
// startup — and only becomes an actual problem if a request is later made
// through this client without a key, which surfaces as a normal API error.
func NewClient() *Client {
	apiKey := os.Getenv("OPENROUTER_API_KEY")

	model := os.Getenv("SIDEX_MODEL")
	if model == "" {
		model = "anthropic/claude-sonnet-4.6"
	}

	baseURL := os.Getenv("OPENROUTER_BASE_URL")
	if baseURL == "" {
		baseURL = "https://openrouter.ai/api/v1"
	}

	return &Client{
		apiKey:  apiKey,
		baseURL: strings.TrimRight(baseURL, "/"),
		model:   model,
		httpClient: &http.Client{
			Timeout: 10 * time.Minute,
			Transport: &http.Transport{
				MaxIdleConns:        20,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

func (c *Client) WithModel(model string) *Client {
	if model == "" {
		return c
	}
	return &Client{
		apiKey:     c.apiKey,
		baseURL:    c.baseURL,
		authMode:   c.authMode,
		provider:   c.provider,
		accountID:  c.accountID,
		model:      model,
		httpClient: c.httpClient,
	}
}

func (c *Client) WithProviderConfig(cfg ProviderConfig) *Client {
	if !cfg.Enabled || cfg.APIKey == "" || cfg.BaseURL == "" {
		return c
	}
	model := c.model
	if ProviderFromModelID(model) == cfg.Provider {
		model = DirectModelID(model)
	}
	return &Client{
		apiKey:     cfg.APIKey,
		baseURL:    strings.TrimRight(cfg.BaseURL, "/"),
		authMode:   cfg.AuthMode,
		provider:   cfg.Provider,
		accountID:  cfg.AccountID,
		model:      model,
		httpClient: c.httpClient,
	}
}

func (c *Client) Model() string {
	return c.model
}

func compressMessages(messages []Message, maxTokens int) []Message {
	total := 0
	for _, m := range messages {
		total += compress.EstimateTokens(m.Content)
	}
	if total <= maxTokens {
		return messages
	}

	ratio := float64(maxTokens) / float64(total)
	comp := compress.New()

	result := make([]Message, len(messages))
	for i, m := range messages {
		result[i] = m
		if i < len(messages)-4 {
			result[i].Content = comp.CompressText(m.Content, ratio)
		}
	}
	return result
}

// StreamOptions configures optional per-request behaviors.
type StreamOptions struct {
	ThinkingBudget int
	// Effort is none|low|medium|high|ultra from the chat slider. When set it
	// wins over ThinkingBudget for providers that take a named level.
	Effort string
	// MaxTokensOverride forces a specific max_tokens (clamped to the model's
	// ceiling). Used by error recovery to escalate after truncated output.
	MaxTokensOverride int
	// SessionID is the stable conversation id. For an Anthropic CLI login it is
	// sent as the X-Claude-Code-Session-Id header so the account is attributed
	// to a consistent, resolvable session — the first-party Claude Code client
	// sends it on every /v1/messages request and omitting it is one of the
	// signals that distinguishes a third-party client.
	SessionID string
}

func (c *Client) StreamChat(messages []Message, tools []ToolDef, systemPrompt string, onChunk func(StreamChunk)) error {
	return c.StreamChatWithOptions(messages, tools, systemPrompt, nil, onChunk)
}

// StreamChatWithOptions streams a chat completion via OpenRouter (OpenAI-compatible SSE).
func (c *Client) StreamChatWithOptions(messages []Message, tools []ToolDef, systemPrompt string, opts *StreamOptions, onChunk func(StreamChunk)) error {
	// Anthropic's own API is not OpenAI-shaped; it needs the Messages API.
	if c.provider == "" {
		if p := ProviderFromModelID(c.model); p == "anthropic" || p == "openai" || p == "google" {
			return fmt.Errorf("%s is not connected. Connect that account or add an API key in Settings → Models — SideX will not send this to OpenRouter.", p)
		}
	}
	if IsAnthropicNative(c.provider) && c.apiKey != "" {
		return c.streamAnthropic(messages, tools, systemPrompt, opts, onChunk)
	}
	if isOpenAICodex(c) {
		return c.streamCodex(messages, tools, systemPrompt, opts, onChunk)
	}

	// Bedrock serves the same Anthropic models but over AWS's own
	// SigV4-signed, event-stream-framed transport.
	if IsBedrockAnthropic(c.provider) && c.apiKey != "" {
		return c.streamBedrock(messages, tools, systemPrompt, opts, onChunk)
	}
	compressed := compressMessages(messages, 180000)

	oaiMsgs := buildOpenAIMessages(compressed, systemPrompt)

	// Respect each model's real output ceiling instead of a fixed 16384,
	// which over-budgets small models (provider 4xx) and under-uses big ones.
	maxTokens := 16384
	if mo := cost.MaxOutputForModel(c.model); mo > 0 {
		maxTokens = mo
		// Keep latency sane: even 64k-output models rarely need more than 32k
		// in an agent loop turn.
		if maxTokens > 32768 {
			maxTokens = 32768
		}
	}
	// Recovery escalation: retry truncated turns with a larger output budget.
	if opts != nil && opts.MaxTokensOverride > 0 {
		maxTokens = opts.MaxTokensOverride
		if ceiling := cost.MaxOutputForModel(c.model); ceiling > 0 && maxTokens > ceiling {
			maxTokens = ceiling
		}
	}

	// Build request body
	reqBody := map[string]interface{}{
		"model":       c.model,
		"messages":    oaiMsgs,
		"stream":      true,
		"max_tokens":  maxTokens,
		"temperature": 0,
	}

	if len(tools) > 0 {
		reqBody["tools"] = tools
		reqBody["tool_choice"] = "auto"
	}

	if reasoning := reasoningForOpenAI(c.model, opts); reasoning != nil {
		budget, _ := reasoning["max_tokens"].(int)
		total := maxTokens + budget
		ceiling := cost.MaxOutputForModel(c.model)
		if ceiling > 0 && total > ceiling {
			total = ceiling
		}
		if budget >= total {
			budget = total / 2
			reasoning["max_tokens"] = budget
		}
		if budget > 0 {
			reqBody["reasoning"] = reasoning
			reqBody["max_tokens"] = total
		} else {
			delete(reasoning, "max_tokens")
			reqBody["reasoning"] = reasoning
		}
	}

	body, _ := json.Marshal(reqBody)

	req, err := http.NewRequest("POST", c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("HTTP-Referer", "https://github.com/Sidenai/sidex")
	req.Header.Set("X-Title", "SideX")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d from %s: %s", resp.StatusCode, c.baseURL, sanitizeAPIErrorBody(resp.StatusCode, b))
	}

	return c.parseSSEStream(resp.Body, onChunk)
}

func buildOpenAIMessages(messages []Message, systemPrompt string) []map[string]interface{} {
	var oaiMsgs []map[string]interface{}
	if systemPrompt != "" {
		oaiMsgs = append(oaiMsgs, map[string]interface{}{
			"role":    "system",
			"content": systemPrompt,
		})
	}

	for _, m := range messages {
		if m.Role == RoleSystem {
			continue
		}

		if m.Role == RoleTool {
			content := m.Content
			var imageMsg map[string]interface{}
			if m.Name == "image_read" || m.Name == "read_file" {
				if summary, msg, ok := imageToolMessages(m.Name, content); ok {
					content = summary
					imageMsg = msg
				}
			}
			if content == "" {
				content = "(empty result)"
			}
			oaiMsgs = append(oaiMsgs, map[string]interface{}{
				"role":         "tool",
				"content":      content,
				"tool_call_id": m.ToolCallID,
			})
			if imageMsg != nil {
				oaiMsgs = append(oaiMsgs, imageMsg)
			}
			continue
		}

		if len(m.ToolCalls) > 0 {
			var toolCalls []map[string]interface{}
			for _, tc := range m.ToolCalls {
				args := tc.Function.Arguments
				if args == "" {
					args = "{}"
				}
				toolCalls = append(toolCalls, map[string]interface{}{
					"id":   tc.ID,
					"type": "function",
					"function": map[string]interface{}{
						"name":      tc.Function.Name,
						"arguments": args,
					},
				})
			}
			msg := map[string]interface{}{
				"role":       string(m.Role),
				"tool_calls": toolCalls,
			}
			if m.Content != "" {
				msg["content"] = m.Content
			}
			oaiMsgs = append(oaiMsgs, msg)
			continue
		}

		content := m.Content
		if strings.TrimSpace(content) == "" {
			content = "(no content)"
		}
		oaiMsgs = append(oaiMsgs, map[string]interface{}{
			"role":    string(m.Role),
			"content": content,
		})
	}
	return oaiMsgs
}

type imageReadResult struct {
	MimeType   string         `json:"mime_type"`
	Base64Data string         `json:"base64_data"`
	FileSize   int            `json:"file_size"`
	Dimensions map[string]int `json:"dimensions"`
}

func imageToolMessages(toolName, output string) (string, map[string]interface{}, bool) {
	var result imageReadResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return "", nil, false
	}
	if result.MimeType == "" || result.Base64Data == "" {
		return "", nil, false
	}
	summary := fmt.Sprintf("%s loaded %s image (%d bytes)", toolName, result.MimeType, result.FileSize)
	if w, ok := result.Dimensions["width"]; ok {
		if h, ok := result.Dimensions["height"]; ok {
			summary += fmt.Sprintf(", %dx%d", w, h)
		}
	}
	summary += ". The image is attached to the next message as vision input."

	imageURL := "data:" + result.MimeType + ";base64," + result.Base64Data
	msg := map[string]interface{}{
		"role": "user",
		"content": []map[string]interface{}{
			{
				"type": "text",
				"text": fmt.Sprintf("Analyze the attached image from %s directly. Do not ask for base64 or use shell/base64; the image bytes are provided as vision input.", toolName),
			},
			{
				"type": "image_url",
				"image_url": map[string]interface{}{
					"url": imageURL,
				},
			},
		},
	}
	return summary, msg, true
}

// parseSSEStream parses OpenAI-compatible Server-Sent Events for streaming.
func (c *Client) parseSSEStream(reader io.Reader, onChunk func(StreamChunk)) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 256*1024), 1024*1024)

	var toolCalls []ToolCall
	toolCallArgs := make(map[int]*ToolCall)

	for scanner.Scan() {
		line := scanner.Text()

		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			if len(toolCalls) > 0 {
				onChunk(StreamChunk{Type: "tool_calls_complete", ToolCalls: toolCalls})
			}
			onChunk(StreamChunk{Type: "done", Done: true})
			return nil
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}

		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}

		// Handle usage info
		if chunk.Usage != nil {
			onChunk(StreamChunk{
				Type: "usage",
				TokensUsed: &Usage{
					PromptTokens:     chunk.Usage.PromptTokens,
					CompletionTokens: chunk.Usage.CompletionTokens,
					TotalTokens:      chunk.Usage.TotalTokens,
				},
			})
		}

		if len(chunk.Choices) == 0 {
			continue
		}

		choice := chunk.Choices[0]

		// Stream text content
		if choice.Delta.Content != "" {
			onChunk(StreamChunk{Type: "text", Content: choice.Delta.Content})
		}

		// Stream tool calls (accumulated across deltas)
		for _, tc := range choice.Delta.ToolCalls {
			idx := tc.Index
			if _, exists := toolCallArgs[idx]; !exists {
				toolCallArgs[idx] = &ToolCall{
					ID:   tc.ID,
					Type: "function",
					Function: ToolCallFunc{
						Name:      tc.Function.Name,
						Arguments: "",
					},
				}
			}
			toolCallArgs[idx].Function.Arguments += tc.Function.Arguments

			// Update ID/name if provided in this delta
			if tc.ID != "" {
				toolCallArgs[idx].ID = tc.ID
			}
			if tc.Function.Name != "" {
				toolCallArgs[idx].Function.Name = tc.Function.Name
			}
		}

		// On finish_reason, emit completed tool calls (once only)
		if choice.FinishReason != nil && *choice.FinishReason == "tool_calls" && len(toolCallArgs) > 0 {
			for i := 0; i < len(toolCallArgs); i++ {
				if tc, ok := toolCallArgs[i]; ok {
					toolCalls = append(toolCalls, *tc)
					onChunk(StreamChunk{Type: "tool_call", ToolCalls: []ToolCall{*tc}})
				}
			}
			toolCallArgs = make(map[int]*ToolCall) // clear to prevent double-emit
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("stream read error: %w", err)
	}

	// If we got here without [DONE], emit done anyway
	if len(toolCalls) > 0 {
		onChunk(StreamChunk{Type: "tool_calls_complete", ToolCalls: toolCalls})
	}
	onChunk(StreamChunk{Type: "done", Done: true})
	return nil
}

// ModelSupportsThinking returns true if the model supports extended thinking.
// Capability comes from the model catalog (with a name heuristic fallback for
// custom models) instead of brittle substring checks.
func ModelSupportsThinking(model string) bool {
	return cost.SupportsThinking(model)
}

func (c *Client) resolveThinkingBudget(opts *StreamOptions) int {
	if !ModelSupportsThinking(c.model) {
		return 0
	}
	if opts != nil && opts.ThinkingBudget > 0 {
		return opts.ThinkingBudget
	}
	return 0
}

// sanitizeAPIErrorBody returns a clean error message for HTTP error responses.
func sanitizeAPIErrorBody(statusCode int, body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	lower := strings.ToLower(trimmed)

	if strings.HasPrefix(lower, "<!doctype") || strings.HasPrefix(lower, "<html") {
		if statusCode >= 500 {
			return "The AI service is temporarily unavailable. Please try again."
		}
		return "Unable to reach the model provider. Please try again in a moment."
	}

	if statusCode >= 500 && (trimmed == "" || strings.HasPrefix(lower, "<")) {
		return "The AI service is temporarily unavailable. Please try again."
	}

	if len(trimmed) > 500 {
		trimmed = trimmed[:500] + "..."
	}
	return trimmed
}

// SanitizeErrorForDisplay cleans an error string before sending to the client.
func SanitizeErrorForDisplay(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	lower := strings.ToLower(msg)

	if strings.Contains(lower, "<!doctype") || strings.Contains(lower, "<html") {
		return "Unable to reach the model provider. Please try again in a moment."
	}
	if strings.Contains(lower, "api error 5") {
		if strings.Contains(lower, "<") {
			return "The AI service is temporarily unavailable. Please try again."
		}
	}
	return msg
}
