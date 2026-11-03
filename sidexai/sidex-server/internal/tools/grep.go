package tools

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/compress"
)

func init_grep(r *Registry) {
	r.tools["grep"] = Tool{
		Name: "grep",
		Description: `Search file contents using ripgrep. This is your primary tool for finding code by keyword, symbol, or pattern.

Usage:
- Prefer grep over shell grep/rg; it returns structured, size-capped output.
- It is always better to speculatively run multiple different searches in parallel (multiple grep calls in one turn) than to search serially.
- Start broad, then narrow: use output_mode="files_with_matches" for an overview, then re-run with output_mode="content" and a smaller scope to see matching lines.
- Use "glob" (e.g. *.ts, **/*.go) or "type" (e.g. js, py, go, rust) to scope by filename. Use "path" to scope by directory.
- For complex regex patterns that span lines, set multiline=true.
- Total output is capped at head_limit lines (default 100). If results are overwhelming, narrow the scope instead of just raising the cap.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"pattern":          map[string]interface{}{"type": "string", "description": "Regex pattern (Rust regex syntax, via ripgrep)."},
				"path":             map[string]interface{}{"type": "string", "description": "File or directory to search in. Defaults to cwd."},
				"glob":             map[string]interface{}{"type": "string", "description": "Glob filter, e.g. '*.ts' or '*.{go,rs}'."},
				"type":             map[string]interface{}{"type": "string", "description": "ripgrep file type, e.g. 'js', 'py', 'go', 'rust'."},
				"output_mode":      map[string]interface{}{"type": "string", "enum": []string{"content", "files_with_matches", "count"}, "description": "'content' (default, matching lines), 'files_with_matches' (paths only), or 'count'."},
				"context":          map[string]interface{}{"type": "integer", "description": "Number of context lines before and after each match (-C)."},
				"case_insensitive": map[string]interface{}{"type": "boolean", "description": "Case-insensitive search (-i)."},
				"head_limit":       map[string]interface{}{"type": "integer", "description": "Max total output lines; default 100."},
				"multiline":        map[string]interface{}{"type": "boolean", "description": "Allow '.' to match newlines so patterns span lines."},
			},
			"required": []string{"pattern"},
		},
	}
}

func (r *Registry) grep(args map[string]interface{}) ExecutionResult {
	pattern := str(args, "pattern")
	dir := r.resolvePath(strOr(args, "path", "."))
	outputMode := strOr(args, "output_mode", "content")
	headLimit := intOr(args, "head_limit", 100)
	if headLimit <= 0 {
		headLimit = 100
	}
	contextLines := intOr(args, "context", 0)
	caseInsensitive := boolOr(args, "case_insensitive", false)
	globFilter := str(args, "glob")
	typeFilter := str(args, "type")
	multiline := boolOr(args, "multiline", false)

	// When sandbox is active, run grep inside the sandbox
	if r.Sandbox != nil && r.Sandbox.Active {
		sandboxDir := strOr(args, "path", "/app")
		cmd := "rg --no-heading --line-number --max-filesize 1M --max-columns 500"
		if contextLines > 0 {
			cmd += fmt.Sprintf(" -C%d", contextLines)
		}
		if caseInsensitive {
			cmd += " -i"
		}
		if multiline {
			cmd += " -U --multiline-dotall"
		}
		if globFilter != "" {
			cmd += " --glob " + shellSingleQuote(globFilter)
		}
		if typeFilter != "" {
			cmd += " --type " + shellSingleQuote(typeFilter)
		}
		if outputMode == "files_with_matches" {
			cmd += " --files-with-matches"
		} else if outputMode == "count" {
			cmd += " --count"
		}
		cmd += fmt.Sprintf(" %s %s 2>/dev/null | head -%d", shellSingleQuote(pattern), shellSingleQuote(sandboxDir), headLimit)
		stdout, _, _, err := r.Sandbox.Exec(cmd, "")
		if err != nil || stdout == "" {
			return ExecutionResult{Output: "no matches found"}
		}
		return ExecutionResult{Output: stdout}
	}

	rgArgs := []string{"--no-heading", "--line-number", "--max-filesize", "1M", "--max-columns", "500"}

	switch outputMode {
	case "files_with_matches":
		rgArgs = append(rgArgs, "--files-with-matches")
	case "count":
		rgArgs = append(rgArgs, "--count")
	default:
		// Note: --max-count is PER FILE; the total cap is applied to the
		// combined output below.
		rgArgs = append(rgArgs, "--max-count", fmt.Sprintf("%d", headLimit))
	}

	if contextLines > 0 {
		rgArgs = append(rgArgs, fmt.Sprintf("-C%d", contextLines))
	}
	if caseInsensitive {
		rgArgs = append(rgArgs, "-i")
	}
	if multiline {
		rgArgs = append(rgArgs, "-U", "--multiline-dotall")
	}
	if globFilter != "" {
		rgArgs = append(rgArgs, "--glob", globFilter)
	}
	if typeFilter != "" {
		rgArgs = append(rgArgs, "--type", typeFilter)
	}

	rgArgs = append(rgArgs, pattern, dir)

	cmd := exec.Command("rg", rgArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return ExecutionResult{Output: "no matches found"}
	}

	result := string(out)

	// Enforce head_limit as a TOTAL line cap across all files.
	lines := strings.Split(strings.TrimRight(result, "\n"), "\n")
	if len(lines) > headLimit {
		truncatedCount := len(lines) - headLimit
		result = strings.Join(lines[:headLimit], "\n") +
			fmt.Sprintf("\n… [%d more lines truncated — narrow the search with path/glob/type, or raise head_limit]", truncatedCount)
	}

	if len(result) > 50000 {
		result = compress.SummarizeToolOutput(result, 50000)
	}
	return ExecutionResult{Output: result}
}

// shellSingleQuote safely single-quotes s for POSIX shells (used only for
// sandbox exec strings). Embedded single quotes are escaped as '\”.
func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
