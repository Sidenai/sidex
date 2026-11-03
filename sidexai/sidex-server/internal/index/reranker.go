package index

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"time"
)

const (
	// Defaults target Cohere's public API — what a standard COHERE_API_KEY
	// from cohere.com works against. Override COHERE_RERANK_ENDPOINT /
	// COHERE_RERANK_MODEL to point at an alternate deployment (e.g. an
	// Azure AI Foundry-hosted Cohere model), which typically requires both
	// a different endpoint and a differently-named model.
	defaultCohereRerankEndpoint = "https://api.cohere.com/v2/rerank"
	defaultCohereRerankModel    = "rerank-v4.0-pro"
	cohereMaxRetries            = 3
	cohereRequestTimeout        = 30 * time.Second
)

// Reranker is a client for Cohere's Rerank API. When the API key is absent,
// it degrades gracefully by returning documents in their original order.
type Reranker struct {
	apiKey   string
	endpoint string
	model    string
	client   *http.Client
}

// NewReranker creates a Reranker using COHERE_API_KEY from the environment.
// COHERE_RERANK_ENDPOINT and COHERE_RERANK_MODEL override the public Cohere
// defaults (e.g. to point at an Azure-hosted deployment).
func NewReranker() *Reranker {
	key := os.Getenv("COHERE_API_KEY")
	endpoint := os.Getenv("COHERE_RERANK_ENDPOINT")
	if endpoint == "" {
		endpoint = defaultCohereRerankEndpoint
	}
	model := os.Getenv("COHERE_RERANK_MODEL")
	if model == "" {
		model = defaultCohereRerankModel
	}
	// Silent when unset: reranking is an opt-in feature, not a
	// misconfiguration, and every normal (local BM25) launch would
	// otherwise print an alarming warning for a service nobody asked for.
	// Rerank already degrades gracefully to passthrough in that case, so
	// there's no diagnostic being lost by staying quiet here.
	if key != "" {
		log.Printf("Reranker: using Cohere Rerank (%s via %s)", model, endpoint)
	}
	return &Reranker{
		apiKey:   key,
		endpoint: endpoint,
		model:    model,
		client: &http.Client{
			Timeout: cohereRequestTimeout,
		},
	}
}

// RerankResult holds a single reranked document with its relevance score.
type RerankResult struct {
	Index    int
	Score    float64
	Document string
}

// Rerank sends documents to the Cohere Rerank API and returns them sorted by
// relevance to the query. If the API key is not configured, documents are
// returned in original order with a score of 0.
func (r *Reranker) Rerank(query string, documents []string, topK int) ([]RerankResult, error) {
	if r.apiKey == "" {
		return r.passthrough(documents, topK), nil
	}
	if len(documents) == 0 {
		return nil, nil
	}
	if topK <= 0 || topK > len(documents) {
		topK = len(documents)
	}

	reqBody := cohereRerankRequest{
		Model:           r.model,
		Query:           query,
		Documents:       documents,
		TopN:            topK,
		ReturnDocuments: true,
	}

	respBody, err := r.doRequest(reqBody)
	if err != nil {
		return nil, fmt.Errorf("cohere rerank failed: %w", err)
	}

	var resp cohereRerankResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return nil, fmt.Errorf("cohere rerank: failed to parse response: %w", err)
	}

	results := make([]RerankResult, 0, len(resp.Results))
	for _, r := range resp.Results {
		doc := ""
		if r.Document.Text != "" {
			doc = r.Document.Text
		} else if r.Index < len(documents) {
			doc = documents[r.Index]
		}
		results = append(results, RerankResult{
			Index:    r.Index,
			Score:    r.RelevanceScore,
			Document: doc,
		})
	}
	return results, nil
}

func (r *Reranker) passthrough(documents []string, topK int) []RerankResult {
	n := topK
	if n > len(documents) {
		n = len(documents)
	}
	results := make([]RerankResult, n)
	for i := 0; i < n; i++ {
		results[i] = RerankResult{
			Index:    i,
			Score:    0,
			Document: documents[i],
		}
	}
	return results
}

func (r *Reranker) doRequest(body cohereRerankRequest) ([]byte, error) {
	var lastErr error

	for attempt := 0; attempt <= cohereMaxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(1<<uint(attempt-1)) * 500 * time.Millisecond
			jitter := time.Duration(rand.Int63n(int64(backoff / 2)))
			time.Sleep(backoff + jitter)
		}

		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal rerank request: %w", err)
		}

		req, err := http.NewRequest("POST", r.endpoint, bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("failed to create rerank request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+r.apiKey)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")

		resp, err := r.client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("rerank request failed: %w", err)
			continue
		}

		respBytes, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = fmt.Errorf("failed to read rerank response: %w", err)
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return respBytes, nil
		}

		lastErr = fmt.Errorf("cohere API error %d: %s", resp.StatusCode, string(respBytes))

		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			log.Printf("[reranker] retryable error (attempt %d/%d): %v", attempt+1, cohereMaxRetries+1, lastErr)
			continue
		}

		return nil, lastErr
	}

	return nil, fmt.Errorf("cohere rerank max retries exceeded: %w", lastErr)
}

// --- Cohere API types ---

type cohereRerankRequest struct {
	Model           string   `json:"model"`
	Query           string   `json:"query"`
	Documents       []string `json:"documents"`
	TopN            int      `json:"top_n"`
	ReturnDocuments bool     `json:"return_documents"`
}

type cohereRerankResponse struct {
	Results []cohereRerankResult `json:"results"`
}

type cohereRerankResult struct {
	Index          int             `json:"index"`
	RelevanceScore float64         `json:"relevance_score"`
	Document       cohereRerankDoc `json:"document"`
}

type cohereRerankDoc struct {
	Text string `json:"text"`
}
