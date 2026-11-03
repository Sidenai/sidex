package index

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

const (
	voyageModel = "voyage-code-3"
	// Default endpoint is Voyage AI's public API — what a standard
	// VOYAGE_API_KEY from voyageai.com works against. Override
	// VOYAGE_ENDPOINT to point at an alternate deployment (e.g. a MongoDB
	// Atlas-hosted Voyage integration), which requires an Atlas-issued key.
	defaultVoyageEndpoint = "https://api.voyageai.com/v1/embeddings"
	voyageDimensions      = 1024
	embedMaxRetries       = 3
)

// Embedder generates vector embeddings via Voyage AI (voyage-code-3).
// OpenRouter is the only LLM provider and Voyage the only embedding
// provider — there is intentionally no Bedrock or other fallback.
//
// Semantic embedding is optional and off by default (workspace search
// falls back to on-device BM25/grep). When VOYAGE_API_KEY is unset, Embed
// and EmbedBatch return a clear, actionable error immediately — there is
// no meaningful passthrough for a missing vector, unlike Reranker's
// order-preserving degrade.
type Embedder struct {
	voyageKey      string
	voyageEndpoint string
	httpClient     *http.Client
}

// NewEmbedder creates an embedding client configured from environment variables.
func NewEmbedder() *Embedder {
	voyageKey := os.Getenv("VOYAGE_API_KEY")
	voyageEndpoint := os.Getenv("VOYAGE_ENDPOINT")
	if voyageEndpoint == "" {
		voyageEndpoint = defaultVoyageEndpoint
	}

	// Silent when unset: semantic embedding is an opt-in feature, not a
	// misconfiguration, and every normal (local BM25) launch would
	// otherwise print an alarming warning for a service nobody asked for.
	// The moment code actually tries to embed something, embedBatchTyped
	// returns a clear, actionable error — so nothing is lost by staying
	// quiet here.
	if voyageKey != "" {
		log.Printf("Embedder: using Voyage AI (%s via %s)", voyageModel, voyageEndpoint)
	}

	return &Embedder{
		voyageKey:      voyageKey,
		voyageEndpoint: voyageEndpoint,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Embed generates a QUERY embedding for a single text string. Voyage models
// are asymmetric: queries and documents must be embedded with the matching
// input_type or retrieval quality degrades.
func (e *Embedder) Embed(text string) ([]float32, error) {
	results, err := e.embedBatchTyped([]string{text}, "query")
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("empty embedding response")
	}
	return results[0], nil
}

// EmbedBatch generates DOCUMENT embeddings for multiple text chunks.
func (e *Embedder) EmbedBatch(texts []string) ([][]float32, error) {
	return e.embedBatchTyped(texts, "document")
}

func (e *Embedder) embedBatchTyped(texts []string, inputType string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	if e.voyageKey == "" {
		return nil, fmt.Errorf("VOYAGE_API_KEY not configured — semantic indexing unavailable")
	}
	return e.embedVoyageBatch(texts, inputType)
}

// embedVoyageBatch calls Voyage AI's embedding API (voyage-code-3) with multiple inputs.
func (e *Embedder) embedVoyageBatch(texts []string, inputType string) ([][]float32, error) {
	// Chunk into batches of 128 (Voyage's maximum limit per request)
	const voyageMaxBatch = 128
	var allResults [][]float32

	for i := 0; i < len(texts); i += voyageMaxBatch {
		end := i + voyageMaxBatch
		if end > len(texts) {
			end = len(texts)
		}

		batchTexts := texts[i:end]
		// Truncate individual texts to ~120k chars to avoid token limits
		for j, t := range batchTexts {
			if len(t) > 120000 {
				batchTexts[j] = t[:120000]
			}
		}

		body := map[string]interface{}{
			"input":      batchTexts,
			"model":      voyageModel,
			"input_type": inputType,
		}

		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}

		var lastErr error
		batchSuccess := false

		for attempt := 0; attempt < embedMaxRetries; attempt++ {
			if attempt > 0 {
				time.Sleep(time.Duration(500*(1<<attempt)) * time.Millisecond)
			}

			req, err := http.NewRequest("POST", e.voyageEndpoint, bytes.NewReader(jsonBody))
			if err != nil {
				return nil, err
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+e.voyageKey)

			resp, err := e.httpClient.Do(req)
			if err != nil {
				lastErr = err
				continue
			}

			respBody, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				lastErr = err
				continue
			}

			if resp.StatusCode == 429 || resp.StatusCode >= 500 {
				lastErr = fmt.Errorf("voyage API returned %d: %s", resp.StatusCode, string(respBody))
				continue
			}
			if resp.StatusCode != 200 {
				return nil, fmt.Errorf("voyage API error %d: %s", resp.StatusCode, string(respBody))
			}

			var result struct {
				Data []struct {
					Embedding []float32 `json:"embedding"`
					Index     int       `json:"index"`
				} `json:"data"`
			}
			if err := json.Unmarshal(respBody, &result); err != nil {
				return nil, fmt.Errorf("voyage: parse response: %w", err)
			}
			if len(result.Data) == 0 {
				return nil, fmt.Errorf("voyage: empty response")
			}

			// Ensure they are ordered correctly, and that every slot was
			// actually filled — a missing index must not become a nil vector
			// silently upserted into the store.
			batchEmbeddings := make([][]float32, len(batchTexts))
			for _, d := range result.Data {
				if d.Index >= 0 && d.Index < len(batchTexts) {
					batchEmbeddings[d.Index] = d.Embedding
				}
			}
			for j, emb := range batchEmbeddings {
				if len(emb) == 0 {
					return nil, fmt.Errorf("voyage: response missing embedding for input %d of batch", j)
				}
			}
			allResults = append(allResults, batchEmbeddings...)
			batchSuccess = true
			break
		}

		if !batchSuccess {
			return nil, fmt.Errorf("voyage: max retries exceeded: %w", lastErr)
		}
	}

	return allResults, nil
}
