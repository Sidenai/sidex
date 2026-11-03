package index

import (
	"strings"
	"testing"
)

func TestNewEmbedderDefaultEndpoint(t *testing.T) {
	t.Setenv("VOYAGE_API_KEY", "")
	t.Setenv("VOYAGE_ENDPOINT", "")

	e := NewEmbedder()
	if e.voyageKey != "" {
		t.Errorf("expected empty voyageKey, got %q", e.voyageKey)
	}
	if e.voyageEndpoint != defaultVoyageEndpoint {
		t.Errorf("expected default endpoint %q, got %q", defaultVoyageEndpoint, e.voyageEndpoint)
	}
}

func TestNewEmbedderCustomEndpoint(t *testing.T) {
	t.Setenv("VOYAGE_API_KEY", "")
	t.Setenv("VOYAGE_ENDPOINT", "https://example.invalid/v1/embeddings")

	e := NewEmbedder()
	if e.voyageEndpoint != "https://example.invalid/v1/embeddings" {
		t.Errorf("VOYAGE_ENDPOINT override was not applied, got %q", e.voyageEndpoint)
	}
}

// Embed/EmbedBatch must fail immediately and clearly when no key is
// configured — this is the real diagnostic that replaces the removed
// startup warning. It must not attempt any network call, so this test has
// no dependency on network access or a mock server.
func TestEmbedWithoutKeyFailsFast(t *testing.T) {
	e := &Embedder{} // zero-value: no key, no endpoint needed since the call must never reach the network

	if _, err := e.Embed("some query text"); err == nil {
		t.Fatal("expected an error when VOYAGE_API_KEY is not configured")
	} else if !strings.Contains(err.Error(), "VOYAGE_API_KEY not configured") {
		t.Errorf("error should name the missing env var so the fix is obvious, got: %v", err)
	}

	if _, err := e.EmbedBatch([]string{"a", "b"}); err == nil {
		t.Fatal("expected an error when VOYAGE_API_KEY is not configured")
	} else if !strings.Contains(err.Error(), "VOYAGE_API_KEY not configured") {
		t.Errorf("error should name the missing env var so the fix is obvious, got: %v", err)
	}
}

// An empty batch is a no-op regardless of configuration — it must not be
// treated as a missing-key error.
func TestEmbedBatchEmptyInputIsNoop(t *testing.T) {
	e := &Embedder{}
	results, err := e.EmbedBatch(nil)
	if err != nil {
		t.Errorf("expected no error for an empty batch, got: %v", err)
	}
	if results != nil {
		t.Errorf("expected nil results for an empty batch, got: %v", results)
	}
}
