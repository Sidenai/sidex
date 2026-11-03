package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/sidex-ai/sidex-server/internal/auth"
	sidexcontext "github.com/sidex-ai/sidex-server/internal/context"
	"github.com/sidex-ai/sidex-server/internal/memory"
	"github.com/sidex-ai/sidex-server/internal/session"
)

func TestResolveCWDFallsBackForMissingDir(t *testing.T) {
	got := resolveCWD("/absolutely/nope/not/real")
	if got == "/absolutely/nope/not/real" {
		t.Fatalf("expected fallback, got %q", got)
	}
	if got == "" {
		t.Fatalf("empty fallback")
	}
}

func TestResolveCWDKeepsExistingDir(t *testing.T) {
	dir := t.TempDir()
	got := resolveCWD(dir)
	if got != dir {
		t.Fatalf("expected %q, got %q", dir, got)
	}
}

func TestResolveCWDEmptyMeansNoWorkspace(t *testing.T) {
	// Empty CWD deliberately stays empty to signal "no workspace" —
	// the session then runs without a working directory until one is set.
	if got := resolveCWD(""); got != "" {
		t.Fatalf("expected empty CWD to be preserved, got %q", got)
	}
}

func TestBuildSystemReminderWrapsContext(t *testing.T) {
	r := buildSystemReminder(&IDEContext{ActiveFile: "/a.ts", Language: "ts"})
	if r == "" {
		t.Fatalf("expected non-empty reminder")
	}
	if !strings.HasPrefix(r, "<system-reminder>") || !strings.HasSuffix(r, "</system-reminder>") {
		t.Fatalf("reminder must be wrapped in tags: %q", r)
	}
	if !strings.Contains(r, "active_file=/a.ts") {
		t.Fatalf("reminder missing active_file: %q", r)
	}
}

func TestBuildSystemReminderEmpty(t *testing.T) {
	if buildSystemReminder(nil) != "" {
		t.Fatalf("nil should be empty")
	}
	if buildSystemReminder(&IDEContext{}) != "" {
		t.Fatalf("empty ctx should be empty")
	}
}

func TestIsGitRepoDetection(t *testing.T) {
	dir := t.TempDir()
	if isGitRepo(dir) {
		t.Fatalf("not a repo yet")
	}
	if err := os.MkdirAll(dir+"/.git", 0755); err != nil {
		t.Fatal(err)
	}
	if !isGitRepo(dir) {
		t.Fatalf("should detect .git")
	}
	if isGitRepo("") {
		t.Fatalf("empty should be false")
	}
}

func TestBuildSystemPromptIncludesFocusedAndRecentFiles(t *testing.T) {
	store, err := memory.NewBoltStore(filepath.Join(t.TempDir(), "memory.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	flow := sidexcontext.NewFlowTracker()
	flow.Record(sidexcontext.FlowEvent{Type: "file_edit", FilePath: "/repo/src/recent.ts"})
	flow.Record(sidexcontext.FlowEvent{Type: "file_open", FilePath: "/repo/package.json"})

	h := &Handler{store: store}
	sess := &session.Session{CWD: t.TempDir()}
	ctx := &IDEContext{
		ActiveFile: "/repo/package.json",
		OpenFiles:  []string{"/repo/src/app.ts"},
	}

	out := h.buildSystemPromptWithFlow(sess, ctx, true, flow, nil, "test-model")

	if !strings.Contains(out, "<open_and_recently_viewed_files>") {
		t.Fatalf("expected open/recent file context in prompt:\n%s", out)
	}
	if !strings.Contains(out, "- /repo/package.json (currently focused file)") {
		t.Fatalf("expected focused active file in prompt:\n%s", out)
	}
	if !strings.Contains(out, "- /repo/src/app.ts") {
		t.Fatalf("expected other open file in prompt:\n%s", out)
	}
	if !strings.Contains(out, "- /repo/src/recent.ts") {
		t.Fatalf("expected recent flow file in prompt:\n%s", out)
	}
	if strings.Count(out, "/repo/package.json") < 1 {
		t.Fatalf("expected active file path in prompt:\n%s", out)
	}
}

func TestSessionHandlersEnforceUserOwnership(t *testing.T) {
	store, err := memory.NewBoltStore(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	h := &Handler{sm: session.NewManager(store), store: store}
	owned := h.sm.CreateForUser(t.TempDir(), "user-a")
	other := h.sm.CreateForUser(t.TempDir(), "user-b")

	req := httptestRequestForUser("GET", "/v1/sessions", "user-a")
	rr := httptestResponse()
	h.ListSessions(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("ListSessions status=%d", rr.Code)
	}
	var sessions []session.Session
	if err := json.Unmarshal(rr.Body.Bytes(), &sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != owned.ID {
		t.Fatalf("expected only owned session, got %+v", sessions)
	}

	req = httptestRequestForUser("GET", "/v1/sessions/"+other.ID, "user-a")
	req = mux.SetURLVars(req, map[string]string{"id": other.ID})
	rr = httptestResponse()
	h.GetSession(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected cross-user session lookup to 404, got %d", rr.Code)
	}
}

func httptestRequestForUser(method, target, userID string) *http.Request {
	req, _ := http.NewRequest(method, target, nil)
	ctx := context.WithValue(req.Context(), auth.UserContextKey, &auth.UserContext{UserID: userID, Email: userID + "@example.com", Plan: "pro"})
	return req.WithContext(ctx)
}

func httptestResponse() *httptest.ResponseRecorder {
	return httptest.NewRecorder()
}
