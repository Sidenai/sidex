package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
)

type completionRequest struct {
	Prefix   string `json:"prefix"`
	Suffix   string `json:"suffix"`
	FilePath string `json:"file_path"`
	Language string `json:"language"`
}

func (h *Handler) Completions(w http.ResponseWriter, r *http.Request) {
	var req completionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, 400)
		return
	}

	if req.Prefix == "" {
		http.Error(w, `{"error":"prefix is required"}`, 400)
		return
	}

	resp, err := h.clientFor("", auth.UserIDFromContext(r.Context())).CompleteWithTimeout(ai.CompletionRequest{
		Prefix:   req.Prefix,
		Suffix:   req.Suffix,
		FilePath: req.FilePath,
		Language: req.Language,
	}, 3*time.Second)

	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(504)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
