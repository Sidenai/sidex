package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestHTTPClientListTools(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		var req jsonRPCRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		requestCount++

		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Mcp-Session-Id", "test-session-123")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"protocolVersion": "2025-03-26",
					"capabilities":    map[string]interface{}{},
					"serverInfo":      map[string]interface{}{"name": "test", "version": "1.0"},
					"sessionId":       "test-session-123",
				},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusNoContent)
		case "tools/list":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"tools": []map[string]interface{}{
						{
							"name":        "get_repo",
							"description": "Get repository info",
							"inputSchema": map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"owner": map[string]interface{}{"type": "string"},
									"repo":  map[string]interface{}{"type": "string"},
								},
								"required": []string{"owner", "repo"},
							},
						},
						{
							"name":        "list_issues",
							"description": "List issues in a repo",
							"inputSchema": map[string]interface{}{
								"type":       "object",
								"properties": map[string]interface{}{},
							},
						},
					},
				},
			})
		default:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  nil,
			})
		}
	}))
	defer server.Close()

	client, err := NewHTTPClient(HTTPClientConfig{URL: server.URL})
	if err != nil {
		t.Fatalf("NewHTTPClient: %v", err)
	}
	defer client.Close()

	if client.sessionID != "test-session-123" {
		t.Errorf("sessionID = %q, want %q", client.sessionID, "test-session-123")
	}

	tools, err := client.ListTools()
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 2 {
		t.Fatalf("got %d tools, want 2", len(tools))
	}
	if tools[0].Name != "get_repo" {
		t.Errorf("tool[0].name = %q, want %q", tools[0].Name, "get_repo")
	}
	if tools[1].Name != "list_issues" {
		t.Errorf("tool[1].name = %q, want %q", tools[1].Name, "list_issues")
	}
}

func TestHTTPClientCallTool(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		var req jsonRPCRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}

		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"protocolVersion": "2025-03-26",
					"capabilities":    map[string]interface{}{},
					"serverInfo":      map[string]interface{}{"name": "test", "version": "1.0"},
				},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusNoContent)
		case "tools/call":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "text", "text": "Repository: sidex-ai/sidex\nStars: 1234"},
					},
				},
			})
		default:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  nil,
			})
		}
	}))
	defer server.Close()

	client, err := NewHTTPClient(HTTPClientConfig{URL: server.URL})
	if err != nil {
		t.Fatalf("NewHTTPClient: %v", err)
	}
	defer client.Close()

	result, err := client.CallTool("get_repo", json.RawMessage(`{"owner":"sidex-ai","repo":"sidex"}`))
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !strings.Contains(result, "sidex-ai/sidex") {
		t.Errorf("result = %q, want to contain 'sidex-ai/sidex'", result)
	}
}

func TestHTTPClientSSEResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		var req jsonRPCRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}

		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"protocolVersion": "2025-03-26",
					"capabilities":    map[string]interface{}{},
					"serverInfo":      map[string]interface{}{"name": "test", "version": "1.0"},
				},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusNoContent)
		case "tools/call":
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			flusher, _ := w.(http.Flusher)

			resp := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"content":[{"type":"text","text":"streamed result"}]}}`, req.ID)
			fmt.Fprintf(w, "data: %s\n\n", resp)
			if flusher != nil {
				flusher.Flush()
			}
		default:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  nil,
			})
		}
	}))
	defer server.Close()

	client, err := NewHTTPClient(HTTPClientConfig{URL: server.URL})
	if err != nil {
		t.Fatalf("NewHTTPClient: %v", err)
	}
	defer client.Close()

	result, err := client.CallTool("test_tool", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("CallTool (SSE): %v", err)
	}
	if result != "streamed result" {
		t.Errorf("result = %q, want %q", result, "streamed result")
	}
}

func TestHTTPClientAuth(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		var req jsonRPCRequest
		json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"result": map[string]interface{}{
				"protocolVersion": "2025-03-26",
				"capabilities":    map[string]interface{}{},
				"serverInfo":      map[string]interface{}{"name": "test", "version": "1.0"},
			},
		})
	}))
	defer server.Close()

	client, err := NewHTTPClient(HTTPClientConfig{
		URL:       server.URL,
		AuthType:  "bearer",
		AuthToken: "my-secret-token",
	})
	if err != nil {
		t.Fatalf("NewHTTPClient: %v", err)
	}
	defer client.Close()

	if gotAuth != "Bearer my-secret-token" {
		t.Errorf("Authorization header = %q, want %q", gotAuth, "Bearer my-secret-token")
	}
}

func TestHTTPClientAliveAndClose(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		var req jsonRPCRequest
		json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      req.ID,
			"result": map[string]interface{}{
				"protocolVersion": "2025-03-26",
				"capabilities":    map[string]interface{}{},
				"serverInfo":      map[string]interface{}{"name": "test", "version": "1.0"},
			},
		})
	}))
	defer server.Close()

	client, err := NewHTTPClient(HTTPClientConfig{URL: server.URL})
	if err != nil {
		t.Fatalf("NewHTTPClient: %v", err)
	}

	if !client.Alive() {
		t.Error("client should be alive before Close()")
	}

	client.Close()

	if client.Alive() {
		t.Error("client should not be alive after Close()")
	}
}

func TestManagerAddHTTPServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		var req jsonRPCRequest
		json.NewDecoder(r.Body).Decode(&req)

		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"protocolVersion": "2025-03-26",
					"capabilities":    map[string]interface{}{},
					"serverInfo":      map[string]interface{}{"name": "test", "version": "1.0"},
				},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusNoContent)
		case "tools/list":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"tools": []map[string]interface{}{
						{"name": "create_issue", "description": "Create an issue", "inputSchema": map[string]interface{}{"type": "object"}},
						{"name": "list_issues", "description": "List issues", "inputSchema": map[string]interface{}{"type": "object"}},
					},
				},
			})
		case "tools/call":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "text", "text": "Issue created: #42"},
					},
				},
			})
		default:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  nil,
			})
		}
	}))
	defer server.Close()

	mgr := NewManager()
	defer mgr.Close()

	err := mgr.AddHTTPServer("linear", HTTPClientConfig{URL: server.URL}, false)
	if err != nil {
		t.Fatalf("AddHTTPServer: %v", err)
	}

	names := mgr.ServerNames()
	if len(names) != 1 || names[0] != "linear" {
		t.Errorf("ServerNames = %v, want [linear]", names)
	}

	tools := mgr.ListAllTools()
	if len(tools) != 2 {
		t.Fatalf("ListAllTools = %d, want 2", len(tools))
	}

	if !mgr.HasTool("create_issue") {
		t.Error("should have create_issue tool")
	}

	result, err := mgr.CallTool("create_issue", json.RawMessage(`{"title":"test"}`))
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if !strings.Contains(result, "#42") {
		t.Errorf("result = %q, want to contain '#42'", result)
	}
}

func TestManagerLazyLoad(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		var req jsonRPCRequest
		json.NewDecoder(r.Body).Decode(&req)

		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"protocolVersion": "2025-03-26",
					"capabilities":    map[string]interface{}{},
					"serverInfo":      map[string]interface{}{"name": "test", "version": "1.0"},
				},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusNoContent)
		case "tools/list":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"tools": []map[string]interface{}{
						{
							"name":        "query",
							"description": "Query data",
							"inputSchema": map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"sql": map[string]interface{}{"type": "string"},
								},
								"required": []string{"sql"},
							},
						},
					},
				},
			})
		default:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  nil,
			})
		}
	}))
	defer server.Close()

	mgr := NewManager()
	defer mgr.Close()

	err := mgr.AddHTTPServer("db", HTTPClientConfig{URL: server.URL}, true)
	if err != nil {
		t.Fatalf("AddHTTPServer: %v", err)
	}

	tools := mgr.ListAllTools()
	if len(tools) != 1 {
		t.Fatalf("ListAllTools = %d, want 1", len(tools))
	}
	if !tools[0].LazySchema {
		t.Error("tool should be marked as lazy")
	}
	if tools[0].Tool.InputSchema != nil {
		t.Error("lazy tool should have nil InputSchema initially")
	}

	// Fetch schema triggers re-fetch
	schema, err := mgr.GetToolSchema("query")
	if err != nil {
		t.Fatalf("GetToolSchema: %v", err)
	}
	if schema == nil {
		t.Fatal("schema should not be nil after fetch")
	}

	// Verify lazy flag is cleared
	tools = mgr.ListAllTools()
	if tools[0].LazySchema {
		t.Error("tool should no longer be lazy after schema fetch")
	}
}

func TestConfigHTTPServer(t *testing.T) {
	dir := t.TempDir()
	sidexDir := dir + "/.sidex"
	os.MkdirAll(sidexDir, 0o755)

	configJSON := `{
		"servers": {
			"github": {
				"url": "https://mcp.github.com/v1",
				"auth": "oauth",
				"scopes": ["repo", "issues"],
				"lazy_load": true
			},
			"local-db": {
				"command": "npx",
				"args": ["-y", "@mcp/postgres"]
			},
			"linear": {
				"url": "http://localhost:3100",
				"auth": "token",
				"token_env": "LINEAR_API_KEY"
			}
		}
	}`
	os.WriteFile(sidexDir+"/mcp.json", []byte(configJSON), 0o644)

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if len(cfg.Servers) != 3 {
		t.Fatalf("servers = %d, want 3", len(cfg.Servers))
	}

	gh := cfg.Servers["github"]
	if gh.Transport() != "http" {
		t.Errorf("github transport = %q, want http", gh.Transport())
	}
	if gh.Auth != "oauth" {
		t.Errorf("github auth = %q, want oauth", gh.Auth)
	}
	if len(gh.Scopes) != 2 {
		t.Errorf("github scopes = %v, want 2 items", gh.Scopes)
	}
	if !gh.LazyLoad {
		t.Error("github should have lazy_load=true")
	}

	db := cfg.Servers["local-db"]
	if db.Transport() != "stdio" {
		t.Errorf("local-db transport = %q, want stdio", db.Transport())
	}
	if db.Command != "npx" {
		t.Errorf("local-db command = %q, want npx", db.Command)
	}

	linear := cfg.Servers["linear"]
	if linear.Transport() != "http" {
		t.Errorf("linear transport = %q, want http", linear.Transport())
	}
	if linear.TokenEnv != "LINEAR_API_KEY" {
		t.Errorf("linear token_env = %q, want LINEAR_API_KEY", linear.TokenEnv)
	}
}
