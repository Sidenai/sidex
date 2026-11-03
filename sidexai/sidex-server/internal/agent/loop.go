package agent

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/compress"
	"github.com/sidex-ai/sidex-server/internal/cost"
	"github.com/sidex-ai/sidex-server/internal/session"
	"github.com/sidex-ai/sidex-server/internal/usage"
)

// RunLoop is the core agent loop. It streams from the AI model and uses
// StreamingToolExecutor to begin executing tool calls AS they arrive —
// rather than waiting for the full model response. Read-only tools run in
// parallel; write tools serialize. After the model response completes, the
// loop waits for any remaining tools, records results, and iterates.
//
// When racing is enabled and trigger conditions are met, the loop dispatches
// the prompt to multiple models in parallel and picks the best response.
func RunLoop(conn Conn, sess *session.Session, aiClient *ai.Client, toolDefs []ai.ToolDef, sysPrompt string, local LocalExecRouter, cfg Config) {
	recovery := &RecoveryState{}
	reflexion := NewReflexionTracker()
	tracker := cost.NewTracker(aiClient.Model())

	maxCtx := cfg.MaxContextTokens
	if maxCtx <= 0 {
		maxCtx = compress.MaxContextTokens
	}

	maxTurns := cfg.MaxTurns
	if maxTurns <= 0 {
		maxTurns = 25
	}

	// Output budget escalation applied after truncated-output errors.
	escalatedMaxTokens := 0

	for turn := 0; ; turn++ {
		// Hard turn limit so a runaway agent can't loop forever on the
		// operator's API key.
		if turn >= maxTurns {
			conn.WriteJSON(ai.StreamChunk{
				Type:  "error",
				Error: fmt.Sprintf("Agent reached the maximum of %d turns. Send a follow-up message to continue.", maxTurns),
			})
			conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
			return
		}

		// Mid-session credit enforcement via CreditChecker callback.
		if cfg.CreditLimitUSD > 0 && cfg.CreditChecker != nil && turn > 0 {
			used, err := cfg.CreditChecker()
			if err == nil && used >= cfg.CreditLimitUSD {
				conn.WriteJSON(ai.StreamChunk{
					Type:  "error",
					Error: "Credit limit reached. Stopping agent.",
				})
				conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
				return
			}
		}

		messages := compressPipeline(sess.GetMessages(), maxCtx)

		// Inject active plan context into the system prompt (P0 core context).
		effectiveSysPrompt := sysPrompt
		if planCtx := sess.Tools.ActivePlanContext(); planCtx != "" {
			effectiveSysPrompt = sysPrompt + "\n\n" + planCtx
		}

		// Fire before_turn hook
		if cfg.Hooks != nil {
			hookCtx := &HookContext{
				Event:      HookBeforeTurn,
				TurnNumber: turn,
				Messages:   messages,
				Metadata:   map[string]any{"session_cost": tracker.TotalCost()},
			}
			result := cfg.Hooks.Fire(hookCtx)
			if result.Inject != "" {
				sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: result.Inject})
				messages = compressPipeline(sess.GetMessages(), maxCtx)
			}
		}

		trigger := RaceTrigger{
			ReflexionFailures: reflexion.Attempt(),
			UserRequestedHard: DetectThinkHarder(messages),
		}

		if cfg.Racing.Enabled && ShouldRace(cfg.Racing, trigger) {
			outcome, err := Race(
				context.Background(),
				aiClient,
				messages,
				effectiveSysPrompt,
				toolDefs,
				cfg.Racing,
				tracker,
			)
			if err != nil {
				log.Printf("race error, falling back to single model: %v", err)
			} else {
				conn.WriteJSON(NewRaceStatusEvent(outcome))

				winner := outcome.Winner
				if winner.Error != nil {
					errMsg := fmt.Sprintf("All racers failed: %s", winner.Error.Error())
					conn.WriteJSON(ai.StreamChunk{Type: "error", Error: errMsg})
					conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
					return
				}

				if winner.Content != "" {
					conn.WriteJSON(ai.StreamChunk{Type: "text", Content: winner.Content})
				}
				for _, tc := range winner.ToolCalls {
					conn.WriteJSON(ai.StreamChunk{Type: "tool_call", ToolCalls: []ai.ToolCall{tc}})
				}

				if len(winner.ToolCalls) == 0 {
					sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: winner.Content})
					conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
					return
				}

				assistantMsg := ai.Message{
					Role:      ai.RoleAssistant,
					Content:   winner.Content,
					ToolCalls: winner.ToolCalls,
				}
				sess.AddMessage(assistantMsg)

				executor := NewStreamingExecutor(conn, sess, local, &cfg)
				for _, tc := range winner.ToolCalls {
					executor.QueueTool(tc)
				}
				executor.WaitAll()
				executor.AddResultsToSession(winner.ToolCalls)

				conn.WriteJSON(ai.StreamChunk{Type: "turn_complete"})
				continue
			}
		}

		var fullText string
		var pendingToolCalls []ai.ToolCall
		// Dedupe duplicate idempotent calls BEFORE queueing/executing them.
		// Deduping after execution desynchronizes the assistant message's
		// tool_calls from the emitted tool results (orphaned tool_call_id →
		// API 400 on the next turn).
		seenIdempotent := map[string]bool{}

		executor := NewStreamingExecutor(conn, sess, local, &cfg)

		streamOpts := &ai.StreamOptions{
			SessionID:         cfg.SessionID,
			ThinkingBudget:    cfg.ThinkingBudget,
			Effort:            cfg.Effort,
			MaxTokensOverride: escalatedMaxTokens,
		}

		err := aiClient.StreamChatWithOptions(messages, toolDefs, effectiveSysPrompt, streamOpts, func(chunk ai.StreamChunk) {
			switch chunk.Type {
			case "text":
				fullText += chunk.Content
				conn.WriteJSON(chunk)
			case "thinking", "thinking_done":
				conn.WriteJSON(chunk)
			case "tool_call":
				for _, tc := range chunk.ToolCalls {
					if IdempotentTools[tc.Function.Name] {
						key := tc.Function.Name + "::" + NormalizeArgs(tc.Function.Arguments)
						if seenIdempotent[key] {
							continue
						}
						seenIdempotent[key] = true
					}
					pendingToolCalls = append(pendingToolCalls, tc)
					executor.QueueTool(tc)
				}
			case "usage":
				if chunk.TokensUsed != nil {
					turnCost := tracker.Add(
						aiClient.Model(),
						chunk.TokensUsed.PromptTokens,
						chunk.TokensUsed.CompletionTokens,
						chunk.TokensUsed.CacheCreationInputTokens,
						chunk.TokensUsed.CacheReadInputTokens,
					)
					if cfg.Analytics != nil {
						go cfg.Analytics.TrackAgentRequest(cfg.UserID, map[string]interface{}{
							"model":         aiClient.Model(),
							"session_id":    cfg.SessionID,
							"input_tokens":  chunk.TokensUsed.PromptTokens,
							"output_tokens": chunk.TokensUsed.CompletionTokens,
							"cost":          tracker.TotalCost(),
							"turn_count":    turn,
						})
					}
					if cfg.LocalUsage != nil {
						cfg.LocalUsage.RecordLocalTurn(
							cfg.UserID, cfg.SessionID, aiClient.Model(), "agent",
							chunk.TokensUsed.PromptTokens,
							chunk.TokensUsed.CompletionTokens,
							chunk.TokensUsed.CacheCreationInputTokens,
							chunk.TokensUsed.CacheReadInputTokens,
							turnCost,
						)
					}
					if cfg.UserID != "" {
						usage.RecordUsageRemote(usage.RemoteUsageEvent{
							UserID:          cfg.UserID,
							Model:           aiClient.Model(),
							RequestType:     "agent",
							TokensIn:        chunk.TokensUsed.PromptTokens,
							TokensOut:       chunk.TokensUsed.CompletionTokens,
							CreditsConsumed: turnCost,
							Source:          "agent",
						})
					}
				}
				conn.WriteJSON(chunk)
			case "done":
			}
		})

		if err != nil {
			// Fire on_error hook
			if cfg.Hooks != nil {
				cfg.Hooks.Fire(&HookContext{
					Event:      HookOnError,
					TurnNumber: turn,
					Error:      err,
					Messages:   sess.GetMessages(),
					Metadata:   map[string]any{"session_cost": tracker.TotalCost()},
				})
			}

			if cfg.Analytics != nil {
				go cfg.Analytics.TrackError(cfg.UserID, map[string]interface{}{
					"error_type":    "api_error",
					"error_message": err.Error(),
					"session_id":    cfg.SessionID,
					"model":         aiClient.Model(),
				})
			}

			action := RecoverFromError(err, recovery)
			switch action {
			case RecoveryRetry:
				log.Printf("recovery: retrying after transient error (attempt %d): %v", recovery.Retries, err)
				time.Sleep(time.Duration(recovery.Retries) * 2 * time.Second)
				continue
			case RecoveryCompact:
				log.Printf("recovery: compacting context after prompt-too-long error: %v", err)
				compacted, did := compress.AutoCompactIfNeeded(
					toCompressMessages(sess.GetMessages()),
					maxCtx,
					compress.EstimateTokens,
				)
				if did {
					sess.ReplaceMessages(fromCompressMessages(compacted))
				}
				continue
			case RecoveryFallbackModel:
				// DO NOT silently fall back to another model. If the user's selected
				// model fails, we should show them the error so they know what happened.
				log.Printf("recovery: model failure, aborting instead of fallback: %v", err)
			case RecoveryEscalateTokens:
				// RecoverFromError caps escalations via state.TokenEscalations.
				// Each escalation doubles the output budget (clamped to the
				// model ceiling in the client) so the retry actually differs.
				if escalatedMaxTokens == 0 {
					escalatedMaxTokens = 32768
				} else {
					escalatedMaxTokens *= 2
				}
				log.Printf("recovery: escalating max_tokens to %d (escalation %d): %v", escalatedMaxTokens, recovery.TokenEscalations, err)
				continue
			case RecoveryAbort, RecoveryNone:
				// fall through to abort
			}

			errMsg := ai.SanitizeErrorForDisplay(err)
			conn.WriteJSON(ai.StreamChunk{Type: "error", Error: errMsg})
			conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
			return
		}

		// Reset recovery state on success.
		recovery = &RecoveryState{}

		// Fire after_turn hook
		if cfg.Hooks != nil {
			hookCtx := &HookContext{
				Event:      HookAfterTurn,
				TurnNumber: turn,
				Messages:   sess.GetMessages(),
				Metadata:   map[string]any{"session_cost": tracker.TotalCost()},
			}
			result := cfg.Hooks.Fire(hookCtx)
			if result.Inject != "" {
				sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: result.Inject})
			}
		}

		if len(pendingToolCalls) == 0 {
			// No tools called this turn.
			if fullText == "" {
				// Model returned neither text nor tool calls — nudge it on the first turn.
				if turn == 0 {
					inject := "Use your tools to explore the codebase and make the required changes. Do not return an empty response."
					sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: inject})
					continue
				}
				conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
				return
			}

			// Model just returned text.
			sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: fullText})

			// Nudge on first turn if they gave a long text description without tools
			// but NOT if it's a short greeting.
			if turn == 0 && len(fullText) > 150 {
				inject := "You described the fix but didn't apply it. Use your tools now: read the relevant file(s), locate the exact lines, and apply the edit."
				sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: inject})
				continue
			}

			fireOnComplete(cfg.Hooks, turn, sess.GetMessages(), tracker.TotalCost())
			conn.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
			return
		}

		// pendingToolCalls was already deduped in the stream callback before
		// queueing, so the assistant message and the executor results stay in
		// lockstep (one tool result per recorded tool call).
		assistantMsg := ai.Message{
			Role:      ai.RoleAssistant,
			Content:   fullText,
			ToolCalls: pendingToolCalls,
		}
		sess.AddMessage(assistantMsg)

		// Tools are already running — wait for them to finish.
		toolResults := executor.WaitAll()

		// Record results in session and stream to client.
		executor.AddResultsToSession(pendingToolCalls)

		// Track tool executions via analytics (with real success/failure).
		if cfg.Analytics != nil {
			for _, r := range toolResults {
				res := r
				go cfg.Analytics.TrackToolExecution(cfg.UserID, map[string]interface{}{
					"tool_name":  res.ToolName,
					"session_id": cfg.SessionID,
					"success":    res.Error == "",
					"error":      res.Error,
				})
			}
		}

		conn.WriteJSON(ai.StreamChunk{Type: "turn_complete"})
		continue
	}
}

// fireOnComplete fires the on_complete hook if a registry is configured.
func fireOnComplete(hooks *HookRegistry, turn int, messages []ai.Message, cost float64) {
	if hooks == nil {
		return
	}
	hooks.Fire(&HookContext{
		Event:      HookOnComplete,
		TurnNumber: turn,
		Messages:   messages,
		Metadata:   map[string]any{"session_cost": cost},
	})
}
