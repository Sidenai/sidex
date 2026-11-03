package agent

import (
	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/compress"
)

func toCompressMessages(msgs []ai.Message) []compress.Message {
	out := make([]compress.Message, len(msgs))
	for i, m := range msgs {
		tcs := make([]compress.ToolCall, len(m.ToolCalls))
		for j, tc := range m.ToolCalls {
			tcs[j] = compress.ToolCall{
				ID:   tc.ID,
				Type: tc.Type,
				Function: compress.ToolCallFunc{
					Name:      tc.Function.Name,
					Arguments: tc.Function.Arguments,
				},
			}
		}
		out[i] = compress.Message{
			Role:       string(m.Role),
			Content:    m.Content,
			ToolCalls:  tcs,
			ToolCallID: m.ToolCallID,
			Name:       m.Name,
		}
	}
	return out
}

func fromCompressMessages(msgs []compress.Message) []ai.Message {
	out := make([]ai.Message, len(msgs))
	for i, m := range msgs {
		tcs := make([]ai.ToolCall, len(m.ToolCalls))
		for j, tc := range m.ToolCalls {
			tcs[j] = ai.ToolCall{
				ID:   tc.ID,
				Type: tc.Type,
				Function: ai.ToolCallFunc{
					Name:      tc.Function.Name,
					Arguments: tc.Function.Arguments,
				},
			}
		}
		out[i] = ai.Message{
			Role:       ai.Role(m.Role),
			Content:    m.Content,
			ToolCalls:  tcs,
			ToolCallID: m.ToolCallID,
			Name:       m.Name,
		}
	}
	return out
}

func compressPipeline(msgs []ai.Message, maxTokens int) []ai.Message {
	return fromCompressMessages(compress.RunPipeline(toCompressMessages(msgs), maxTokens))
}
