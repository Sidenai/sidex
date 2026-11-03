package tools

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func init_glob(r *Registry) {
	r.tools["glob"] = Tool{
		Name: "glob",
		Description: `Find files by name pattern within a directory tree. Supports both basename patterns ('*.ts' matches any .ts file at any depth) and full-path patterns with '**' (e.g. 'src/**/*.tsx'). Returns relative paths, capped at 500 results, and tells you when results were truncated. Noise directories (.git, node_modules, build outputs) are skipped automatically.

Does NOT search file contents — use grep for that. It is always better to speculatively run multiple globs/greps in parallel than one at a time.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"pattern": map[string]interface{}{"type": "string", "description": "Glob, e.g. '*.ts' or 'src/**/*.tsx'."},
				"path":    map[string]interface{}{"type": "string", "description": "Base directory (default cwd)."},
			},
			"required": []string{"pattern"},
		},
	}
}

// skipDirs are directories that are never useful in file discovery and make
// walks slow on large repos.
var skipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	".hg":          true,
	".svn":         true,
	"dist":         true,
	"build":        true,
	"out":          true,
	"target":       true,
	".next":        true,
	".venv":        true,
	"venv":         true,
	"__pycache__":  true,
	".cache":       true,
	"vendor":       true,
}

const globResultLimit = 500

func (r *Registry) globFiles(args map[string]interface{}) ExecutionResult {
	pattern := str(args, "pattern")
	dir := r.resolvePath(strOr(args, "path", "."))

	// Patterns containing '/' match against the full relative path (with **
	// support); plain patterns match against the basename.
	pathPattern := strings.Contains(pattern, "/")
	var pathRe *regexp.Regexp
	if pathPattern {
		var err error
		pathRe, err = globToRegexp(pattern)
		if err != nil {
			return ExecutionResult{Error: "invalid glob pattern: " + pattern}
		}
	}

	var matches []string
	truncated := false
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if skipDirs[info.Name()] && path != dir {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		var matched bool
		if pathPattern {
			matched = pathRe.MatchString(filepath.ToSlash(rel))
		} else {
			matched, _ = filepath.Match(pattern, filepath.Base(rel))
		}
		if matched {
			if len(matches) >= globResultLimit {
				truncated = true
				return filepath.SkipAll
			}
			matches = append(matches, rel)
		}
		return nil
	})

	if len(matches) == 0 {
		return ExecutionResult{Output: "no files matched"}
	}
	out := strings.Join(matches, "\n")
	if truncated {
		out += "\n… [results truncated at 500 — narrow the pattern or path]"
	}
	return ExecutionResult{Output: out}
}

// globToRegexp converts a glob with '*', '?', and '**' into an anchored regexp
// matched against slash-separated relative paths.
func globToRegexp(glob string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	i := 0
	for i < len(glob) {
		c := glob[i]
		switch c {
		case '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				// '**/' or trailing '**' crosses directory boundaries
				if i+2 < len(glob) && glob[i+2] == '/' {
					b.WriteString("(?:[^/]+/)*")
					i += 3
				} else {
					b.WriteString(".*")
					i += 2
				}
			} else {
				b.WriteString("[^/]*")
				i++
			}
		case '?':
			b.WriteString("[^/]")
			i++
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
			i++
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}
