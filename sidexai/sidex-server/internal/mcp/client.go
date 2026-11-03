package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

const (
	protocolVersion = "2024-11-05"
	requestTimeout  = 30 * time.Second
)

// MCPClient communicates with an MCP server over stdio using JSON-RPC 2.0.
type MCPClient struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	reqID  int64

	mu       sync.Mutex
	pending  map[int64]chan *jsonRPCResponse
	closed   bool
	closeErr error
}

// MCPTool describes a tool exposed by an MCP server.
type MCPTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// jsonRPCRequest is a JSON-RPC 2.0 request envelope.
type jsonRPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int64       `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}

// jsonRPCResponse is a JSON-RPC 2.0 response envelope.
type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type initializeParams struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities"`
	ClientInfo      clientInfo     `json:"clientInfo"`
}

type clientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type toolsCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type toolsListResult struct {
	Tools []MCPTool `json:"tools"`
}

type toolCallContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type toolCallResult struct {
	Content []toolCallContent `json:"content"`
	IsError bool              `json:"isError,omitempty"`
}

// NewStdioClient starts an MCP server process and performs the initialize handshake.
func NewStdioClient(command string, args []string, env []string) (*MCPClient, error) {
	cmd := exec.Command(command, args...)
	if len(env) > 0 {
		cmd.Env = env
	}

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("mcp: stdin pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("mcp: stdout pipe: %w", err)
	}
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("mcp: start %q: %w", command, err)
	}

	c := &MCPClient{
		cmd:     cmd,
		stdin:   stdinPipe,
		stdout:  bufio.NewReaderSize(stdoutPipe, 256*1024),
		pending: make(map[int64]chan *jsonRPCResponse),
	}

	go c.readLoop()

	if err := c.initialize(); err != nil {
		c.Close()
		return nil, fmt.Errorf("mcp: initialize handshake failed: %w", err)
	}

	return c, nil
}

// readLoop reads newline-delimited JSON-RPC responses from stdout and dispatches
// them to the matching pending request channel.
func (c *MCPClient) readLoop() {
	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var resp jsonRPCResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			continue
		}

		// Notifications (no id) are ignored for now.
		if resp.ID == nil {
			continue
		}

		c.mu.Lock()
		ch, ok := c.pending[*resp.ID]
		if ok {
			delete(c.pending, *resp.ID)
		}
		c.mu.Unlock()

		if ok {
			ch <- &resp
		}
	}

	c.mu.Lock()
	c.closed = true
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
}

// send writes a JSON-RPC request and waits for the matching response.
func (c *MCPClient) send(method string, params interface{}) (*jsonRPCResponse, error) {
	id := atomic.AddInt64(&c.reqID, 1)

	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("mcp: marshal request: %w", err)
	}
	data = append(data, '\n')

	ch := make(chan *jsonRPCResponse, 1)

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("mcp: client closed")
	}
	c.pending[id] = ch
	c.mu.Unlock()

	if _, err := c.stdin.Write(data); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("mcp: write request: %w", err)
	}

	select {
	case resp, ok := <-ch:
		if !ok || resp == nil {
			return nil, fmt.Errorf("mcp: connection closed while waiting for response")
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("mcp: server error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp, nil
	case <-time.After(requestTimeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("mcp: request %q timed out after %s", method, requestTimeout)
	}
}

// initialize performs the MCP initialize handshake: sends initialize, then
// notifications/initialized.
func (c *MCPClient) initialize() error {
	params := initializeParams{
		ProtocolVersion: protocolVersion,
		Capabilities:    map[string]any{},
		ClientInfo: clientInfo{
			Name:    "sidex",
			Version: "0.5.0",
		},
	}

	if _, err := c.send("initialize", params); err != nil {
		return err
	}

	// Send initialized notification (no id, no response expected).
	notif := struct {
		JSONRPC string      `json:"jsonrpc"`
		Method  string      `json:"method"`
		Params  interface{} `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	data, err := json.Marshal(notif)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = c.stdin.Write(data)
	return err
}

// ListTools calls tools/list on the MCP server and returns the available tools.
func (c *MCPClient) ListTools() ([]MCPTool, error) {
	resp, err := c.send("tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}

	var result toolsListResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("mcp: parse tools/list result: %w", err)
	}
	return result.Tools, nil
}

// CallTool invokes a named tool with the given arguments and returns the
// text content from the response.
func (c *MCPClient) CallTool(name string, arguments json.RawMessage) (string, error) {
	params := toolsCallParams{
		Name:      name,
		Arguments: arguments,
	}

	resp, err := c.send("tools/call", params)
	if err != nil {
		return "", err
	}

	var result toolCallResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return "", fmt.Errorf("mcp: parse tools/call result: %w", err)
	}

	var text string
	for _, c := range result.Content {
		if c.Type == "text" {
			if text != "" {
				text += "\n"
			}
			text += c.Text
		}
	}

	if result.IsError {
		return "", fmt.Errorf("mcp tool %q error: %s", name, text)
	}

	return text, nil
}

// Alive returns true if the underlying process is still running.
func (c *MCPClient) Alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed
}

// Close sends a shutdown request and kills the server process.
func (c *MCPClient) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return c.closeErr
	}
	c.mu.Unlock()

	// Best-effort shutdown request (ignore errors).
	c.send("shutdown", nil) //nolint:errcheck

	c.stdin.Close()

	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()

	select {
	case err := <-done:
		c.closeErr = err
	case <-time.After(5 * time.Second):
		c.cmd.Process.Kill()
		c.closeErr = <-done
	}

	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return c.closeErr
}
