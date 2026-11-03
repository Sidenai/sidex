package skills

// BundledSkills returns the set of built-in skills that ship with Sidex.
// These are always available regardless of project configuration.
func BundledSkills() []Skill {
	return []Skill{
		commitSkill(),
		reviewSkill(),
		simplifySkill(),
		explainSkill(),
	}
}

func commitSkill() Skill {
	return Skill{
		Name:          "commit",
		Description:   "Generate a git commit message from the current diff",
		UserInvocable: true,
		Body: `You are generating a git commit message. Follow these steps:

1. Run git diff --cached (staged changes). If empty, run git diff (unstaged changes).
2. Run git log --oneline -5 to understand the recent commit style.
3. Analyze the changes and write a commit message following these rules:
   - First line: imperative mood summary, max 72 characters (e.g. "Add skill loader for .sidex/skills/ directory")
   - Blank line after the summary
   - Optional body: explain *why* the change was made, not *what* (the diff shows what)
   - If there are multiple logical changes, consider suggesting they be split
4. Present the commit message to the user for approval before committing.
5. If the user approves, run git commit with that message.

Do NOT commit files that look like secrets (.env, credentials, tokens).`,
	}
}

func reviewSkill() Skill {
	return Skill{
		Name:          "review",
		Description:   "Review recent changes for bugs, issues, and improvements",
		UserInvocable: true,
		Body: `You are a code reviewer. Review the recent changes in this project.

1. Run git diff HEAD to see uncommitted changes. If empty, run git diff HEAD~1 for the last commit.
2. For each changed file, check for:
   - **Bugs**: logic errors, off-by-one, nil/null dereference, race conditions
   - **Security**: hardcoded secrets, SQL injection, path traversal, unsanitized input
   - **Performance**: unnecessary allocations, N+1 queries, missing indexes
   - **Style**: naming consistency, dead code, overly complex logic
3. Present findings grouped by severity (critical / warning / suggestion).
4. For each finding, show the relevant code and explain the issue.
5. End with a summary: "X critical, Y warnings, Z suggestions".

Be specific and actionable. Don't flag style nits unless they affect readability significantly.`,
	}
}

func simplifySkill() Skill {
	return Skill{
		Name:          "simplify",
		Description:   "Suggest simplifications for recent changes",
		UserInvocable: true,
		Body: `You are looking for ways to simplify the recent code changes.

1. Run git diff HEAD to see the current changes.
2. For each changed section, ask:
   - Can this be expressed more concisely without losing clarity?
   - Are there redundant variables, conditions, or abstractions?
   - Could a standard library function replace custom logic?
   - Is there duplicated code that could be extracted?
   - Are there unnecessary type conversions or wrapper layers?
3. For each suggestion, show the current code and the simplified version.
4. Only suggest changes that genuinely reduce complexity — don't trade clarity for brevity.

Present suggestions as a numbered list with before/after code snippets.`,
	}
}

func explainSkill() Skill {
	return Skill{
		Name:          "explain",
		Description:   "Explain the current file or selection in detail",
		UserInvocable: true,
		Body: `You are explaining code to the user. The user wants to understand what the current file or selection does.

1. If the user has a file open or selected text, explain that specific code.
2. If no specific context is given, ask the user which file or code they want explained.
3. Structure your explanation:
   - **Purpose**: What does this code do at a high level?
   - **How it works**: Walk through the logic step by step.
   - **Key decisions**: Why was it written this way? What are the trade-offs?
   - **Dependencies**: What does it depend on? What depends on it?
   - **Edge cases**: What inputs or conditions might cause unexpected behavior?
4. Use concrete examples where helpful.
5. Adjust detail level to the code complexity — don't over-explain trivial code.

Write clearly and concisely. Assume the reader is a competent developer who just hasn't seen this code before.`,
	}
}
