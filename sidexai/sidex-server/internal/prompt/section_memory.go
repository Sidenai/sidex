package prompt

import (
	"fmt"
	"strings"
)

func memorySection(mems []Memory) string {
	if len(mems) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("<project_memory>\n")
	b.WriteString("# Project memory\n\n")
	b.WriteString("Persistent notes about this workspace/project. These are saved preferences and project-specific context.\n\n")
	b.WriteString("IMPORTANT: Only save to memory things the user EXPLICITLY asks you to remember, or critical project configuration (e.g., 'this project uses pnpm', 'deploy to staging first'). NEVER save device details, conversation history, personal info, or transient facts to memory.\n\n")
	for _, m := range mems {
		fmt.Fprintf(&b, "- **%s**: %s\n", m.Key, m.Value)
	}
	b.WriteString("</project_memory>")
	return b.String()
}
