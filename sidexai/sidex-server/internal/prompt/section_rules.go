package prompt

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/paths"
)

// LoadRulesPrompt reads all custom workspace rules from project-local (.sidex/rules/)
// and user-global (~/.sidex/rules/) directories, plus the root-level .sidexrules file,
// and compiles them into a unified section inside the system prompt.
func LoadRulesPrompt(workspacePath string) string {
	var rules []string

	// 1. Check for legacy .sidexrules file in the root
	rootRules := filepath.Join(workspacePath, ".sidexrules")
	if data, err := os.ReadFile(rootRules); err == nil {
		content := strings.TrimSpace(string(data))
		if content != "" {
			rules = append(rules, fmt.Sprintf("### Root .sidexrules Configuration\n\n%s", content))
		}
	}

	// Helper to load md/mdc rules from a directory
	loadFromDir := func(dir string) {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() && (strings.HasSuffix(e.Name(), ".md") || strings.HasSuffix(e.Name(), ".mdc")) {
				filePath := filepath.Join(dir, e.Name())
				if data, err := os.ReadFile(filePath); err == nil {
					content := strings.TrimSpace(string(data))
					if content != "" {
						ruleName := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
						rules = append(rules, fmt.Sprintf("### Rule: %s\n\n%s", ruleName, content))
					}
				}
			}
		}
	}

	// 2. Load user-global rules (~/.sidex/rules/)
	loadFromDir(paths.GlobalRulesDir())

	// 3. Load project-local rules (<project>/.sidex/rules/)
	loadFromDir(paths.InRepoRulesDir(workspacePath))

	if len(rules) == 0 {
		return ""
	}

	return fmt.Sprintf("<custom_workspace_rules>\n# Custom Workspace Rules\n\nThe following custom rules and guidelines are configured for this workspace. You MUST follow them strictly:\n\n%s\n</custom_workspace_rules>", strings.Join(rules, "\n\n"))
}
