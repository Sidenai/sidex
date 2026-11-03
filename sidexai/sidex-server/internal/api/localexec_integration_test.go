package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sidex-ai/sidex-server/internal/agent"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/session"
)

// bootTestServer stands up a real Handler with an in-memory store.
// Chat/AI is not wired — these tests only exercise the websocket
// plumbing (tool_request / tool_response routing, notice on bad cwd,
// local-exec sticky bit).
func bootTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	store, err := memory.NewBoltStore(t.TempDir() + "/mem.db")
	if err != nil {
		t.Fatalf("bolt: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	mgr := session.NewManager(store)
	h := NewHandler(mgr, store, nil, nil)
	srv := httptest.NewServer(http.HandlerFunc(h.Stream))
	t.Cleanup(srv.Close)
	return srv
}

func dialWS(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestToolResponseFrameIsParsed(t *testing.T) {
	raw := []byte(`{"type":"tool_response","tool_call_id":"abc","output":"hi","error":""}`)
	frame := tryParseToolResponse(raw)
	if frame == nil {
		t.Fatalf("expected to parse tool_response")
	}
	if frame.ToolCallID != "abc" || frame.Output != "hi" {
		t.Fatalf("bad frame: %+v", frame)
	}
}

func TestNonToolResponseReturnsNil(t *testing.T) {
	raw := []byte(`{"session_id":"","message":"hi","cwd":"/tmp"}`)
	if frame := tryParseToolResponse(raw); frame != nil {
		t.Fatalf("should not mis-identify chat request: %+v", frame)
	}
	raw2 := []byte(`not json at all`)
	if frame := tryParseToolResponse(raw2); frame != nil {
		t.Fatalf("should tolerate garbage")
	}
}

func TestLocalExecFlagSuppressesBadCwdNotice(t *testing.T) {
	srv := bootTestServer(t)
	c := dialWS(t, srv)

	// Sending LocalExec=true with a cwd the server can't see should NOT
	// produce the "does not exist on the server" notice, because local
	// mode makes server-visibility irrelevant.
	req := ChatRequest{CWD: "/Users/fake/not-on-server", LocalExec: true, Message: "ping"}
	if err := c.WriteJSON(req); err != nil {
		t.Fatalf("write: %v", err)
	}

	// We expect session frame first, and NO notice frame. We may then get
	// an AI provider error because there's no real API key in tests — ignore
	// everything after session.
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	got := map[string]bool{}
	for i := 0; i < 5; i++ {
		var frame map[string]interface{}
		if err := c.ReadJSON(&frame); err != nil {
			break
		}
		t, _ := frame["type"].(string)
		got[t] = true
		if t == "session" {
			break
		}
	}
	if got["notice"] {
		t.Fatalf("LocalExec should suppress unreachable-cwd notice")
	}
	if !got["session"] {
		t.Fatalf("expected session frame")
	}
}

func TestNonLocalExecEmitsNoticeForBadCwd(t *testing.T) {
	srv := bootTestServer(t)
	c := dialWS(t, srv)

	req := ChatRequest{CWD: "/definitely/nope/path", LocalExec: false, Message: "ping"}
	if err := c.WriteJSON(req); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	gotNotice := false
	for i := 0; i < 5; i++ {
		var frame map[string]interface{}
		if err := c.ReadJSON(&frame); err != nil {
			break
		}
		if tp, _ := frame["type"].(string); tp == "notice" {
			gotNotice = true
			if content, _ := frame["content"].(string); !strings.Contains(content, "does not exist") {
				t.Fatalf("notice content unexpected: %q", content)
			}
			break
		}
	}
	if !gotNotice {
		t.Fatalf("expected notice for unreachable cwd when LocalExec is off")
	}
}

func TestLocalExecToolsCatalogIncludesCoreTools(t *testing.T) {
	for _, name := range []string{"cwd", "read_file", "write_file", "edit_file", "shell", "grep", "list_dir", "git_status"} {
		if !agent.LocalExecTools[name] {
			t.Errorf("localExecTools missing %q", name)
		}
	}
	// Web + memory tools must NOT be local — they need server resources.
	for _, name := range []string{"web_fetch", "memory_store", "memory_search", "todo_write", "spawn_agents"} {
		if agent.LocalExecTools[name] {
			t.Errorf("%q must NOT be a local tool (needs server)", name)
		}
	}
}

func TestBrokerRouteViaHandler(t *testing.T) {
	// End-to-end test that a tool_response frame coming over the socket
	// reaches a waiter registered on the broker.
	srv := bootTestServer(t)
	c := dialWS(t, srv)

	// Kick off a session first so the server is in a sane state.
	_ = c.WriteJSON(ChatRequest{CWD: "/tmp", LocalExec: true, Message: "init"})
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	for i := 0; i < 3; i++ {
		var frame map[string]interface{}
		if err := c.ReadJSON(&frame); err != nil {
			break
		}
		if frame["type"] == "session" {
			break
		}
	}

	// Send a tool_response directly. We can't assert the broker received
	// it without hooking internals, but this ensures it doesn't crash
	// the server (regression: earlier we tried to decode this as a
	// ChatRequest and failed loudly).
	raw := []byte(`{"type":"tool_response","tool_call_id":"noone","output":"x"}`)
	if err := c.WriteMessage(websocket.TextMessage, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Ping the server with another chat request; if the prior frame broke
	// anything, this would fail to produce a session-or-error response.
	_ = c.WriteJSON(ChatRequest{CWD: "/tmp", LocalExec: true, Message: "still alive?"})
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	var frame map[string]interface{}
	if err := c.ReadJSON(&frame); err != nil {
		t.Fatalf("server died after stray tool_response: %v", err)
	}
	_ = frame
}

// (the _ = json import here keeps parity if future tests add payload asserts)
var _ = json.Marshal
