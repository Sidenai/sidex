package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/sidex-ai/sidex-server/internal/context"
)

// flowEventRequest is the JSON body for POST /v1/flow/event.
type flowEventRequest struct {
	Type     string            `json:"type"`
	FilePath string            `json:"file_path"`
	Content  string            `json:"content"`
	Metadata map[string]string `json:"metadata"`
}

// RecordFlowEvent receives an IDE action event via HTTP.
// POST /v1/flow/event
// Body: {"type": "file_edit", "file_path": "/src/app.ts", "content": "...", "metadata": {...}}
func (h *Handler) RecordFlowEvent(w http.ResponseWriter, r *http.Request) {
	var req flowEventRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid request body"})
		return
	}

	if req.Type == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "type is required"})
		return
	}

	tracker := h.getFlowTracker()
	if tracker == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "no active session"})
		return
	}

	event := context.FlowEvent{
		Type:      req.Type,
		FilePath:  req.FilePath,
		Content:   req.Content,
		Timestamp: time.Now(),
		Metadata:  req.Metadata,
	}
	tracker.Record(event)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "recorded",
		"event_count": tracker.EventCount(),
	})
}

// GetFlowContext returns the formatted recent context from the flow tracker.
// GET /v1/flow/context?max_tokens=2000
func (h *Handler) GetFlowContext(w http.ResponseWriter, r *http.Request) {
	tracker := h.getFlowTracker()
	if tracker == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"context":     "",
			"event_count": 0,
		})
		return
	}

	maxTokens := 2000
	if mt := r.URL.Query().Get("max_tokens"); mt != "" {
		if v, err := strconv.Atoi(mt); err == nil && v > 0 {
			maxTokens = v
		}
	}

	ctx := tracker.GetRecentContext(maxTokens)
	recentFiles := tracker.GetRecentFiles(10)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"context":      ctx,
		"recent_files": recentFiles,
		"event_count":  tracker.EventCount(),
	})
}

// GetRecentFiles returns the most recently touched files from flow tracking.
// GET /v1/flow/files?limit=10
func (h *Handler) GetRecentFiles(w http.ResponseWriter, r *http.Request) {
	tracker := h.getFlowTracker()
	if tracker == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]string{})
		return
	}

	limit := 10
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 {
			limit = v
		}
	}

	files := tracker.GetRecentFiles(limit)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(files)
}

// getFlowTracker returns the handler's shared flow tracker, creating it if needed.
func (h *Handler) getFlowTracker() *context.FlowTracker {
	h.flowMu.Lock()
	defer h.flowMu.Unlock()
	if h.flowTracker == nil {
		h.flowTracker = context.NewFlowTracker()
	}
	return h.flowTracker
}
