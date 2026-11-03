package agent

import (
	"sync"
	"time"
)

// PermissionBroker routes permission_response frames from the websocket
// read loop to the goroutine waiting for approval. It follows the same
// register-then-send pattern as localexec.Broker.
type PermissionBroker struct {
	mu      sync.Mutex
	waiters map[string]chan PermissionResponse
}

func NewPermissionBroker() *PermissionBroker {
	return &PermissionBroker{waiters: make(map[string]chan PermissionResponse)}
}

func (b *PermissionBroker) Register(toolCallID string) <-chan PermissionResponse {
	ch := make(chan PermissionResponse, 1)
	b.mu.Lock()
	b.waiters[toolCallID] = ch
	b.mu.Unlock()
	return ch
}

func (b *PermissionBroker) Resolve(resp PermissionResponse) {
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

func (b *PermissionBroker) Cancel(toolCallID string) {
	b.mu.Lock()
	delete(b.waiters, toolCallID)
	b.mu.Unlock()
}

// Wait blocks until a permission response arrives or the timeout elapses.
// Returns (response, true) on success, (zero, false) on timeout.
func (b *PermissionBroker) Wait(toolCallID string, ch <-chan PermissionResponse, timeout time.Duration) (PermissionResponse, bool) {
	select {
	case resp := <-ch:
		return resp, true
	case <-time.After(timeout):
		b.Cancel(toolCallID)
		return PermissionResponse{}, false
	}
}
