package agent

import (
	"sync"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/compress"
	"github.com/sidex-ai/sidex-server/internal/session"
)

const maxToolOutputSize = 80000

// ExecuteTool runs a single tool call, handling loop detection, local vs
// server routing, output compression, and result streaming.
func ExecuteTool(conn Conn, sess *session.Session, tc ai.ToolCall, local LocalExecRouter) {
	conn.WriteJSON(ai.StreamChunk{Type: "tool_running", Content: tc.Function.Name, ToolCalls: []ai.ToolCall{tc}})

	if msg, looped := DetectLoop(sess.GetMessages(), tc); looped {
		conn.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: msg, ToolCalls: []ai.ToolCall{tc}})
		sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: msg, ToolCallID: tc.ID, Name: tc.Function.Name})
		return
	}

	output := runTool(sess, tc, local)

	conn.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
	sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
}

// ExecuteToolsConcurrent runs multiple read-only tool calls in parallel.
func ExecuteToolsConcurrent(conn Conn, sess *session.Session, toolCalls []ai.ToolCall, local LocalExecRouter) {
	type result struct {
		tc     ai.ToolCall
		output string
	}

	results := make([]result, len(toolCalls))
	var wg sync.WaitGroup

	for i, tc := range toolCalls {
		wg.Add(1)
		go func(idx int, tc ai.ToolCall) {
			defer wg.Done()
			conn.WriteJSON(ai.StreamChunk{Type: "tool_running", Content: tc.Function.Name, ToolCalls: []ai.ToolCall{tc}})

			if msg, looped := DetectLoop(sess.GetMessages(), tc); looped {
				results[idx] = result{tc: tc, output: msg}
				return
			}

			results[idx] = result{tc: tc, output: runTool(sess, tc, local)}
		}(i, tc)
	}

	wg.Wait()

	for _, r := range results {
		conn.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: r.output, ToolCalls: []ai.ToolCall{r.tc}})
		sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: r.output, ToolCallID: r.tc.ID, Name: r.tc.Function.Name})
	}
}

func runTool(sess *session.Session, tc ai.ToolCall, local LocalExecRouter) string {
	var output, errStr string
	if local != nil && local.ShouldRunLocal(tc.Function.Name) {
		output, errStr = local.RunViaClient(tc)
	} else {
		if LocalExecTools[tc.Function.Name] && (sess.Tools == nil || sess.Tools.Sandbox == nil || !sess.Tools.Sandbox.Active) {
			return "ERROR: tool " + tc.Function.Name + " must run in the Sidex desktop client or an active sandbox; refusing server-side workspace execution"
		}
		result := sess.Tools.Execute(tc.Function.Name, tc.Function.Arguments)
		output = result.Output
		errStr = result.Error
	}
	if errStr != "" {
		output = "ERROR: " + errStr
	}
	if output == "" {
		output = "(no output)"
	}
	if len(output) > maxToolOutputSize {
		output = compress.SummarizeToolOutput(output, maxToolOutputSize)
	}
	return output
}
