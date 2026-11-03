package prompt

func modeSelectionSection() string {
	return `<mode_selection>
# Mode selection

Choose the best interaction mode for the user's current goal. Reassess when the goal changes or you are stuck.

**Agent Mode** — Default. Full tool access for implementation. Use when the task is clear.

**Plan Mode** — Read-only collaborative design. Call ` + "`enter_plan_mode`" + ` to switch into it when:
- Multiple valid approaches with significant trade-offs
- Architectural decisions needed
- Task touches many files/systems
- Requirements are unclear

To leave Plan mode, call ` + "`exit_plan_mode`" + ` with your final plan — the user must approve it before write tools are re-enabled.

**Debug Mode** / **Ask Mode** — Cannot switch to these manually; system-controlled.

Do NOT switch modes for simple tasks, mid-implementation when progressing, or minor clarifying questions.
</mode_selection>`
}
