package agent

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/session"
)

type ToolStatus int

const (
	ToolQueued ToolStatus = iota
	ToolRunning
	ToolCompleted
	ToolResultSent
)

type StreamingToolResult struct {
	ToolCallID string
	ToolName   string
	Output     string
	Error      string
	Duration   time.Duration
	Status     ToolStatus
}

// StreamingToolExecutor receives tool_call chunks as they stream from the
// model and immediately begins executing them. Read-only tools run in
// parallel; write/exclusive tools serialize after all pending reads drain.
type StreamingToolExecutor struct {
	local LocalExecRouter
	conn  Conn
	sess  *session.Session
	cfg   *Config

	mu      sync.Mutex
	results []StreamingToolResult

	// readWg tracks in-flight read-only goroutines so exclusive tools can
	// wait for them to drain before executing.
	readWg sync.WaitGroup

	// allWg tracks every in-flight tool goroutine so WaitAll can block
	// until everything is done.
	allWg sync.WaitGroup

	// exclusiveMu serializes write/exclusive tool execution.
	exclusiveMu sync.Mutex

	// permBroker routes permission responses to waiting goroutines.
	permBroker *PermissionBroker
}

func NewStreamingExecutor(conn Conn, sess *session.Session, local LocalExecRouter, cfg *Config) *StreamingToolExecutor {
	return &StreamingToolExecutor{
		conn:       conn,
		sess:       sess,
		local:      local,
		cfg:        cfg,
		permBroker: NewPermissionBroker(),
	}
}

// QueueTool is called as each complete tool_call block streams in from the
// model. It immediately classifies the tool and launches execution.
func (e *StreamingToolExecutor) QueueTool(tc ai.ToolCall) {
	e.mu.Lock()
	idx := len(e.results)
	e.results = append(e.results, StreamingToolResult{
		ToolCallID: tc.ID,
		ToolName:   tc.Function.Name,
		Status:     ToolQueued,
	})
	e.mu.Unlock()

	e.conn.WriteJSON(ai.StreamChunk{
		Type:      "tool_call",
		Content:   tc.Function.Name,
		ToolCalls: []ai.ToolCall{tc},
	})

	if ReadOnlyTools[tc.Function.Name] {
		e.allWg.Add(1)
		e.readWg.Add(1)
		go func() {
			defer e.allWg.Done()
			defer e.readWg.Done()
			result := e.executeTool(tc)
			e.mu.Lock()
			e.results[idx] = result
			e.mu.Unlock()
		}()
	} else {
		e.allWg.Add(1)
		go func() {
			defer e.allWg.Done()
			e.readWg.Wait()
			e.exclusiveMu.Lock()
			defer e.exclusiveMu.Unlock()

			result := e.checkPermissionAndExecute(tc)
			e.mu.Lock()
			e.results[idx] = result
			e.mu.Unlock()
		}()
	}
}

// WaitAll blocks until every queued tool has finished executing, then sends
// all results to the session and websocket connection in order.
func (e *StreamingToolExecutor) WaitAll() []StreamingToolResult {
	e.allWg.Wait()

	e.mu.Lock()
	results := make([]StreamingToolResult, len(e.results))
	copy(results, e.results)
	e.mu.Unlock()

	return results
}

// AddResultsToSession records all tool results in the session and streams
// them to the client. Called after WaitAll so the assistant message (with
// tool calls) is already in the session.
func (e *StreamingToolExecutor) AddResultsToSession(toolCalls []ai.ToolCall) {
	e.mu.Lock()
	results := make([]StreamingToolResult, len(e.results))
	copy(results, e.results)
	e.mu.Unlock()

	tcByID := make(map[string]ai.ToolCall, len(toolCalls))
	for _, tc := range toolCalls {
		tcByID[tc.ID] = tc
	}

	for _, r := range results {
		tc := tcByID[r.ToolCallID]
		output := r.Output
		if r.Error != "" {
			output = "ERROR: " + r.Error
		}
		if output == "" {
			output = "(no output)"
		}
		e.conn.WriteJSON(ai.StreamChunk{
			Type:      "tool_result",
			Content:   output,
			ToolCalls: []ai.ToolCall{tc},
		})
		e.sess.AddMessage(ai.Message{
			Role:       ai.RoleTool,
			Content:    output,
			ToolCallID: r.ToolCallID,
			Name:       r.ToolName,
		})
	}
}

func (e *StreamingToolExecutor) executeTool(tc ai.ToolCall) StreamingToolResult {
	start := time.Now()

	e.conn.WriteJSON(ai.StreamChunk{
		Type:      "tool_running",
		Content:   tc.Function.Name,
		ToolCalls: []ai.ToolCall{tc},
	})

	if msg, looped := DetectLoop(e.sess.GetMessages(), tc); looped {
		return StreamingToolResult{
			ToolCallID: tc.ID,
			ToolName:   tc.Function.Name,
			Output:     msg,
			Duration:   time.Since(start),
			Status:     ToolCompleted,
		}
	}

	// Fire before_tool_use hook
	if e.cfg != nil && e.cfg.Hooks != nil {
		args := parseToolArgs(tc.Function.Arguments)
		hookCtx := &HookContext{
			Event:    HookBeforeToolUse,
			ToolName: tc.Function.Name,
			ToolArgs: args,
			Messages: e.sess.GetMessages(),
			Metadata: map[string]any{},
		}

		// For shell-like tools, also fire before_shell
		if tc.Function.Name == "shell" || tc.Function.Name == "run_background" {
			hookCtx.Command, _ = args["command"].(string)
			shellResult := e.cfg.Hooks.Fire(&HookContext{
				Event:    HookBeforeShell,
				ToolName: tc.Function.Name,
				ToolArgs: args,
				Command:  hookCtx.Command,
				Messages: e.sess.GetMessages(),
				Metadata: map[string]any{},
			})
			if !shellResult.Allow {
				msg := "Hook blocked shell command"
				if shellResult.Inject != "" {
					msg = shellResult.Inject
				}
				return StreamingToolResult{
					ToolCallID: tc.ID,
					ToolName:   tc.Function.Name,
					Output:     msg,
					Duration:   time.Since(start),
					Status:     ToolCompleted,
				}
			}
		}

		// For edit tools, fire before_edit
		if tc.Function.Name == "edit_file" || tc.Function.Name == "write_file" || tc.Function.Name == "multi_edit" {
			hookCtx.FilePath, _ = args["path"].(string)
			editResult := e.cfg.Hooks.Fire(&HookContext{
				Event:    HookBeforeEdit,
				ToolName: tc.Function.Name,
				ToolArgs: args,
				FilePath: hookCtx.FilePath,
				Messages: e.sess.GetMessages(),
				Metadata: map[string]any{},
			})
			if !editResult.Allow {
				msg := "Hook blocked file edit"
				if editResult.Inject != "" {
					msg = editResult.Inject
				}
				return StreamingToolResult{
					ToolCallID: tc.ID,
					ToolName:   tc.Function.Name,
					Output:     msg,
					Duration:   time.Since(start),
					Status:     ToolCompleted,
				}
			}
		}

		result := e.cfg.Hooks.Fire(hookCtx)
		if !result.Allow || result.Skip {
			msg := "Hook blocked tool execution"
			if result.Inject != "" {
				msg = result.Inject
			}
			return StreamingToolResult{
				ToolCallID: tc.ID,
				ToolName:   tc.Function.Name,
				Output:     msg,
				Duration:   time.Since(start),
				Status:     ToolCompleted,
			}
		}
	}

	output := runTool(e.sess, tc, e.local)

	// Fire after_tool_use hook
	if e.cfg != nil && e.cfg.Hooks != nil {
		args := parseToolArgs(tc.Function.Arguments)
		hookCtx := &HookContext{
			Event:      HookAfterToolUse,
			ToolName:   tc.Function.Name,
			ToolArgs:   args,
			ToolOutput: output,
			Messages:   e.sess.GetMessages(),
			Metadata:   map[string]any{},
		}
		if tc.Function.Name == "edit_file" || tc.Function.Name == "write_file" || tc.Function.Name == "multi_edit" {
			hookCtx.FilePath, _ = args["path"].(string)
			e.cfg.Hooks.Fire(&HookContext{
				Event:      HookAfterEdit,
				ToolName:   tc.Function.Name,
				ToolArgs:   args,
				FilePath:   hookCtx.FilePath,
				ToolOutput: output,
				Messages:   e.sess.GetMessages(),
				Metadata:   map[string]any{},
			})
		}
		if tc.Function.Name == "shell" || tc.Function.Name == "run_background" {
			hookCtx.Command, _ = args["command"].(string)
			e.cfg.Hooks.Fire(&HookContext{
				Event:      HookAfterShell,
				ToolName:   tc.Function.Name,
				ToolArgs:   args,
				Command:    hookCtx.Command,
				ToolOutput: output,
				Messages:   e.sess.GetMessages(),
				Metadata:   map[string]any{},
			})
		}
		afterResult := e.cfg.Hooks.Fire(hookCtx)
		if afterResult.Modified != "" {
			output = afterResult.Modified
		}
	}

	return StreamingToolResult{
		ToolCallID: tc.ID,
		ToolName:   tc.Function.Name,
		Output:     output,
		Duration:   time.Since(start),
		Status:     ToolCompleted,
	}
}

// parseToolArgs parses JSON arguments into a map for hook consumption.
func parseToolArgs(argsJSON string) map[string]any {
	var args map[string]any
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return map[string]any{}
	}
	return args
}

// checkPermissionAndExecute runs the permission gate before executing a
// non-read-only tool. If AutoMode is configured, it uses the safety classifier
// to auto-approve or block. Otherwise falls back to the standard permission flow.
func (e *StreamingToolExecutor) checkPermissionAndExecute(tc ai.ToolCall) StreamingToolResult {
	start := time.Now()

	mode := PermissionDefault
	if e.cfg != nil {
		mode = e.cfg.PermMode
	}

	// Check session-level "always allow" overrides.
	if e.cfg != nil && e.cfg.SessionAllowed != nil && e.cfg.SessionAllowed[tc.Function.Name] {
		return e.executeTool(tc)
	}

	// AutoMode classifier: if enabled, use the three-layer safety classifier
	// instead of the simple permission check.
	if e.cfg != nil && e.cfg.AutoMode != nil && e.cfg.AutoMode.config.Enabled {
		args := parseToolArgs(tc.Function.Arguments)
		action := e.cfg.AutoMode.Classify(tc.Function.Name, args, e.sess.GetMessages())

		switch action.Decision {
		case DecisionAllow:
			e.conn.WriteJSON(ai.StreamChunk{
				Type:    "auto_approved",
				Content: tc.Function.Name + ": " + action.Reason,
			})
			result := e.executeTool(tc)
			if isFileEditTool(tc.Function.Name) {
				if path, ok := args["path"].(string); ok {
					e.cfg.AutoMode.RecordEdit(path)
				}
			}
			return result

		case DecisionBlock:
			e.conn.WriteJSON(ai.StreamChunk{
				Type:    "auto_blocked",
				Content: tc.Function.Name + ": " + action.Reason,
			})
			return StreamingToolResult{
				ToolCallID: tc.ID,
				ToolName:   tc.Function.Name,
				Error:      "Auto-mode blocked: " + action.Reason,
				Duration:   time.Since(start),
				Status:     ToolCompleted,
			}

		case DecisionAsk:
			req := PermissionRequest{
				Type:       "permission_request",
				ToolCallID: tc.ID,
				ToolName:   tc.Function.Name,
				Args:       args,
			}
			e.conn.WriteJSON(req)

			ch := e.permBroker.Register(tc.ID)
			resp, ok := e.permBroker.Wait(tc.ID, ch, 5*time.Minute)
			if !ok {
				return StreamingToolResult{
					ToolCallID: tc.ID,
					ToolName:   tc.Function.Name,
					Error:      "permission request timed out — tool execution skipped",
					Duration:   time.Since(start),
					Status:     ToolCompleted,
				}
			}

			if !resp.Approved {
				e.cfg.AutoMode.AddToBlockList(tc.Function.Name)
				return StreamingToolResult{
					ToolCallID: tc.ID,
					ToolName:   tc.Function.Name,
					Error:      "user denied permission for " + tc.Function.Name,
					Duration:   time.Since(start),
					Status:     ToolCompleted,
				}
			}

			e.cfg.AutoMode.AddToAllowList(tc.Function.Name)
			result := e.executeTool(tc)
			if isFileEditTool(tc.Function.Name) {
				if path, ok := args["path"].(string); ok {
					e.cfg.AutoMode.RecordEdit(path)
				}
			}
			return result
		}
	}

	// Standard permission flow (no auto-mode).
	decision := CheckPermission(tc.Function.Name, mode)

	switch decision {
	case PermAllow:
		return e.executeTool(tc)

	case PermDeny:
		return StreamingToolResult{
			ToolCallID: tc.ID,
			ToolName:   tc.Function.Name,
			Error:      "tool not allowed in current permission mode (" + PermissionModeString(mode) + ")",
			Duration:   time.Since(start),
			Status:     ToolCompleted,
		}

	case PermAsk:
		req := NewPermissionRequest(tc.ID, tc.Function.Name, tc.Function.Arguments)
		e.conn.WriteJSON(req)

		ch := e.permBroker.Register(tc.ID)
		resp, ok := e.permBroker.Wait(tc.ID, ch, 5*time.Minute)
		if !ok {
			return StreamingToolResult{
				ToolCallID: tc.ID,
				ToolName:   tc.Function.Name,
				Error:      "permission request timed out — tool execution skipped",
				Duration:   time.Since(start),
				Status:     ToolCompleted,
			}
		}

		if !resp.Approved {
			return StreamingToolResult{
				ToolCallID: tc.ID,
				ToolName:   tc.Function.Name,
				Error:      "user denied permission for " + tc.Function.Name,
				Duration:   time.Since(start),
				Status:     ToolCompleted,
			}
		}

		return e.executeTool(tc)
	}

	return e.executeTool(tc)
}

// ResolvePermission routes an incoming permission_response from the client
// to the goroutine waiting on it.
func (e *StreamingToolExecutor) ResolvePermission(resp PermissionResponse) {
	e.permBroker.Resolve(resp)
}

// CollectToolCalls returns all tool calls that were queued, reconstructed
// from stored results. Useful when the caller needs the full list.
func (e *StreamingToolExecutor) CollectToolCalls() []ai.ToolCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	calls := make([]ai.ToolCall, 0, len(e.results))
	for _, r := range e.results {
		calls = append(calls, ai.ToolCall{
			ID:   r.ToolCallID,
			Type: "function",
			Function: ai.ToolCallFunc{
				Name: r.ToolName,
			},
		})
	}
	return calls
}
