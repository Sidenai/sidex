package tools

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

func init_edit_file(r *Registry) {
	r.tools["edit_file"] = Tool{
		Name: "edit_file",
		Description: `Perform an exact string replacement in a file. This is the preferred way to modify existing code.

Usage:
- You MUST have called read_file on this path at least once before editing. The edit is rejected otherwise.
- "old_string" must match the file exactly, including whitespace and indentation. Copy text directly from read_file output, stripping the "LINE|" prefix.
- "old_string" must be unique in the file, OR you must pass replace_all=true to rename every occurrence. Pick the smallest unique snippet that clearly identifies the target — typically 2–4 adjacent lines.
- If old_string is not found, do NOT immediately re-call with a near-identical string. Read the file again to see what's actually there, then retry with accurate text.
- Preserve the exact indentation that appears in the file (tabs vs spaces).
- Do not include line numbers in old_string or new_string.
- Only use emojis in new_string if the user explicitly requested it.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":        map[string]interface{}{"type": "string", "description": "Absolute or cwd-relative path to the file."},
				"old_string":  map[string]interface{}{"type": "string", "description": "Exact text to find. Must be unique unless replace_all=true."},
				"new_string":  map[string]interface{}{"type": "string", "description": "Replacement text. Can be empty to delete the matched region."},
				"replace_all": map[string]interface{}{"type": "boolean", "description": "Replace every occurrence (used for rename refactors)."},
			},
			"required": []string{"path", "old_string", "new_string"},
		},
	}
}

func (r *Registry) editFile(args map[string]interface{}) ExecutionResult {
	path, perr := r.resolvePathChecked(str(args, "path"))
	if perr != nil {
		return ExecutionResult{Error: perr.Error()}
	}
	r.AutoCheckpoint(str(args, "path"))

	// Soft guard: warn (don't block) when a test file is edited before any
	// source change. Hard-blocking broke legitimate "write a test" tasks.
	testWarning := r.testFileGuard(path, "modifying")

	// Skip stale check when sandbox active (files are inside container)
	if r.Sandbox == nil || !r.Sandbox.Active {
		if err := r.checkStale(path); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
	}

	// Read file content (from sandbox if active, otherwise local)
	var content string
	if r.Sandbox != nil && r.Sandbox.Active {
		data, err := r.Sandbox.ReadFile(path)
		if err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		content = data
	} else {
		data, err := os.ReadFile(path)
		if err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		content = string(data)
	}

	oldStr := str(args, "old_string")
	newStr := str(args, "new_string")

	if oldStr == "" {
		return ExecutionResult{Error: "old_string is required and cannot be empty"}
	}

	if !strings.Contains(content, oldStr) {
		// Exact match failed — try fast-apply fuzzy matching before giving up.
		if r.FastApply != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			result, err := r.FastApply.FuzzyApply(ctx, path, oldStr, newStr, content)
			if err == nil && result.NewContent != "" {
				if r.Sandbox != nil && r.Sandbox.Active {
					if err := r.Sandbox.WriteFile(path, result.NewContent); err != nil {
						return ExecutionResult{Error: err.Error()}
					}
				} else {
					if err := os.WriteFile(path, []byte(result.NewContent), 0644); err != nil {
						return ExecutionResult{Error: err.Error()}
					}
				}
				r.trackRead(path)
				log.Printf("[fast-apply] fuzzy edit succeeded on %s via %s (%v)", path, result.Method, result.Duration)
				// The exact string was NOT found — a fuzzy/LLM apply changed the
				// file. Show the model exactly what was written so it can verify
				// (and correct) instead of trusting a silent guess.
				return ExecutionResult{Output: fmt.Sprintf(
					"edited %s via fuzzy apply (%s). Your old_string did NOT match exactly; the following change was applied instead — verify it is what you intended:\n%s",
					path, result.Method, summarizeContentChange(content, result.NewContent))}
			}
			if err != nil {
				log.Printf("[fast-apply] fuzzy edit failed on %s: %v", path, err)
			}
		}
		hint := buildEditNotFoundHint(content, oldStr)
		return ExecutionResult{Error: "old_string not found in file. " + hint}
	}

	count := strings.Count(content, oldStr)
	if count > 1 {
		replaceAll := boolOr(args, "replace_all", false)
		if !replaceAll {
			preview := buildAmbiguityPreview(content, oldStr)
			return ExecutionResult{Error: fmt.Sprintf("old_string matches %d times in file. Either pass replace_all=true to rewrite every match, or provide a larger, unique old_string. First matches:\n%s", count, preview)}
		}
		content = strings.ReplaceAll(content, oldStr, newStr)
	} else {
		content = strings.Replace(content, oldStr, newStr, 1)
	}

	// Write back (to sandbox if active)
	if r.Sandbox != nil && r.Sandbox.Active {
		if err := r.Sandbox.WriteFile(path, content); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
	} else {
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
	}
	r.trackRead(path)
	return ExecutionResult{Output: fmt.Sprintf("edited %s (%d replacement(s))", path, count) + testWarning}
}

// buildEditNotFoundHint tries to help the model self-correct by finding the
// longest prefix of old_string that DOES appear in the file, and reporting it.
// If nothing useful matches, it returns a generic hint.
func buildEditNotFoundHint(content, old string) string {
	lines := strings.Split(old, "\n")
	for i := len(lines); i > 0; i-- {
		candidate := strings.Join(lines[:i], "\n")
		if candidate != "" && candidate != old && strings.Contains(content, candidate) {
			cnt := strings.Count(content, candidate)
			shown := candidate
			if len(shown) > 160 {
				shown = shown[:160] + "…"
			}
			return fmt.Sprintf("The first %d line(s) of your old_string DO appear in the file (%d times). Re-read the file and correct the trailing portion. Matched prefix:\n%s", i, cnt, shown)
		}
	}
	for _, line := range lines {
		l := strings.TrimSpace(line)
		if l == "" {
			continue
		}
		if strings.Contains(content, l) {
			return fmt.Sprintf("Part of your old_string (%q) exists in the file but the surrounding context differs. Re-read the file to see the exact text.", truncate(l, 80))
		}
		break
	}
	return "Re-read the file with read_file; the text you provided does not appear anywhere. Watch for whitespace, indentation, or line-ending differences."
}

// buildAmbiguityPreview shows the model up to 3 line-numbered match locations
// so it can pick a more unique snippet.
func buildAmbiguityPreview(content, old string) string {
	idx := 0
	lineNum := 1
	var locations []int
	for idx < len(content) {
		pos := strings.Index(content[idx:], old)
		if pos < 0 {
			break
		}
		absolute := idx + pos
		for j := idx; j < absolute; j++ {
			if content[j] == '\n' {
				lineNum++
			}
		}
		locations = append(locations, lineNum)
		idx = absolute + len(old)
		if len(locations) >= 3 {
			break
		}
	}
	parts := make([]string, 0, len(locations))
	for i, ln := range locations {
		parts = append(parts, fmt.Sprintf("  match %d at line %d", i+1, ln))
	}
	if len(parts) == 0 {
		return "  (unable to preview matches)"
	}
	return strings.Join(parts, "\n")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// summarizeContentChange produces a compact line diff (-old/+new) between two
// file contents, capped to keep tool output small.
func summarizeContentChange(oldContent, newContent string) string {
	oldLines := strings.Split(oldContent, "\n")
	newLines := strings.Split(newContent, "\n")

	// Trim common prefix
	start := 0
	for start < len(oldLines) && start < len(newLines) && oldLines[start] == newLines[start] {
		start++
	}
	// Trim common suffix
	oldEnd, newEnd := len(oldLines), len(newLines)
	for oldEnd > start && newEnd > start && oldLines[oldEnd-1] == newLines[newEnd-1] {
		oldEnd--
		newEnd--
	}

	const maxShown = 40
	var b strings.Builder
	fmt.Fprintf(&b, "@@ line %d @@\n", start+1)
	shown := 0
	for i := start; i < oldEnd && shown < maxShown; i++ {
		fmt.Fprintf(&b, "- %s\n", oldLines[i])
		shown++
	}
	for i := start; i < newEnd && shown < maxShown*2; i++ {
		fmt.Fprintf(&b, "+ %s\n", newLines[i])
		shown++
	}
	if (oldEnd-start) > maxShown || (newEnd-start) > maxShown {
		b.WriteString("… [diff truncated]\n")
	}
	return b.String()
}
