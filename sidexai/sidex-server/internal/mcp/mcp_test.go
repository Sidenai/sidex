package mcp

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- Unit tests for JSON-RPC encoding/decoding ---

func TestJSONRPCRequestEncoding(t *testing.T) {
	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "tools/list",
		Params:  map[string]any{},
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded["jsonrpc"] != "2.0" {
		t.Errorf("jsonrpc = %v, want 2.0", decoded["jsonrpc"])
	}
	if decoded["method"] != "tools/list" {
		t.Errorf("method = %v, want tools/list", decoded["method"])
	}
	if decoded["id"].(float64) != 1 {
		t.Errorf("id = %v, want 1", decoded["id"])
	}
}

func TestJSONRPCResponseDecoding(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr bool
		errCode int
	}{
		{
			name:  "success response",
			input: `{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`,
		},
		{
			name:    "error response",
			input:   `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}`,
			wantErr: true,
			errCode: -32601,
		},
		{
			name:  "notification (no id)",
			input: `{"jsonrpc":"2.0","method":"some/notification"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var resp jsonRPCResponse
			if err := json.Unmarshal([]byte(tc.input), &resp); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if tc.wantErr {
				if resp.Error == nil {
					t.Fatal("expected error, got nil")
				}
				if resp.Error.Code != tc.errCode {
					t.Errorf("error code = %d, want %d", resp.Error.Code, tc.errCode)
				}
			}
		})
	}
}

func TestToolCallResultParsing(t *testing.T) {
	input := `{"content":[{"type":"text","text":"hello world"},{"type":"text","text":"more text"}],"isError":false}`

	var result toolCallResult
	if err := json.Unmarshal([]byte(input), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(result.Content) != 2 {
		t.Fatalf("content length = %d, want 2", len(result.Content))
	}
	if result.Content[0].Text != "hello world" {
		t.Errorf("content[0].text = %q, want %q", result.Content[0].Text, "hello world")
	}
	if result.IsError {
		t.Error("isError = true, want false")
	}
}

func TestToolCallResultErrorParsing(t *testing.T) {
	input := `{"content":[{"type":"text","text":"something went wrong"}],"isError":true}`

	var result toolCallResult
	if err := json.Unmarshal([]byte(input), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if !result.IsError {
		t.Error("isError = false, want true")
	}
}

// --- Integration test with a fake MCP server via pipes ---

func fakeServer(serverRead io.Reader, serverWrite io.WriteCloser) {
	scanner := bufio.NewScanner(serverRead)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var raw map[string]json.RawMessage
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}

		idRaw, hasID := raw["id"]
		if !hasID {
			continue
		}

		var method string
		json.Unmarshal(idRaw, &method) // will fail; that's fine
		json.Unmarshal(raw["method"], &method)

		var id json.RawMessage = idRaw

		var resultJSON string
		switch method {
		case "initialize":
			resultJSON = `{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"test","version":"0.1"}}`
		case "tools/list":
			resultJSON = `{"tools":[{"name":"echo","description":"echoes input","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}`
		case "tools/call":
			var params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if raw["params"] != nil {
				json.Unmarshal(raw["params"], &params)
			}
			escaped := strings.ReplaceAll(string(params.Arguments), `"`, `\"`)
			resultJSON = `{"content":[{"type":"text","text":"echoed: ` + escaped + `"}]}`
		case "shutdown":
			resultJSON = `null`
		default:
			resultJSON = `null`
		}

		resp := `{"jsonrpc":"2.0","id":` + string(id) + `,"result":` + resultJSON + "}\n"
		serverWrite.Write([]byte(resp))
	}
	serverWrite.Close()
}

func TestClientWithPipes(t *testing.T) {
	clientRead, serverWrite := io.Pipe()
	serverRead, clientWrite := io.Pipe()

	client := &MCPClient{
		stdin:   clientWrite,
		stdout:  bufio.NewReaderSize(clientRead, 64*1024),
		pending: make(map[int64]chan *jsonRPCResponse),
	}
	go client.readLoop()
	go fakeServer(serverRead, serverWrite)

	// Initialize
	if err := client.initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	// ListTools
	tools, err := client.ListTools()
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("got %d tools, want 1", len(tools))
	}
	if tools[0].Name != "echo" {
		t.Errorf("tool name = %q, want %q", tools[0].Name, "echo")
	}

	// CallTool
	result, err := client.CallTool("echo", json.RawMessage(`{"text":"hello"}`))
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if result == "" {
		t.Error("CallTool returned empty result")
	}

	// Alive
	if !client.Alive() {
		t.Error("client should be alive")
	}

	clientWrite.Close()
}

// --- Config loading tests ---

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	sidexDir := filepath.Join(dir, ".sidex")
	os.MkdirAll(sidexDir, 0o755)

	configJSON := `{
		"servers": {
			"postgres": {
				"command": "npx",
				"args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/test"],
				"env": {"PG_SSL": "true"}
			},
			"augment": {
				"command": "auggie",
				"args": ["mcp", "serve"]
			}
		}
	}`
	os.WriteFile(filepath.Join(sidexDir, "mcp.json"), []byte(configJSON), 0o644)

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg == nil {
		t.Fatal("config is nil")
	}
	if len(cfg.Servers) != 2 {
		t.Fatalf("servers = %d, want 2", len(cfg.Servers))
	}

	pg, ok := cfg.Servers["postgres"]
	if !ok {
		t.Fatal("missing postgres server")
	}
	if pg.Command != "npx" {
		t.Errorf("postgres command = %q, want %q", pg.Command, "npx")
	}
	if len(pg.Args) != 3 {
		t.Errorf("postgres args = %d, want 3", len(pg.Args))
	}
	if pg.Env["PG_SSL"] != "true" {
		t.Errorf("postgres env PG_SSL = %q, want %q", pg.Env["PG_SSL"], "true")
	}
}

func TestLoadConfigMissing(t *testing.T) {
	cfg, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg != nil {
		t.Fatal("expected nil config for missing file")
	}
}

func TestLoadConfigInvalid(t *testing.T) {
	dir := t.TempDir()
	sidexDir := filepath.Join(dir, ".sidex")
	os.MkdirAll(sidexDir, 0o755)
	os.WriteFile(filepath.Join(sidexDir, "mcp.json"), []byte(`not json`), 0o644)

	_, err := LoadConfig(dir)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

// --- Manager unit tests ---

func TestManagerHasToolEmpty(t *testing.T) {
	mgr := NewManager()
	if mgr.HasTool("anything") {
		t.Error("empty manager should not have any tools")
	}
}

func TestManagerCallToolUnknown(t *testing.T) {
	mgr := NewManager()
	_, err := mgr.CallTool("nonexistent", json.RawMessage(`{}`))
	if err == nil {
		t.Error("expected error for unknown tool")
	}
}

func TestManagerServerNames(t *testing.T) {
	mgr := NewManager()
	if len(mgr.ServerNames()) != 0 {
		t.Error("empty manager should have no server names")
	}
}

func TestBuildEnv(t *testing.T) {
	env := buildEnv(nil)
	if env != nil {
		t.Error("nil extra should return nil")
	}

	env = buildEnv(map[string]string{"FOO": "bar"})
	if len(env) == 0 {
		t.Fatal("expected non-empty env")
	}
	found := false
	for _, e := range env {
		if e == "FOO=bar" {
			found = true
			break
		}
	}
	if !found {
		t.Error("FOO=bar not found in env")
	}
}
