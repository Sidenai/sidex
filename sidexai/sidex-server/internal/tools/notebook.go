package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func init_notebook(r *Registry) {
	r.tools["notebook_edit"] = Tool{
		Name: "notebook_edit",
		Description: `Edit a Jupyter notebook (.ipynb) cell — replace, insert, or delete. Use this for modifying notebook files instead of manual JSON manipulation with edit_file.

Actions: 'replace' overwrites a cell at cell_index, 'insert' adds a new cell at cell_index (or appends if -1), 'delete' removes the cell at cell_index. Cell types: 'code' or 'markdown'. The notebook's JSON structure is handled automatically.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":       map[string]interface{}{"type": "string", "description": "Path to .ipynb file."},
				"cell_index": map[string]interface{}{"type": "integer", "description": "0-based cell index. -1 to append."},
				"cell_type":  map[string]interface{}{"type": "string", "description": "code or markdown."},
				"source":     map[string]interface{}{"type": "string", "description": "New cell content."},
				"action":     map[string]interface{}{"type": "string", "description": "replace, insert, or delete."},
			},
			"required": []string{"path", "cell_index", "action"},
		},
	}
}

func (r *Registry) notebookEdit(args map[string]interface{}) ExecutionResult {
	path := r.resolvePath(str(args, "path"))
	action := str(args, "action")
	cellIdx := intOr(args, "cell_index", -1)
	source := str(args, "source")
	cellType := strOr(args, "cell_type", "code")

	data, err := os.ReadFile(path)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	var nb map[string]interface{}
	if err := json.Unmarshal(data, &nb); err != nil {
		return ExecutionResult{Error: "not a valid notebook: " + err.Error()}
	}

	cells, ok := nb["cells"].([]interface{})
	if !ok {
		return ExecutionResult{Error: "notebook has no cells array"}
	}

	switch action {
	case "replace":
		if cellIdx < 0 || cellIdx >= len(cells) {
			return ExecutionResult{Error: fmt.Sprintf("cell index %d out of range (0-%d)", cellIdx, len(cells)-1)}
		}
		cell := cells[cellIdx].(map[string]interface{})
		cell["source"] = strings.Split(source, "\n")
		cell["cell_type"] = cellType
	case "insert":
		newCell := map[string]interface{}{
			"cell_type": cellType,
			"source":    strings.Split(source, "\n"),
			"metadata":  map[string]interface{}{},
			"outputs":   []interface{}{},
		}
		if cellIdx < 0 || cellIdx >= len(cells) {
			cells = append(cells, newCell)
		} else {
			cells = append(cells[:cellIdx+1], cells[cellIdx:]...)
			cells[cellIdx] = newCell
		}
		nb["cells"] = cells
	case "delete":
		if cellIdx < 0 || cellIdx >= len(cells) {
			return ExecutionResult{Error: fmt.Sprintf("cell index %d out of range", cellIdx)}
		}
		cells = append(cells[:cellIdx], cells[cellIdx+1:]...)
		nb["cells"] = cells
	default:
		return ExecutionResult{Error: "action must be replace, insert, or delete"}
	}

	out, _ := json.MarshalIndent(nb, "", " ")
	if err := os.WriteFile(path, out, 0644); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	return ExecutionResult{Output: fmt.Sprintf("%s cell %d in %s", action, cellIdx, path)}
}
