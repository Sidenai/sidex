package tools

import (
	"fmt"
	"os"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/compress"
)

func init_batch_read(r *Registry) {
	r.tools["batch_read"] = Tool{
		Name: "batch_read",
		Description: `Read multiple files in a single call and return all their contents concatenated. Use this instead of many sequential read_file calls when you need to examine several related files at once (e.g. a component and its test, or all files in a module).

Large files are automatically compressed. Each file's output is prefixed with "=== path ===" for easy identification. Don't batch dozens of unrelated files — pick the 3-8 you actually need. Files that don't exist report errors inline without failing the whole batch.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"paths": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Array of file paths."},
			},
			"required": []string{"paths"},
		},
	}
}

func (r *Registry) batchRead(args map[string]interface{}) ExecutionResult {
	paths, ok := args["paths"].([]interface{})
	if !ok {
		return ExecutionResult{Error: "paths must be an array"}
	}

	var out strings.Builder
	for _, p := range paths {
		path := r.resolvePath(fmt.Sprint(p))
		data, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(&out, "=== %s ===\nERROR: %s\n\n", path, err)
			continue
		}
		content := string(data)
		if len(content) > 10000 {
			content = compress.CompressFileContent(content, 100)
		}
		fmt.Fprintf(&out, "=== %s ===\n%s\n\n", path, content)
	}
	return ExecutionResult{Output: out.String()}
}
