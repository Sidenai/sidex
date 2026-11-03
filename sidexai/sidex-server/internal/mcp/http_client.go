package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	httpRequestTimeout = 60 * time.Second
	sseRetryDefault    = 3 * time.Second
)

// HTTPClient communicates with an MCP v2 server over Streamable HTTP
// (POST requests, SSE responses). This is the primary transport for
// remote/cloud MCP servers (GitHub, Linear, etc.)
type HTTPClient struct {
	serverURL  string
	authToken  string
	authType   string // "bearer", "oauth", or ""
	httpClient *http.Client
	sessionID  string

	reqID  int64
	mu     sync.Mutex
	closed bool
}

// HTTPClientConfig configures an HTTP-based MCP client.
type HTTPClientConfig struct {
	URL       string
	AuthType  string // "bearer", "oauth", or ""
	AuthToken string
	Timeout   time.Duration
}

// NewHTTPClient creates an MCP client that uses Streamable HTTP transport.
// It performs the initialize handshake upon creation.
func NewHTTPClient(cfg HTTPClientConfig) (*HTTPClient, error) {
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = httpRequestTimeout
	}

	c := &HTTPClient{
		serverURL: strings.TrimRight(cfg.URL, "/"),
		authToken: cfg.AuthToken,
		authType:  cfg.AuthType,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}

	if err := c.initialize(); err != nil {
		return nil, fmt.Errorf("mcp http: initialize handshake failed: %w", err)
	}

	return c, nil
}

func (c *HTTPClient) initialize() error {
	params := initializeParams{
		ProtocolVersion: "2025-03-26",
		Capabilities: map[string]any{
			"elicitation": map[string]any{},
		},
		ClientInfo: clientInfo{
			Name:    "sidex",
			Version: "0.5.0",
		},
	}

	resp, err := c.sendRequest(context.Background(), "initialize", params)
	if err != nil {
		return err
	}

	var initResult struct {
		SessionID string `json:"sessionId"`
	}
	if resp.Result != nil {
		json.Unmarshal(resp.Result, &initResult)
	}
	if initResult.SessionID != "" {
		c.sessionID = initResult.SessionID
	}

	// Send initialized notification
	_, _ = c.sendNotification(context.Background(), "notifications/initialized", nil)

	return nil
}

// sendRequest sends a JSON-RPC request over HTTP POST and reads the SSE response.
func (c *HTTPClient) sendRequest(ctx context.Context, method string, params interface{}) (*jsonRPCResponse, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("mcp http: client closed")
	}
	c.mu.Unlock()

	id := atomic.AddInt64(&c.reqID, 1)

	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("mcp http: marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.serverURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("mcp http: create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream, application/json")
	if c.sessionID != "" {
		httpReq.Header.Set("Mcp-Session-Id", c.sessionID)
	}
	c.setAuth(httpReq)

	httpResp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("mcp http: request failed: %w", err)
	}
	defer httpResp.Body.Close()

	if httpResp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("mcp http: authentication failed (401)")
	}
	if httpResp.StatusCode >= 400 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(httpResp.Body, 1024))
		return nil, fmt.Errorf("mcp http: server returned %d: %s", httpResp.StatusCode, string(bodyBytes))
	}

	if sid := httpResp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.sessionID = sid
	}

	contentType := httpResp.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "text/event-stream") {
		return c.readSSEResponse(httpResp.Body, id)
	}

	// Plain JSON response
	var resp jsonRPCResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&resp); err != nil {
		return nil, fmt.Errorf("mcp http: decode response: %w", err)
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("mcp http: server error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	return &resp, nil
}

// readSSEResponse parses an SSE stream for the JSON-RPC response matching the given id.
func (c *HTTPClient) readSSEResponse(body io.Reader, expectedID int64) (*jsonRPCResponse, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 256*1024), 10*1024*1024)

	var dataBuffer strings.Builder

	for scanner.Scan() {
		line := scanner.Text()

		if line == "" {
			// End of event — process accumulated data
			if dataBuffer.Len() > 0 {
				data := dataBuffer.String()
				dataBuffer.Reset()

				var resp jsonRPCResponse
				if err := json.Unmarshal([]byte(data), &resp); err != nil {
					continue
				}

				if resp.ID != nil && *resp.ID == expectedID {
					if resp.Error != nil {
						return nil, fmt.Errorf("mcp http: server error %d: %s", resp.Error.Code, resp.Error.Message)
					}
					return &resp, nil
				}
			}
			continue
		}

		if strings.HasPrefix(line, "data: ") {
			dataBuffer.WriteString(strings.TrimPrefix(line, "data: "))
		} else if strings.HasPrefix(line, "data:") {
			dataBuffer.WriteString(strings.TrimPrefix(line, "data:"))
		}
	}

	// Check if we have remaining data
	if dataBuffer.Len() > 0 {
		data := dataBuffer.String()
		var resp jsonRPCResponse
		if err := json.Unmarshal([]byte(data), &resp); err == nil {
			if resp.ID != nil && *resp.ID == expectedID {
				if resp.Error != nil {
					return nil, fmt.Errorf("mcp http: server error %d: %s", resp.Error.Code, resp.Error.Message)
				}
				return &resp, nil
			}
		}
	}

	return nil, fmt.Errorf("mcp http: SSE stream ended without response for request %d", expectedID)
}

// sendNotification sends a JSON-RPC notification (no response expected).
func (c *HTTPClient) sendNotification(ctx context.Context, method string, params interface{}) (*http.Response, error) {
	notif := struct {
		JSONRPC string      `json:"jsonrpc"`
		Method  string      `json:"method"`
		Params  interface{} `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}

	body, err := json.Marshal(notif)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.serverURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	if c.sessionID != "" {
		httpReq.Header.Set("Mcp-Session-Id", c.sessionID)
	}
	c.setAuth(httpReq)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	resp.Body.Close()
	return resp, nil
}

func (c *HTTPClient) setAuth(req *http.Request) {
	if c.authToken == "" {
		return
	}
	switch c.authType {
	case "oauth", "bearer":
		req.Header.Set("Authorization", "Bearer "+c.authToken)
	default:
		req.Header.Set("Authorization", "Bearer "+c.authToken)
	}
}

// ListTools calls tools/list on the MCP server.
func (c *HTTPClient) ListTools() ([]MCPTool, error) {
	resp, err := c.sendRequest(context.Background(), "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}

	var result toolsListResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("mcp http: parse tools/list: %w", err)
	}
	return result.Tools, nil
}

// CallTool invokes a named tool and returns text content.
func (c *HTTPClient) CallTool(name string, arguments json.RawMessage) (string, error) {
	return c.CallToolWithContext(context.Background(), name, arguments)
}

// CallToolWithContext invokes a named tool with context support.
func (c *HTTPClient) CallToolWithContext(ctx context.Context, name string, arguments json.RawMessage) (string, error) {
	params := toolsCallParams{
		Name:      name,
		Arguments: arguments,
	}

	resp, err := c.sendRequest(ctx, "tools/call", params)
	if err != nil {
		return "", err
	}

	var result toolCallResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return "", fmt.Errorf("mcp http: parse tools/call: %w", err)
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

// Alive returns true if the client is not closed.
func (c *HTTPClient) Alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed
}

// Close marks the client as closed and sends a session termination if supported.
func (c *HTTPClient) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()

	if c.sessionID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, "DELETE", c.serverURL, nil)
		if err == nil {
			req.Header.Set("Mcp-Session-Id", c.sessionID)
			c.setAuth(req)
			resp, err := c.httpClient.Do(req)
			if err == nil {
				resp.Body.Close()
			}
		}
	}
	return nil
}
