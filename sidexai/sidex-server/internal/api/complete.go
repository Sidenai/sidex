package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type fimRequest struct {
	Prefix    string `json:"prefix"`
	Suffix    string `json:"suffix"`
	Language  string `json:"language"`
	FilePath  string `json:"filePath"`
	MaxTokens int    `json:"maxTokens"`
}

type fimResponse struct {
	Text         string `json:"text"`
	FinishReason string `json:"finishReason"`
}

type vllmCompletionRequest struct {
	Model       string   `json:"model"`
	Prompt      string   `json:"prompt"`
	MaxTokens   int      `json:"max_tokens"`
	Temperature float64  `json:"temperature"`
	Stop        []string `json:"stop"`
}

type vllmCompletionResponse struct {
	Choices []struct {
		Text         string `json:"text"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
}

const (
	fimPrefix = "<[fim-prefix]>"
	fimSuffix = "<[fim-suffix]>"
	fimMiddle = "<[fim-middle]>"

	defaultFIMModel  = "sidex-complete"
	defaultMaxTokens = 128
	vllmTimeout      = 3 * time.Second
)

var fimStopTokens = []string{
	"<|endoftext|>",
	fimPrefix,
	fimSuffix,
	fimMiddle,
	"\n\n\n",
}

func vllmURL() string {
	if u := os.Getenv("VLLM_URL"); u != "" {
		return u
	}
	return ""
}

func (h *Handler) Complete(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)
	var req fimRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeEmptyCompletion(w)
		return
	}

	if req.Prefix == "" && req.Suffix == "" {
		writeEmptyCompletion(w)
		return
	}
	if vllmURL() == "" {
		writeEmptyCompletion(w)
		return
	}

	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultMaxTokens
	}
	if maxTokens > 256 {
		maxTokens = 256
	}

	prompt := fimPrefix + req.Prefix + fimSuffix + req.Suffix + fimMiddle

	vllmReq := vllmCompletionRequest{
		Model:       defaultFIMModel,
		Prompt:      prompt,
		MaxTokens:   maxTokens,
		Temperature: 0,
		Stop:        fimStopTokens,
	}

	body, _ := json.Marshal(vllmReq)

	ctx, cancel := context.WithTimeout(r.Context(), vllmTimeout)
	defer cancel()

	endpoint := strings.TrimRight(vllmURL(), "/") + "/v1/completions"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		log.Printf("complete: failed to build request: %v", err)
		writeEmptyCompletion(w)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		log.Printf("complete: vLLM request failed: %v", err)
		writeEmptyCompletion(w)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		log.Printf("complete: vLLM returned %d: %s", resp.StatusCode, string(b))
		writeEmptyCompletion(w)
		return
	}

	var vllmResp vllmCompletionResponse
	if err := json.NewDecoder(resp.Body).Decode(&vllmResp); err != nil {
		log.Printf("complete: decode error: %v", err)
		writeEmptyCompletion(w)
		return
	}

	if len(vllmResp.Choices) == 0 {
		writeEmptyCompletion(w)
		return
	}

	text := cleanCompletion(vllmResp.Choices[0].Text)
	finishReason := vllmResp.Choices[0].FinishReason
	if finishReason == "" {
		finishReason = "stop"
	}

	if text == "" {
		writeEmptyCompletion(w)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(fimResponse{
		Text:         text,
		FinishReason: finishReason,
	})
}

func cleanCompletion(text string) string {
	for _, tok := range fimStopTokens {
		text = strings.ReplaceAll(text, tok, "")
	}
	text = strings.TrimRight(text, " \t\r\n")
	return text
}

func writeEmptyCompletion(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(fimResponse{Text: "", FinishReason: "stop"})
}
