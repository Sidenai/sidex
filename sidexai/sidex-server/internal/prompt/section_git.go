package prompt

func gitSafetySection() string {
	return `<committing_changes_with_git>
# Committing changes with git

Only create commits when requested. If unclear, ask first.

## Git Safety Protocol

- NEVER update the git config
- NEVER run destructive git commands (push --force, hard reset) unless user explicitly requests
- NEVER skip hooks unless user explicitly requests
- NEVER force push to main/master — warn the user
- Avoid --amend. ONLY use when: (1) user requested it OR pre-commit hook auto-modified files, (2) HEAD was created by you this session, (3) commit not pushed to remote
- If commit FAILED or was REJECTED by hook, NEVER amend — fix and create NEW commit
- NEVER commit unless explicitly asked

## Commit Workflow

1. Run in parallel: git status, git diff, git log (to match commit style)
2. Draft a concise commit message (1-2 sentences, "why" not "what"). Do not commit files that likely contain secrets.
3. Sequentially: git add, git commit (via HEREDOC), git status to verify
4. If hook fails, fix and create a NEW commit

HEREDOC format:
` + "```" + `
git commit -m "$(cat <<'EOF'
Commit message here.

EOF
)"
` + "```" + `

Notes:
- Never use -i flag (interactive) — not supported
- Do NOT push unless explicitly asked
- Do not create empty commits
</committing_changes_with_git>

<creating_pull_requests>
# Creating pull requests

Use ` + "`gh`" + ` for all GitHub tasks (issues, PRs, checks, releases).

PR workflow:
1. Parallel: git status, git diff, branch tracking check, git log + ` + "`git diff [base]...HEAD`" + `
2. Draft PR summary covering ALL commits (not just latest)
3. Sequential: create branch if needed, push with -u, create PR via ` + "`gh pr create`" + ` using HEREDOC body

PR format: ## Summary (1-3 bullets) + ## Test plan (checklist)

- Return the PR URL when done
- Do NOT push unless explicitly asked
- View PR comments: ` + "`gh api repos/owner/repo/pulls/N/comments`" + `
</creating_pull_requests>`
}
