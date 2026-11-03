package tools

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// mcpStdioConn represents a connection to an MCP server over stdio.
type mcpStdioConn struct {
	name   string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	mu     sync.Mutex
	nextID atomic.Int64
	tools  []mcpToolDef
	alive  bool
}

type mcpToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

type jsonrpcRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int64       `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonrpcError   `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

var mcpConns = struct {
	mu    sync.Mutex
	conns map[*Registry]map[string]*mcpStdioConn
}{conns: make(map[*Registry]map[string]*mcpStdioConn)}

func getMCPConns(r *Registry) map[string]*mcpStdioConn {
	mcpConns.mu.Lock()
	defer mcpConns.mu.Unlock()
	if mcpConns.conns[r] == nil {
		mcpConns.conns[r] = make(map[string]*mcpStdioConn)
	}
	return mcpConns.conns[r]
}

func init_mcp(r *Registry) {
	r.tools["mcp_connect"] = Tool{
		Name: "mcp_connect",
		Description: `Connect to an MCP (Model Context Protocol) server via stdio transport. Launches the server process with the given command and establishes a JSON-RPC connection.

Use this to integrate external tools (databases, APIs, custom services) exposed through the MCP protocol. After connecting, use mcp_list_tools to discover available tools, and mcp_call_tool to invoke them. The connection persists for the session.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name":    map[string]interface{}{"type": "string", "description": "Unique name for this MCP server connection."},
				"command": map[string]interface{}{"type": "string", "description": "Command to launch the MCP server (e.g. 'npx', 'python')."},
				"args":    map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Arguments to pass to the command."},
				"env":     map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Environment variables in KEY=VALUE format."},
			},
			"required": []string{"name", "command"},
		},
	}

	r.tools["mcp_disconnect"] = Tool{
		Name:        "mcp_disconnect",
		Description: `Disconnect from a named MCP server and terminate its process. Use this to clean up when you're done using an MCP server's tools, or if the connection is stale. After disconnecting, the server's tools are no longer available until you reconnect.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name": map[string]interface{}{"type": "string", "description": "Name of the MCP server to disconnect."},
			},
			"required": []string{"name"},
		},
	}

	r.tools["mcp_list_tools"] = Tool{
		Name:        "mcp_list_tools",
		Description: `List all tools available from connected MCP servers. Use this after mcp_connect to discover what tools a server exposes, including their names, descriptions, and input schemas. Returns tools grouped by server name.`,
		Parameters: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
	}

	r.tools["mcp_call_tool"] = Tool{
		Name:        "mcp_call_tool",
		Description: `Invoke a tool on a connected MCP server by name, passing arbitrary JSON arguments. Use this to call external service tools discovered via mcp_list_tools. Check the tool's input schema (from mcp_list_tools) before calling to ensure you pass the correct arguments.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"server":    map[string]interface{}{"type": "string", "description": "Name of the MCP server."},
				"tool":      map[string]interface{}{"type": "string", "description": "Name of the tool to call."},
				"arguments": map[string]interface{}{"type": "object", "description": "Arguments to pass to the tool."},
			},
			"required": []string{"server", "tool"},
		},
	}
}

func (r *Registry) mcpConnect(args map[string]interface{}) ExecutionResult {
	name := str(args, "name")
	command := str(args, "command")
	if name == "" || command == "" {
		return ExecutionResult{Error: "name and command are required"}
	}

	conns := getMCPConns(r)
	if _, exists := conns[name]; exists {
		return ExecutionResult{Error: fmt.Sprintf("MCP server '%s' is already connected", name)}
	}

	var cmdArgs []string
	if rawArgs, ok := args["args"].([]interface{}); ok {
		for _, a := range rawArgs {
			if s, ok := a.(string); ok {
				cmdArgs = append(cmdArgs, s)
			}
		}
	}

	cmd := exec.Command(command, cmdArgs...)

	if rawEnv, ok := args["env"].([]interface{}); ok {
		for _, e := range rawEnv {
			if s, ok := e.(string); ok {
				cmd.Env = append(cmd.Env, s)
			}
		}
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return ExecutionResult{Error: "mcp_connect: stdin pipe: " + err.Error()}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return ExecutionResult{Error: "mcp_connect: stdout pipe: " + err.Error()}
	}

	if err := cmd.Start(); err != nil {
		return ExecutionResult{Error: "mcp_connect: start: " + err.Error()}
	}

	conn := &mcpStdioConn{
		name:   name,
		cmd:    cmd,
		stdin:  stdin,
		stdout: bufio.NewReader(stdout),
		alive:  true,
	}

	// Initialize the connection with the MCP protocol handshake.
	initResult, err := conn.call("initialize", map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]interface{}{},
		"clientInfo": map[string]interface{}{
			"name":    "sidex-server",
			"version": "1.0.0",
		},
	})
	if err != nil {
		cmd.Process.Kill()
		return ExecutionResult{Error: "mcp_connect: initialize: " + err.Error()}
	}

	// Send initialized notification (no response expected — fire and forget).
	conn.notify("notifications/initialized", nil)

	// List available tools.
	toolsResult, err := conn.call("tools/list", nil)
	if err != nil {
		cmd.Process.Kill()
		return ExecutionResult{Error: "mcp_connect: tools/list: " + err.Error()}
	}

	var toolsResp struct {
		Tools []mcpToolDef `json:"tools"`
	}
	if err := json.Unmarshal(toolsResult, &toolsResp); err != nil {
		cmd.Process.Kill()
		return ExecutionResult{Error: "mcp_connect: parse tools: " + err.Error()}
	}
	conn.tools = toolsResp.Tools

	conns[name] = conn

	_ = initResult // used only for handshake validation
	return ExecutionResult{Output: fmt.Sprintf("Connected to MCP server '%s' with %d tools available.", name, len(conn.tools))}
}

func (r *Registry) mcpDisconnect(args map[string]interface{}) ExecutionResult {
	name := str(args, "name")
	if name == "" {
		return ExecutionResult{Error: "name is required"}
	}

	conns := getMCPConns(r)
	conn, ok := conns[name]
	if !ok {
		return ExecutionResult{Error: fmt.Sprintf("MCP server '%s' is not connected", name)}
	}

	conn.close()
	delete(conns, name)
	return ExecutionResult{Output: fmt.Sprintf("Disconnected from MCP server '%s'.", name)}
}

func (r *Registry) mcpListTools(args map[string]interface{}) ExecutionResult {
	conns := getMCPConns(r)

	if len(conns) == 0 {
		return ExecutionResult{Output: "(no MCP servers connected)"}
	}

	var sb strings.Builder
	for name, conn := range conns {
		sb.WriteString(fmt.Sprintf("## Server: %s (%d tools)\n", name, len(conn.tools)))
		for _, t := range conn.tools {
			sb.WriteString(fmt.Sprintf("  - %s: %s\n", t.Name, t.Description))
		}
		sb.WriteString("\n")
	}
	return ExecutionResult{Output: sb.String()}
}

func (r *Registry) mcpCallTool(args map[string]interface{}) ExecutionResult {
	serverName := str(args, "server")
	toolName := str(args, "tool")
	if serverName == "" || toolName == "" {
		return ExecutionResult{Error: "server and tool are required"}
	}

	conns := getMCPConns(r)
	conn, ok := conns[serverName]
	if !ok {
		return ExecutionResult{Error: fmt.Sprintf("MCP server '%s' is not connected", serverName)}
	}

	if !conn.alive {
		return ExecutionResult{Error: fmt.Sprintf("MCP server '%s' is no longer running", serverName)}
	}

	toolArgs, _ := args["arguments"].(map[string]interface{})
	if toolArgs == nil {
		toolArgs = map[string]interface{}{}
	}

	result, err := conn.call("tools/call", map[string]interface{}{
		"name":      toolName,
		"arguments": toolArgs,
	})
	if err != nil {
		return ExecutionResult{Error: fmt.Sprintf("mcp_call_tool(%s/%s): %s", serverName, toolName, err.Error())}
	}

	// Parse the MCP tool result to extract text content.
	var callResp struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(result, &callResp); err != nil {
		return ExecutionResult{Output: string(result)}
	}

	var parts []string
	for _, c := range callResp.Content {
		if c.Type == "text" {
			parts = append(parts, c.Text)
		}
	}
	output := strings.Join(parts, "\n")
	if output == "" {
		output = "(no output)"
	}
	if callResp.IsError {
		return ExecutionResult{Error: output}
	}
	return ExecutionResult{Output: output}
}

// call sends a JSON-RPC request and waits for a response.
func (c *mcpStdioConn) call(method string, params interface{}) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	id := c.nextID.Add(1)
	req := jsonrpcRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		c.alive = false
		return nil, fmt.Errorf("write to stdin: %w", err)
	}

	// Read response lines until we get one with our ID.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		line, err := c.stdout.ReadString('\n')
		if err != nil {
			c.alive = false
			return nil, fmt.Errorf("read from stdout: %w", err)
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var resp jsonrpcResponse
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			continue // skip non-JSON lines (e.g. notifications)
		}

		if resp.ID != id {
			continue // response for a different request or notification
		}

		if resp.Error != nil {
			return nil, fmt.Errorf("RPC error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	}
	return nil, fmt.Errorf("timeout waiting for response to %s", method)
}

// notify sends a JSON-RPC notification (no response expected).
func (c *mcpStdioConn) notify(method string, params interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()

	req := struct {
		JSONRPC string      `json:"jsonrpc"`
		Method  string      `json:"method"`
		Params  interface{} `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	data, _ := json.Marshal(req)
	c.stdin.Write(append(data, '\n')) //nolint:errcheck
}

func (c *mcpStdioConn) close() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.alive = false
	c.stdin.Close()
	if c.cmd.Process != nil {
		c.cmd.Process.Kill()
	}
	c.cmd.Wait() //nolint:errcheck
}
