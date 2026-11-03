package mcp

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// ServerConfig defines how to connect to a single MCP server.
// Supports both stdio (command-based) and HTTP (URL-based) transports.
type ServerConfig struct {
	// Stdio transport fields
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`

	// HTTP transport fields (MCP v2)
	URL      string   `json:"url,omitempty"`
	Auth     string   `json:"auth,omitempty"`      // "oauth", "token", "bearer", or ""
	TokenEnv string   `json:"token_env,omitempty"` // env var name holding the auth token
	Token    string   `json:"token,omitempty"`     // inline token (prefer token_env)
	Scopes   []string `json:"scopes,omitempty"`    // OAuth scopes if auth="oauth"

	// Behavior
	LazyLoad bool `json:"lazy_load,omitempty"` // if true, only load tool names initially
}

// Transport returns the transport type for this server config.
func (sc ServerConfig) Transport() string {
	if sc.URL != "" {
		return "http"
	}
	return "stdio"
}

// ResolveToken returns the auth token, checking the environment variable first.
func (sc ServerConfig) ResolveToken() string {
	if sc.TokenEnv != "" {
		if val := os.Getenv(sc.TokenEnv); val != "" {
			return val
		}
	}
	return sc.Token
}

// Config is the top-level structure for .sidex/mcp.json.
type Config struct {
	Servers map[string]ServerConfig `json:"servers"`
}

// LoadConfig reads the MCP configuration from the workspace's .sidex/mcp.json.
// Returns nil (no error) if the file does not exist.
func LoadConfig(workspaceDir string) (*Config, error) {
	configPath := filepath.Join(workspaceDir, ".sidex", "mcp.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("mcp: read config %s: %w", configPath, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("mcp: parse config %s: %w", configPath, err)
	}
	return &cfg, nil
}

// StartFromConfig loads the MCP config for the given workspace and connects
// to all configured servers. Returns a ready-to-use MCPManager.
// If no config file exists, returns an empty manager.
func StartFromConfig(workspaceDir string) (*MCPManager, error) {
	cfg, err := LoadConfig(workspaceDir)
	if err != nil {
		return nil, err
	}

	mgr := NewManager()

	if cfg == nil || len(cfg.Servers) == 0 {
		return mgr, nil
	}

	for name, sc := range cfg.Servers {
		switch sc.Transport() {
		case "http":
			token := sc.ResolveToken()
			authType := sc.Auth
			if authType == "token" {
				authType = "bearer"
			}
			opts := HTTPClientConfig{
				URL:       sc.URL,
				AuthType:  authType,
				AuthToken: token,
			}
			if err := mgr.AddHTTPServer(name, opts, sc.LazyLoad); err != nil {
				log.Printf("mcp: failed to connect to HTTP server %q (%s): %v (skipping)", name, sc.URL, err)
				continue
			}
		default:
			env := buildEnv(sc.Env)
			if err := mgr.AddServer(name, sc.Command, sc.Args, env); err != nil {
				log.Printf("mcp: failed to start server %q: %v (skipping)", name, err)
				continue
			}
		}
	}
	return mgr, nil
}

// buildEnv converts a map of env vars into the os.Environ() + overrides format
// that exec.Cmd.Env expects.
func buildEnv(extra map[string]string) []string {
	if len(extra) == 0 {
		return nil
	}
	base := os.Environ()
	for k, v := range extra {
		base = append(base, k+"="+v)
	}
	return base
}
