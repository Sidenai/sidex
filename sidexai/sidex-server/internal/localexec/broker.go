// Package localexec implements the server-side half of Sidex's local tool
// execution protocol. The user's IDE (the websocket client) runs tools
// against the user's real filesystem. The server proxies tool calls to the
// client, awaits the result, and feeds it back to the AI loop as if the
// tool had run locally on the server.
//
// Wire format (both directions are JSON over the same websocket that carries
// the streaming chat protocol):
//
//	server -> client (request):
//	  { "type": "tool_request",
//	    "tool_call_id": "toolu_...",
//	    "name":         "read_file",
//	    "arguments":    "{\"path\":\"src/index.ts\"}" }
//
//	client -> server (response):
//	  { "type":  "tool_response",
//	    "tool_call_id": "toolu_...",
//	    "output": "...",
//	    "error":  "" }
//
// If the client never replies, the server times out and returns a structured
// error to the agent loop so the model can recover.
package localexec

import (
	"errors"
	"sync"
	"time"
)

// Response is what the client sends back for a single tool call.
type Response struct {
	ToolCallID string `json:"tool_call_id"`
	Output     string `json:"output,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ErrTimeout is returned when the client does not answer in time.
var ErrTimeout = errors.New("local tool execution timed out waiting for client")

// Broker tracks in-flight local tool calls. Each call gets a one-shot
// channel that the websocket read loop resolves when the client replies.
type Broker struct {
	mu      sync.Mutex
	waiters map[string]chan Response
}

// NewBroker creates an empty broker.
func NewBroker() *Broker {
	return &Broker{waiters: make(map[string]chan Response)}
}

// Register prepares to wait for a response for the given tool_call_id.
// Call Register BEFORE sending the tool_request over the wire to eliminate
// the race where the client responds faster than the registration completes.
func (b *Broker) Register(toolCallID string) <-chan Response {
	ch := make(chan Response, 1)
	b.mu.Lock()
	b.waiters[toolCallID] = ch
	b.mu.Unlock()
	return ch
}

// Resolve is called by the websocket read loop when a tool_response frame
// arrives. It unblocks whichever goroutine is waiting on Wait for that id.
// If no waiter is registered (late response, buggy client), Resolve is a
// safe no-op.
func (b *Broker) Resolve(resp Response) {
	b.mu.Lock()
	ch, ok := b.waiters[resp.ToolCallID]
	if ok {
		delete(b.waiters, resp.ToolCallID)
	}
	b.mu.Unlock()
	if ok {
		ch <- resp
	}
}

// Cancel is called when a connection goes away or a waiter is no longer
// relevant. It removes the waiter so the read loop won't try to send into
// a closed channel.
func (b *Broker) Cancel(toolCallID string) {
	b.mu.Lock()
	delete(b.waiters, toolCallID)
	b.mu.Unlock()
}

// Wait blocks until Resolve is called for toolCallID, or the timeout
// elapses. On timeout the waiter is deregistered and ErrTimeout is returned.
func (b *Broker) Wait(toolCallID string, ch <-chan Response, timeout time.Duration) (Response, error) {
	select {
	case resp := <-ch:
		return resp, nil
	case <-time.After(timeout):
		b.Cancel(toolCallID)
		return Response{ToolCallID: toolCallID, Error: ErrTimeout.Error()}, ErrTimeout
	}
}

// InFlight returns how many tool calls are currently awaiting a client
// response. Exposed for tests and for a /metrics endpoint later.
func (b *Broker) InFlight() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.waiters)
}
