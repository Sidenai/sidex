package agent

import (
	"sync"
	"testing"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
)

// mockConn captures WriteJSON calls in a thread-safe way.
type mockConn struct {
	mu     sync.Mutex
	chunks []ai.StreamChunk
}

func (c *mockConn) WriteJSON(v interface{}) {
	if chunk, ok := v.(ai.StreamChunk); ok {
		c.mu.Lock()
		c.chunks = append(c.chunks, chunk)
		c.mu.Unlock()
	}
}

func (c *mockConn) ReadJSON(v interface{}) error {
	// Block forever — tests don't use the read path.
	select {}
}

func (c *mockConn) getChunks() []ai.StreamChunk {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]ai.StreamChunk, len(c.chunks))
	copy(cp, c.chunks)
	return cp
}

// mockLocalRouter runs tools "locally" by returning the tool name as output.
type mockLocalRouter struct{}

func (m *mockLocalRouter) ShouldRunLocal(name string) bool { return true }
func (m *mockLocalRouter) RunViaClient(tc ai.ToolCall) (string, string) {
	time.Sleep(5 * time.Millisecond)
	return "output:" + tc.Function.Name, ""
}

func TestStreamingExecutor_ReadOnlyToolsRunConcurrently(t *testing.T) {
	conn := &mockConn{}
	sess := testSession(t)
	local := &mockLocalRouter{}
	cfg := DefaultConfig()
	cfg.PermMode = PermissionAutoAll
	executor := NewStreamingExecutor(conn, sess, local, &cfg)

	tc1 := ai.ToolCall{ID: "1", Type: "function", Function: ai.ToolCallFunc{Name: "read_file", Arguments: `{"path":"a.go"}`}}
	tc2 := ai.ToolCall{ID: "2", Type: "function", Function: ai.ToolCallFunc{Name: "grep", Arguments: `{"pattern":"foo"}`}}
	tc3 := ai.ToolCall{ID: "3", Type: "function", Function: ai.ToolCallFunc{Name: "glob", Arguments: `{"pattern":"*.go"}`}}

	start := time.Now()
	executor.QueueTool(tc1)
	executor.QueueTool(tc2)
	executor.QueueTool(tc3)
	results := executor.WaitAll()
	elapsed := time.Since(start)

	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}

	// If truly concurrent, 3 tools sleeping 5ms each should complete well
	// under 15ms (serial time). Allow generous margin for CI.
	if elapsed > 50*time.Millisecond {
		t.Errorf("read-only tools should run concurrently, took %v", elapsed)
	}

	for _, r := range results {
		if r.Status != ToolCompleted {
			t.Errorf("tool %s status = %d, want ToolCompleted", r.ToolCallID, r.Status)
		}
		if r.Output == "" {
			t.Errorf("tool %s output empty", r.ToolCallID)
		}
	}
}

func TestStreamingExecutor_WriteToolsSerialize(t *testing.T) {
	conn := &mockConn{}
	sess := testSession(t)
	local := &mockLocalRouter{}
	cfg := DefaultConfig()
	cfg.PermMode = PermissionAutoAll
	executor := NewStreamingExecutor(conn, sess, local, &cfg)

	tc1 := ai.ToolCall{ID: "1", Type: "function", Function: ai.ToolCallFunc{Name: "write_file", Arguments: `{"path":"a.go","content":"x"}`}}
	tc2 := ai.ToolCall{ID: "2", Type: "function", Function: ai.ToolCallFunc{Name: "edit_file", Arguments: `{"path":"b.go"}`}}

	executor.QueueTool(tc1)
	executor.QueueTool(tc2)
	results := executor.WaitAll()

	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}

	for _, r := range results {
		if r.Status != ToolCompleted {
			t.Errorf("tool %s should be completed", r.ToolCallID)
		}
	}
}

func TestStreamingExecutor_MixedReadWriteOrdering(t *testing.T) {
	conn := &mockConn{}
	sess := testSession(t)
	local := &mockLocalRouter{}
	cfg := DefaultConfig()
	cfg.PermMode = PermissionAutoAll
	executor := NewStreamingExecutor(conn, sess, local, &cfg)

	// Queue two reads, then a write, then a read.
	reads1 := ai.ToolCall{ID: "r1", Type: "function", Function: ai.ToolCallFunc{Name: "grep", Arguments: `{"pattern":"a"}`}}
	reads2 := ai.ToolCall{ID: "r2", Type: "function", Function: ai.ToolCallFunc{Name: "read_file", Arguments: `{"path":"x"}`}}
	write := ai.ToolCall{ID: "w1", Type: "function", Function: ai.ToolCallFunc{Name: "shell", Arguments: `{"command":"echo hi"}`}}
	reads3 := ai.ToolCall{ID: "r3", Type: "function", Function: ai.ToolCallFunc{Name: "glob", Arguments: `{"pattern":"*.go"}`}}

	executor.QueueTool(reads1)
	executor.QueueTool(reads2)
	executor.QueueTool(write)
	executor.QueueTool(reads3)
	results := executor.WaitAll()

	if len(results) != 4 {
		t.Fatalf("expected 4 results, got %d", len(results))
	}

	for _, r := range results {
		if r.Status != ToolCompleted {
			t.Errorf("tool %s not completed", r.ToolCallID)
		}
	}
}

func TestStreamingExecutor_AddResultsToSession(t *testing.T) {
	conn := &mockConn{}
	sess := testSession(t)
	local := &mockLocalRouter{}
	cfg := DefaultConfig()
	cfg.PermMode = PermissionAutoAll
	executor := NewStreamingExecutor(conn, sess, local, &cfg)

	tc := ai.ToolCall{ID: "1", Type: "function", Function: ai.ToolCallFunc{Name: "read_file", Arguments: `{"path":"x"}`}}
	executor.QueueTool(tc)
	executor.WaitAll()

	initialMsgCount := len(sess.GetMessages())
	executor.AddResultsToSession([]ai.ToolCall{tc})

	msgs := sess.GetMessages()
	if len(msgs) != initialMsgCount+1 {
		t.Fatalf("expected %d messages, got %d", initialMsgCount+1, len(msgs))
	}
	last := msgs[len(msgs)-1]
	if last.Role != ai.RoleTool {
		t.Errorf("last message role = %s, want tool", last.Role)
	}
	if last.ToolCallID != "1" {
		t.Errorf("tool_call_id = %s, want 1", last.ToolCallID)
	}

	chunks := conn.getChunks()
	hasResult := false
	for _, c := range chunks {
		if c.Type == "tool_result" {
			hasResult = true
			break
		}
	}
	if !hasResult {
		t.Error("expected tool_result chunk to be streamed")
	}
}

func TestStreamingExecutor_EmptyWaitAll(t *testing.T) {
	conn := &mockConn{}
	sess := testSession(t)
	cfg := DefaultConfig()
	executor := NewStreamingExecutor(conn, sess, nil, &cfg)

	results := executor.WaitAll()
	if len(results) != 0 {
		t.Fatalf("expected 0 results, got %d", len(results))
	}
}
