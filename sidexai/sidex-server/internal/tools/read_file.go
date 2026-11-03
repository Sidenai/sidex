package tools

import (
	"fmt"
	"os"
	"strings"
)

func init_read_file(r *Registry) {
	r.tools["read_file"] = Tool{
		Name: "read_file",
		Description: `Read a file from the user's filesystem. Text files are returned with line numbers (LINE|CONTENT format). Supported image files (PNG, JPEG, GIF, WebP) are read as bytes and attached as vision input for analysis.

Usage:
- You can optionally specify "offset" (1-based start line) and "limit" (number of lines) for partial reads of long files. If omitted, up to 2000 lines are returned; the output tells you how to page through the rest.
- For supported image files, offset/limit are ignored; the image is returned as structured data that the model receives as an attached image.
- Lines in the output are numbered so other tools (like edit_file) can reference them, but when you call edit_file you must NOT include the line-number prefix in old_string — only the actual file content.
- Prefer this tool over shell cat/head/tail. It handles line numbering and size limits correctly and rejects binary files.
- It is always better to speculatively read multiple potentially relevant files in parallel (multiple read_file calls in one turn) than to read them one at a time.
- Before editing a file with edit_file, write_file, or multi_edit, you MUST read it at least once in the current session so your edits can target exact existing text.
- If a file you've already read has been modified externally, re-read it before editing — the edit tool will reject stale writes.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":   map[string]interface{}{"type": "string", "description": "Absolute or cwd-relative path to the file."},
				"offset": map[string]interface{}{"type": "integer", "description": "Start reading from this 1-based line number."},
				"limit":  map[string]interface{}{"type": "integer", "description": "Maximum number of lines to return after offset."},
			},
			"required": []string{"path"},
		},
	}
}

func (r *Registry) readFile(args map[string]interface{}) ExecutionResult {
	path, err := r.resolveReadablePath(str(args, "path"))
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	// If sandbox is active, read from inside the container
	var content string
	if r.Sandbox != nil && r.Sandbox.Active {
		data, err := r.Sandbox.ReadFile(path)
		if err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		content = data
	} else {
		if isSupportedImagePath(path) {
			res := readImageFile(path, 10*1024*1024)
			if res.Error == "" {
				r.trackRead(path)
			}
			return res
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		if isBinaryContent(data) {
			return ExecutionResult{Error: fmt.Sprintf("%s appears to be a binary file (%d bytes) — read_file supports text plus PNG, JPEG, GIF, and WebP images", path, len(data))}
		}
		content = string(data)
	}

	r.trackRead(path)
	offset := intOr(args, "offset", 0)
	limit := intOr(args, "limit", 0)

	lines := strings.Split(content, "\n")
	totalLines := len(lines)

	startLine := 0
	if offset > 0 {
		startLine = offset - 1
		if startLine >= len(lines) {
			startLine = len(lines) - 1
		}
	}

	endLine := len(lines)
	if limit > 0 && startLine+limit < endLine {
		endLine = startLine + limit
	}

	// Hard cap on unrequested huge reads so one minified bundle can't blow
	// the context window. The model can page with offset/limit.
	truncated := false
	if limit <= 0 && endLine-startLine > maxReadLines {
		endLine = startLine + maxReadLines
		truncated = true
	}

	var numbered strings.Builder
	bytesWritten := 0
	for i := startLine; i < endLine; i++ {
		line := lines[i]
		if len(line) > maxReadLineLength {
			line = line[:maxReadLineLength] + "… [line truncated]"
		}
		fmt.Fprintf(&numbered, "%6d|%s\n", i+1, line)
		bytesWritten += len(line) + 8
		if bytesWritten > maxReadBytes {
			truncated = true
			endLine = i + 1
			break
		}
	}
	if truncated {
		fmt.Fprintf(&numbered, "\n[Output truncated at line %d of %d. Use offset=%d to continue reading.]\n", endLine, totalLines, endLine+1)
	}
	return ExecutionResult{Output: numbered.String()}
}

const (
	maxReadLines      = 2000
	maxReadLineLength = 2000
	maxReadBytes      = 256 * 1024
)
