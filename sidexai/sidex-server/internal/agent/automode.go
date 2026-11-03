package agent

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/sidex-ai/sidex-server/internal/ai"
)

// AutoMode automatically approves or blocks tool calls based on safety classification.
// It eliminates the need for manual approval on 90%+ of operations by using a
// three-layer classifier: fast heuristics, context-aware rules, and (optionally)
// a model-based fallback for ambiguous cases.
type AutoMode struct {
	config  AutoModeConfig
	mu      sync.RWMutex
	history []ClassifiedAction
	// Session-accumulated allow/block overrides from user decisions.
	allowList map[string]bool
	blockList map[string]bool
	// Tracks files edited in this session for context-aware decisions.
	editedFiles map[string]int
}

// AutoModeConfig controls how aggressive the auto-classifier is.
type AutoModeConfig struct {
	Enabled         bool          `json:"enabled"`
	Level           AutoModeLevel `json:"level"`
	MaxFileEdits    int           `json:"max_file_edits"`
	AllowShell      []string      `json:"allow_shell"`
	BlockShell      []string      `json:"block_shell"`
	RequireApproval []string      `json:"require_approval"`
}

// AutoModeLevel determines the risk tolerance of the classifier.
type AutoModeLevel string

const (
	AutoModeConservative AutoModeLevel = "conservative" // only auto-approve reads
	AutoModeBalanced     AutoModeLevel = "balanced"     // auto-approve safe writes
	AutoModeAggressive   AutoModeLevel = "aggressive"   // auto-approve almost everything
)

// ClassifiedAction records a classification decision for audit and context.
type ClassifiedAction struct {
	ToolName   string         `json:"tool_name"`
	Args       map[string]any `json:"args"`
	Decision   Decision       `json:"decision"`
	Reason     string         `json:"reason"`
	Confidence float64        `json:"confidence"`
	Layer      int            `json:"layer"` // which layer made the decision (1, 2, or 3)
}

// Decision is the outcome of the safety classifier.
type Decision string

const (
	DecisionAllow Decision = "allow"
	DecisionBlock Decision = "block"
	DecisionAsk   Decision = "ask"
)

// NewAutoMode creates an AutoMode with the given configuration.
func NewAutoMode(cfg AutoModeConfig) *AutoMode {
	if cfg.MaxFileEdits <= 0 {
		cfg.MaxFileEdits = 10
	}
	return &AutoMode{
		config:      cfg,
		allowList:   make(map[string]bool),
		blockList:   make(map[string]bool),
		editedFiles: make(map[string]int),
	}
}

// DefaultAutoModeConfig returns a balanced configuration suitable for most sessions.
func DefaultAutoModeConfig() AutoModeConfig {
	return AutoModeConfig{
		Enabled:      false,
		Level:        AutoModeBalanced,
		MaxFileEdits: 10,
	}
}

// Classify determines if a tool call should be allowed, blocked, or escalated
// to the user. It uses a three-layer approach:
//
//	Layer 1: Fast heuristic (regex/pattern matching on tool name and args)
//	Layer 2: Context-aware rules (session history, edit counts, reflexion state)
//	Layer 3: Escalation (ambiguous cases go to user)
func (a *AutoMode) Classify(toolName string, args map[string]any, messages []ai.Message) *ClassifiedAction {
	action := &ClassifiedAction{
		ToolName:   toolName,
		Args:       args,
		Confidence: 1.0,
	}

	// Check permanent block/allow lists first (user overrides).
	a.mu.RLock()
	pattern := toolCallPattern(toolName, args)
	if a.blockList[pattern] || a.blockList[toolName] {
		a.mu.RUnlock()
		action.Decision = DecisionBlock
		action.Reason = "permanently blocked by user"
		action.Layer = 0
		a.recordAction(action)
		return action
	}
	if a.allowList[pattern] || a.allowList[toolName] {
		a.mu.RUnlock()
		action.Decision = DecisionAllow
		action.Reason = "permanently allowed by user"
		action.Layer = 0
		a.recordAction(action)
		return action
	}
	a.mu.RUnlock()

	// Layer 1: Fast heuristic classification.
	if decision, reason := a.classifyLayer1(toolName, args); decision != "" {
		action.Decision = decision
		action.Reason = reason
		action.Layer = 1
		a.recordAction(action)
		return action
	}

	// Layer 2: Context-aware rules.
	if decision, reason, confidence := a.classifyLayer2(toolName, args, messages); decision != "" {
		action.Decision = decision
		action.Reason = reason
		action.Confidence = confidence
		action.Layer = 2
		a.recordAction(action)
		return action
	}

	// Layer 3: Ambiguous — escalate to user.
	action.Decision = DecisionAsk
	action.Reason = "ambiguous case — requesting user approval"
	action.Confidence = 0.5
	action.Layer = 3
	a.recordAction(action)
	return action
}

// classifyLayer1 uses fast pattern matching on tool name and arguments.
func (a *AutoMode) classifyLayer1(toolName string, args map[string]any) (Decision, string) {
	// Read-only tools are always safe.
	if readOnlyToolSet[toolName] {
		return DecisionAllow, "read-only tool"
	}

	// Safe meta tools that don't affect the filesystem.
	if safeMetaToolSet[toolName] {
		return DecisionAllow, "safe meta tool"
	}

	// Shell commands need special handling.
	if toolName == "shell" || toolName == "run_background" {
		cmd, _ := args["command"].(string)
		if cmd == "" {
			return DecisionAsk, "shell with empty command"
		}
		return a.classifyShellCommand(cmd)
	}

	// File edit tools — behavior depends on level.
	if isFileEditTool(toolName) {
		return a.classifyFileEdit(toolName, args)
	}

	// Git commit — level-dependent.
	if toolName == "git_commit" {
		if a.config.Level == AutoModeAggressive {
			return DecisionAllow, "git_commit allowed in aggressive mode"
		}
		return DecisionAsk, "git_commit requires approval"
	}

	// Explicitly required approval tools.
	for _, req := range a.config.RequireApproval {
		if toolName == req {
			return DecisionAsk, "tool in require_approval list"
		}
	}

	// Checkpoint/rollback.
	if toolName == "checkpoint" {
		return DecisionAllow, "checkpoint is safe"
	}
	if toolName == "rollback" {
		if a.config.Level >= AutoModeBalanced {
			return DecisionAllow, "rollback allowed (reverting to safe state)"
		}
		return DecisionAsk, "rollback requires approval in conservative mode"
	}

	return "", ""
}

// classifyShellCommand evaluates a shell command against safe/dangerous patterns.
func (a *AutoMode) classifyShellCommand(cmd string) (Decision, string) {
	lower := strings.ToLower(strings.TrimSpace(cmd))

	// Check user-configured block patterns first.
	for _, pat := range a.config.BlockShell {
		if matchesPattern(lower, pat) {
			return DecisionBlock, fmt.Sprintf("matches blocked shell pattern: %s", pat)
		}
	}

	// Check built-in dangerous patterns.
	for _, pat := range dangerousShellPatterns {
		if matchesPattern(lower, pat) {
			return DecisionBlock, fmt.Sprintf("matches dangerous pattern: %s", pat)
		}
	}

	// Check user-configured allow patterns.
	for _, pat := range a.config.AllowShell {
		if matchesPattern(lower, pat) {
			return DecisionAllow, fmt.Sprintf("matches allowed shell pattern: %s", pat)
		}
	}

	// Check built-in safe patterns.
	for _, pat := range safeShellPatterns {
		if matchesPattern(lower, pat) {
			return DecisionAllow, fmt.Sprintf("matches safe shell pattern: %s", pat)
		}
	}

	// Level-dependent: aggressive mode allows unknown shell commands.
	if a.config.Level == AutoModeAggressive {
		return DecisionAllow, "shell allowed in aggressive mode"
	}

	return DecisionAsk, "unrecognized shell command"
}

// classifyFileEdit determines whether a file edit should be auto-approved.
func (a *AutoMode) classifyFileEdit(toolName string, args map[string]any) (Decision, string) {
	if a.config.Level == AutoModeConservative {
		return DecisionAsk, "file edits require approval in conservative mode"
	}

	path, _ := args["path"].(string)

	// In balanced/aggressive mode, file edits within the workspace are allowed.
	if a.config.Level >= AutoModeBalanced {
		if path != "" && !isOutsideWorkspace(path) {
			return DecisionAllow, "file edit within workspace"
		}
		if path == "" {
			return DecisionAllow, "file edit (no path specified, assume workspace)"
		}
	}

	return DecisionAsk, "file edit outside workspace"
}

// classifyLayer2 applies context-aware rules based on session history.
func (a *AutoMode) classifyLayer2(toolName string, args map[string]any, messages []ai.Message) (Decision, string, float64) {
	path, _ := args["path"].(string)

	// If the agent has edited this file before in this session, allow.
	if path != "" && isFileEditTool(toolName) {
		a.mu.RLock()
		editCount := a.editedFiles[path]
		a.mu.RUnlock()
		if editCount > 0 {
			return DecisionAllow, "file previously edited in this session", 0.9
		}
	}

	// If in a reflexion retry (agent fixing its own mistake), be more permissive.
	if isInReflexionContext(messages) {
		if isFileEditTool(toolName) || toolName == "shell" {
			return DecisionAllow, "reflexion retry — agent fixing its own mistake", 0.85
		}
	}

	// If too many files edited, escalate.
	a.mu.RLock()
	totalEdited := len(a.editedFiles)
	a.mu.RUnlock()
	if isFileEditTool(toolName) && totalEdited >= a.config.MaxFileEdits {
		return DecisionAsk, fmt.Sprintf("exceeded max file edits (%d/%d)", totalEdited, a.config.MaxFileEdits), 0.7
	}

	return "", "", 0
}

// RecordEdit marks a file as edited so future edits to the same file are auto-approved.
func (a *AutoMode) RecordEdit(path string) {
	if path == "" {
		return
	}
	a.mu.Lock()
	a.editedFiles[path]++
	a.mu.Unlock()
}

// AddToAllowList permanently allows a tool/pattern for this session.
func (a *AutoMode) AddToAllowList(key string) {
	a.mu.Lock()
	a.allowList[key] = true
	a.mu.Unlock()
}

// AddToBlockList permanently blocks a tool/pattern for this session.
func (a *AutoMode) AddToBlockList(key string) {
	a.mu.Lock()
	a.blockList[key] = true
	a.mu.Unlock()
}

// History returns a copy of recent classification decisions.
func (a *AutoMode) History() []ClassifiedAction {
	a.mu.RLock()
	defer a.mu.RUnlock()
	h := make([]ClassifiedAction, len(a.history))
	copy(h, a.history)
	return h
}

// Stats returns auto-mode classification statistics.
func (a *AutoMode) Stats() AutoModeStats {
	a.mu.RLock()
	defer a.mu.RUnlock()

	stats := AutoModeStats{}
	for _, action := range a.history {
		stats.Total++
		switch action.Decision {
		case DecisionAllow:
			stats.Allowed++
		case DecisionBlock:
			stats.Blocked++
		case DecisionAsk:
			stats.Escalated++
		}
	}
	if stats.Total > 0 {
		stats.AutoApproveRate = float64(stats.Allowed) / float64(stats.Total)
	}
	return stats
}

// AutoModeStats reports classification hit rates for monitoring.
type AutoModeStats struct {
	Total           int     `json:"total"`
	Allowed         int     `json:"allowed"`
	Blocked         int     `json:"blocked"`
	Escalated       int     `json:"escalated"`
	AutoApproveRate float64 `json:"auto_approve_rate"`
}

func (a *AutoMode) recordAction(action *ClassifiedAction) {
	a.mu.Lock()
	a.history = append(a.history, *action)
	if len(a.history) > 200 {
		a.history = a.history[len(a.history)-100:]
	}
	a.mu.Unlock()
	log.Printf("[automode] %s(%v) → %s (layer %d): %s",
		action.ToolName, summarizeArgs(action.Args), action.Decision, action.Layer, action.Reason)
}

// toolCallPattern creates a string key for a specific tool+args combination.
func toolCallPattern(toolName string, args map[string]any) string {
	if path, ok := args["path"].(string); ok && path != "" {
		return toolName + ":" + path
	}
	if cmd, ok := args["command"].(string); ok && cmd != "" {
		parts := strings.Fields(cmd)
		if len(parts) > 0 {
			return toolName + ":" + parts[0]
		}
	}
	return toolName
}

func summarizeArgs(args map[string]any) string {
	if args == nil {
		return "{}"
	}
	if path, ok := args["path"].(string); ok {
		return fmt.Sprintf("path=%q", truncStr(path, 40))
	}
	if cmd, ok := args["command"].(string); ok {
		return fmt.Sprintf("cmd=%q", truncStr(cmd, 40))
	}
	data, _ := json.Marshal(args)
	s := string(data)
	return truncStr(s, 60)
}

func truncStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

// isInReflexionContext checks if recent messages indicate a reflexion retry.
func isInReflexionContext(messages []ai.Message) bool {
	for i := len(messages) - 1; i >= 0 && i > len(messages)-5; i-- {
		if messages[i].Role == ai.RoleUser && strings.Contains(messages[i].Content, "Reflexion Required") {
			return true
		}
	}
	return false
}

// isOutsideWorkspace detects paths that try to escape the project workspace.
func isOutsideWorkspace(path string) bool {
	return strings.HasPrefix(path, "/etc/") ||
		strings.HasPrefix(path, "/usr/") ||
		strings.HasPrefix(path, "/bin/") ||
		strings.HasPrefix(path, "/sbin/") ||
		strings.HasPrefix(path, "/var/") ||
		strings.HasPrefix(path, "/root/") ||
		strings.Contains(path, "../../../") ||
		strings.HasPrefix(path, "~/.ssh") ||
		strings.HasPrefix(path, "~/.gnupg")
}

// isFileEditTool returns true for tools that modify files.
func isFileEditTool(name string) bool {
	switch name {
	case "write_file", "edit_file", "multi_edit", "patch_file", "regex_replace", "notebook_edit":
		return true
	}
	return false
}

// matchesPattern checks if a command matches a simple pattern (prefix or contains).
func matchesPattern(cmd, pattern string) bool {
	if strings.HasPrefix(pattern, "^") {
		return strings.HasPrefix(cmd, strings.TrimPrefix(pattern, "^"))
	}
	return strings.Contains(cmd, pattern)
}

// ParseAutoModeLevel converts a string to an AutoModeLevel.
func ParseAutoModeLevel(s string) AutoModeLevel {
	switch strings.ToLower(s) {
	case "conservative":
		return AutoModeConservative
	case "aggressive":
		return AutoModeAggressive
	default:
		return AutoModeBalanced
	}
}

// IsEnabled returns whether auto-mode is active.
func (a *AutoMode) IsEnabled() bool {
	return a != nil && a.config.Enabled
}

// IsFileEditToolName is an exported version of isFileEditTool for use by the handler.
func IsFileEditToolName(name string) bool {
	return isFileEditTool(name)
}
