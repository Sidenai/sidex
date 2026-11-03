package paths

import (
	"os"
	"path/filepath"
	"strings"
)

// ExpandUser expands a leading "~" or "~/" in a path to the user's home
// directory. Environment variables like SIDEX_DATA_DIR are often set with a
// literal tilde that the shell never expanded; Go treats that as a relative
// path and silently creates a "./~" directory, so we expand it here.
func ExpandUser(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p[1:], string(filepath.Separator)))
		}
	}
	return p
}

// SidexHome returns the root of sidex's user-level state directory.
// Defaults to ~/.sidex but can be overridden via SIDEX_HOME.
func SidexHome() string {
	if env := os.Getenv("SIDEX_HOME"); env != "" {
		return ExpandUser(env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), ".sidex")
	}
	return filepath.Join(home, ".sidex")
}

// GlobalConfig returns the path to the global config file (~/.sidex/config.json).
func GlobalConfig() string {
	return filepath.Join(SidexHome(), "config.json")
}

// GlobalMCP returns the path to the global MCP server definitions (~/.sidex/mcp.json).
func GlobalMCP() string {
	return filepath.Join(SidexHome(), "mcp.json")
}

// GlobalSkillsDir returns the path to user-global skills (~/.sidex/skills/).
func GlobalSkillsDir() string {
	return filepath.Join(SidexHome(), "skills")
}

// GlobalRulesDir returns the path to user-global rules (~/.sidex/rules/).
func GlobalRulesDir() string {
	return filepath.Join(SidexHome(), "rules")
}

// GlobalAgentsDir returns the path to user-global custom subagents (~/.sidex/agents/).
func GlobalAgentsDir() string {
	return filepath.Join(SidexHome(), "agents")
}

// PlansDir returns the path to agent plan files (~/.sidex/plans/).
func PlansDir() string {
	return filepath.Join(SidexHome(), "plans")
}

// StateDB returns the path to the global BoltDB state file (~/.sidex/state.db).
func StateDB() string {
	return filepath.Join(SidexHome(), "state.db")
}

// ProjectsDir returns the root projects directory (~/.sidex/projects/).
func ProjectsDir() string {
	return filepath.Join(SidexHome(), "projects")
}

// ProjectDir returns the per-project state directory for a given workspace path.
// The workspace path is converted to a slug: absolute path with "/" replaced by "-"
// and the leading separator removed. Example:
//
//	/Users/bob/code/myapp → Users-bob-code-myapp
func ProjectDir(workspacePath string) string {
	slug := WorkspaceSlug(workspacePath)
	return filepath.Join(ProjectsDir(), slug)
}

// WorkspaceSlug converts an absolute workspace path to a directory-safe slug.
func WorkspaceSlug(workspacePath string) string {
	abs, err := filepath.Abs(workspacePath)
	if err != nil {
		abs = workspacePath
	}
	abs = filepath.Clean(abs)
	slug := strings.TrimPrefix(abs, string(filepath.Separator))
	slug = strings.ReplaceAll(slug, string(filepath.Separator), "-")
	return slug
}

// ProjectMemoryDB returns the SQLite memory database path for a workspace.
func ProjectMemoryDB(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "memory.db")
}

// ProjectMemoryMD returns the human-readable memory markdown path for a workspace.
func ProjectMemoryMD(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "memory.md")
}

// ProjectTranscriptsDir returns the transcripts directory for a workspace.
func ProjectTranscriptsDir(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "transcripts")
}

// ProjectTerminalsDir returns the terminals directory for a workspace.
func ProjectTerminalsDir(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "terminals")
}

// ProjectAssetsDir returns the assets directory for a workspace.
func ProjectAssetsDir(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "assets")
}

// ProjectToolsDir returns the tool output cache directory for a workspace.
func ProjectToolsDir(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "tools")
}

// ProjectCanvasesDir returns the canvases directory for a workspace.
func ProjectCanvasesDir(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "canvases")
}

// ProjectUploadsDir returns the uploads directory for a workspace.
func ProjectUploadsDir(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "uploads")
}

// ProjectMCPDir returns the MCP tool descriptor cache directory for a workspace.
func ProjectMCPDir(workspacePath string) string {
	return filepath.Join(ProjectDir(workspacePath), "mcps")
}

// InRepoRulesDir returns the in-repo rules directory (<project>/.sidex/rules/).
// This is the ONLY state we write inside the user's git repo.
func InRepoRulesDir(workspacePath string) string {
	return filepath.Join(workspacePath, ".sidex", "rules")
}

// InRepoSkillsDir returns the in-repo skills directory (<project>/.sidex/skills/).
func InRepoSkillsDir(workspacePath string) string {
	return filepath.Join(workspacePath, ".sidex", "skills")
}

// EnsureProjectDirs creates all the per-project subdirectories if they don't exist.
func EnsureProjectDirs(workspacePath string) error {
	dirs := []string{
		ProjectDir(workspacePath),
		ProjectTranscriptsDir(workspacePath),
		ProjectTerminalsDir(workspacePath),
		ProjectAssetsDir(workspacePath),
		ProjectToolsDir(workspacePath),
		ProjectCanvasesDir(workspacePath),
		ProjectUploadsDir(workspacePath),
		ProjectMCPDir(workspacePath),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return err
		}
	}
	return nil
}

// EnsureGlobalDirs creates the top-level ~/.sidex structure.
func EnsureGlobalDirs() error {
	dirs := []string{
		SidexHome(),
		GlobalSkillsDir(),
		GlobalRulesDir(),
		GlobalAgentsDir(),
		PlansDir(),
		ProjectsDir(),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return err
		}
	}
	return nil
}
