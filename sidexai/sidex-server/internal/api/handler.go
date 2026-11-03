package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/sidex-ai/sidex-server/internal/agent"
	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/analytics"
	"github.com/sidex-ai/sidex-server/internal/auth"
	"github.com/sidex-ai/sidex-server/internal/compress"
	"github.com/sidex-ai/sidex-server/internal/context"
	"github.com/sidex-ai/sidex-server/internal/cost"
	"github.com/sidex-ai/sidex-server/internal/feedback"
	"github.com/sidex-ai/sidex-server/internal/index"
	"github.com/sidex-ai/sidex-server/internal/localexec"
	"github.com/sidex-ai/sidex-server/internal/mcp"
	"github.com/sidex-ai/sidex-server/internal/memdir"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/paths"
	"github.com/sidex-ai/sidex-server/internal/plan"
	"github.com/sidex-ai/sidex-server/internal/prompt"
	"github.com/sidex-ai/sidex-server/internal/session"
	"github.com/sidex-ai/sidex-server/internal/tools"
	"github.com/sidex-ai/sidex-server/internal/usage"
)

// AllowedOrigins is the canonical set of origins accepted by the API server.
// Only the desktop webview and local dev servers: this server is loopback-only.
// Both the CORS middleware in main and the WebSocket upgrader reference this.
var AllowedOrigins = map[string]bool{
	"tauri://localhost":       true,
	"https://tauri.localhost": true,
	"http://tauri.localhost":  true, // Tauri webview origin on Linux
	"http://localhost:3000":   true,
	"http://localhost:1420":   true,
}

type Handler struct {
	sm            *session.Manager
	store         *memory.Store
	aiClient      *ai.Client
	upgrader      websocket.Upgrader
	feedbackStore *feedback.Store
	analyzer      *feedback.Analyzer
	analytics     *analytics.Analytics
	flags         *analytics.Flags
	usageService  *usage.Service
	indexService  *index.IndexService
	memoryStore   *context.MemoryStore
	flowTracker   *context.FlowTracker
	flowMu        sync.Mutex
}

func NewHandler(sm *session.Manager, store *memory.Store, usageSvc *usage.Service, indexSvc *index.IndexService) *Handler {
	fbPath := paths.ExpandUser(os.Getenv("SIDEX_DATA_DIR"))
	if fbPath == "" {
		fbPath = filepath.Join(paths.SidexHome(), "data")
	}
	if err := os.MkdirAll(fbPath, 0755); err != nil {
		log.Printf("data dir: failed to create %s: %v", fbPath, err)
	}
	fbStore, err := feedback.OpenStore(filepath.Join(fbPath, "feedback.db"))
	if err != nil {
		log.Printf("feedback: failed to open store: %v (continuing without feedback)", err)
	}

	var analyzer *feedback.Analyzer
	if fbStore != nil {
		analyzer = feedback.NewAnalyzer(fbStore)
	}

	// Initialize MemoryStore if we have a data directory for it.
	var memStore *context.MemoryStore
	memDBPath := filepath.Join(fbPath, "context_memory.db")
	memDB, memErr := context.OpenMemoryDB(memDBPath)
	if memErr != nil {
		log.Printf("context memory: failed to open store: %v (continuing without auto-memories)", memErr)
	} else {
		memStore = context.NewMemoryStore(memDB)
	}

	return &Handler{
		sm:            sm,
		store:         store,
		aiClient:      ai.NewClient(),
		feedbackStore: fbStore,
		analyzer:      analyzer,
		analytics:     analytics.NewAnalytics(),
		flags:         analytics.LoadFlags(),
		usageService:  usageSvc,
		indexService:  indexSvc,
		memoryStore:   memStore,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				if origin == "" {
					return true
				}
				return AllowedOrigins[origin]
			},
			ReadBufferSize:  1024 * 64,
			WriteBufferSize: 1024 * 64,
		},
	}
}

// --- request/response types ---

// Close shuts down the handler's resources including the analytics client.
func (h *Handler) Close() {
	if h.analytics != nil {
		h.analytics.Close()
	}
}

type IDEContext struct {
	ActiveFile       string          `json:"active_file,omitempty"`
	Language         string          `json:"language,omitempty"`
	Selection        string          `json:"selection,omitempty"`
	SelectionRange   *SelectionRange `json:"selection_range,omitempty"`
	WorkspaceFolders []string        `json:"workspace_folders,omitempty"`
	OpenFiles        []string        `json:"open_files,omitempty"`
}

type SelectionRange struct {
	StartLine   int `json:"startLine"`
	StartColumn int `json:"startColumn"`
	EndLine     int `json:"endLine"`
	EndColumn   int `json:"endColumn"`
}

type UserInfo struct {
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	Shell         string `json:"shell"`
	WorkspacePath string `json:"workspace_path"`
	IsGitRepo     bool   `json:"is_git_repo"`
	Date          string `json:"date"`
}

type ChatRequest struct {
	SessionID      string      `json:"session_id"`
	Message        string      `json:"message"`
	CWD            string      `json:"cwd"`
	Context        *IDEContext `json:"context,omitempty"`
	UserInfo       *UserInfo   `json:"user_info,omitempty"`
	LocalExec      bool        `json:"local_exec,omitempty"`
	Mode           string      `json:"mode,omitempty"`
	Model          string      `json:"model,omitempty"`
	PermissionMode string      `json:"permission_mode,omitempty"`
	MaxMode        bool        `json:"max_mode,omitempty"`
	ThinkingBudget int         `json:"thinking_budget,omitempty"`
	ThinkingEffort string      `json:"thinking_effort,omitempty"`
	SandboxImage   string      `json:"sandbox_image,omitempty"`
	SandboxSetup   string      `json:"sandbox_setup,omitempty"`
	Timestamp      string      `json:"timestamp,omitempty"`
	OpenFiles      []string    `json:"open_files,omitempty"`
	ActiveFile     string      `json:"active_file,omitempty"`
	GitStatus      string      `json:"git_status,omitempty"`
}

type toolResponseFrame struct {
	Type       string `json:"type"`
	ToolCallID string `json:"tool_call_id"`
	Output     string `json:"output"`
	Error      string `json:"error"`
}

type permissionResponseFrame struct {
	Type       string `json:"type"`
	ToolCallID string `json:"tool_call_id"`
	Approved   bool   `json:"approved"`
}

// --- thread-safe websocket conn (implements agent.Conn) ---

type safeConn struct {
	conn            *websocket.Conn
	mu              sync.Mutex
	broker          *localexec.Broker
	permBroker      *agent.PermissionBroker
	elicitBroker    *elicitationBroker
	localExec       bool
	userInfo        *UserInfo
	currentMode     agent.AgentMode
	modelOverride   string
	maxMode         bool
	thinkingBudget  int
	thinkingEffort  string
	permMode        agent.PermissionMode
	sessionAllow    map[string]bool
	debugBugDesc    string
	feedbackTracker *feedback.Tracker
	authUser        *auth.UserContext
	flowTracker     *context.FlowTracker
	gitStatus       string
}

// elicitationBroker manages MCP elicitation response channels.
type elicitationBroker struct {
	mu      sync.Mutex
	pending map[string]chan string
}

func newElicitationBroker() *elicitationBroker {
	return &elicitationBroker{pending: make(map[string]chan string)}
}

func (b *elicitationBroker) Register(id string) <-chan string {
	ch := make(chan string, 1)
	b.mu.Lock()
	b.pending[id] = ch
	b.mu.Unlock()
	return ch
}

func (b *elicitationBroker) Resolve(id, answer string) {
	b.mu.Lock()
	ch, ok := b.pending[id]
	if ok {
		delete(b.pending, id)
	}
	b.mu.Unlock()
	if ok {
		ch <- answer
	}
}

func (sc *safeConn) WriteJSON(v interface{}) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	if err := sc.conn.WriteJSON(v); err != nil {
		log.Printf("ws write error: %v", err)
	}
}

// ReadJSON satisfies agent.Conn. For the handler's agent loop this is
// unused because the websocket read loop dispatches responses via brokers.
// It exists to satisfy the interface for test doubles and the RunLoop path.
func (sc *safeConn) ReadJSON(v interface{}) error {
	return sc.conn.ReadJSON(v)
}

// localExecAdapter implements agent.LocalExecRouter using the websocket broker.
type localExecAdapter struct {
	sc *safeConn
}

func (a *localExecAdapter) ShouldRunLocal(toolName string) bool {
	return a.sc != nil && a.sc.localExec && agent.LocalExecTools[toolName]
}

func (a *localExecAdapter) RunViaClient(tc ai.ToolCall) (string, string) {
	if a.sc == nil || a.sc.broker == nil {
		return "", "local execution not available on this connection"
	}
	ch := a.sc.broker.Register(tc.ID)
	a.sc.WriteJSON(map[string]interface{}{
		"type":         "tool_request",
		"tool_call_id": tc.ID,
		"name":         tc.Function.Name,
		"arguments":    tc.Function.Arguments,
	})

	timeout := 60 * time.Second
	if tc.Function.Name == "run_background" || tc.Function.Name == "shell" {
		timeout = 5 * time.Minute
	}
	resp, err := a.sc.broker.Wait(tc.ID, ch, timeout)
	if err != nil {
		return "", fmt.Sprintf("local execution timed out after %s", timeout)
	}
	return resp.Output, resp.Error
}

// --- HTTP handlers ---

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"version": "0.5.0",
		"model":   h.aiClient.Model(),
		"time":    time.Now().Unix(),
	})
}

func (h *Handler) GetUsage(w http.ResponseWriter, r *http.Request) {
	user := auth.GetUser(r.Context())
	if user == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if h.usageService == nil {
		http.Error(w, `{"error":"usage tracking not configured"}`, http.StatusServiceUnavailable)
		return
	}

	userID, err := h.usageService.EnsureUser(user.UserID, user.Email, user.Plan)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve user"}`, http.StatusInternalServerError)
		return
	}

	periodStart := usage.BillingPeriodStart()
	summary, err := h.usageService.GetUserSummary(userID, periodStart)
	if err != nil {
		http.Error(w, `{"error":"failed to get usage summary"}`, http.StatusInternalServerError)
		return
	}

	tier := plan.ParseTier(user.Plan)
	limits := plan.GetLimits(tier)
	remaining, _ := h.usageService.CheckCredits(userID, limits.MonthlyCreditsUSD, periodStart)
	summary.CreditsRemaining = remaining

	daily, _ := h.usageService.GetDailyBreakdown(userID, 30)
	models, _ := h.usageService.GetModelBreakdown(userID, periodStart)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"summary":  summary,
		"daily":    daily,
		"by_model": models,
	})
}

func (h *Handler) GetPlan(w http.ResponseWriter, r *http.Request) {
	user := auth.GetUser(r.Context())
	if user == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	tier := plan.ParseTier(user.Plan)
	limits := plan.GetLimits(tier)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tier":   string(tier),
		"email":  user.Email,
		"limits": limits,
	})
}

// ListModels advertises only the models the user can actually reach.
//
// When a provider is configured, the list comes from that provider's own
// /models endpoint (Claude Code, Codex, Ollama, …) — not a hardcoded
// snapshot in pricing.go. The static catalog is only a fallback when
// nothing is configured or a live fetch fails.
func (h *Handler) ListModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(reachableModels())
}

func reachableModels() []cost.ModelInfo {
	configured := ai.ConfiguredLocalProviders()
	if len(configured) == 0 {
		return cost.ListModels()
	}

	out := make([]cost.ModelInfo, 0, 32)
	for _, cfg := range configured {
		live, err := ai.ListRemoteModels(cfg)
		if err != nil || len(live) == 0 {
			for _, m := range cost.ListModels() {
				if m.Provider == cfg.Provider {
					m.Default = true
					out = append(out, m)
				}
			}
			continue
		}
		for _, rm := range live {
			window := rm.ContextWindow
			if window <= 0 {
				window = cost.ContextWindowForModel(rm.ID)
			}
			out = append(out, cost.ModelInfo{
				ID:               rm.ID,
				Name:             rm.Name,
				Provider:         cfg.Provider,
				ContextWindow:    window,
				MaxOutput:        cost.MaxOutputForModel(rm.ID),
				SupportsTools:    true,
				SupportsThinking: cost.SupportsThinking(rm.ID),
				Default:          true,
				Pricing:          cost.LookupPricing(rm.ID),
			})
		}
	}
	if len(out) == 0 {
		return cost.ListModels()
	}
	return out
}

func (h *Handler) ListTools(w http.ResponseWriter, r *http.Request) {
	reg := h.sm.Create(".").Tools
	json.NewEncoder(w).Encode(reg.List())
}

func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024) // 2MB max
	var req ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	sess := h.getOrCreateSession(req.SessionID, req.CWD, currentUserID(r))
	if sess == nil {
		http.Error(w, "session not found", 404)
		return
	}
	sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: req.Message})

	// /chat is the non-streaming, single-round endpoint: it cannot execute
	// tools, so none are advertised to the model. Tool-driven work must go
	// through the /stream WebSocket agent loop.
	var fullResponse string
	sysPrompt := h.buildSystemPrompt(sess, nil, false)

	currentMode := agent.AgentMode(req.Mode)
	if currentMode == "" {
		currentMode = agent.ModeAgent
	}
	if currentMode == agent.ModePlan {
		sysPrompt += agent.PlanModePromptSuffix()
	} else if currentMode == agent.ModeAsk {
		sysPrompt += agent.AskModePromptSuffix()
	} else if currentMode == agent.ModeProactive {
		sysPrompt += agent.ProactivePromptSuffix()
	} else if currentMode == agent.ModeDebug {
		if bugDesc, ok := agent.ParseDebug(req.Message); ok {
			sysPrompt += agent.DebugModePromptSuffix(bugDesc)
		}
	}

	err := h.clientFor("", auth.UserIDFromContext(r.Context())).StreamChat(sess.GetMessages(), nil, sysPrompt, func(chunk ai.StreamChunk) {
		if chunk.Type == "text" {
			fullResponse += chunk.Content
		}
	})
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: fullResponse})
	h.autoTitleAndSave(sess)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"session_id": sess.ID, "response": fullResponse})
}

// --- WebSocket streaming handler ---

func (h *Handler) Stream(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	sc := &safeConn{conn: conn, broker: localexec.NewBroker(), permBroker: agent.NewPermissionBroker(), elicitBroker: newElicitationBroker(), authUser: auth.GetUser(r.Context()), flowTracker: context.NewFlowTracker()}

	// Proactive server-pushed update notifications:
	// If the client passed its "version" query parameter and it is older
	// than the latest release published on the server, push an update_available
	// frame immediately after handshake. The open client gets a sticky
	// notification instantly instead of waiting for a 4-hour periodic check!
	if clientVersion := r.URL.Query().Get("version"); clientVersion != "" {
		uH := NewUpdateHandler()
		latestPath := filepath.Join(uH.dir, "latest.json")
		if data, err := os.ReadFile(latestPath); err == nil {
			var manifest struct {
				Version string `json:"version"`
				Notes   string `json:"notes"`
			}
			if err := json.Unmarshal(data, &manifest); err == nil {
				if manifest.Version != "" && manifest.Version != clientVersion {
					if isNewerSemver(manifest.Version, clientVersion) {
						sc.WriteJSON(map[string]interface{}{
							"type":    "update_available",
							"version": manifest.Version,
							"notes":   manifest.Notes,
						})
					}
				}
			}
		}
	}

	var sess *session.Session

	turnReady := make(chan struct{}, 1)
	turnReady <- struct{}{}

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if frame := tryParseToolResponse(message); frame != nil {
			sc.broker.Resolve(localexec.Response{
				ToolCallID: frame.ToolCallID,
				Output:     frame.Output,
				Error:      frame.Error,
			})
			continue
		}

		if frame := tryParsePermissionResponse(message); frame != nil {
			sc.permBroker.Resolve(agent.PermissionResponse{
				Type:       "permission_response",
				ToolCallID: frame.ToolCallID,
				Approved:   frame.Approved,
			})
			continue
		}

		if frame := tryParseElicitationResponse(message); frame != nil {
			sc.elicitBroker.Resolve(frame.ID, frame.Answer)
			continue
		}

		if frame := tryParseFeedbackEvent(message); frame != nil {
			if sc.feedbackTracker != nil {
				switch frame.Signal {
				case "edit_accepted":
					sc.feedbackTracker.RecordEditFeedback(frame.Tool, frame.Turn, true)
				case "edit_reverted":
					sc.feedbackTracker.RecordEditFeedback(frame.Tool, frame.Turn, false)
				}
				sc.feedbackTracker.Flush()
			}
			continue
		}

		if frame := tryParseFlowEvent(message); frame != nil {
			sc.flowTracker.Record(context.FlowEvent{
				Type:      frame.EventType,
				FilePath:  frame.FilePath,
				Content:   frame.Content,
				Timestamp: time.Now(),
				Metadata:  frame.Metadata,
			})
			continue
		}

		if frame := tryParseRevert(message); frame != nil {
			// Only the session bound to THIS connection may be reverted.
			// A global session lookup would let any authenticated client
			// truncate arbitrary transcripts by guessing session IDs.
			if sess != nil && (frame.SessionID == "" || frame.SessionID == sess.ID) && frame.KeepUserMessages > 0 {
				truncateAfterUserMessage(sess, frame.KeepUserMessages)
				h.sm.SaveTranscript(sess)
			}
			continue
		}

		var req ChatRequest
		if err := json.Unmarshal(message, &req); err != nil {
			sc.WriteJSON(ai.StreamChunk{Type: "error", Error: err.Error()})
			continue
		}

		if req.LocalExec {
			sc.localExec = true
		}
		if req.UserInfo != nil {
			sc.userInfo = req.UserInfo
		}

		if req.Mode != "" {
			sc.currentMode = agent.AgentMode(req.Mode)
		}
		if sc.currentMode == "" {
			sc.currentMode = agent.ModeAgent
		}
		if req.Model != "" {
			sc.modelOverride = req.Model
		}
		sc.maxMode = req.MaxMode
		sc.thinkingBudget = req.ThinkingBudget
		sc.thinkingEffort = req.ThinkingEffort
		if req.PermissionMode != "" {
			requested := agent.ParsePermissionMode(req.PermissionMode)
			if requested == agent.PermissionAutoAll && sc.authUser != nil {
				userTier := plan.ParseTier(sc.authUser.Plan)
				if userTier == plan.TierHobby {
					requested = agent.PermissionDefault
				}
			}
			sc.permMode = requested
		}

		if sess == nil {
			resolvedCWD := resolveCWD(req.CWD)
			if req.SandboxImage != "" && req.CWD != "" {
				// Sandbox mode: trust CWD exists inside the container
				resolvedCWD = req.CWD
			} else if !sc.localExec && req.CWD != "" && req.CWD != resolvedCWD && req.CWD != "." {
				sc.WriteJSON(ai.StreamChunk{
					Type:    "notice",
					Content: fmt.Sprintf("Requested working directory %q does not exist on the server. Using %q instead.", req.CWD, resolvedCWD),
				})
			}
			if sc.localExec && req.CWD != "" {
				resolvedCWD = req.CWD
			}
			sessionUserID := ""
			if sc.authUser != nil {
				sessionUserID = sc.authUser.UserID
			}
			sess = h.getOrCreateSession(req.SessionID, resolvedCWD, sessionUserID)
			if sess == nil {
				sc.WriteJSON(ai.StreamChunk{Type: "error", Error: "session not found"})
				continue
			}
			sc.WriteJSON(ai.StreamChunk{Type: "session", Content: sess.ID})
			h.wireMCPElicitation(sess, sc)

			if h.feedbackStore != nil {
				sc.feedbackTracker = feedback.NewTracker(sess.ID, h.feedbackStore)
			}

			// Start Docker/Daytona sandbox if requested
			if req.SandboxImage != "" && sess.Tools != nil && sess.Tools.Sandbox == nil {
				sb := &tools.Sandbox{}
				sandboxWorkDir := req.CWD
				if sandboxWorkDir == "" {
					sandboxWorkDir = "/root"
				}
				// Retry sandbox start up to 3 times — Daytona snapshots can take a moment
				var startErr error
				for attempt := 1; attempt <= 3; attempt++ {
					startErr = sb.Start(sandboxWorkDir, req.SandboxImage)
					if startErr == nil {
						break
					}
					if attempt < 3 {
						time.Sleep(time.Duration(attempt*8) * time.Second)
					}
				}
				if startErr != nil {
					sc.WriteJSON(ai.StreamChunk{Type: "error", Error: "Sandbox start failed: " + startErr.Error()})
					sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
					return
				}
				sess.Tools.Sandbox = sb
				sc.WriteJSON(ai.StreamChunk{Type: "notice", Content: "Sandbox active: commands execute in cloud sandbox"})
				if req.SandboxSetup != "" {
					if err := sb.WriteFile("/tmp/_setup.sh", "#!/bin/bash\nset -e\n"+req.SandboxSetup); err == nil {
						_, stderr, code, _ := sb.Exec("bash /tmp/_setup.sh", "")
						if code != 0 {
							sc.WriteJSON(ai.StreamChunk{Type: "notice", Content: "Setup failed: " + stderr})
						}
					}
				}
			}
		}

		userContent := req.Message
		if reminder := buildSystemReminder(req.Context); reminder != "" {
			userContent = reminder + "\n\n" + userContent
		}

		// Store git_status on first message of the session for reuse
		if req.GitStatus != "" && sc.gitStatus == "" {
			sc.gitStatus = req.GitStatus
		}

		// Prepend Cursor-style context blocks to the user message. Prefer the
		// explicit top-level fields, but fall back to the structured IDE context
		// so clients cannot accidentally drop "current file" context.
		openFiles := req.OpenFiles
		activeFile := req.ActiveFile
		if req.Context != nil {
			if len(openFiles) == 0 {
				openFiles = req.Context.OpenFiles
			}
			if activeFile == "" {
				activeFile = req.Context.ActiveFile
			}
		}
		contextBlocks := buildContextInjection(req.Timestamp, sc.gitStatus, openFiles, activeFile)
		if contextBlocks != "" {
			userContent = contextBlocks + userContent
		}

		sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: userContent})

		// Record follow-up signal if this isn't the first user message
		if sc.feedbackTracker != nil {
			userMsgCount := 0
			for _, m := range sess.GetMessages() {
				if m.Role == ai.RoleUser {
					userMsgCount++
				}
			}
			if userMsgCount > 1 {
				sc.feedbackTracker.RecordFollowUp(userMsgCount)
			}
		}

		<-turnReady
		ctx := req.Context
		go func(sc *safeConn, sess *session.Session, ctx *IDEContext) {
			defer func() { turnReady <- struct{}{} }()
			defer func() {
				if r := recover(); r != nil {
					log.Printf("agent loop panic: %v", r)
					sc.WriteJSON(ai.StreamChunk{Type: "error", Error: fmt.Sprintf("internal error: %v", r)})
					sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
				}
			}()
			h.runAgentLoop(sc, sess, ctx)
		}(sc, sess, ctx)
	}

	// Connection closed — clean up background shells for this session.
	// Note: sandbox is NOT auto-deleted here — the client verification step
	// needs it alive to extract git diff and run tests. Client deletes it after.
	if sess != nil && sess.Tools != nil {
		sess.Tools.Cleanup()
		log.Printf("cleaned up session %s", sess.ID)
	}
	if sc.feedbackTracker != nil {
		sc.feedbackTracker.RecordSessionEnd()
		sc.feedbackTracker.Flush()
	}
}

func (h *Handler) runAgentLoop(sc *safeConn, sess *session.Session, ctx *IDEContext) {
	msgs := sess.GetMessages()
	if len(msgs) > 0 {
		lastMsg := msgs[len(msgs)-1]
		if lastMsg.Role == ai.RoleUser {
			if cfg, ok := agent.ParseBestOfN(lastMsg.Content); ok {
				agent.RunBestOfN(cfg, sc, sess.CWD, h.aiClient, h.store, agent.DefaultConfig())
				h.sm.SaveTranscript(sess)
				return
			}
			if cfg, ok := agent.ParseMultitask(lastMsg.Content); ok {
				agent.RunMultitask(cfg, sc, sess.CWD, h.aiClient, h.store, agent.DefaultConfig())
				h.sm.SaveTranscript(sess)
				return
			}
			if bugDesc, ok := agent.ParseDebug(lastMsg.Content); ok {
				sc.currentMode = agent.ModeDebug
				sc.debugBugDesc = bugDesc
				sc.WriteJSON(map[string]interface{}{"type": "mode_change", "mode": "debug"})
				sc.WriteJSON(ai.StreamChunk{
					Type:    "debug_phase",
					Content: "Starting debug investigation...",
				})
			}
		}
	}
	h.runAgentLoopWithAgents(sc, sess, ctx, nil)
}

func (h *Handler) runAgentLoopWithAgents(sc *safeConn, sess *session.Session, ctx *IDEContext, activeAgents map[string]*agent.ActiveSubAgent) {
	if activeAgents == nil {
		activeAgents = make(map[string]*agent.ActiveSubAgent)
	}
	cfg := agent.DefaultConfig()
	cfg.PermMode = sc.permMode
	cfg.SessionAllowed = sc.sessionAllow
	cfg.PromptMode = os.Getenv("SIDEX_PROMPT_MODE")
	cfg.LocalUsage = h.usageService
	cfg.SessionID = sess.ID

	// Register built-in hooks for agent intelligence and safety.
	hooks := agent.NewHookRegistry()
	hooks.Register(agent.HookBeforeTurn, "loop_breaker", agent.LoopBreakerHook, 100)
	hooks.Register(agent.HookBeforeTurn, "exploration_nudge", agent.ExplorationNudgeHook, 90)
	hooks.Register(agent.HookBeforeTurn, "verify_after_edit", agent.VerifyAfterEditHook, 80)
	hooks.Register(agent.HookBeforeToolUse, "security_gate", agent.SecurityGateHook, 100)
	// Load user-defined hooks from <workspace>/.sidex/hooks.json (no-op if absent).
	if sess.CWD != "" {
		if err := hooks.LoadFromConfig(filepath.Join(sess.CWD, ".sidex", "hooks.json")); err != nil {
			log.Printf("hooks: failed to load workspace config: %v", err)
		}
	}
	cfg.Hooks = hooks

	// Initialize AutoMode if configured via environment or if permission mode is auto_all.
	if autoLevel := os.Getenv("SIDEX_AUTO_MODE"); autoLevel != "" {
		cfg.AutoMode = agent.NewAutoMode(agent.AutoModeConfig{
			Enabled:      true,
			Level:        agent.ParseAutoModeLevel(autoLevel),
			MaxFileEdits: 10,
		})
	}

	effort := ai.ParseEffort(sc.thinkingEffort, sc.thinkingBudget)
	if sc.maxMode && effort == ai.EffortNone {
		effort = ai.EffortUltra
	}
	if effort == ai.EffortNone {
		if budget := os.Getenv("SIDEX_THINKING_BUDGET"); budget != "" {
			if b, err := parseIntEnv(budget); err == nil && b > 0 {
				effort = ai.ParseEffort("", b)
			}
		}
	}
	cfg.Effort = string(effort)
	cfg.ThinkingBudget = effort.Budget()
	if effort != ai.EffortNone {
		cfg.MaxContextTokens = cost.ContextWindowForModel(sc.modelOverride)
	}
	if sc.currentMode == agent.ModeDebug {
		cfg.MaxTurns = 40
	}

	// --- Plan enforcement: pre-session gate ---
	userID := ""
	userPlan := ""
	if sc.authUser != nil {
		userID = sc.authUser.UserID
		userPlan = sc.authUser.Plan
	}
	tier := plan.ParseTier(userPlan)
	planLimits := plan.GetLimits(tier)

	// Tier limits only mean something when we are the ones billing. With the
	// user's own provider credentials there is no plan to exceed, and the
	// provider enforces its own limits — applying ours on top would cap the
	// agent's turns and refuse requests for credits nobody is counting.
	if plan.Metered() {
		if planLimits.MaxTurnsPerSession > 0 && planLimits.MaxTurnsPerSession < cfg.MaxTurns {
			cfg.MaxTurns = planLimits.MaxTurnsPerSession
		}

		if h.usageService != nil && userID != "" {
			periodStart := usage.BillingPeriodStart()
			creditsUsed, _ := h.usageService.GetCreditsUsed(userID, periodStart)
			requestCount, _ := h.usageService.GetRequestCount(userID, periodStart)
			allowed, reason := plan.CanMakeRequest(tier, creditsUsed, requestCount)
			if !allowed {
				sc.WriteJSON(ai.StreamChunk{Type: "error", Error: "Plan limit reached: " + reason})
				sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
				return
			}
		}
	}

	// Check if the requested model is allowed for the user's plan tier.
	requestedModel := sc.modelOverride
	if requestedModel == "" {
		requestedModel = h.aiClient.Model()
	}
	if plan.Metered() && !plan.IsModelAllowed(tier, requestedModel) {
		sc.WriteJSON(ai.StreamChunk{
			Type:  "error",
			Error: fmt.Sprintf("Model %q is not available on your %s plan. Upgrade to access this model.", requestedModel, string(tier)),
		})
		sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
		return
	}

	toolDefs := agent.BuildToolDefs(sess.Tools)
	sysPrompt := h.buildSystemPromptWithFlow(sess, ctx, sc.localExec, sc.flowTracker, sc.userInfo, sc.modelOverride)
	client := h.clientFor(sc.modelOverride, userID)

	// --- Context Engine: augment system prompt with retrieved code and memories ---
	sysPrompt = h.augmentWithContextEngine(sysPrompt, sess, ctx)

	currentMode := sc.currentMode
	toolDefs = agent.FilterToolDefs(toolDefs, currentMode)

	if currentMode == agent.ModePlan {
		sysPrompt += agent.PlanModePromptSuffix()
	} else if currentMode == agent.ModeAsk {
		sysPrompt += agent.AskModePromptSuffix()
	} else if currentMode == agent.ModeProactive {
		sysPrompt += agent.ProactivePromptSuffix()
	} else if currentMode == agent.ModeDebug && sc.debugBugDesc != "" {
		sysPrompt += agent.DebugModePromptSuffix(sc.debugBugDesc)
	}

	local := &localExecAdapter{sc: sc}
	tracker := cost.NewTracker(requestedModel)
	loopStart := time.Now()
	privacyMode := h.privacyModeEnabled(userID)

	// Track session start with active feature flags
	if !privacyMode {
		h.analytics.TrackSessionStart(userID, sess.ID, sc.modelOverride)
		h.analytics.TrackFeatureUsage(userID, "flags", h.flags.ToMap())
	}

	// Custom loop that handles spawn_agents specially (subagents need the
	// aiClient and memory store which are Handler-level concerns).
	for turn := 0; ; turn++ {
		// Max turns guard: stop the agent if it's exceeded the configured limit.
		if turn >= cfg.MaxTurns {
			sc.WriteJSON(ai.StreamChunk{Type: "error", Error: "agent reached maximum turns"})
			sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
			if !privacyMode {
				go h.analytics.TrackSessionEnd(userID, map[string]interface{}{
					"session_id":   sess.ID,
					"total_cost":   tracker.TotalCost(),
					"total_tokens": tracker.TotalUsage().InputTokens + tracker.TotalUsage().OutputTokens,
					"duration_ms":  time.Since(loopStart).Milliseconds(),
					"turn_count":   cfg.MaxTurns,
				})
			}
			return
		}

		// Mid-session credit check: stop the agent if credits are exhausted.
		if plan.Metered() && h.usageService != nil && userID != "" && turn > 0 {
			periodStart := usage.BillingPeriodStart()
			creditsUsed, _ := h.usageService.GetCreditsUsed(userID, periodStart)
			if planLimits.MonthlyCreditsUSD >= 0 && creditsUsed >= planLimits.MonthlyCreditsUSD {
				sc.WriteJSON(ai.StreamChunk{
					Type:  "error",
					Error: "Credit limit reached mid-session. Stopping agent. Please upgrade your plan for more credits.",
				})
				sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
				return
			}
		}

		// Run 5-layer compression pipeline to keep context within budget
		messages := ai.CompressPipeline(sess.GetMessages(), compress.MaxContextTokens)

		// Fire before_turn hooks (loop breaker, exploration nudge, verify
		// reminder, user-defined). Injections are appended to this turn's
		// model input without polluting the persisted session history.
		if cfg.Hooks != nil && cfg.Hooks.HasHandlers(agent.HookBeforeTurn) {
			hookRes := cfg.Hooks.Fire(&agent.HookContext{
				Event:      agent.HookBeforeTurn,
				TurnNumber: turn,
				Messages:   messages,
				Metadata:   map[string]any{"session_cost": tracker.TotalCost()},
			})
			if hookRes.Inject != "" {
				messages = append(messages, ai.Message{Role: ai.RoleUser, Content: hookRes.Inject})
			}
		}

		var fullText string
		var pendingToolCalls []ai.ToolCall
		var lastInputTokens, lastOutputTokens int
		var lastTurnCost float64
		hadToolCalls := false

		streamOpts := &ai.StreamOptions{
			SessionID:      sess.ID,
			ThinkingBudget: cfg.ThinkingBudget,
			Effort:         cfg.Effort,
		}

		err := client.StreamChatWithOptions(messages, toolDefs, sysPrompt, streamOpts, func(chunk ai.StreamChunk) {
			switch chunk.Type {
			case "text":
				fullText += chunk.Content
				sc.WriteJSON(chunk)
			case "thinking", "thinking_done":
				sc.WriteJSON(chunk)
			case "tool_call":
				hadToolCalls = true
				pendingToolCalls = append(pendingToolCalls, chunk.ToolCalls...)
			case "usage":
				if chunk.TokensUsed != nil {
					turnCost := tracker.Add(
						requestedModel,
						chunk.TokensUsed.PromptTokens,
						chunk.TokensUsed.CompletionTokens,
						chunk.TokensUsed.CacheCreationInputTokens,
						chunk.TokensUsed.CacheReadInputTokens,
					)
					sc.WriteJSON(map[string]interface{}{
						"type":       "cost_update",
						"turn_cost":  turnCost,
						"total_cost": tracker.TotalCost(),
						"usage":      tracker.ToJSON(),
					})
					go h.analytics.TrackAgentRequest(userID, map[string]interface{}{
						"model":         requestedModel,
						"session_id":    sess.ID,
						"input_tokens":  chunk.TokensUsed.PromptTokens,
						"output_tokens": chunk.TokensUsed.CompletionTokens,
						"cost":          turnCost,
						"turn_count":    turn,
					})
					// Store latest usage for end-of-turn PostHog tracking
					lastInputTokens = chunk.TokensUsed.PromptTokens
					lastOutputTokens = chunk.TokensUsed.CompletionTokens
					lastTurnCost = turnCost
					h.usageService.RecordLocalTurn(
						userID, sess.ID, requestedModel, "agent",
						chunk.TokensUsed.PromptTokens,
						chunk.TokensUsed.CompletionTokens,
						chunk.TokensUsed.CacheCreationInputTokens,
						chunk.TokensUsed.CacheReadInputTokens,
						turnCost,
					)
					if userID != "" {
						usage.RecordUsageRemote(usage.RemoteUsageEvent{
							UserID:          userID,
							Model:           requestedModel,
							RequestType:     "agent",
							TokensIn:        chunk.TokensUsed.PromptTokens,
							TokensOut:       chunk.TokensUsed.CompletionTokens,
							CreditsConsumed: turnCost,
							Source:          "agent",
						})
					}
				}
				sc.WriteJSON(chunk)
			case "done":
			}
		})

		// Track single $ai_generation event per turn (after streaming completes)
		if !privacyMode && (lastInputTokens > 0 || lastOutputTokens > 0) {
			go func() {
				var toolNames []string
				for _, tc := range pendingToolCalls {
					toolNames = append(toolNames, tc.Function.Name)
				}
				latency := float64(time.Since(loopStart).Milliseconds()) / 1000.0

				props := map[string]interface{}{
					"$ai_trace_id":                    sess.ID,
					"$ai_model":                       requestedModel,
					"$ai_input_tokens":                lastInputTokens,
					"$ai_output_tokens":               lastOutputTokens,
					"$ai_total_cost_usd":              lastTurnCost,
					"$ai_latency":                     latency,
					"$ai_provider":                    providerFromModel(requestedModel),
					"$ai_is_error":                    err != nil,
					"$ai_cache_read_input_tokens":     tracker.TotalUsage().CacheReadTokens,
					"$ai_cache_creation_input_tokens": tracker.TotalUsage().CacheWriteTokens,
				}
				if len(toolNames) > 0 {
					props["$ai_tools"] = toolNames
				}
				h.analytics.TrackAIGeneration(userID, props)
			}()
		}

		if err != nil {
			errMsg := ai.SanitizeErrorForDisplay(err)
			sc.WriteJSON(ai.StreamChunk{Type: "error", Error: errMsg})
			sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
			if !privacyMode {
				go h.analytics.TrackError(userID, map[string]interface{}{
					"error_type":    "api_error",
					"error_message": err.Error(),
					"session_id":    sess.ID,
					"model":         requestedModel,
				})
			}
			return
		}

		if fullText != "" && !hadToolCalls {
			sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: fullText})

			h.autoTitleAndSave(sess)

			sc.WriteJSON(map[string]interface{}{
				"type": "cost_summary", "usage": tracker.ToJSON(), "summary": tracker.Summary(),
			})

			// In proactive mode, inject a tick to keep the model alive
			// unless the model explicitly stopped (no sleep call = done).
			if currentMode == agent.ModeProactive && turn < cfg.MaxTurns-1 {
				sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
				time.Sleep(2 * time.Second)
				tick := agent.TickMessage()
				// Name "tick" keeps server-injected user messages out of the
				// revert protocol's user-message count (see truncateAfterUserMessage).
				sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: tick, Name: "tick"})
				sc.WriteJSON(map[string]interface{}{"type": "tick", "content": tick})
				continue
			}

			sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
			if !privacyMode {
				go memdir.ExtractMemories(sess.CWD, sess.GetMessages(), h.aiClient)
				go h.learnFromConversation(sess)
				go h.analytics.TrackSessionEnd(userID, map[string]interface{}{
					"session_id":       sess.ID,
					"total_cost":       tracker.TotalCost(),
					"total_tokens":     tracker.TotalUsage().InputTokens + tracker.TotalUsage().OutputTokens,
					"duration_ms":      time.Since(loopStart).Milliseconds(),
					"turn_count":       turn,
					"tools_used_count": len(pendingToolCalls),
				})
			}
			return
		}

		if hadToolCalls {
			pendingToolCalls = agent.DedupeIdempotentCalls(pendingToolCalls)
			for _, tc := range pendingToolCalls {
				sc.WriteJSON(ai.StreamChunk{Type: "tool_call", Content: tc.Function.Name, ToolCalls: []ai.ToolCall{tc}})
			}
			assistantMsg := ai.Message{Role: ai.RoleAssistant, Content: fullText, ToolCalls: pendingToolCalls}
			sess.AddMessage(assistantMsg)

			allowedToolCalls := pendingToolCalls[:0]
			for _, tc := range pendingToolCalls {
				if agent.IsToolAllowedInMode(tc.Function.Name, currentMode) {
					allowedToolCalls = append(allowedToolCalls, tc)
					continue
				}
				output := fmt.Sprintf("ERROR: tool %s is not allowed in %s mode", tc.Function.Name, currentMode)
				sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
				sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
			}
			pendingToolCalls = allowedToolCalls
			if len(pendingToolCalls) == 0 {
				continue
			}

			allReadOnly := true
			for _, tc := range pendingToolCalls {
				if !agent.ReadOnlyTools[tc.Function.Name] {
					allReadOnly = false
					break
				}
			}

			if allReadOnly && len(pendingToolCalls) > 1 {
				agent.ExecuteToolsConcurrent(sc, sess, pendingToolCalls, local)
			} else {
				for _, tc := range pendingToolCalls {
					if tc.Function.Name == "enter_plan_mode" || tc.Function.Name == "exit_plan_mode" {
						// Ask mode is user-controlled: models can emit tool names
						// that were never advertised, so honoring exit_plan_mode
						// here would be an unapproved escalation to write access.
						if currentMode == agent.ModeAsk {
							output := "Mode switching is not available in Ask mode — the user controls the mode. Answer the question with read-only tools."
							sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
							sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
							continue
						}
						var newMode agent.AgentMode
						if tc.Function.Name == "enter_plan_mode" {
							newMode = agent.ModePlan
						} else {
							newMode = agent.ModeAgent

							// Plan approval gate: leaving plan mode re-enables all
							// write tools, so the USER must approve the plan first.
							// The agent never self-promotes to write access.
							if currentMode == agent.ModePlan {
								req := agent.NewPermissionRequest(tc.ID, "exit_plan_mode", tc.Function.Arguments)
								ch := sc.permBroker.Register(tc.ID)
								sc.WriteJSON(req)
								resp, ok := sc.permBroker.Wait(tc.ID, ch, 10*time.Minute)
								if !ok || !resp.Approved {
									output := "The user did NOT approve the plan. Stay in Plan mode: ask what they'd like changed, refine the plan, and call exit_plan_mode again once they're satisfied."
									if !ok {
										output = "Plan approval timed out. Stay in Plan mode and wait for the user's next message."
									}
									sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
									sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
									continue
								}
							}
						}
						output := "MODE_SWITCH:" + string(newMode)
						sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
						sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})

						currentMode = newMode
						sc.currentMode = newMode
						toolDefs = agent.FilterToolDefs(agent.BuildToolDefs(sess.Tools), currentMode)
						if currentMode == agent.ModePlan {
							sysPrompt = h.buildSystemPromptWithFlow(sess, ctx, sc.localExec, sc.flowTracker, sc.userInfo, sc.modelOverride) + agent.PlanModePromptSuffix()
						} else if currentMode == agent.ModeAsk {
							sysPrompt = h.buildSystemPromptWithFlow(sess, ctx, sc.localExec, sc.flowTracker, sc.userInfo, sc.modelOverride) + agent.AskModePromptSuffix()
						} else {
							sysPrompt = h.buildSystemPromptWithFlow(sess, ctx, sc.localExec, sc.flowTracker, sc.userInfo, sc.modelOverride)
						}
						sc.WriteJSON(map[string]interface{}{"type": "mode_change", "mode": string(newMode)})
						continue
					}
					if tc.Function.Name == "spawn_agents" {
						// Subagents get full write tools — respect the user's permission mode.
						if denied := h.checkPermAndMaybeDeny(sc, sess, tc, &cfg); denied {
							continue
						}
						localRouter := &localExecAdapter{sc: sc}
						output := agent.HandleSpawnAgents(sc, sess.CWD, tc, client, h.store, activeAgents, cfg, localRouter)
						sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
					} else if tc.Function.Name == "send_message" {
						output := agent.HandleSendMessage(sc, tc, client, h.store, activeAgents, cfg)
						sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
					} else if tc.Function.Name == "agent_status" {
						output := agent.HandleAgentStatus(tc, activeAgents)
						sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
					} else if tc.Function.Name == "parallel_plan_execute" {
						// Merges worktree branches — respect the user's permission mode.
						if denied := h.checkPermAndMaybeDeny(sc, sess, tc, &cfg); denied {
							continue
						}
						output := agent.HandleParallelPlanExecute(sc, tc, sess.CWD, client, h.store, sess.Tools.Plans, cfg)
						sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
					} else {
						if blocked := fireBeforeToolUseHook(sc, sess, cfg.Hooks, tc, turn, tracker.TotalCost()); blocked {
							continue
						}
						if denied := h.checkPermAndMaybeDeny(sc, sess, tc, &cfg); denied {
							continue
						}
						agent.ExecuteTool(sc, sess, tc, local)
						fireAfterToolUseHook(sess, cfg.Hooks, tc, turn, tracker.TotalCost())
					}
				}
			}

			// Record feedback signals for tool outcomes
			if sc.feedbackTracker != nil {
				h.recordToolFeedback(sc.feedbackTracker, sess, pendingToolCalls, turn, fullText)
			}

			// Track tool executions via PostHog
			for _, tc := range pendingToolCalls {
				if !privacyMode {
					go h.analytics.TrackToolExecution(userID, map[string]interface{}{
						"tool_name":    tc.Function.Name,
						"session_id":   sess.ID,
						"$ai_trace_id": sess.ID,
						"turn":         turn,
						"success":      true,
						"args_length":  len(tc.Function.Arguments),
					})
					go h.analytics.TrackAISpan(userID, map[string]interface{}{
						"$ai_trace_id":  sess.ID,
						"$ai_span_name": "tool:" + tc.Function.Name,
						"$ai_provider":  "sidex",
					})
				}
			}

			sc.WriteJSON(ai.StreamChunk{Type: "turn_complete"})
			h.sm.SaveTranscript(sess)
			continue
		}

		sc.WriteJSON(ai.StreamChunk{Type: "done", Done: true})
		if !privacyMode {
			go memdir.ExtractMemories(sess.CWD, sess.GetMessages(), h.aiClient)
			go h.learnFromConversation(sess)
			go h.analytics.TrackSessionEnd(userID, map[string]interface{}{
				"session_id":    sess.ID,
				"$ai_trace_id":  sess.ID,
				"total_cost":    tracker.TotalCost(),
				"input_tokens":  tracker.TotalUsage().InputTokens,
				"output_tokens": tracker.TotalUsage().OutputTokens,
				"total_tokens":  tracker.TotalUsage().InputTokens + tracker.TotalUsage().OutputTokens,
				"duration_ms":   time.Since(loopStart).Milliseconds(),
				"turn_count":    turn,
				"model":         requestedModel,
				"mode":          string(sc.currentMode),
			})
		}
		return
	}
}

// recordToolFeedback inspects the session messages after tool execution
// and records success/failure signals based on tool result content.
func (h *Handler) recordToolFeedback(tracker *feedback.Tracker, sess *session.Session, toolCalls []ai.ToolCall, turn int, taskContext string) {
	msgs := sess.GetMessages()
	for _, tc := range toolCalls {
		// Find the tool result message
		var errStr string
		for i := len(msgs) - 1; i >= 0; i-- {
			if msgs[i].ToolCallID == tc.ID {
				content := msgs[i].Content
				if isToolError(content) {
					errStr = content
				}
				break
			}
		}
		tracker.RecordToolOutcome(tc.Function.Name, taskContext, turn, errStr)
	}
	go tracker.Flush()
}

func isToolError(content string) bool {
	if len(content) < 5 {
		return false
	}
	prefixes := []string{"ERROR:", "error:", "Error:", "FAILED", "failed"}
	for _, p := range prefixes {
		if len(content) >= len(p) && content[:len(p)] == p {
			return true
		}
	}
	return false
}

// --- REST handlers ---

func (h *Handler) ListSessions(w http.ResponseWriter, r *http.Request) {
	sessions := h.sm.ListForUser(currentUserID(r))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

func (h *Handler) GetSession(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	sess := h.sm.Get(id)
	if sess == nil || sess.UserID != currentUserID(r) {
		http.Error(w, "session not found", 404)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sess)
}

func (h *Handler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	sess := h.sm.Get(id)
	if sess == nil {
		if loaded, err := h.sm.LoadTranscript(id); err == nil {
			sess = loaded
		}
	}
	if sess == nil || sess.UserID != currentUserID(r) {
		http.Error(w, "session not found", 404)
		return
	}
	h.sm.Delete(id)
	w.WriteHeader(204)
}

func (h *Handler) SearchMemory(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	var results []memory.MemoryEntry
	var mErr error
	if query == "" {
		results, mErr = h.store.AllMemoryForUser(currentUserID(r))
	} else {
		results, mErr = h.store.SearchMemoryForUser(query, currentUserID(r))
	}
	if mErr != nil {
		http.Error(w, mErr.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

func (h *Handler) SaveMemory(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024) // 512KB max
	var entry memory.MemoryEntry
	if err := json.NewDecoder(r.Body).Decode(&entry); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if entry.ID == "" {
		entry.ID = uuid.New().String()
	}
	entry.UserID = currentUserID(r)
	entry.CreatedAt = time.Now()
	if err := h.store.SaveMemory(entry); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entry)
}

// checkPermAndMaybeDeny runs the permission gate for a tool call in the
// handler's sequential execution path. Returns true if the tool was denied
// or the user rejected it (result already added to session).
func (h *Handler) checkPermAndMaybeDeny(sc *safeConn, sess *session.Session, tc ai.ToolCall, cfg *agent.Config) bool {
	// Session-level "always allow" bypass
	if cfg.SessionAllowed != nil && cfg.SessionAllowed[tc.Function.Name] {
		return false
	}

	// AutoMode classifier: if enabled, use safety classifier before standard permissions.
	if cfg.AutoMode != nil && cfg.AutoMode.IsEnabled() {
		args := parseToolArgsForPerm(tc.Function.Arguments)
		action := cfg.AutoMode.Classify(tc.Function.Name, args, sess.GetMessages())

		switch action.Decision {
		case agent.DecisionAllow:
			sc.WriteJSON(map[string]interface{}{
				"type":   "auto_approved",
				"tool":   tc.Function.Name,
				"reason": action.Reason,
			})
			if agent.IsFileEditToolName(tc.Function.Name) {
				if path, ok := args["path"].(string); ok {
					cfg.AutoMode.RecordEdit(path)
				}
			}
			return false

		case agent.DecisionBlock:
			output := "ERROR: Auto-mode blocked: " + action.Reason
			sc.WriteJSON(map[string]interface{}{
				"type":   "auto_blocked",
				"tool":   tc.Function.Name,
				"reason": action.Reason,
			})
			sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
			sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
			return true

		case agent.DecisionAsk:
			req := agent.NewPermissionRequest(tc.ID, tc.Function.Name, tc.Function.Arguments)
			ch := sc.permBroker.Register(tc.ID)
			sc.WriteJSON(req)

			resp, ok := sc.permBroker.Wait(tc.ID, ch, 5*time.Minute)
			if !ok {
				output := "ERROR: permission request timed out — tool execution skipped"
				sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
				sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
				return true
			}
			if !resp.Approved {
				cfg.AutoMode.AddToBlockList(tc.Function.Name)
				output := "ERROR: user denied permission for " + tc.Function.Name
				sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
				sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
				return true
			}
			cfg.AutoMode.AddToAllowList(tc.Function.Name)
			if agent.IsFileEditToolName(tc.Function.Name) {
				if path, ok := args["path"].(string); ok {
					cfg.AutoMode.RecordEdit(path)
				}
			}
			return false
		}
	}

	decision := agent.CheckPermission(tc.Function.Name, cfg.PermMode)

	switch decision {
	case agent.PermAllow:
		return false

	case agent.PermDeny:
		output := "ERROR: tool not allowed in current permission mode (" + agent.PermissionModeString(cfg.PermMode) + ")"
		sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
		sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
		return true

	case agent.PermAsk:
		req := agent.NewPermissionRequest(tc.ID, tc.Function.Name, tc.Function.Arguments)
		ch := sc.permBroker.Register(tc.ID)
		sc.WriteJSON(req)

		resp, ok := sc.permBroker.Wait(tc.ID, ch, 5*time.Minute)
		if !ok {
			output := "ERROR: permission request timed out — tool execution skipped"
			sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
			sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
			return true
		}
		if !resp.Approved {
			output := "ERROR: user denied permission for " + tc.Function.Name
			sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
			sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
			return true
		}
		return false
	}

	return false
}

// parseToolArgsForPerm parses JSON arguments into a map for AutoMode classification.
func parseToolArgsForPerm(argsJSON string) map[string]any {
	var args map[string]any
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
		return map[string]any{}
	}
	return args
}

// hookEventsForTool returns the gating lifecycle events to fire before a
// given tool runs: the generic before_tool_use plus the specialized
// before_edit / before_shell events for matching tools.
func hookEventsForTool(toolName string, before bool) []agent.HookEvent {
	var events []agent.HookEvent
	if before {
		events = append(events, agent.HookBeforeToolUse)
	} else {
		events = append(events, agent.HookAfterToolUse)
	}
	switch {
	case agent.IsFileEditToolName(toolName):
		if before {
			events = append(events, agent.HookBeforeEdit)
		} else {
			events = append(events, agent.HookAfterEdit)
		}
	case toolName == "shell" || toolName == "run_background":
		if before {
			events = append(events, agent.HookBeforeShell)
		} else {
			events = append(events, agent.HookAfterShell)
		}
	}
	return events
}

// fireBeforeToolUseHook runs before_tool_use (and before_edit/before_shell)
// hooks for a pending tool call. Returns true if the call was blocked; the
// block reason is streamed and recorded in the session so the model can
// adjust course. Message history is deliberately NOT copied here — gating
// hooks operate on the tool name/args, and copying the full session per tool
// call grows quadratically over long sessions.
func fireBeforeToolUseHook(sc *safeConn, sess *session.Session, hooks *agent.HookRegistry, tc ai.ToolCall, turn int, totalCost float64) bool {
	if hooks == nil {
		return false
	}
	events := hookEventsForTool(tc.Function.Name, true)
	hasAny := false
	for _, ev := range events {
		if hooks.HasHandlers(ev) {
			hasAny = true
			break
		}
	}
	if !hasAny {
		return false
	}

	args := parseToolArgsForPerm(tc.Function.Arguments)
	cmd, _ := args["command"].(string)
	filePath, _ := args["path"].(string)

	for _, ev := range events {
		if !hooks.HasHandlers(ev) {
			continue
		}
		res := hooks.Fire(&agent.HookContext{
			Event:      ev,
			TurnNumber: turn,
			ToolName:   tc.Function.Name,
			ToolArgs:   args,
			Command:    cmd,
			FilePath:   filePath,
			Metadata:   map[string]any{"session_cost": totalCost},
		})
		if res.Allow && !res.Skip {
			continue
		}
		output := res.Inject
		if output == "" {
			output = "ERROR: tool call blocked by hook policy"
		}
		sc.WriteJSON(ai.StreamChunk{Type: "tool_result", Content: output, ToolCalls: []ai.ToolCall{tc}})
		sess.AddMessage(ai.Message{Role: ai.RoleTool, Content: output, ToolCallID: tc.ID, Name: tc.Function.Name})
		return true
	}
	return false
}

// fireAfterToolUseHook runs after_tool_use (and after_edit/after_shell) hooks
// once a tool finishes. Any injected guidance (e.g. auto-format reminders) is
// appended to the session tagged with Name "hook" so it is distinguishable
// from real user input.
func fireAfterToolUseHook(sess *session.Session, hooks *agent.HookRegistry, tc ai.ToolCall, turn int, totalCost float64) {
	if hooks == nil {
		return
	}
	events := hookEventsForTool(tc.Function.Name, false)
	hasAny := false
	for _, ev := range events {
		if hooks.HasHandlers(ev) {
			hasAny = true
			break
		}
	}
	if !hasAny {
		return
	}

	args := parseToolArgsForPerm(tc.Function.Arguments)
	cmd, _ := args["command"].(string)
	filePath, _ := args["path"].(string)

	// Locate this call's recorded output for hook context (scan the tail —
	// ExecuteTool appended it moments ago).
	var toolOutput string
	msgs := sess.GetMessages()
	for i := len(msgs) - 1; i >= 0 && i >= len(msgs)-8; i-- {
		if msgs[i].ToolCallID == tc.ID {
			toolOutput = msgs[i].Content
			break
		}
	}

	for _, ev := range events {
		if !hooks.HasHandlers(ev) {
			continue
		}
		res := hooks.Fire(&agent.HookContext{
			Event:      ev,
			TurnNumber: turn,
			ToolName:   tc.Function.Name,
			ToolArgs:   args,
			ToolOutput: toolOutput,
			Command:    cmd,
			FilePath:   filePath,
			Metadata:   map[string]any{"session_cost": totalCost},
		})
		if res.Inject != "" {
			sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: res.Inject, Name: "hook"})
		}
	}
}

// providerFromModel extracts the provider segment from an OpenRouter-style
// model identifier such as "anthropic/claude-sonnet-4.6".
func providerFromModel(model string) string {
	if i := strings.Index(model, "/"); i > 0 {
		return model[:i]
	}
	if model == "" {
		return "openrouter"
	}
	return model
}

func (h *Handler) autoTitleAndSave(sess *session.Session) {
	if sess.Title == "" {
		for _, m := range sess.GetMessages() {
			if m.Role == ai.RoleUser {
				sess.Title = session.GenerateTitle(m.Content, 50)
				break
			}
		}
	}
	h.sm.SaveTranscript(sess)
}

func (h *Handler) SetSessionTitle(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if body.Title == "" {
		http.Error(w, "title is required", 400)
		return
	}
	sess := h.sm.Get(id)
	if sess == nil {
		if loaded, err := h.sm.LoadTranscript(id); err == nil {
			sess = loaded
		}
	}
	if sess == nil || sess.UserID != currentUserID(r) {
		http.Error(w, "session not found", 404)
		return
	}
	if err := h.sm.SetTitle(id, body.Title); err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": id, "title": body.Title})
}

func (h *Handler) ListTranscripts(w http.ResponseWriter, r *http.Request) {
	transcripts, err := h.sm.ListTranscriptsForUser(currentUserID(r))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(transcripts)
}

func (h *Handler) ResumeSession(w http.ResponseWriter, r *http.Request) {
	id := mux.Vars(r)["id"]
	sess := h.sm.Get(id)
	if sess == nil {
		var err error
		sess, err = h.sm.LoadTranscript(id)
		if err != nil {
			http.Error(w, "session not found", 404)
			return
		}
	}
	if sess.UserID != currentUserID(r) {
		http.Error(w, "session not found", 404)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sess)
}

// --- helpers ---

func tryParseToolResponse(raw []byte) *toolResponseFrame {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Type != "tool_response" {
		return nil
	}
	var frame toolResponseFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil
	}
	return &frame
}

func tryParsePermissionResponse(raw []byte) *permissionResponseFrame {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Type != "permission_response" {
		return nil
	}
	var frame permissionResponseFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil
	}
	return &frame
}

type elicitationResponseFrame struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Answer string `json:"answer"`
}

func tryParseElicitationResponse(raw []byte) *elicitationResponseFrame {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Type != "elicitation_response" {
		return nil
	}
	var frame elicitationResponseFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil
	}
	return &frame
}

func buildSystemReminder(ctx *IDEContext) string {
	if ctx == nil {
		return ""
	}
	pctx := &prompt.IDEContext{
		ActiveFile:       ctx.ActiveFile,
		Language:         ctx.Language,
		Selection:        ctx.Selection,
		WorkspaceFolders: ctx.WorkspaceFolders,
		OpenFiles:        ctx.OpenFiles,
	}
	if ctx.SelectionRange != nil {
		pctx.SelectionRange = &prompt.SelectionRange{
			StartLine:   ctx.SelectionRange.StartLine,
			StartColumn: ctx.SelectionRange.StartColumn,
			EndLine:     ctx.SelectionRange.EndLine,
			EndColumn:   ctx.SelectionRange.EndColumn,
		}
	}
	return prompt.SystemReminder(pctx)
}

// buildContextInjection constructs Cursor-style context blocks that are
// prepended to the user message so the model sees them as part of each turn.
func buildContextInjection(timestamp, gitStatus string, openFiles []string, activeFile string) string {
	var sb strings.Builder

	if timestamp != "" {
		sb.WriteString("<timestamp>")
		sb.WriteString(timestamp)
		sb.WriteString("</timestamp>\n")
	}

	if gitStatus != "" {
		sb.WriteString("<git_status>\nThis is the git status at the start of the conversation.\n\n```\n")
		sb.WriteString(gitStatus)
		sb.WriteString("\n```\n</git_status>\n")
	}

	if len(openFiles) > 0 || activeFile != "" {
		sb.WriteString("<open_and_recently_viewed_files>\n")
		if len(openFiles) > 0 {
			sb.WriteString("Recently viewed files (recent at the top, oldest at the bottom):\n")
			for _, f := range openFiles {
				sb.WriteString("- ")
				sb.WriteString(f)
				sb.WriteString("\n")
			}
			sb.WriteString("\n")
		}
		if activeFile != "" {
			sb.WriteString("Files that are currently open and visible in the user's IDE:\n")
			sb.WriteString("- ")
			sb.WriteString(activeFile)
			sb.WriteString(" (currently focused file)\n")
		}
		sb.WriteString("</open_and_recently_viewed_files>\n")
	}

	if sb.Len() > 0 {
		return sb.String() + "\n"
	}
	return ""
}

func currentUserID(r *http.Request) string {
	if user := auth.GetUser(r.Context()); user != nil {
		return user.UserID
	}
	return ""
}

func (h *Handler) privacyModeEnabled(userID string) bool {
	if userID == "" {
		return false
	}
	db := usage.GetPostgres()
	if db == nil {
		return false
	}
	var enabled bool
	if err := db.QueryRow(`SELECT COALESCE(privacy_mode, false) FROM users WHERE workos_id = $1`, userID).Scan(&enabled); err != nil {
		return false
	}
	return enabled
}

func (h *Handler) getOrCreateSession(id, cwd, userID string) *session.Session {
	if id != "" {
		if s := h.sm.Get(id); s != nil {
			if s.UserID != userID {
				return nil
			}
			return s
		}
		if s, err := h.sm.LoadTranscript(id); err == nil {
			if s.UserID != userID {
				return nil
			}
			h.attachIndexService(s)
			return s
		}
	}
	cwd = resolveCWD(cwd)
	sess := h.sm.CreateForUser(cwd, userID)
	h.attachIndexService(sess)
	h.initMCP(sess)
	return sess
}

// attachIndexService sets the server-side IndexService on the session's tool
// registry so context_search can fall back to server-side search.
func (h *Handler) attachIndexService(sess *session.Session) {
	if h.indexService != nil && sess.Tools != nil {
		sess.Tools.IndexService = h.indexService
	}
}

// initMCP loads .sidex/mcp.json from the session workspace and attaches
// connected MCP servers to the tool registry.
func (h *Handler) initMCP(sess *session.Session) {
	if os.Getenv("SIDEX_ENABLE_SERVER_MCP") != "1" {
		return
	}
	mgr, err := mcp.StartFromConfig(sess.CWD)
	if err != nil {
		log.Printf("mcp: config error for %s: %v", sess.CWD, err)
		return
	}
	if len(mgr.ServerNames()) > 0 {
		sess.Tools.MCP = mgr
		log.Printf("mcp: loaded %d server(s) for session %s", len(mgr.ServerNames()), sess.ID)
	}
}

// wireMCPElicitation sets up the elicitation handler for the session's MCP
// manager, routing elicitation requests through the WebSocket connection.
func (h *Handler) wireMCPElicitation(sess *session.Session, sc *safeConn) {
	if sess.Tools.MCP == nil {
		return
	}
	sess.Tools.MCP.ElicitHandler = mcp.WebSocketElicitationHandler(
		func(v interface{}) { sc.WriteJSON(v) },
		func(id string) <-chan string { return sc.elicitBroker.Register(id) },
	)
}

func resolveCWD(cwd string) string {
	if cwd == "" {
		return "" // Allow empty CWD to signal "no workspace"
	}
	if cwd != "." {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			return cwd
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		if info, err := os.Stat(home); err == nil && info.IsDir() {
			return home
		}
	}
	return "/tmp"
}

func (h *Handler) buildSystemPrompt(sess *session.Session, ctx *IDEContext, localExec bool) string {
	return h.buildSystemPromptWithFlow(sess, ctx, localExec, nil, nil, "")
}

func (h *Handler) buildSystemPromptWithFlow(sess *session.Session, ctx *IDEContext, localExec bool, flowTracker *context.FlowTracker, userInfo *UserInfo, modelOverride string) string {
	memories, _ := h.store.AllMemoryForUser(sess.UserID)
	mems := make([]prompt.Memory, 0, len(memories))
	for _, m := range memories {
		mems = append(mems, prompt.Memory{Key: m.Key, Value: m.Value})
	}

	var pctx *prompt.IDEContext
	if ctx != nil {
		pctx = &prompt.IDEContext{
			ActiveFile:       ctx.ActiveFile,
			Language:         ctx.Language,
			Selection:        ctx.Selection,
			WorkspaceFolders: ctx.WorkspaceFolders,
			OpenFiles:        ctx.OpenFiles,
		}
		if ctx.SelectionRange != nil {
			pctx.SelectionRange = &prompt.SelectionRange{
				StartLine:   ctx.SelectionRange.StartLine,
				StartColumn: ctx.SelectionRange.StartColumn,
				EndLine:     ctx.SelectionRange.EndLine,
				EndColumn:   ctx.SelectionRange.EndColumn,
			}
		}
	}

	// Determine which model is actually being used for this session
	activeModel := modelOverride
	if activeModel == "" {
		activeModel = h.aiClient.Model()
	}

	openFileInfos := promptOpenFilesFromContext(ctx)
	recentFileInfos := promptRecentFilesFromFlow(flowTracker, openFileInfos)

	base := prompt.Build(prompt.Input{
		CWD:          sess.CWD,
		Model:        activeModel,
		IsGit:        isGitRepo(sess.CWD),
		Platform:     "",
		Shell:        detectShell(),
		Context:      pctx,
		Memories:     mems,
		LocalExec:    localExec,
		MemdirPrompt: memdir.LoadMemoryPrompt(sess.CWD),
		RulesPrompt:  prompt.LoadRulesPrompt(sess.CWD),
		PromptMode:   os.Getenv("SIDEX_PROMPT_MODE"),
		UserInfo:     convertUserInfo(userInfo),
		RecentFiles:  recentFileInfos,
		OpenFiles:    openFileInfos,
	})

	// Inject learned behavioral guidance from feedback signals
	if h.analyzer != nil {
		taskCtx := lastUserMessage(sess.GetMessages())
		if guidance := h.analyzer.GenerateGuidance(taskCtx); guidance != "" {
			base += "\n\n" + guidance
		}
	}

	// Inject flow awareness context (priority 600-700: recent IDE activity)
	if flowTracker != nil {
		flowCtx := flowTracker.GetRecentContext(1500)
		if flowCtx != "" {
			base += "\n\n" + flowCtx
		}
	}

	return base
}

func isGitRepo(cwd string) bool {
	if cwd == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(cwd, ".git"))
	return err == nil && info != nil
}

func detectShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return filepath.Base(s)
	}
	return ""
}

func convertUserInfo(ui *UserInfo) *prompt.UserInfoBlock {
	if ui == nil {
		return nil
	}
	return &prompt.UserInfoBlock{
		OS:            ui.OS,
		Shell:         ui.Shell,
		WorkspacePath: ui.WorkspacePath,
		IsGitRepo:     ui.IsGitRepo,
		Date:          ui.Date,
	}
}

func promptOpenFilesFromContext(ctx *IDEContext) []prompt.OpenFileInfo {
	if ctx == nil {
		return nil
	}

	seen := make(map[string]bool)
	files := make([]prompt.OpenFileInfo, 0, 1+len(ctx.OpenFiles))
	add := func(path string, focused bool) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		files = append(files, prompt.OpenFileInfo{
			Path:      path,
			IsFocused: focused,
		})
	}

	add(ctx.ActiveFile, true)
	for _, path := range ctx.OpenFiles {
		add(path, false)
	}
	return files
}

func promptRecentFilesFromFlow(flowTracker *context.FlowTracker, openFiles []prompt.OpenFileInfo) []prompt.OpenFileInfo {
	if flowTracker == nil {
		return nil
	}

	seen := make(map[string]bool, len(openFiles))
	for _, f := range openFiles {
		seen[f.Path] = true
	}

	recent := flowTracker.GetRecentFiles(10)
	files := make([]prompt.OpenFileInfo, 0, len(recent))
	for _, path := range recent {
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		files = append(files, prompt.OpenFileInfo{Path: path})
	}
	return files
}

type feedbackFrame struct {
	Type   string `json:"type"`
	Signal string `json:"signal"`
	Turn   int    `json:"turn"`
	Tool   string `json:"tool"`
}

func tryParseFeedbackEvent(raw []byte) *feedbackFrame {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Type != "feedback" {
		return nil
	}
	var frame feedbackFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil
	}
	return &frame
}

// flowEventFrame represents an IDE flow event received over WebSocket.
type flowEventFrame struct {
	Type      string            `json:"type"`       // "flow_event"
	EventType string            `json:"event_type"` // "file_edit", "file_open", etc.
	FilePath  string            `json:"file_path"`
	Content   string            `json:"content"`
	Metadata  map[string]string `json:"metadata"`
}

func tryParseFlowEvent(raw []byte) *flowEventFrame {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Type != "flow_event" {
		return nil
	}
	var frame flowEventFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil
	}
	if frame.EventType == "" {
		return nil
	}
	return &frame
}

// revertFrame is sent by the client when the user reverts the conversation
// to an earlier checkpoint. KeepUserMessages is the number of user-authored
// messages (counted from the start) that should survive the revert.
type revertFrame struct {
	Type             string `json:"type"`
	SessionID        string `json:"session_id"`
	KeepUserMessages int    `json:"keep_user_messages"`
}

func tryParseRevert(raw []byte) *revertFrame {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Type != "revert" {
		return nil
	}
	var frame revertFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil
	}
	return &frame
}

// truncateAfterUserMessage drops every session message after the Nth
// user-authored message, mirroring a client-side conversation revert.
// Server-injected user messages (Name "hook", "tick", ...) are not counted
// because the client never displays them.
func truncateAfterUserMessage(sess *session.Session, keepUserMessages int) {
	msgs := sess.GetMessages()
	count := 0
	for i, m := range msgs {
		if m.Role == ai.RoleUser && m.Name == "" {
			count++
			if count == keepUserMessages {
				sess.ReplaceMessages(msgs[:i+1])
				return
			}
		}
	}
}

func lastUserMessage(msgs []ai.Message) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == ai.RoleUser {
			content := msgs[i].Content
			if len(content) > 300 {
				content = content[:300]
			}
			return content
		}
	}
	return ""
}

func parseIntEnv(s string) (int, error) {
	return strconv.Atoi(s)
}

// augmentWithContextEngine retrieves relevant code chunks and memories,
// then uses the Priompt assembler to build an optimally-filled context
// that's appended to the system prompt.
func (h *Handler) augmentWithContextEngine(basePrompt string, sess *session.Session, ctx *IDEContext) string {
	if h.indexService == nil && h.memoryStore == nil {
		return basePrompt
	}

	userQuery := lastUserMessage(sess.GetMessages())
	if userQuery == "" {
		return basePrompt
	}

	// Derive namespace from workspace folder path.
	namespace := sess.CWD
	if ctx != nil && len(ctx.WorkspaceFolders) > 0 {
		namespace = ctx.WorkspaceFolders[0]
	}

	var retrievedSection string

	// Retrieve relevant code chunks via IndexService.
	if h.indexService != nil {
		searchStart := time.Now()
		results, err := h.indexService.HybridSearch(namespace, userQuery, 20, namespace)
		if err == nil && len(results) > 0 {
			if !h.privacyModeEnabled(sess.UserID) {
				go h.analytics.TrackAISpan(sess.UserID, map[string]interface{}{
					"$ai_trace_id":  sess.ID,
					"$ai_span_name": "context:semantic_search",
					"$ai_latency":   float64(time.Since(searchStart).Milliseconds()) / 1000.0,
					"results_count": len(results),
				})
			}

			var chunks []string
			for _, r := range results {
				header := fmt.Sprintf("// %s:%d-%d", r.File, r.StartLine, r.EndLine)
				if r.Symbol != "" {
					header += " (" + r.Symbol + ")"
				}
				snippet := r.Snippet
				if snippet == "" {
					snippet = header
				} else {
					snippet = header + "\n" + snippet
				}
				chunks = append(chunks, snippet)
			}
			retrievedSection += "\n\n<retrieved_context>\n" + strings.Join(chunks, "\n---\n") + "\n</retrieved_context>"
		}
	}

	// Retrieve relevant memories via MemoryStore.
	if h.memoryStore != nil {
		var activeFiles []string
		if ctx != nil {
			if ctx.ActiveFile != "" {
				activeFiles = append(activeFiles, ctx.ActiveFile)
			}
			activeFiles = append(activeFiles, ctx.OpenFiles...)
		}
		memories := h.memoryStore.Recall(userQuery, activeFiles, 10)
		if len(memories) > 0 {
			var memLines []string
			for _, m := range memories {
				memLines = append(memLines, "- "+m.Content)
			}
			retrievedSection += "\n\n<learned_conventions>\n" + strings.Join(memLines, "\n") + "\n</learned_conventions>"
		}
	}

	if retrievedSection == "" {
		return basePrompt
	}

	return basePrompt + retrievedSection
}

// learnFromConversation extracts conventions from the completed conversation
// and stores them as auto-memories for future retrieval.
func (h *Handler) learnFromConversation(sess *session.Session) {
	if h.memoryStore == nil || h.privacyModeEnabled(sess.UserID) {
		return
	}

	msgs := sess.GetMessages()
	if len(msgs) == 0 {
		return
	}

	// Convert ai.Message to context.Message for the MemoryStore.
	ctxMsgs := make([]context.Message, 0, len(msgs))
	for _, m := range msgs {
		ctxMsgs = append(ctxMsgs, context.Message{
			Role:    string(m.Role),
			Content: m.Content,
		})
	}

	// Collect tool results from the conversation.
	var toolResults []string
	for _, m := range msgs {
		if m.Role == ai.RoleTool && m.Content != "" {
			toolResults = append(toolResults, m.Content)
		}
	}

	h.memoryStore.Learn(ctxMsgs, toolResults)
}

// isNewerSemver compares two semver strings (e.g. "0.2.0" and "0.1.3")
// and returns true if the candidate is strictly newer than current.
func isNewerSemver(candidate, current string) bool {
	candParts := strings.Split(candidate, ".")
	currParts := strings.Split(current, ".")
	for i := 0; i < len(candParts) && i < len(currParts); i++ {
		candNum, _ := strconv.Atoi(candParts[i])
		currNum, _ := strconv.Atoi(currParts[i])
		if candNum > currNum {
			return true
		}
		if candNum < currNum {
			return false
		}
	}
	return len(candParts) > len(currParts)
}
