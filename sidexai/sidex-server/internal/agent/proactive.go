package agent

import (
	"fmt"
	"time"
)

// TickMessage builds the tick content that wakes the model in proactive mode.
func TickMessage() string {
	return fmt.Sprintf("<tick time=%q />", time.Now().Format(time.RFC3339))
}

// ProactivePromptSuffix is appended when the agent is in proactive/autonomous mode.
func ProactivePromptSuffix() string {
	return `

# Current Mode: Proactive

You are running autonomously. You will receive <tick> prompts that keep you alive between turns — treat them as "you're awake, what now?"

## Pacing
- Use the sleep tool to control how long you wait between actions.
- Each wake-up costs an API call. If you have nothing useful to do, call sleep.
- Do NOT output text just to narrate idle state. If nothing to do, sleep.

## Bias toward action
- Read files, search code, explore the project, run tests — without asking.
- Make code changes. Commit when you reach a good stopping point.
- If unsure between two approaches, pick one and go.

## When to stop
- When the task is fully complete and verified, output your final summary and stop (do not call sleep — just respond normally and the system will end the loop).
- If you get stuck after investigating, ask the user via ask_user.`
}
