package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
)

// HookEvent identifies a point in the agent lifecycle where hooks fire.
type HookEvent string

const (
	HookBeforeTurn    HookEvent = "before_turn"
	HookAfterTurn     HookEvent = "after_turn"
	HookBeforeToolUse HookEvent = "before_tool_use"
	HookAfterToolUse  HookEvent = "after_tool_use"
	HookBeforeEdit    HookEvent = "before_edit"
	HookAfterEdit     HookEvent = "after_edit"
	HookOnError       HookEvent = "on_error"
	HookOnComplete    HookEvent = "on_complete"
	HookOnReflexion   HookEvent = "on_reflexion"
	HookBeforeShell   HookEvent = "before_shell"
	HookAfterShell    HookEvent = "after_shell"
)

// HookContext provides data to hook handlers about the current event.
type HookContext struct {
	Event      HookEvent
	TurnNumber int
	ToolName   string
	ToolArgs   map[string]any
	ToolOutput string
	FilePath   string
	Command    string
	Error      error
	Messages   []ai.Message
	Metadata   map[string]any
}

// HookResult controls agent behavior after hook execution.
type HookResult struct {
	Allow    bool   // for gating hooks — false blocks the action
	Modified string // modified tool args or output
	Inject   string // inject a message into the conversation
	Skip     bool   // skip this tool call entirely
}

// DefaultHookResult returns an allow-all result.
func DefaultHookResult() *HookResult {
	return &HookResult{Allow: true}
}

// HookHandler is a function that processes a hook event and optionally
// modifies agent behavior via the returned HookResult.
type HookHandler func(ctx *HookContext) *HookResult

// RegisteredHook pairs a handler with metadata for ordering and management.
type RegisteredHook struct {
	ID       string
	Name     string
	Handler  HookHandler
	Priority int // higher priority runs first
}

// HookRegistry manages registered hooks across all events.
type HookRegistry struct {
	handlers map[HookEvent][]RegisteredHook
	mu       sync.RWMutex
	nextID   atomic.Int64
}

// NewHookRegistry creates an empty hook registry.
func NewHookRegistry() *HookRegistry {
	return &HookRegistry{
		handlers: make(map[HookEvent][]RegisteredHook),
	}
}

// Register adds a hook handler for the given event. If a hook with the same
// name is already registered for that event it is replaced (this lets a
// workspace hooks.json override a built-in default instead of double-firing).
// Returns a unique hook ID that can be used to unregister the hook later.
func (r *HookRegistry) Register(event HookEvent, name string, handler HookHandler, priority int) string {
	id := fmt.Sprintf("hook_%d", r.nextID.Add(1))
	hook := RegisteredHook{
		ID:       id,
		Name:     name,
		Handler:  handler,
		Priority: priority,
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	existing := r.handlers[event]
	filtered := existing[:0]
	for _, h := range existing {
		if h.Name != name {
			filtered = append(filtered, h)
		}
	}
	r.handlers[event] = append(filtered, hook)
	sort.Slice(r.handlers[event], func(i, j int) bool {
		return r.handlers[event][i].Priority > r.handlers[event][j].Priority
	})

	return id
}

// Unregister removes a hook by its ID from all events.
func (r *HookRegistry) Unregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for event, hooks := range r.handlers {
		filtered := hooks[:0]
		for _, h := range hooks {
			if h.ID != id {
				filtered = append(filtered, h)
			}
		}
		r.handlers[event] = filtered
	}
}

// Fire executes all registered handlers for the given event in priority order.
// Results are merged: any handler returning Allow=false causes the final result
// to block; Modified/Inject values are taken from the last handler that set them.
func (r *HookRegistry) Fire(ctx *HookContext) *HookResult {
	r.mu.RLock()
	hooks := make([]RegisteredHook, len(r.handlers[ctx.Event]))
	copy(hooks, r.handlers[ctx.Event])
	r.mu.RUnlock()

	if len(hooks) == 0 {
		return DefaultHookResult()
	}

	merged := DefaultHookResult()
	for _, hook := range hooks {
		result := hook.Handler(ctx)
		if result == nil {
			continue
		}
		if !result.Allow {
			merged.Allow = false
		}
		if result.Skip {
			merged.Skip = true
		}
		if result.Modified != "" {
			merged.Modified = result.Modified
		}
		if result.Inject != "" {
			merged.Inject = result.Inject
		}
	}
	return merged
}

// HasHandlers returns true if any hooks are registered for the given event.
func (r *HookRegistry) HasHandlers(event HookEvent) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.handlers[event]) > 0
}

// hookConfigFile represents the JSON structure of .sidex/hooks.json
type hookConfigFile struct {
	Hooks []hookConfigEntry `json:"hooks"`
}

type hookConfigEntry struct {
	Name     string         `json:"name"`
	Events   []string       `json:"events"`
	Command  string         `json:"command,omitempty"`
	Builtin  string         `json:"builtin,omitempty"`
	Priority int            `json:"priority"`
	Config   map[string]any `json:"config,omitempty"`
}

// LoadFromConfig reads hook definitions from a JSON file (typically .sidex/hooks.json)
// and registers built-in hooks referenced by name. Custom command hooks are registered
// as shell-exec hooks that run the specified command with the HookContext as JSON stdin.
func (r *HookRegistry) LoadFromConfig(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("reading hooks config: %w", err)
	}

	var cfg hookConfigFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("parsing hooks config %s: %w", path, err)
	}

	for _, entry := range cfg.Hooks {
		for _, evStr := range entry.Events {
			event := HookEvent(evStr)
			if entry.Builtin != "" {
				handler := resolveBuiltinHook(entry.Builtin, entry.Config)
				if handler != nil {
					r.Register(event, entry.Name, handler, entry.Priority)
				}
			} else if entry.Command != "" {
				r.Register(event, entry.Name, makeCommandHook(entry.Command), entry.Priority)
			}
		}
	}
	return nil
}

// resolveBuiltinHook maps a builtin name to a HookHandler. Returns nil
// if the name is not recognized.
func resolveBuiltinHook(name string, config map[string]any) HookHandler {
	switch name {
	case "security_gate":
		return SecurityGateHook
	case "auto_format":
		formatter, _ := config["formatter"].(string)
		return MakeAutoFormatHook(formatter)
	case "cost_alert":
		threshold := 1.0
		if v, ok := config["threshold"].(float64); ok {
			threshold = v
		}
		return MakeCostAlertHook(threshold)
	case "loop_breaker":
		return LoopBreakerHook
	case "exploration_nudge":
		return ExplorationNudgeHook
	case "verify_after_edit":
		return VerifyAfterEditHook
	default:
		return nil
	}
}

// commandHookPayload is the JSON document piped to external command hooks
// on stdin. It is a slim, stable projection of HookContext (the full message
// history is intentionally omitted to keep payloads small and fast).
type commandHookPayload struct {
	Event      string         `json:"event"`
	TurnNumber int            `json:"turn_number"`
	ToolName   string         `json:"tool_name,omitempty"`
	ToolArgs   map[string]any `json:"tool_args,omitempty"`
	ToolOutput string         `json:"tool_output,omitempty"`
	FilePath   string         `json:"file_path,omitempty"`
	Command    string         `json:"command,omitempty"`
	Error      string         `json:"error,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// commandHookTimeout bounds how long an external hook command may run.
const commandHookTimeout = 30 * time.Second

// gatingEvents are the lifecycle points where a hook's verdict can actually
// block an action. For every other event a command hook's non-zero exit is
// informational only — synthesizing a "blocked" message there would mislead
// the model (nothing was blocked).
var gatingEvents = map[HookEvent]bool{
	HookBeforeToolUse: true,
	HookBeforeEdit:    true,
	HookBeforeShell:   true,
}

// makeCommandHook creates a handler that executes an external command,
// passing the HookContext as JSON on stdin. For gating events the command's
// exit code determines Allow (0 = allow, non-zero = block). A hook may also
// print a JSON object {"allow":bool,"modified":string,"inject":string,"skip":bool}
// to stdout to control agent behavior precisely.
func makeCommandHook(command string) HookHandler {
	return func(ctx *HookContext) *HookResult {
		payload := commandHookPayload{
			Event:      string(ctx.Event),
			TurnNumber: ctx.TurnNumber,
			ToolName:   ctx.ToolName,
			ToolArgs:   ctx.ToolArgs,
			ToolOutput: ctx.ToolOutput,
			FilePath:   ctx.FilePath,
			Command:    ctx.Command,
			Metadata:   ctx.Metadata,
		}
		if ctx.Error != nil {
			payload.Error = ctx.Error.Error()
		}
		data, err := json.Marshal(payload)
		if err != nil {
			return DefaultHookResult()
		}

		execCtx, cancel := context.WithTimeout(context.Background(), commandHookTimeout)
		defer cancel()

		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(execCtx, "cmd", "/c", command)
		} else {
			cmd = exec.CommandContext(execCtx, "/bin/sh", "-c", command)
		}
		cmd.Stdin = bytes.NewReader(data)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		if runErr := cmd.Run(); runErr != nil {
			// Non-gating events (before_turn, after_turn, ...): a failing or
			// missing hook command must never inject a fake "blocked" message.
			if !gatingEvents[ctx.Event] {
				log.Printf("hooks: command hook failed on %s (ignored): %v", ctx.Event, runErr)
				return DefaultHookResult()
			}
			// Gating events: non-zero exit (or timeout) blocks the action.
			// Surface the hook's output so the model knows why.
			reason := strings.TrimSpace(stderr.String())
			if reason == "" {
				reason = strings.TrimSpace(stdout.String())
			}
			msg := fmt.Sprintf("Hook command blocked this action (%v)", runErr)
			if reason != "" {
				msg = "Hook blocked this action: " + reason
			}
			return &HookResult{Allow: false, Inject: msg}
		}

		// Exit 0: allow by default, but honor a structured HookResult on stdout.
		out := strings.TrimSpace(stdout.String())
		if strings.HasPrefix(out, "{") {
			var parsed struct {
				Allow    *bool  `json:"allow"`
				Modified string `json:"modified"`
				Inject   string `json:"inject"`
				Skip     bool   `json:"skip"`
			}
			if json.Unmarshal([]byte(out), &parsed) == nil {
				res := DefaultHookResult()
				if parsed.Allow != nil {
					res.Allow = *parsed.Allow
				}
				res.Modified = parsed.Modified
				res.Inject = parsed.Inject
				res.Skip = parsed.Skip
				return res
			}
		}
		return DefaultHookResult()
	}
}
