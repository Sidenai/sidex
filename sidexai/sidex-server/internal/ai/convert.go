package ai

import (
	"github.com/sidex-ai/sidex-server/internal/compress"
)

// ToCompressMessages converts ai.Message slice to compress.Message slice.
func ToCompressMessages(msgs []Message) []compress.Message {
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

// FromCompressMessages converts compress.Message slice back to ai.Message slice.
func FromCompressMessages(msgs []compress.Message) []Message {
	out := make([]Message, len(msgs))
	for i, m := range msgs {
		tcs := make([]ToolCall, len(m.ToolCalls))
		for j, tc := range m.ToolCalls {
			tcs[j] = ToolCall{
				ID:   tc.ID,
				Type: tc.Type,
				Function: ToolCallFunc{
					Name:      tc.Function.Name,
					Arguments: tc.Function.Arguments,
				},
			}
		}
		out[i] = Message{
			Role:       Role(m.Role),
			Content:    m.Content,
			ToolCalls:  tcs,
			ToolCallID: m.ToolCallID,
			Name:       m.Name,
		}
	}
	return out
}

// CompressPipeline runs the 5-layer compression pipeline, handling
// conversion between ai.Message and compress.Message.
func CompressPipeline(msgs []Message, maxTokens int) []Message {
	return FromCompressMessages(compress.RunPipeline(ToCompressMessages(msgs), maxTokens))
}
