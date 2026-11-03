package tools

import "encoding/json"

func init_synthetic_output(r *Registry) {
	r.tools["structured_output"] = Tool{
		Name: "structured_output",
		Description: `Return structured JSON data as a tool result. Use this when you need to produce machine-readable output (e.g., a list of findings, a structured analysis, data for the UI to render).

The JSON is passed through to the caller without modification. Ensure it's valid JSON.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"data":        map[string]interface{}{"type": "string", "description": "Valid JSON string to return."},
				"schema_hint": map[string]interface{}{"type": "string", "description": "Optional description of the JSON structure for documentation."},
			},
			"required": []string{"data"},
		},
	}
}

func (r *Registry) structuredOutput(args map[string]interface{}) ExecutionResult {
	data := str(args, "data")
	var v interface{}
	if err := json.Unmarshal([]byte(data), &v); err != nil {
		return ExecutionResult{Error: "data must be valid JSON: " + err.Error()}
	}
	return ExecutionResult{Output: data}
}
