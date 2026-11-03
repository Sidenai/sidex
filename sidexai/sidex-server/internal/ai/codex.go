package ai

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Codex ChatGPT-subscription logins are not OpenAI platform keys. They are
// used against the Codex Responses host the official CLI talks to. That host
// only accepts first-party Codex originators; identifying as "sidex" is a 403.
//
// GPT-5.6 models are also gated on the `version` header. 0.50.0 is rejected
// with "requires a newer version of Codex". Prefer the version the local
// Codex app last cached; otherwise a floor known to serve gpt-5.6-terra.
const (
	codexOriginator            = "codex_cli_rs"
	codexClientVersionFallback = "0.146.0"
	codexBeta                  = "responses=v1"
)

var (
	codexVersionOnce   sync.Once
	codexVersionCached string
)

func resolvedCodexClientVersion() string {
	codexVersionOnce.Do(func() {
		if v := strings.TrimSpace(os.Getenv("SIDEX_CODEX_CLIENT_VERSION")); v != "" {
			codexVersionCached = v
			return
		}
		if v := parseCodexModelsCacheVersion(readCodexModelsCache()); v != "" {
			codexVersionCached = v
			return
		}
		codexVersionCached = codexClientVersionFallback
	})
	return codexVersionCached
}

func readCodexModelsCache() []byte {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(home, ".codex", "models_cache.json"))
	if err != nil {
		return nil
	}
	return b
}

func parseCodexModelsCacheVersion(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var env struct {
		ClientVersion string `json:"client_version"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return ""
	}
	return strings.TrimSpace(env.ClientVersion)
}

func applyCodexIdentity(req *http.Request, token, accountID string) {
	ver := resolvedCodexClientVersion()
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if accountID != "" {
		req.Header.Set("ChatGPT-Account-ID", accountID)
	}
	req.Header.Set("OpenAI-Beta", codexBeta)
	req.Header.Set("originator", codexOriginator)
	req.Header.Set("version", ver)
	req.Header.Set("User-Agent", codexOriginator+"/"+ver)
}

func isOpenAICodex(c *Client) bool {
	if c == nil || c.apiKey == "" {
		return false
	}
	if c.provider != "openai" || c.authMode != AuthModeOAuth {
		return false
	}
	return strings.Contains(c.baseURL, "chatgpt.com") || strings.Contains(c.baseURL, "backend-api/codex")
}

type codexContentPart struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type codexInputItem struct {
	Role    string             `json:"role"`
	Content []codexContentPart `json:"content"`
}

type codexFunctionTool struct {
	Type        string                 `json:"type"`
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
}

type codexReasoning struct {
	Effort string `json:"effort,omitempty"`
}

type codexRequest struct {
	Model        string              `json:"model"`
	Instructions string              `json:"instructions,omitempty"`
	Input        []codexInputItem    `json:"input"`
	Tools        []codexFunctionTool `json:"tools,omitempty"`
	Stream       bool                `json:"stream"`
	Store        bool                `json:"store"`
	Reasoning    *codexReasoning     `json:"reasoning,omitempty"`
}

func buildCodexInput(messages []Message, systemPrompt string) (string, []codexInputItem) {
	instructions := systemPrompt
	input := make([]codexInputItem, 0, len(messages))
	for _, m := range messages {
		switch m.Role {
		case RoleSystem:
			if strings.TrimSpace(m.Content) != "" {
				if instructions != "" {
					instructions += "\n\n"
				}
				instructions += m.Content
			}
		case RoleUser:
			if strings.TrimSpace(m.Content) == "" {
				continue
			}
			input = append(input, codexInputItem{
				Role:    "user",
				Content: []codexContentPart{{Type: "input_text", Text: m.Content}},
			})
		case RoleAssistant:
			if strings.TrimSpace(m.Content) == "" {
				continue
			}
			input = append(input, codexInputItem{
				Role:    "assistant",
				Content: []codexContentPart{{Type: "output_text", Text: m.Content}},
			})
		case RoleTool:
			if strings.TrimSpace(m.Content) == "" {
				continue
			}
			input = append(input, codexInputItem{
				Role:    "user",
				Content: []codexContentPart{{Type: "input_text", Text: "Tool result:\n" + m.Content}},
			})
		}
	}
	return instructions, input
}

func buildCodexTools(tools []ToolDef) []codexFunctionTool {
	out := make([]codexFunctionTool, 0, len(tools))
	for _, t := range tools {
		params := t.Function.Parameters
		if params == nil {
			params = map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
		}
		out = append(out, codexFunctionTool{
			Type:        "function",
			Name:        t.Function.Name,
			Description: t.Function.Description,
			Parameters:  params,
		})
	}
	return out
}

func (c *Client) streamCodex(
	messages []Message,
	tools []ToolDef,
	systemPrompt string,
	opts *StreamOptions,
	onChunk func(StreamChunk),
) error {
	instructions, input := buildCodexInput(messages, systemPrompt)
	if len(input) == 0 {
		input = []codexInputItem{{
			Role:    "user",
			Content: []codexContentPart{{Type: "input_text", Text: "(continuing)"}},
		}}
	}
	body := codexRequest{
		Model:        c.model,
		Instructions: instructions,
		Input:        input,
		Tools:        buildCodexTools(tools),
		Stream:       true,
		Store:        false,
	}
	if opts != nil {
		if e := ParseEffort(opts.Effort, opts.ThinkingBudget).OpenAIEffort(); e != "" {
			body.Reasoning = &codexReasoning{Effort: e}
		}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to encode request: %w", err)
	}

	req, err := http.NewRequest("POST", strings.TrimRight(c.baseURL, "/")+"/responses", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	applyCodexIdentity(req, c.apiKey, c.accountID)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Codex API error %d: %s", resp.StatusCode, sanitizeAPIErrorBody(resp.StatusCode, b))
	}
	return parseCodexSSE(resp.Body, onChunk)
}

type codexEvent struct {
	Type     string `json:"type"`
	Delta    string `json:"delta"`
	Text     string `json:"text"`
	Response struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"response"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func parseCodexSSE(r io.Reader, onChunk func(StreamChunk)) error {
	scanner := bufio.NewScanner(r)
	// Responses events can include sizable payloads (reasoning, tool args).
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

	var dataLines []string
	flush := func() error {
		if len(dataLines) == 0 {
			return nil
		}
		raw := strings.Join(dataLines, "\n")
		dataLines = dataLines[:0]
		if raw == "" || raw == "[DONE]" {
			return nil
		}
		var ev codexEvent
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			return nil
		}
		switch {
		case strings.Contains(ev.Type, "output_text.delta") || ev.Type == "response.output_text.delta":
			text := ev.Delta
			if text == "" {
				text = ev.Text
			}
			if text != "" {
				onChunk(StreamChunk{Type: "text", Content: text})
			}
		case ev.Type == "response.failed" || ev.Type == "error":
			msg := "Codex request failed"
			if ev.Error != nil && ev.Error.Message != "" {
				msg = ev.Error.Message
			} else if ev.Response.Error != nil && ev.Response.Error.Message != "" {
				msg = ev.Response.Error.Message
			}
			return fmt.Errorf("%s", msg)
		}
		return nil
	}

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := flush(); err != nil {
		return err
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	onChunk(StreamChunk{Type: "done", Done: true})
	return nil
}
