package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
)

type inlineEditRequest struct {
	Instruction string `json:"instruction"`
	Code        string `json:"code"`
	Language    string `json:"language"`
	FilePath    string `json:"file_path"`
	Model       string `json:"model,omitempty"`
}

func (h *Handler) InlineEdit(w http.ResponseWriter, r *http.Request) {
	var req inlineEditRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, 400)
		return
	}

	if req.Instruction == "" {
		http.Error(w, `{"error":"instruction is required"}`, 400)
		return
	}
	if req.Code == "" {
		http.Error(w, `{"error":"code is required"}`, 400)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, `{"error":"streaming not supported"}`, 500)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	sysPrompt := buildInlineEditPrompt(req.Instruction, req.Code, req.Language)

	client := h.clientFor(req.Model, auth.UserIDFromContext(r.Context()))

	messages := []ai.Message{
		{Role: ai.RoleUser, Content: sysPrompt},
	}

	err := client.StreamChat(messages, nil, "", func(chunk ai.StreamChunk) {
		switch chunk.Type {
		case "text":
			data, _ := json.Marshal(map[string]string{
				"type":    "text",
				"content": chunk.Content,
			})
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		case "done":
			fmt.Fprintf(w, "data: {\"type\":\"done\"}\n\n")
			flusher.Flush()
		}
	})

	if err != nil {
		errData, _ := json.Marshal(map[string]string{
			"type":  "error",
			"error": err.Error(),
		})
		fmt.Fprintf(w, "data: %s\n\n", errData)
		flusher.Flush()
	}
}

func buildInlineEditPrompt(instruction, code, language string) string {
	if language == "" {
		language = "text"
	}

	var sb strings.Builder
	sb.WriteString("You are editing code inline. The user selected this code and wants you to: ")
	sb.WriteString(instruction)
	sb.WriteString("\n\nSelected code:\n```")
	sb.WriteString(language)
	sb.WriteString("\n")
	sb.WriteString(code)
	sb.WriteString("\n```\n\n")
	sb.WriteString("Return ONLY the replacement code. No explanation, no markdown, no backticks. Just the code that should replace the selection.")
	return sb.String()
}
