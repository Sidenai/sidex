package prompt

import (
	"fmt"
	"runtime"
	"strings"
)

// MinimalSystemPrompt returns a concise system prompt for capable models.
// Research shows that with Claude Sonnet 4+, less instruction = better performance.
// The model already knows how to code well — over-instructing constrains it.
func MinimalSystemPrompt(in Input) string {
	platform := in.Platform
	if platform == "" {
		platform = runtime.GOOS
	}

	var memory string
	if len(in.Memories) > 0 {
		var b strings.Builder
		b.WriteString("\nProject notes:\n")
		for _, m := range in.Memories {
			fmt.Fprintf(&b, "- %s: %s\n", m.Key, m.Value)
		}
		memory = b.String()
	}
	if in.MemdirPrompt != "" {
		memory += "\n" + strings.TrimSpace(in.MemdirPrompt) + "\n"
	}
	if in.RulesPrompt != "" {
		memory += "\n" + strings.TrimSpace(in.RulesPrompt) + "\n"
	}

	cwdLine := in.CWD
	if cwdLine == "" {
		cwdLine = "(no workspace open — ask user to open a folder before making file changes)"
	}

	return fmt.Sprintf(`You are Sidex, an AI coding agent in the Sidex IDE. You have filesystem tools to read, write, search, and run commands.

Working directory: %s
Platform: %s
Git repo: %v

Rules:
- Make minimal, targeted changes
- ALWAYS read before editing
- Verify with tests after editing
- If a fix fails, try a fundamentally different approach
- NEVER use placeholder comments in edits
- Do NOT narrate what you are about to do — just do it
- Keep explanations concise unless the user asks for detail
- NEVER force push, amend pushed commits, or commit without being asked
- If no workspace is open, tell the user to open a folder. Do NOT explore random directories.
%s`, cwdLine, platform, in.IsGit, memory)
}
