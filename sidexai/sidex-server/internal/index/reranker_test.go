package index

import (
	"reflect"
	"testing"
)

func TestNewRerankerDefaults(t *testing.T) {
	t.Setenv("COHERE_API_KEY", "")
	t.Setenv("COHERE_RERANK_ENDPOINT", "")
	t.Setenv("COHERE_RERANK_MODEL", "")

	r := NewReranker()
	if r.apiKey != "" {
		t.Errorf("expected empty apiKey, got %q", r.apiKey)
	}
	if r.endpoint != defaultCohereRerankEndpoint {
		t.Errorf("expected default endpoint %q, got %q", defaultCohereRerankEndpoint, r.endpoint)
	}
	if r.model != defaultCohereRerankModel {
		t.Errorf("expected default model %q, got %q", defaultCohereRerankModel, r.model)
	}
}

func TestNewRerankerEnvOverrides(t *testing.T) {
	t.Setenv("COHERE_API_KEY", "test-key")
	t.Setenv("COHERE_RERANK_ENDPOINT", "https://example.invalid/rerank")
	t.Setenv("COHERE_RERANK_MODEL", "custom-model")

	r := NewReranker()
	if r.endpoint != "https://example.invalid/rerank" {
		t.Errorf("COHERE_RERANK_ENDPOINT override was not applied, got %q", r.endpoint)
	}
	if r.model != "custom-model" {
		t.Errorf("COHERE_RERANK_MODEL override was not applied, got %q", r.model)
	}
}

// Without a key, Rerank must degrade gracefully to passthrough (original
// order, score 0) rather than error — this is the one place across the
// three optional services where "no key" is a real, working mode rather
// than a failure. No network access is required: passthrough returns
// before any request is built.
func TestRerankPassthroughWithoutKey(t *testing.T) {
	r := &Reranker{} // zero-value: no key, no endpoint needed

	docs := []string{"alpha", "beta", "gamma"}
	got, err := r.Rerank("query", docs, 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []RerankResult{
		{Index: 0, Score: 0, Document: "alpha"},
		{Index: 1, Score: 0, Document: "beta"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("passthrough result = %+v, want %+v", got, want)
	}
}

func TestRerankPassthroughTopKClampedToDocumentCount(t *testing.T) {
	r := &Reranker{}
	docs := []string{"only-one"}

	got, err := r.Rerank("query", docs, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Document != "only-one" {
		t.Errorf("expected topK to clamp to len(documents), got %+v", got)
	}
}

// With a key configured but no documents, Rerank must short-circuit before
// attempting any request — verified by asserting a nil result/error rather
// than depending on network reachability.
func TestRerankEmptyDocumentsWithKeyIsNoop(t *testing.T) {
	r := &Reranker{apiKey: "configured"}

	got, err := r.Rerank("query", nil, 5)
	if err != nil {
		t.Errorf("expected no error for empty documents, got: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil results for empty documents, got: %v", got)
	}
}
