package prompt

import (
	"fmt"
	"strings"
)

func ideContextSection(ctx *IDEContext) string {
	if ctx == nil {
		return ""
	}
	hasAny := ctx.ActiveFile != "" || ctx.Language != "" || ctx.Selection != "" ||
		len(ctx.WorkspaceFolders) > 0 || len(ctx.OpenFiles) > 0
	if !hasAny {
		return ""
	}

	var b strings.Builder
	b.WriteString("<ide_context>\n")
	b.WriteString("# IDE context\n\n")
	b.WriteString("The following context is attached from the IDE for the user's current session. It reflects the state at the moment of this message and may change between turns. Reference it directly — do NOT ask the user things the context already tells you.\n\n")

	if len(ctx.WorkspaceFolders) > 0 {
		fmt.Fprintf(&b, "- Workspace folders: %s\n", strings.Join(ctx.WorkspaceFolders, ", "))
	}
	if ctx.ActiveFile != "" {
		fmt.Fprintf(&b, "- Active file: %s\n", ctx.ActiveFile)
	}
	if ctx.Language != "" {
		fmt.Fprintf(&b, "- Language: %s\n", ctx.Language)
	}
	if len(ctx.OpenFiles) > 0 {
		files := ctx.OpenFiles
		if len(files) > 15 {
			files = files[:15]
		}
		fmt.Fprintf(&b, "- Open files (up to 15): %s\n", strings.Join(files, ", "))
	}
	if ctx.Selection != "" {
		sel := ctx.Selection
		if len(sel) > 2000 {
			sel = sel[:2000] + "\n...(truncated)"
		}
		rangeDesc := ""
		if ctx.SelectionRange != nil {
			rangeDesc = fmt.Sprintf(" (L%d:%d–L%d:%d)",
				ctx.SelectionRange.StartLine, ctx.SelectionRange.StartColumn,
				ctx.SelectionRange.EndLine, ctx.SelectionRange.EndColumn)
		}
		fmt.Fprintf(&b, "\nUser's current selection%s:\n```\n%s\n```\n", rangeDesc, sel)
	}

	b.WriteString("</ide_context>")
	return b.String()
}
