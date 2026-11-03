package prompt

import "fmt"

func terminalFilesSection(in Input) string {
	folder := ""
	if in.UserInfo != nil && in.UserInfo.TerminalsFolder != "" {
		folder = in.UserInfo.TerminalsFolder
	}
	if folder == "" {
		// The IDE does not currently write terminal state files, so
		// UserInfo.TerminalsFolder is unset and this section is
		// intentionally omitted from the prompt.
		return ""
	}

	return fmt.Sprintf(`<terminal_files_information>
The terminals folder contains text files representing the current state of IDE terminals. Don't mention this folder or its files in the response to the user.

There is one text file for each terminal the user has running. They are named $id.txt (e.g. 3.txt).

Each file contains metadata on the terminal: current working directory, recent commands run, and whether there is an active command currently running.

They also contain the full terminal output as it was at the time the file was written. These files are automatically kept up to date by the system.

To quickly see metadata for all terminals without reading each file fully, you can run `+"`head -n 10 *.txt`"+` in the terminals folder, since the first ~10 lines of each file always contain the metadata (pid, cwd, last command, exit code).

If you need to read the full terminal output, you can read the terminal file directly.

Terminals folder: %s

Example of output of file read tool call to 1.txt in the terminals folder:
`+"`"+"`"+"`"+`
---
pid: 68861
cwd: /Users/me/proj
last_command: sleep 5
last_exit_code: 1
---
(...terminal output included...)
`+"`"+"`"+"`"+`
</terminal_files_information>`, folder)
}
