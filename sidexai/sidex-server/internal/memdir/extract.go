package memdir

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/sidex-ai/sidex-server/internal/ai"
)

const extractionPrompt = `You are a memory extraction agent. Review the conversation and extract any durable facts worth remembering for future sessions.

Extract only:
- Project structure and tech stack decisions
- User preferences and coding conventions
- Key file paths and their purposes
- Build/test/lint commands
- Non-obvious constraints or gotchas

Output a JSON array of memories, each with "key" and "value" and "category" (one of: user, project, feedback, reference).

Example: [{"key":"tech_stack","value":"Go server + Rust client + Tauri desktop","category":"project"}]

If nothing worth remembering, output: []`

// ChatStreamer is the subset of *ai.Client needed for memory extraction.
type ChatStreamer interface {
	StreamChat([]ai.Message, []ai.ToolDef, string, func(ai.StreamChunk)) error
}

// ExtractMemories runs a lightweight AI call to extract memories from recent messages.
// This is called in the background after each conversation turn — do not block the user.
func ExtractMemories(projectDir string, recentMessages []ai.Message, aiClient ChatStreamer) {
	if len(recentMessages) < 4 {
		return
	}

	msgs := recentMessages
	if len(msgs) > 10 {
		msgs = msgs[len(msgs)-10:]
	}

	var convo string
	for _, m := range msgs {
		if m.Role == ai.RoleUser || m.Role == ai.RoleAssistant {
			text := m.Content
			if len(text) > 500 {
				text = text[:500] + "..."
			}
			convo += fmt.Sprintf("[%s]: %s\n", m.Role, text)
		}
	}

	extractMsgs := []ai.Message{
		{Role: ai.RoleUser, Content: "Recent conversation:\n\n" + convo + "\n\nExtract memories as JSON:"},
	}

	var response string
	err := aiClient.StreamChat(extractMsgs, nil, extractionPrompt, func(chunk ai.StreamChunk) {
		if chunk.Type == "text" {
			response += chunk.Content
		}
	})
	if err != nil {
		log.Printf("memory extraction failed: %v", err)
		return
	}

	var memories []struct {
		Key      string `json:"key"`
		Value    string `json:"value"`
		Category string `json:"category"`
	}
	if err := json.Unmarshal([]byte(response), &memories); err != nil {
		return
	}

	for _, m := range memories {
		if m.Key == "" || m.Value == "" {
			continue
		}
		if err := SaveMemory(projectDir, m.Key, m.Value, m.Category); err != nil {
			log.Printf("failed to save memory %q: %v", m.Key, err)
		}
	}
}
