package tools

func init_lsp(r *Registry) {
	r.tools["lsp_hover"] = Tool{
		Name: "lsp_hover",
		Description: `Get type information and documentation for a symbol at a specific file position from the language server. Use this to understand variable types, function signatures, or read inline documentation without navigating to the definition.

Provide the exact file path and 0-based line/character position. The position should point to the symbol you want to inspect. Returns whatever the language server reports at that location (type signature, doc comments, etc.).`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":      map[string]interface{}{"type": "string", "description": "File path."},
				"line":      map[string]interface{}{"type": "integer", "description": "0-based line number."},
				"character": map[string]interface{}{"type": "integer", "description": "0-based character offset."},
			},
			"required": []string{"path", "line", "character"},
		},
	}

	r.tools["lsp_definition"] = Tool{
		Name: "lsp_definition",
		Description: `Jump to where a symbol is defined. Returns the file path and position of the definition. Use this to navigate from a usage to its implementation — e.g., to find where a function, class, type, or variable is declared.

More precise than grep for navigating code because it uses the language server's semantic understanding. Provide the file path and 0-based line/character of the symbol usage you want to trace.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":      map[string]interface{}{"type": "string", "description": "File path."},
				"line":      map[string]interface{}{"type": "integer", "description": "0-based line number."},
				"character": map[string]interface{}{"type": "integer", "description": "0-based character offset."},
			},
			"required": []string{"path", "line", "character"},
		},
	}

	r.tools["lsp_references"] = Tool{
		Name: "lsp_references",
		Description: `Find all references to a symbol across the entire project. Returns a list of file paths and positions where the symbol is used. Use this BEFORE renaming, moving, or deleting something to understand its full usage scope and avoid breakage.

More accurate than grep because it uses semantic analysis — won't match string coincidences or comments, only actual code references.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":      map[string]interface{}{"type": "string", "description": "File path."},
				"line":      map[string]interface{}{"type": "integer", "description": "0-based line number."},
				"character": map[string]interface{}{"type": "integer", "description": "0-based character offset."},
			},
			"required": []string{"path", "line", "character"},
		},
	}

	r.tools["lsp_diagnostics"] = Tool{
		Name: "lsp_diagnostics",
		Description: `Get linter errors, type errors, and warnings for a file from the language server. Use this AFTER editing a file to verify you haven't introduced type errors, missing imports, or other issues.

Returns diagnostics with severity level, message, and line/character position. Only reports issues the language server detects — does not run tests or custom linters.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{"type": "string", "description": "File path."},
			},
			"required": []string{"path"},
		},
	}
}

func (r *Registry) lspHover(args map[string]interface{}) ExecutionResult {
	return ExecutionResult{Output: "LSP tools must be executed locally via the IDE client."}
}

func (r *Registry) lspDefinition(args map[string]interface{}) ExecutionResult {
	return ExecutionResult{Output: "LSP tools must be executed locally via the IDE client."}
}

func (r *Registry) lspReferences(args map[string]interface{}) ExecutionResult {
	return ExecutionResult{Output: "LSP tools must be executed locally via the IDE client."}
}

func (r *Registry) lspDiagnostics(args map[string]interface{}) ExecutionResult {
	return ExecutionResult{Output: "LSP tools must be executed locally via the IDE client."}
}

func init_read_lints(r *Registry) {
	r.tools["read_lints"] = Tool{
		Name: "read_lints",
		Description: `Read linter errors and warnings from the workspace. Use this AFTER making substantive edits to verify you haven't introduced errors.

- If paths are provided, returns diagnostics for those files/directories only.
- If no paths are provided, returns diagnostics for all recently edited files.
- Returns severity (error/warning/info), message, file path, and line/character position.
- NEVER call this on a file unless you've edited it or are about to edit it.
- If you've introduced linter errors, fix them before considering the task done.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"paths": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "Optional array of file or directory paths to check. If omitted, checks all recently edited files.",
				},
			},
		},
	}
}

func (r *Registry) readLints(args map[string]interface{}) ExecutionResult {
	return ExecutionResult{Output: "read_lints must be executed locally via the IDE client. Linting is not available in server/sandbox mode."}
}
