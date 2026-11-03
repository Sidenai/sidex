package index

import (
	"os"
	"testing"
	"time"
)

// TestLivePipeline exercises the full Voyage→Turbopuffer→search pipeline
// against real services. Skipped unless SIDEX_E2E=1 and keys are set:
//
//	set -a; source deploy/.env.api.production; set +a
//	SIDEX_E2E=1 go test ./internal/index/ -run TestLivePipeline -v
func TestLivePipeline(t *testing.T) {
	if os.Getenv("SIDEX_E2E") != "1" || os.Getenv("VOYAGE_API_KEY") == "" || os.Getenv("TURBOPUFFER_API_KEY") == "" {
		t.Skip("set SIDEX_E2E=1 with VOYAGE_API_KEY/TURBOPUFFER_API_KEY for live test")
	}

	svc := NewIndexService(os.Getenv("TURBOPUFFER_API_KEY"))
	ns := "sidex-e2e-test"

	files := map[string][]byte{
		"auth/login.go": []byte("package auth\n\n// Authenticate validates the user's password hash and issues a session token.\nfunc Authenticate(user, password string) (string, error) {\n\treturn issueSessionToken(user)\n}\n\n// issueSessionToken creates a signed session token for the user.\nfunc issueSessionToken(user string) (string, error) {\n\treturn \"token-\" + user, nil\n}\n"),
		"math/sum.go":   []byte("package math\n\n// Sum adds two integers.\nfunc Sum(a, b int) int { return a + b }\n"),
	}
	tree := BuildTree(files)

	indexed, _, err := svc.SyncWorkspace(ns, tree, files, nil)
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	t.Logf("indexed %d chunks", indexed)

	// The structural graph must be populated alongside the vector index.
	st := svc.Status(ns)
	t.Logf("status: %d files, %d chunks, graph %d nodes / %d edges", st.Files, st.Chunks, st.GraphNodes, st.GraphEdges)
	if st.GraphNodes == 0 {
		t.Error("code graph was not populated during sync")
	}

	time.Sleep(2 * time.Second) // let turbopuffer commit

	results, err := svc.HybridSearch(ns, "how is user authentication handled", 5, "")
	if err != nil {
		t.Fatalf("search failed: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("no search results")
	}
	for i, r := range results {
		snippet := r.Snippet
		if len(snippet) > 60 {
			snippet = snippet[:60]
		}
		t.Logf("result %d: %s L%d-%d score=%.3f snippet=%q", i, r.File, r.StartLine, r.EndLine, r.Score, snippet)
	}
	if results[0].File != "auth/login.go" {
		t.Errorf("expected auth/login.go first, got %s", results[0].File)
	}

	if err := svc.DeleteNamespace(ns); err != nil {
		t.Logf("cleanup warning: %v", err)
	}
}
