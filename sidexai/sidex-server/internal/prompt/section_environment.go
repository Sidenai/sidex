package prompt

import (
	"fmt"
	"runtime"
	"strings"
)

func environmentSection(in Input) string {
	// If client provided user_info (like Cursor's <user_info> block), use that directly.
	// Format matches Cursor's injected <user_info> exactly.
	if in.UserInfo != nil {
		gitLine := "No"
		if in.UserInfo.IsGitRepo {
			if in.UserInfo.GitRepoRoot != "" {
				gitLine = fmt.Sprintf("Yes, at %s", in.UserInfo.GitRepoRoot)
			} else if in.UserInfo.WorkspacePath != "" {
				gitLine = fmt.Sprintf("Yes, at %s", in.UserInfo.WorkspacePath)
			} else {
				gitLine = "Yes"
			}
		}

		lines := []string{
			"<user_info>",
			fmt.Sprintf("OS Version: %s", in.UserInfo.OS),
			fmt.Sprintf("Shell: %s", in.UserInfo.Shell),
			fmt.Sprintf("Workspace Path: %s", in.UserInfo.WorkspacePath),
			fmt.Sprintf("Is directory a git repo: %s", gitLine),
			fmt.Sprintf("Today's date: %s", in.UserInfo.Date),
		}
		if in.UserInfo.TerminalsFolder != "" {
			lines = append(lines, fmt.Sprintf("Terminals folder: %s", in.UserInfo.TerminalsFolder))
		}
		lines = append(lines, "</user_info>")

		lines = append(lines, "", "<environment>")

		if in.LocalExec {
			lines = append(lines,
				"You have ZERO access to the server. ALL tools execute on the USER'S MACHINE via the IDE client. The server only routes your requests — it cannot execute commands, read files, or access any filesystem.",
			)
		}

		if in.CWD == "" && in.UserInfo.WorkspacePath == "" {
			lines = append(lines, "",
				"CRITICAL: No workspace is currently open. If the user asks you to work on files, tell them to open a workspace first (File > Open Folder). Do NOT explore random directories. You CAN answer general questions and have conversations.")
		}

		lines = append(lines, "</environment>")
		return strings.Join(lines, "\n")
	}

	// Fallback: construct from server-side data when no client-provided UserInfo
	lines := []string{
		"<user_info>",
	}

	platform := in.Platform
	if platform == "" {
		platform = inferPlatform(in.CWD)
	}
	lines = append(lines, fmt.Sprintf("OS Version: %s", platform))
	if in.Shell != "" {
		lines = append(lines, fmt.Sprintf("Shell: %s", in.Shell))
	}
	if in.CWD != "" {
		lines = append(lines, fmt.Sprintf("Workspace Path: %s", in.CWD))
	}

	gitLine := "No"
	if in.IsGit {
		if in.CWD != "" {
			gitLine = fmt.Sprintf("Yes, at %s", in.CWD)
		} else {
			gitLine = "Yes"
		}
	}
	lines = append(lines, fmt.Sprintf("Is directory a git repo: %s", gitLine))
	lines = append(lines, "</user_info>")

	lines = append(lines, "", "<environment>")

	if in.LocalExec {
		lines = append(lines,
			"You have ZERO access to the server. ALL tools execute on the USER'S MACHINE via the IDE client. The server only routes your requests — it cannot execute commands, read files, or access any filesystem.",
		)
	} else {
		lines = append(lines,
			"You are running inside the SideX IDE and talking to the user over a websocket.",
		)
	}

	if in.CWD == "" {
		lines = append(lines, "",
			"CRITICAL: No workspace is currently open. If the user asks you to work on files, tell them to open a workspace first (File > Open Folder). Do NOT explore random directories. You CAN answer general questions and have conversations.")
	}

	lines = append(lines, "</environment>")
	return strings.Join(lines, "\n")
}

// inferPlatform guesses the user's OS from a workspace path when the client
// did not send one. Covers macOS, Linux, and Windows — not just /Users/.
func inferPlatform(cwd string) string {
	if cwd == "" {
		return runtime.GOOS
	}
	if strings.HasPrefix(cwd, "/Users/") {
		return "darwin"
	}
	if strings.HasPrefix(cwd, "/home/") {
		return "linux"
	}
	if len(cwd) >= 3 && ((cwd[0] >= 'A' && cwd[0] <= 'Z') || (cwd[0] >= 'a' && cwd[0] <= 'z')) && cwd[1] == ':' {
		return "windows"
	}
	return runtime.GOOS
}
