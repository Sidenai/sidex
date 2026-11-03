package mcp

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
)

// MCPToolRef maps a tool name to the server that owns it.
type MCPToolRef struct {
	ServerName string
	Tool       MCPTool
	LazySchema bool // if true, InputSchema hasn't been fetched yet
}

// ElicitationRequest is emitted when an MCP server requests user input.
type ElicitationRequest struct {
	Server  string   `json:"server"`
	Prompt  string   `json:"prompt"`
	Options []string `json:"options,omitempty"`
}

// ElicitationHandler is a callback that asks the user for input and returns their response.
type ElicitationHandler func(req ElicitationRequest) (string, error)

// MCPTransport is an interface abstracting stdio and HTTP MCP connections.
type MCPTransport interface {
	ListTools() ([]MCPTool, error)
	CallTool(name string, arguments json.RawMessage) (string, error)
	Alive() bool
	Close() error
}

// MCPManager manages connections to multiple MCP servers and provides
// a unified tool namespace. Supports both stdio and HTTP transports.
type MCPManager struct {
	mu      sync.RWMutex
	clients map[string]MCPTransport // server name → client
	tools   map[string]MCPToolRef   // tool name → server + tool metadata
	lazy    map[string]bool         // server name → lazy-loaded (names only)

	// ElicitHandler is called when an MCP server requests user input.
	// Set this before using servers that may require elicitation.
	ElicitHandler ElicitationHandler
}

// NewManager creates an empty MCPManager.
func NewManager() *MCPManager {
	return &MCPManager{
		clients: make(map[string]MCPTransport),
		tools:   make(map[string]MCPToolRef),
		lazy:    make(map[string]bool),
	}
}

// AddServer connects to an MCP server via stdio, lists its tools, and registers them.
func (m *MCPManager) AddServer(name, command string, args, env []string) error {
	client, err := NewStdioClient(command, args, env)
	if err != nil {
		return fmt.Errorf("mcp manager: connect %q: %w", name, err)
	}

	tools, err := client.ListTools()
	if err != nil {
		client.Close()
		return fmt.Errorf("mcp manager: list tools from %q: %w", name, err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.removeServerLocked(name)
	m.clients[name] = client

	for _, t := range tools {
		toolName := t.Name
		if _, exists := m.tools[toolName]; exists {
			toolName = name + "__" + t.Name
		}
		m.tools[toolName] = MCPToolRef{ServerName: name, Tool: t}
	}

	log.Printf("mcp: connected to %q (stdio) — %d tools registered", name, len(tools))
	return nil
}

// AddHTTPServer connects to an MCP server via Streamable HTTP transport.
// If lazy is true, only tool names and descriptions are loaded initially;
// full schemas are fetched on first invocation.
func (m *MCPManager) AddHTTPServer(name string, cfg HTTPClientConfig, lazy bool) error {
	client, err := NewHTTPClient(cfg)
	if err != nil {
		return fmt.Errorf("mcp manager: connect http %q: %w", name, err)
	}

	tools, err := client.ListTools()
	if err != nil {
		client.Close()
		return fmt.Errorf("mcp manager: list tools from http %q: %w", name, err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.removeServerLocked(name)
	m.clients[name] = client
	m.lazy[name] = lazy

	for _, t := range tools {
		toolName := t.Name
		if _, exists := m.tools[toolName]; exists {
			toolName = name + "__" + t.Name
		}
		ref := MCPToolRef{ServerName: name, Tool: t}
		if lazy {
			ref.LazySchema = true
			ref.Tool.InputSchema = nil
		}
		m.tools[toolName] = ref
	}

	log.Printf("mcp: connected to %q (http) — %d tools registered (lazy=%v)", name, len(tools), lazy)
	return nil
}

// removeServerLocked removes an existing server entry (must hold write lock).
func (m *MCPManager) removeServerLocked(name string) {
	if old, exists := m.clients[name]; exists {
		old.Close()
		for toolName, ref := range m.tools {
			if ref.ServerName == name {
				delete(m.tools, toolName)
			}
		}
		delete(m.lazy, name)
	}
}

// RemoveServer disconnects from the named MCP server and unregisters its tools.
func (m *MCPManager) RemoveServer(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	client, ok := m.clients[name]
	if !ok {
		return fmt.Errorf("mcp manager: server %q not found", name)
	}

	for toolName, ref := range m.tools {
		if ref.ServerName == name {
			delete(m.tools, toolName)
		}
	}
	delete(m.clients, name)
	delete(m.lazy, name)

	return client.Close()
}

// ListAllTools returns all tools from all connected MCP servers.
func (m *MCPManager) ListAllTools() []MCPToolRef {
	m.mu.RLock()
	defer m.mu.RUnlock()

	refs := make([]MCPToolRef, 0, len(m.tools))
	for _, ref := range m.tools {
		refs = append(refs, ref)
	}
	return refs
}

// HasTool checks whether the given tool name is an MCP tool.
func (m *MCPManager) HasTool(name string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.tools[name]
	return ok
}

// GetToolSchema returns the full schema for a tool, fetching it from the
// server if it was lazily loaded. This enables the dynamic context discovery
// pattern where only tool names are sent initially.
func (m *MCPManager) GetToolSchema(name string) (json.RawMessage, error) {
	m.mu.RLock()
	ref, ok := m.tools[name]
	if !ok {
		m.mu.RUnlock()
		return nil, fmt.Errorf("mcp: unknown tool %q", name)
	}

	if !ref.LazySchema || ref.Tool.InputSchema != nil {
		schema := ref.Tool.InputSchema
		m.mu.RUnlock()
		return schema, nil
	}

	client, clientOk := m.clients[ref.ServerName]
	m.mu.RUnlock()

	if !clientOk {
		return nil, fmt.Errorf("mcp: server %q not connected", ref.ServerName)
	}

	// Re-fetch full tool list to get schemas
	tools, err := client.ListTools()
	if err != nil {
		return nil, fmt.Errorf("mcp: refresh schema from %q: %w", ref.ServerName, err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	var schema json.RawMessage
	for _, t := range tools {
		for toolName, existingRef := range m.tools {
			if existingRef.ServerName == ref.ServerName && existingRef.Tool.Name == t.Name {
				existingRef.Tool.InputSchema = t.InputSchema
				existingRef.LazySchema = false
				m.tools[toolName] = existingRef
				if t.Name == ref.Tool.Name {
					schema = t.InputSchema
				}
			}
		}
	}
	return schema, nil
}

// CallTool routes a tool call to the correct MCP server and returns the result.
func (m *MCPManager) CallTool(name string, arguments json.RawMessage) (string, error) {
	m.mu.RLock()
	ref, ok := m.tools[name]
	if !ok {
		m.mu.RUnlock()
		return "", fmt.Errorf("mcp: unknown tool %q", name)
	}
	client, clientOk := m.clients[ref.ServerName]
	m.mu.RUnlock()

	if !clientOk {
		return "", fmt.Errorf("mcp: server %q for tool %q is not connected", ref.ServerName, name)
	}

	if !client.Alive() {
		return "", fmt.Errorf("mcp: server %q has crashed — remove and re-add to reconnect", ref.ServerName)
	}

	return client.CallTool(ref.Tool.Name, arguments)
}

// ServerNames returns the names of all connected servers.
func (m *MCPManager) ServerNames() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	names := make([]string, 0, len(m.clients))
	for name := range m.clients {
		names = append(names, name)
	}
	return names
}

// Close disconnects from all MCP servers.
func (m *MCPManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for name, client := range m.clients {
		if err := client.Close(); err != nil {
			log.Printf("mcp: error closing %q: %v", name, err)
		}
	}
	m.clients = make(map[string]MCPTransport)
	m.tools = make(map[string]MCPToolRef)
	m.lazy = make(map[string]bool)
}
