package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const HaikuModelID = "anthropic/claude-haiku-3.5"

type CompletionRequest struct {
	Prefix   string `json:"prefix"`
	Suffix   string `json:"suffix"`
	FilePath string `json:"file_path"`
	Language string `json:"language"`
}

type CompletionResponse struct {
	Completion string `json:"completion"`
	Model      string `json:"model"`
}

// vLLM OpenAI-compatible request/response types

type openAIChatRequest struct {
	Model       string          `json:"model"`
	Messages    []openAIMessage `json:"messages"`
	MaxTokens   int             `json:"max_tokens"`
	Temperature float64         `json:"temperature"`
	Stream      bool            `json:"stream"`
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAIChatResponse struct {
	ID      string `json:"id"`
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Model string `json:"model"`
}

// completionServerURL returns the vLLM server URL if configured.
func completionServerURL() string {
	return os.Getenv("COMPLETION_SERVER_URL")
}

// CompleteVLLM sends a FIM request to a vLLM server using the OpenAI-compatible
// API. Formats the prefix/suffix with Qwen FIM tokens.
func (c *Client) CompleteVLLM(ctx context.Context, req CompletionRequest, maxTokens int) (CompletionResponse, error) {
	serverURL := completionServerURL()
	model := os.Getenv("COMPLETION_MODEL")
	if model == "" {
		model = "Qwen/Qwen3-Coder-7B-Instruct"
	}

	prompt := buildQwenFIMPrompt(req)

	chatReq := openAIChatRequest{
		Model: model,
		Messages: []openAIMessage{
			{Role: "system", Content: "Complete the code. Output ONLY code, no explanations."},
			{Role: "user", Content: prompt},
		},
		MaxTokens:   maxTokens,
		Temperature: 0.0,
		Stream:      false,
	}

	body, _ := json.Marshal(chatReq)
	endpoint := strings.TrimRight(serverURL, "/") + "/chat/completions"

	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return CompletionResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	if apiKey := os.Getenv("COMPLETION_API_KEY"); apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return CompletionResponse{}, fmt.Errorf("vLLM request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return CompletionResponse{}, fmt.Errorf("vLLM API error %d: %s", resp.StatusCode, sanitizeAPIErrorBody(resp.StatusCode, b))
	}

	var chatResp openAIChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return CompletionResponse{}, fmt.Errorf("vLLM response decode failed: %w", err)
	}

	if len(chatResp.Choices) == 0 {
		return CompletionResponse{}, fmt.Errorf("vLLM returned no choices")
	}

	completion := strings.TrimRight(chatResp.Choices[0].Message.Content, "\n")
	return CompletionResponse{
		Completion: completion,
		Model:      chatResp.Model,
	}, nil
}

// buildQwenFIMPrompt formats a FIM request using Qwen3-Coder's native tokens.
func buildQwenFIMPrompt(req CompletionRequest) string {
	var sb strings.Builder
	sb.WriteString("<|fim_prefix|>")
	if req.FilePath != "" || req.Language != "" {
		sb.WriteString("// File: ")
		sb.WriteString(req.FilePath)
		if req.Language != "" {
			sb.WriteString(" (")
			sb.WriteString(req.Language)
			sb.WriteString(")")
		}
		sb.WriteString("\n")
	}
	sb.WriteString(req.Prefix)
	sb.WriteString("<|fim_suffix|>")
	sb.WriteString(req.Suffix)
	sb.WriteString("<|fim_middle|>")
	return sb.String()
}

// Complete sends a fill-in-the-middle completion request via OpenRouter.
func (c *Client) Complete(ctx context.Context, req CompletionRequest, model string, maxTokens int) (CompletionResponse, error) {
	if completionServerURL() != "" {
		return c.CompleteVLLM(ctx, req, maxTokens)
	}
	return c.completeOpenRouter(ctx, req, model, maxTokens)
}

// completeOpenRouter uses OpenRouter's OpenAI-compatible API for completions.
func (c *Client) completeOpenRouter(ctx context.Context, req CompletionRequest, model string, maxTokens int) (CompletionResponse, error) {
	if model == "" {
		model = "anthropic/claude-haiku-3.5"
	}

	prompt := buildFIMPrompt(req)

	body, _ := json.Marshal(map[string]interface{}{
		"model":       model,
		"max_tokens":  maxTokens,
		"temperature": 0,
		"messages": []map[string]interface{}{
			{"role": "system", "content": "You are a code completion engine. Output ONLY the code that should replace the [MASK]. No explanations, no markdown fences, no comments about the code. Just the raw code completion."},
			{"role": "user", "content": prompt},
		},
	})

	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return CompletionResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return CompletionResponse{}, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return CompletionResponse{}, fmt.Errorf("OpenRouter API error %d: %s", resp.StatusCode, sanitizeAPIErrorBody(resp.StatusCode, b))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return CompletionResponse{}, fmt.Errorf("decode response: %w", err)
	}

	completion := ""
	if len(result.Choices) > 0 {
		completion = strings.TrimRight(result.Choices[0].Message.Content, "\n")
	}
	return CompletionResponse{
		Completion: completion,
		Model:      model,
	}, nil
}

func buildFIMPrompt(req CompletionRequest) string {
	var sb strings.Builder
	if req.FilePath != "" || req.Language != "" {
		sb.WriteString("File: ")
		sb.WriteString(req.FilePath)
		if req.Language != "" {
			sb.WriteString(" (")
			sb.WriteString(req.Language)
			sb.WriteString(")")
		}
		sb.WriteString("\n\n")
	}
	sb.WriteString("Complete the code at the [MASK] position. Output ONLY the completion text.\n\n")
	sb.WriteString(req.Prefix)
	sb.WriteString("[MASK]")
	sb.WriteString(req.Suffix)
	return sb.String()
}

// CompleteWithTimeout is a convenience wrapper that enforces a deadline.
func (c *Client) CompleteWithTimeout(req CompletionRequest, timeout time.Duration) (CompletionResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return c.Complete(ctx, req, HaikuModelID, 200)
}
