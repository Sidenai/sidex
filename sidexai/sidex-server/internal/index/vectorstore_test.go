package index

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewVectorStoreFallsBackToEnv(t *testing.T) {
	t.Setenv("TURBOPUFFER_API_KEY", "from-env")

	vs := NewVectorStore("")
	if vs.apiKey != "from-env" {
		t.Errorf("expected apiKey from TURBOPUFFER_API_KEY, got %q", vs.apiKey)
	}
}

func TestNewVectorStoreExplicitArgWins(t *testing.T) {
	t.Setenv("TURBOPUFFER_API_KEY", "from-env")

	vs := NewVectorStore("explicit-key")
	if vs.apiKey != "explicit-key" {
		t.Errorf("explicit argument should take precedence over env, got %q", vs.apiKey)
	}
}

// unroutableBaseURL points at a TEST-NET address (RFC 5737) reserved for
// documentation/testing — it is guaranteed to never be a real Turbopuffer
// endpoint, so if a test using it ever reaches the network something is
// wrong with the fail-fast check under test.
const unroutableBaseURL = "http://192.0.2.1"

// Every public method must refuse to make a network call and instead
// return a clear, actionable error when no API key is configured — that is
// the real diagnostic that replaces the removed startup warning. The exact
// error text is asserted (rather than just "err != nil") specifically to
// prove doRequest short-circuited locally instead of surfacing a wrapped
// network/HTTP error from an attempted, doomed request.
func TestVectorStoreMethodsFailFastWithoutKey(t *testing.T) {
	vs := &VectorStore{
		apiKey:     "",
		baseURL:    unroutableBaseURL,
		httpClient: &http.Client{Timeout: 2 * time.Second},
	}
	const wantErr = "TURBOPUFFER_API_KEY not configured — vector store unavailable"

	start := time.Now()
	if err := vs.Upsert("ns", []Vector{{ID: "1", Vector: []float32{0.1}}}); err == nil || err.Error() != wantErr {
		t.Errorf("Upsert: got %v, want %q", err, wantErr)
	}
	if _, err := vs.Query("ns", []float32{0.1}, 5, nil); err == nil || err.Error() != wantErr {
		t.Errorf("Query: got %v, want %q", err, wantErr)
	}
	if err := vs.DeleteNamespace("ns"); err == nil || err.Error() != wantErr {
		t.Errorf("DeleteNamespace: got %v, want %q", err, wantErr)
	}
	if err := vs.DeleteByIDs("ns", []string{"1"}); err == nil || err.Error() != wantErr {
		t.Errorf("DeleteByIDs: got %v, want %q", err, wantErr)
	}
	if err := vs.DeleteByFilePaths("ns", []string{"a.go"}); err == nil || err.Error() != wantErr {
		t.Errorf("DeleteByFilePaths: got %v, want %q", err, wantErr)
	}
	// A generous upper bound: any of the five calls above hitting the
	// network (even to fail) against an unroutable address would take far
	// longer than this to resolve/timeout.
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("calls took %v — looks like the network was actually hit instead of failing fast", elapsed)
	}
}

// Empty-input calls are no-ops by design (nothing to delete/upsert) and
// must stay that way even without a configured key — they must not be
// reinterpreted as a missing-key error.
func TestVectorStoreEmptyInputsAreNoopsWithoutKey(t *testing.T) {
	vs := &VectorStore{apiKey: ""}

	if err := vs.Upsert("ns", nil); err != nil {
		t.Errorf("Upsert with no vectors should be a no-op, got: %v", err)
	}
	if err := vs.DeleteByIDs("ns", nil); err != nil {
		t.Errorf("DeleteByIDs with no ids should be a no-op, got: %v", err)
	}
	if err := vs.DeleteByFilePaths("ns", nil); err != nil {
		t.Errorf("DeleteByFilePaths with no paths should be a no-op, got: %v", err)
	}
}

// With a key configured, requests must still reach the server exactly as
// before — the fail-fast check must not affect the configured path. Uses a
// local httptest server, so no real network access is required.
func TestVectorStoreQuerySucceedsWithKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("expected Authorization header with configured key, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"rows": []map[string]interface{}{
				{"id": "chunk-1", "$dist": 0.2, "file_path": "main.go"},
			},
		})
	}))
	defer server.Close()

	vs := &VectorStore{
		apiKey:     "test-key",
		baseURL:    server.URL,
		httpClient: server.Client(),
	}

	results, err := vs.Query("my/namespace", []float32{0.1, 0.2}, 5, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 1 || results[0].ID != "chunk-1" {
		t.Errorf("unexpected results: %+v", results)
	}
}

func TestSanitizeNamespace(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"user/repo", "user-repo"},
		{"my workspace", "my_workspace"},
		{"already-clean_ns.1", "already-clean_ns.1"},
	}
	for _, c := range cases {
		if got := sanitizeNamespace(c.in); got != c.want {
			t.Errorf("sanitizeNamespace(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	long := strings.Repeat("a", 200)
	if got := sanitizeNamespace(long); len(got) != 128 {
		t.Errorf("expected truncation to 128 chars, got length %d", len(got))
	}
}
