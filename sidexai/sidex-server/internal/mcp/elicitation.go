package mcp

import (
	"fmt"
	"sync"
	"time"
)

const elicitationTimeout = 5 * time.Minute

// ElicitationBroker manages pending elicitation requests from MCP servers.
// It bridges between the MCP transport layer and the WebSocket client
// connection, allowing servers to request user input.
type ElicitationBroker struct {
	mu      sync.Mutex
	pending map[string]chan string // request ID → response channel
	handler ElicitationHandler
}

// NewElicitationBroker creates a broker with the given handler.
func NewElicitationBroker(handler ElicitationHandler) *ElicitationBroker {
	return &ElicitationBroker{
		pending: make(map[string]chan string),
		handler: handler,
	}
}

// Elicit sends an elicitation request to the user and blocks until
// they respond or the timeout expires.
func (b *ElicitationBroker) Elicit(server, prompt string, options []string) (string, error) {
	if b.handler == nil {
		return "", fmt.Errorf("mcp elicitation: no handler registered")
	}

	req := ElicitationRequest{
		Server:  server,
		Prompt:  prompt,
		Options: options,
	}

	return b.handler(req)
}

// ElicitationEvent is the WebSocket event emitted to the client when
// an MCP server requests user input.
type ElicitationEvent struct {
	Type    string   `json:"type"`
	Server  string   `json:"server"`
	Prompt  string   `json:"prompt"`
	Options []string `json:"options,omitempty"`
	ID      string   `json:"id"`
}

// ElicitationResponse is the client's reply to an elicitation event.
type ElicitationResponse struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Answer string `json:"answer"`
}

// WebSocketElicitationHandler creates an ElicitationHandler that emits
// elicitation events over a WebSocket connection and waits for responses.
// The writeJSON function should send a JSON message to the client.
// The registerWait function should register a response channel for the given ID.
func WebSocketElicitationHandler(
	writeJSON func(v interface{}),
	registerWait func(id string) <-chan string,
) ElicitationHandler {
	return func(req ElicitationRequest) (string, error) {
		id := fmt.Sprintf("elicit_%s_%d", req.Server, time.Now().UnixNano())

		ch := registerWait(id)

		writeJSON(ElicitationEvent{
			Type:    "elicitation",
			Server:  req.Server,
			Prompt:  req.Prompt,
			Options: req.Options,
			ID:      id,
		})

		select {
		case answer := <-ch:
			return answer, nil
		case <-time.After(elicitationTimeout):
			return "", fmt.Errorf("mcp elicitation: timed out waiting for user response (server=%s)", req.Server)
		}
	}
}
