package prompt

import (
	"fmt"
	"strings"
)

// OpenFileInfo represents a recently viewed or currently open file in the IDE.
type OpenFileInfo struct {
	Path       string
	TotalLines int
	IsFocused  bool
	CursorLine int // line where the cursor is positioned (0 if unknown)
}

func openFilesSection(in Input) string {
	if len(in.RecentFiles) == 0 && len(in.OpenFiles) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString("<open_and_recently_viewed_files>\n")

	if len(in.RecentFiles) > 0 {
		b.WriteString("Recently viewed files (recent at the top, oldest at the bottom):\n")
		for _, f := range in.RecentFiles {
			if f.TotalLines > 0 {
				fmt.Fprintf(&b, "- %s (total lines: %d)\n", f.Path, f.TotalLines)
			} else {
				fmt.Fprintf(&b, "- %s\n", f.Path)
			}
		}
		b.WriteString("\n")
	}

	if len(in.OpenFiles) > 0 {
		b.WriteString("Files that are currently open and visible in the user's IDE:\n")
		for _, f := range in.OpenFiles {
			parts := []string{f.Path}
			if f.IsFocused {
				if f.CursorLine > 0 {
					parts = append(parts, fmt.Sprintf("(currently focused file, cursor is on line %d", f.CursorLine))
				} else {
					parts = append(parts, "(currently focused file")
				}
				if f.TotalLines > 0 {
					parts[len(parts)-1] += fmt.Sprintf(", total lines: %d)", f.TotalLines)
				} else {
					parts[len(parts)-1] += ")"
				}
			} else if f.TotalLines > 0 {
				parts = append(parts, fmt.Sprintf("(total lines: %d)", f.TotalLines))
			}
			fmt.Fprintf(&b, "- %s\n", strings.Join(parts, " "))
		}
		b.WriteString("\n")
	}

	b.WriteString("Note: these files may or may not be relevant to the current conversation. If the user says \"current file\", \"this file\", or similar, use the currently focused file when one is listed; if none is listed, ask one direct clarifying question instead of guessing. Use the read file tool if you need to get file contents.\n")
	b.WriteString("</open_and_recently_viewed_files>")
	return b.String()
}
