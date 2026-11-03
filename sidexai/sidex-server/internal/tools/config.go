package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func init_config(r *Registry) {
	r.tools["config"] = Tool{
		Name: "config",
		Description: `Read or write Sidex configuration settings. Use "get" to read a setting, "set" to change one, "list" to see all settings.

This tool operates on .sidex/config.json in the project directory.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"action": map[string]interface{}{"type": "string", "description": "get, set, or list"},
				"key":    map[string]interface{}{"type": "string", "description": "Setting key (for get/set)."},
				"value":  map[string]interface{}{"type": "string", "description": "Setting value (for set)."},
			},
			"required": []string{"action"},
		},
	}
}

func (r *Registry) config(args map[string]interface{}) ExecutionResult {
	action := str(args, "action")
	configPath := filepath.Join(r.cwd, ".sidex", "config.json")

	switch action {
	case "list":
		data, err := os.ReadFile(configPath)
		if err != nil {
			return ExecutionResult{Output: "(no config file found)"}
		}
		return ExecutionResult{Output: string(data)}
	case "get":
		key := str(args, "key")
		data, err := os.ReadFile(configPath)
		if err != nil {
			return ExecutionResult{Output: fmt.Sprintf("%s: (not set)", key)}
		}
		var cfg map[string]interface{}
		json.Unmarshal(data, &cfg)
		v, ok := cfg[key]
		if !ok {
			return ExecutionResult{Output: fmt.Sprintf("%s: (not set)", key)}
		}
		b, _ := json.Marshal(v)
		return ExecutionResult{Output: fmt.Sprintf("%s: %s", key, string(b))}
	case "set":
		key := str(args, "key")
		value := str(args, "value")
		var cfg map[string]interface{}
		if data, err := os.ReadFile(configPath); err == nil {
			json.Unmarshal(data, &cfg)
		}
		if cfg == nil {
			cfg = make(map[string]interface{})
		}
		cfg[key] = value
		os.MkdirAll(filepath.Dir(configPath), 0755)
		data, _ := json.MarshalIndent(cfg, "", "  ")
		if err := os.WriteFile(configPath, data, 0644); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		return ExecutionResult{Output: fmt.Sprintf("set %s = %s", key, value)}
	default:
		return ExecutionResult{Error: "action must be get, set, or list"}
	}
}
