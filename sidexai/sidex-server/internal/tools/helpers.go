package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/paths"
)

// List returns all registered tools in deterministic (name-sorted) order.
// Stable ordering matters: the tool array is part of every model request, so
// nondeterministic ordering defeats provider prompt caching.
func (r *Registry) List() []Tool {
	out := make([]Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ListWithMCP returns all built-in tools plus tools from connected MCP servers.
// For lazy-loaded servers, tools appear with a minimal "any object" schema
// until their full schema is fetched on first use.
func (r *Registry) ListWithMCP() []Tool {
	out := r.List()
	if r.MCP == nil {
		return out
	}
	for _, ref := range r.MCP.ListAllTools() {
		params := make(map[string]interface{})
		if ref.LazySchema || ref.Tool.InputSchema == nil {
			params["type"] = "object"
			params["additionalProperties"] = true
		} else {
			json.Unmarshal(ref.Tool.InputSchema, &params) //nolint:errcheck
		}
		out = append(out, Tool{
			Name:        ref.Tool.Name,
			Description: fmt.Sprintf("[MCP:%s] %s", ref.ServerName, ref.Tool.Description),
			Parameters:  params,
		})
	}
	return out
}

// IsDangerous returns true if the named tool is marked dangerous.
func (r *Registry) IsDangerous(name string) bool {
	t, ok := r.tools[name]
	return ok && t.Dangerous
}

// Cleanup releases resources held by the registry (background shells, MCP servers, etc.).
func (r *Registry) Cleanup() {
	if r.bg != nil {
		r.bg.CleanupAll()
	}
	if r.MCP != nil {
		r.MCP.Close()
	}
}

// trackRead records the current mtime of a file so checkStale can detect
// external modifications before the agent tries to edit it.
func (r *Registry) trackRead(path string) {
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	r.readState[path] = fileReadState{mtime: info.ModTime(), readAt: now()}

	// Agent file reads are a retrieval-recency signal: recently read files
	// rank higher in semantic search. Paths are stored workspace-relative to
	// match how the index records chunk file paths.
	if r.IndexService != nil {
		rel, relErr := filepath.Rel(r.cwd, path)
		if relErr != nil || strings.HasPrefix(rel, "..") {
			rel = path
		}
		r.IndexService.RecordRead(r.cwd, rel)
	}
}

// checkStale returns an error if the file was modified since the last read.
func (r *Registry) checkStale(path string) error {
	state, ok := r.readState[path]
	if !ok {
		return fmt.Errorf("file has not been read yet — use read_file first before editing")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	if info.ModTime().After(state.mtime) {
		return fmt.Errorf(
			"file was modified since last read (read at %s, modified at %s) — re-read before editing",
			state.readAt.Format("15:04:05"), info.ModTime().Format("15:04:05"),
		)
	}
	return nil
}

// resolvePath makes a relative path absolute against the workspace root.
// When sandbox is active, paths are trusted (container provides isolation).
func (r *Registry) resolvePath(p string) string {
	var resolved string
	if filepath.IsAbs(p) {
		resolved = filepath.Clean(p)
	} else {
		resolved = filepath.Clean(filepath.Join(r.cwd, p))
	}

	// Skip path restriction when sandbox is active — Docker provides isolation
	if r.Sandbox != nil && r.Sandbox.Active {
		return resolved
	}

	cwdClean := filepath.Clean(r.cwd)
	if resolved == cwdClean || strings.HasPrefix(resolved, cwdClean+string(os.PathSeparator)) {
		return resolved
	}

	// Path escapes workspace — reject by clamping to basename within cwd
	return filepath.Join(r.cwd, filepath.Base(p))
}

// resolvePathChecked is like resolvePath but returns an explicit error when
// the path escapes the workspace instead of silently clamping to a different
// file. Write-capable tools must use this so the model never believes it
// edited a file it didn't.
func (r *Registry) resolvePathChecked(p string) (string, error) {
	var resolved string
	if filepath.IsAbs(p) {
		resolved = filepath.Clean(p)
	} else {
		resolved = filepath.Clean(filepath.Join(r.cwd, p))
	}

	// Skip path restriction when sandbox is active — container provides isolation
	if r.Sandbox != nil && r.Sandbox.Active {
		return resolved, nil
	}

	cwdClean := filepath.Clean(r.cwd)
	if resolved == cwdClean || strings.HasPrefix(resolved, cwdClean+string(os.PathSeparator)) {
		return resolved, nil
	}
	return "", fmt.Errorf("path %q is outside the workspace root %q — use a path inside the workspace", p, r.cwd)
}

// resolveReadablePath permits normal workspace reads plus SideX-managed project
// assets/uploads, where user-attached files are copied before being shown to
// the agent. Write tools must continue to use resolvePathChecked.
func (r *Registry) resolveReadablePath(p string) (string, error) {
	resolved, err := r.resolvePathChecked(p)
	if err == nil {
		return resolved, nil
	}
	if p == "" || !filepath.IsAbs(p) || r.cwd == "" {
		return "", err
	}

	clean := filepath.Clean(p)
	for _, root := range []string{
		paths.ProjectAssetsDir(r.cwd),
		paths.ProjectUploadsDir(r.cwd),
	} {
		if isWithinRoot(clean, root) {
			return clean, nil
		}
	}
	return "", err
}

func isWithinRoot(path, root string) bool {
	root = filepath.Clean(root)
	return path == root || strings.HasPrefix(path, root+string(os.PathSeparator))
}

// isTestFile returns true if the path looks like a test file.
func isTestFile(path string) bool {
	base := filepath.Base(path)
	dir := filepath.Dir(path)
	return strings.Contains(dir, "/tests/") ||
		strings.Contains(dir, "/test/") ||
		strings.HasPrefix(base, "test_") ||
		strings.HasSuffix(base, "_test.go") ||
		strings.HasSuffix(base, "_test.py") ||
		strings.HasSuffix(base, ".test.ts") ||
		strings.HasSuffix(base, ".test.js") ||
		strings.HasSuffix(base, ".spec.ts") ||
		strings.HasSuffix(base, ".spec.js")
}

// testFileGuard implements the shared soft guard for write tools: warn (don't
// block) when a test file is modified before any source change, and track the
// source-edit state. Returns a warning string to append to successful output
// (empty when not applicable). One implementation — edit_file, write_file,
// and multi_edit must never drift on this policy.
func (r *Registry) testFileGuard(path, verb string) string {
	if isTestFile(path) && !r.hasEditedSourceFile {
		r.testOnlyEditCount++
		return "\n<system-reminder>You are " + verb + " a test file before any source change. If the task is to FIX failing tests, never weaken tests to make them pass — fix the source implementation instead. If the task is to write/extend tests, this is fine.</system-reminder>"
	}
	if !isTestFile(path) {
		r.hasEditedSourceFile = true
	}
	return ""
}

// isBinaryContent reports whether data looks like a binary (non-text) file.
// Shared by the read tool and any other text-vs-binary decisions in this
// package; the index service keeps an equivalent check (import cycle).
func isBinaryContent(data []byte) bool {
	n := len(data)
	if n == 0 {
		return false
	}
	if n > 8000 {
		n = 8000
	}
	for _, b := range data[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}
