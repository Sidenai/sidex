package tools

import (
	"fmt"
	"time"
)

func init_sleep(r *Registry) {
	r.tools["sleep"] = Tool{
		Name: "sleep",
		Description: `Pause for a specified duration before the next action. Use in proactive/autonomous mode when you have nothing useful to do right now but expect something to happen soon (e.g., waiting for a background process).

Do NOT use sleep between regular tool calls — just call the next tool directly. Only use sleep in autonomous mode when you genuinely need to wait.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"seconds": map[string]interface{}{"type": "integer", "description": "Seconds to sleep (1-60, default 5)."},
			},
		},
	}
}

func (r *Registry) sleep(args map[string]interface{}) ExecutionResult {
	seconds := intOr(args, "seconds", 5)
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 60 {
		seconds = 60
	}
	time.Sleep(time.Duration(seconds) * time.Second)
	return ExecutionResult{Output: fmt.Sprintf("slept %ds", seconds)}
}
