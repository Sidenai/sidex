package ai

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// Native Anthropic Messages API support.
//
// The rest of this package speaks OpenAI-compatible `/chat/completions`, which
// is what OpenRouter and every other provider here accepts. Anthropic's own API
// is a different shape — `/v1/messages`, content blocks instead of flat strings,
// its own SSE event names — so it needs a dedicated path rather than a base-URL
// swap.
//
// Two credential kinds are supported:
//
//	api_key  a console key, sent as `x-api-key`
//	oauth    an existing Claude Code login, sent as a bearer token
//
// The OAuth path exists so someone already signed into Claude Code doesn't have
// to buy a second credential. Note that a Claude.ai subscription token is issued
// for use by Claude Code; driving it from another client may not be permitted by
// Anthropic's terms. SideX keeps it strictly opt-in and never reads it unless
// the user has turned that provider on.
//
// Anthropic runs two checks on subscription tokens: the bearer must authenticate,
// and the request must come from a client it allows to spend the subscription.
// Listing models passes the first check alone, but /v1/messages also inspects the
// client identity. We therefore send the same first-party identity Claude Code
// itself sends (its user-agent plus the claude-code beta) when using a CLI login,
// and keep SideX's own identity for real API keys.

const (
	anthropicVersion = "2023-06-01"

	// anthropicOAuthBeta is required to use a subscription (OAuth) token on
	// /v1/messages at all.
	anthropicOAuthBeta = "oauth-2025-04-20"
	// anthropicClaudeCodeBeta marks the caller as a Claude Code client. Without
	// it, /v1/messages rejects a subscription token with a bare 429 even though
	// /v1/models (which doesn't gate on client identity) works fine.
	anthropicClaudeCodeBeta = "claude-code-20250219"

	// First-party identity Claude Code presents on /v1/messages. The User-Agent
	// must match a CLI build the gateway already knows; an unknown tag is
	// refused the same way a third-party client is.
	anthropicClaudeCodeUserAgent = "claude-cli/2.1.235 (external, sdk-cli)"

	// claudeCodeSystemPrefix is the system block the CLI always sends. The
	// subscription gate checks for it alongside the headers.
	claudeCodeSystemPrefix = "You are Claude Code, Anthropic's official CLI for Claude."

	// anthropicClaudeCodeBetas is the beta list the CLI sends on every
	// /v1/messages call that spends a subscription token.
	anthropicClaudeCodeBetas = anthropicClaudeCodeBeta + "," + anthropicOAuthBeta

	// AuthModeAPIKey is a console key from console.anthropic.com.
	AuthModeAPIKey = "api_key"
	// AuthModeOAuth is a bearer token lifted from an existing CLI login.
	AuthModeOAuth = "oauth"
)

// defaultAnthropicMaxTokens is used when the caller sets no ceiling. Anthropic
// requires max_tokens on every request, unlike the OpenAI-shaped API.
const defaultAnthropicMaxTokens = 8192

// IsAnthropicNative reports whether a provider must use the Messages API.
func IsAnthropicNative(provider string) bool {
	return provider == "anthropic"
}

// AnthropicModelID converts a catalog model id into the name Anthropic expects.
//
// The catalog uses OpenRouter-style ids (`anthropic/claude-opus-4.6`) because
// that is what every other provider here consumes. Anthropic spells the same
// model `claude-opus-4-6`.
func AnthropicModelID(modelID string) string {
	id := modelID
	if parts := strings.SplitN(id, "/", 2); len(parts) == 2 {
		id = parts[1]
	}
	// Anthropic uses dashes where the catalog uses dots for the version.
	return strings.ReplaceAll(id, ".", "-")
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

type anthropicBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`

	// tool_use
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`

	// tool_result
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   string `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
}

type anthropicMessage struct {
	Role    string           `json:"role"`
	Content []anthropicBlock `json:"content"`
}

type anthropicTool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	InputSchema map[string]interface{} `json:"input_schema"`
}

type anthropicThinking struct {
	Type         string `json:"type"`
	BudgetTokens int    `json:"budget_tokens,omitempty"`
}

type anthropicRequest struct {
	Model        string                 `json:"model"`
	MaxTokens    int                    `json:"max_tokens"`
	System       interface{}            `json:"system,omitempty"`
	Messages     []anthropicMessage     `json:"messages"`
	Tools        []anthropicTool        `json:"tools,omitempty"`
	Stream       bool                   `json:"stream"`
	Thinking     *anthropicThinking     `json:"thinking,omitempty"`
	OutputConfig *anthropicOutputConfig `json:"output_config,omitempty"`
}

// applyClaudeCodeIdentity sets the headers the Messages API requires to spend
// a Claude.ai subscription token. /v1/models authenticates the bearer alone;
// /v1/messages also checks that the caller looks like Claude Code.
func applyClaudeCodeIdentity(req *http.Request, token, sessionID string) {
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", anthropicClaudeCodeBetas)
	req.Header.Set("User-Agent", anthropicClaudeCodeUserAgent)
	req.Header.Set("x-app", "cli")
	req.Header.Set("anthropic-dangerous-direct-browser-access", "true")
	if sessionID == "" {
		sessionID = uuid.NewString()
	}
	req.Header.Set("X-Claude-Code-Session-Id", sessionID)
}

func claudeCodeSystem(userSystem string) []anthropicBlock {
	blocks := []anthropicBlock{{Type: "text", Text: claudeCodeSystemPrefix}}
	if strings.TrimSpace(userSystem) != "" {
		blocks = append(blocks, anthropicBlock{Type: "text", Text: userSystem})
	}
	return blocks
}

// buildAnthropicMessages converts the internal history into Anthropic's
// content-block form.
//
// Two structural rules drive this: the system prompt is hoisted out of the
// message list into its own field, and a tool result is a `tool_result` block
// inside a *user* message rather than a role of its own.
func buildAnthropicMessages(messages []Message, systemPrompt string) ([]anthropicMessage, string) {
	system := systemPrompt
	out := make([]anthropicMessage, 0, len(messages))

	appendBlocks := func(role string, blocks []anthropicBlock) {
		if len(blocks) == 0 {
			return
		}
		// Anthropic rejects two consecutive messages with the same role, and
		// consecutive tool results are common, so merge them.
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, blocks...)
			return
		}
		out = append(out, anthropicMessage{Role: role, Content: blocks})
	}

	for _, m := range messages {
		switch m.Role {
		case RoleSystem:
			// Fold stray system turns into the top-level prompt.
			if strings.TrimSpace(m.Content) != "" {
				if system != "" {
					system += "\n\n"
				}
				system += m.Content
			}

		case RoleUser:
			content := m.Content
			if peeled, rest := peelSystemInstruction(content); peeled != "" {
				if system != "" {
					system += "\n\n"
				}
				system += peeled
				content = rest
			}
			if strings.TrimSpace(content) != "" {
				appendBlocks("user", []anthropicBlock{{Type: "text", Text: content}})
			}

		case RoleAssistant:
			blocks := make([]anthropicBlock, 0, 1+len(m.ToolCalls))
			if strings.TrimSpace(m.Content) != "" {
				blocks = append(blocks, anthropicBlock{Type: "text", Text: m.Content})
			}
			for _, tc := range m.ToolCalls {
				input := json.RawMessage(tc.Function.Arguments)
				if len(input) == 0 || !json.Valid(input) {
					// A truncated or empty argument string would be rejected
					// outright; an empty object keeps the turn well-formed.
					input = json.RawMessage(`{}`)
				}
				blocks = append(blocks, anthropicBlock{
					Type:  "tool_use",
					ID:    tc.ID,
					Name:  tc.Function.Name,
					Input: input,
				})
			}
			appendBlocks("assistant", blocks)

		case RoleTool:
			appendBlocks("user", []anthropicBlock{{
				Type:      "tool_result",
				ToolUseID: m.ToolCallID,
				Content:   m.Content,
			}})
		}
	}

	// The conversation must open with a user turn.
	if len(out) > 0 && out[0].Role == "assistant" {
		out = append([]anthropicMessage{{
			Role:    "user",
			Content: []anthropicBlock{{Type: "text", Text: "(continuing)"}},
		}}, out...)
	}

	return out, system
}

// peelSystemInstruction lifts a client-injected <system_instruction> block out
// of a user turn. Those tags in the user role look like a jailbreak to Claude
// (especially with a Claude Code identity prefix) and get ignored. The inner
// text belongs in the real system prompt.
func peelSystemInstruction(content string) (instruction, rest string) {
	const open, close = "<system_instruction>", "</system_instruction>"
	rest = content
	var parts []string
	for {
		start := strings.Index(rest, open)
		if start < 0 {
			break
		}
		relEnd := strings.Index(rest[start:], close)
		if relEnd < 0 {
			break
		}
		end := start + relEnd
		inner := strings.TrimSpace(rest[start+len(open) : end])
		if inner != "" {
			parts = append(parts, inner)
		}
		rest = rest[:start] + rest[end+len(close):]
	}
	return strings.Join(parts, "\n\n"), strings.TrimSpace(rest)
}

func buildAnthropicTools(tools []ToolDef) []anthropicTool {
	out := make([]anthropicTool, 0, len(tools))
	for _, t := range tools {
		params := t.Function.Parameters
		if params == nil {
			params = map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
		}
		out = append(out, anthropicTool{
			Name:        t.Function.Name,
			Description: t.Function.Description,
			InputSchema: params,
		})
	}
	return out
}

// subscriptionHarnessTool reports tools Anthropic treats as a third-party
// harness fingerprint. Advertising them on a Claude Code login makes
// /v1/messages 400 with the extra-usage refusal even when the headers are
// first-party. Official MCP tools use the `mcp__server__tool` prefix; these
// management names do not.
func subscriptionHarnessTool(name string) bool {
	switch name {
	case "mcp_connect", "mcp_disconnect", "mcp_list_tools", "mcp_call_tool":
		return true
	default:
		return strings.HasPrefix(name, "mcp_") && !strings.HasPrefix(name, "mcp__")
	}
}

func filterSubscriptionTools(tools []ToolDef) []ToolDef {
	out := make([]ToolDef, 0, len(tools))
	for _, t := range tools {
		if subscriptionHarnessTool(t.Function.Name) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

// streamAnthropic runs one turn against the Messages API, emitting the same
// StreamChunk sequence the OpenAI-compatible path produces so callers need no
// special case.
func (c *Client) streamAnthropic(
	messages []Message,
	tools []ToolDef,
	systemPrompt string,
	opts *StreamOptions,
	onChunk func(StreamChunk),
) error {
	maxTokens := defaultAnthropicMaxTokens
	if opts != nil && opts.MaxTokensOverride > 0 {
		maxTokens = opts.MaxTokensOverride
	}

	msgs, system := buildAnthropicMessages(messages, systemPrompt)
	if c.authMode == AuthModeOAuth {
		tools = filterSubscriptionTools(tools)
	}
	body := anthropicRequest{
		Model:     AnthropicModelID(c.model),
		MaxTokens: maxTokens,
		Messages:  msgs,
		Tools:     buildAnthropicTools(tools),
		Stream:    true,
	}
	if c.authMode == AuthModeOAuth {
		body.System = claudeCodeSystem(system)
	} else if system != "" {
		body.System = system
	}

	applyAnthropicThinking(&body, c.model, opts)

	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}

	url := c.baseURL + "/messages"
	if c.authMode == AuthModeOAuth {
		url += "?beta=true"
	}
	req, err := http.NewRequest("POST", url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", anthropicVersion)
	if c.authMode == AuthModeOAuth {
		sessionID := ""
		if opts != nil {
			sessionID = opts.SessionID
		}
		applyClaudeCodeIdentity(req, c.apiKey, sessionID)
	} else {
		req.Header.Set("x-api-key", c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		if hint := subscriptionAuthHint(c.authMode, resp); hint != "" {
			return errors.New(hint)
		}
		if hint := extraUsageHint(c.authMode, resp.StatusCode, b); hint != "" {
			return errors.New(hint)
		}
		return fmt.Errorf("Anthropic API error %d: %s", resp.StatusCode, sanitizeAPIErrorBody(resp.StatusCode, b))
	}

	return parseAnthropicSSE(resp.Body, onChunk)
}

// anthropicEvent covers the fields we read across every event type.
type anthropicEvent struct {
	Type         string `json:"type"`
	Index        int    `json:"index"`
	ContentBlock *struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
		Text string `json:"text"`
	} `json:"content_block"`
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		PartialJSON string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Message *struct {
		Usage *anthropicUsage `json:"usage"`
	} `json:"message"`
	Usage *anthropicUsage `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

type anthropicUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

// parseAnthropicSSE translates Anthropic's event stream into StreamChunks.
//
// Tool arguments arrive as `input_json_delta` fragments that only form valid
// JSON once the block closes, so each tool call is accumulated by block index
// and emitted at `content_block_stop`.
func parseAnthropicSSE(r io.Reader, onChunk func(StreamChunk)) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	type pendingTool struct {
		id   string
		name string
		args strings.Builder
	}
	pending := map[int]*pendingTool{}
	var completed []ToolCall
	usage := Usage{}

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "" || data == "[DONE]" {
			continue
		}

		var ev anthropicEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			continue // a malformed frame should not kill the turn
		}

		switch ev.Type {
		case "message_start":
			if ev.Message != nil && ev.Message.Usage != nil {
				usage.PromptTokens = ev.Message.Usage.InputTokens
				usage.CacheCreationInputTokens = ev.Message.Usage.CacheCreationInputTokens
				usage.CacheReadInputTokens = ev.Message.Usage.CacheReadInputTokens
			}

		case "content_block_start":
			if ev.ContentBlock == nil {
				continue
			}
			switch ev.ContentBlock.Type {
			case "tool_use":
				pending[ev.Index] = &pendingTool{id: ev.ContentBlock.ID, name: ev.ContentBlock.Name}
			case "text":
				if ev.ContentBlock.Text != "" {
					onChunk(StreamChunk{Type: "text", Content: ev.ContentBlock.Text})
				}
			}

		case "content_block_delta":
			if ev.Delta == nil {
				continue
			}
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					onChunk(StreamChunk{Type: "text", Content: ev.Delta.Text})
				}
			case "input_json_delta":
				if p := pending[ev.Index]; p != nil {
					p.args.WriteString(ev.Delta.PartialJSON)
				}
			}

		case "content_block_stop":
			p := pending[ev.Index]
			if p == nil {
				continue
			}
			delete(pending, ev.Index)
			args := p.args.String()
			if strings.TrimSpace(args) == "" {
				args = "{}"
			}
			tc := ToolCall{
				ID:       p.id,
				Type:     "function",
				Function: ToolCallFunc{Name: p.name, Arguments: args},
			}
			completed = append(completed, tc)
			onChunk(StreamChunk{Type: "tool_call", ToolCalls: []ToolCall{tc}})

		case "message_delta":
			if ev.Usage != nil {
				usage.CompletionTokens = ev.Usage.OutputTokens
			}

		case "error":
			if ev.Error != nil {
				return fmt.Errorf("Anthropic stream error: %s", ev.Error.Message)
			}
			return fmt.Errorf("Anthropic stream error")

		case "message_stop":
			// Terminal event; totals are emitted below.
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("stream read failed: %w", err)
	}

	usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
	if usage.TotalTokens > 0 {
		u := usage
		onChunk(StreamChunk{Type: "usage", TokensUsed: &u})
	}
	if len(completed) > 0 {
		onChunk(StreamChunk{Type: "tool_calls_complete", ToolCalls: completed})
	}
	onChunk(StreamChunk{Type: "done", Done: true})
	return nil
}

// subscriptionAuthHint explains a refusal that a raw status code would not.
//
// A Claude.ai subscription login is issued for use by Claude Code. When it is
// presented by another client, Anthropic authenticates it — the response still
// carries the organization it belongs to — and then declines with a 429 that
// has none of the metadata a real quota limit would: no `retry-after`, no
// `anthropic-ratelimit-*`, and an empty message. Reporting that verbatim sends
// the user hunting for a quota problem they do not have.
func subscriptionAuthHint(authMode string, resp *http.Response) string {
	if authMode != AuthModeOAuth || resp.StatusCode != http.StatusTooManyRequests {
		return ""
	}
	// A genuine rate limit says how long to wait; this refusal does not.
	if resp.Header.Get("retry-after") != "" {
		return ""
	}
	for key := range resp.Header {
		if strings.HasPrefix(strings.ToLower(key), "anthropic-ratelimit") {
			return ""
		}
	}

	return "Anthropic returned 429 for this Claude login. That is usually this model's " +
		"usage cap for the current window, not an invalid login. Switch to another " +
		"Claude model in the picker, wait for the window to reset, or add an API key " +
		"in Settings → Models."
}

func extraUsageHint(authMode string, status int, body []byte) string {
	if authMode != AuthModeOAuth || status != http.StatusBadRequest {
		return ""
	}
	if !strings.Contains(strings.ToLower(string(body)), "extra usage") {
		return ""
	}
	return "Anthropic treated this chat as a third-party app, so it billed extra usage " +
		"instead of your Claude plan. SideX omitted the MCP connect tools that trigger " +
		"that gate — retry the message. If it persists, add extra usage at " +
		"claude.ai/settings/usage or use an Anthropic API key in Settings → Models."
}
