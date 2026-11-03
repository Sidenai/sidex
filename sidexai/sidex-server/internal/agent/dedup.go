package agent

import "github.com/sidex-ai/sidex-server/internal/ai"

// DedupeIdempotentCalls collapses duplicate calls to idempotent read-only
// tools within a single turn. E.g. if the model fires 3x cwd with the same
// args, only one is kept.
func DedupeIdempotentCalls(calls []ai.ToolCall) []ai.ToolCall {
	if len(calls) <= 1 {
		return calls
	}
	seen := map[string]bool{}
	out := make([]ai.ToolCall, 0, len(calls))
	for _, c := range calls {
		if !IdempotentTools[c.Function.Name] {
			out = append(out, c)
			continue
		}
		key := c.Function.Name + "::" + NormalizeArgs(c.Function.Arguments)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, c)
	}
	return out
}
