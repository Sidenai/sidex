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
	"strings"
	"time"
)

const (
	turbopufferBaseURL    = "https://api.turbopuffer.com"
	turbopufferMaxRetries = 3
)

// Vector represents a single vector with its metadata for storage.
type Vector struct {
	ID         string                 `json:"id"`
	Vector     []float32              `json:"vector,omitempty"`
	Attributes map[string]interface{} `json:"attributes,omitempty"`
}

// QueryResult is a single result from a vector search.
type QueryResult struct {
	ID         string                 `json:"id"`
	Score      float64                `json:"$dist"`
	Attributes map[string]interface{} `json:"attributes,omitempty"`
}

// VectorStore is a client for Turbopuffer's vector database.
//
// The remote vector index is optional and off by default (workspace search
// falls back to on-device BM25/grep). When no API key is configured, every
// method returns a clear, actionable error immediately — doRequest refuses
// to send an unauthenticated request that Turbopuffer would only reject
// after a real round trip (or that would hang until the client timeout if
// the network is unreachable).
type VectorStore struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
}

// NewVectorStore creates a Turbopuffer-backed vector store client.
func NewVectorStore(apiKey string) *VectorStore {
	if apiKey == "" {
		apiKey = os.Getenv("TURBOPUFFER_API_KEY")
	}
	// Silent when unset: the vector store is an opt-in feature, not a
	// misconfiguration, and every normal (local BM25) launch would
	// otherwise print an alarming warning for a service nobody asked for.
	// doRequest returns a clear, actionable error the moment something
	// actually tries to use the store.
	if apiKey != "" {
		log.Println("VectorStore: using Turbopuffer")
	}

	return &VectorStore{
		apiKey:  apiKey,
		baseURL: turbopufferBaseURL,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// sanitizeNamespace converts a namespace like "user/repo" to "user-repo"
// Turbopuffer namespaces must match [A-Za-z0-9-_.]{1,128}
func sanitizeNamespace(ns string) string {
	ns = strings.ReplaceAll(ns, "/", "-")
	ns = strings.ReplaceAll(ns, " ", "_")
	if len(ns) > 128 {
		ns = ns[:128]
	}
	return ns
}

// Upsert stores vectors in the given Turbopuffer namespace.
// Uses the v2 row-based upsert format per docs: POST /v2/namespaces/:namespace
func (vs *VectorStore) Upsert(namespace string, vectors []Vector) error {
	if len(vectors) == 0 {
		return nil
	}

	ns := sanitizeNamespace(namespace)

	rows := make([]map[string]interface{}, len(vectors))
	for i, v := range vectors {
		row := map[string]interface{}{
			"id":     v.ID,
			"vector": v.Vector,
		}
		for key, val := range v.Attributes {
			row[key] = val
		}
		rows[i] = row
	}

	body := map[string]interface{}{
		"upsert_rows":     rows,
		"distance_metric": "cosine_distance",
	}

	endpoint := fmt.Sprintf("%s/v2/namespaces/%s", vs.baseURL, ns)
	_, err := vs.doRequest("POST", endpoint, body)
	return err
}

// Query performs an approximate nearest-neighbor search in the given namespace.
// Uses: POST /v2/namespaces/:namespace/query with rank_by: ["vector", "ANN", [...]]
func (vs *VectorStore) Query(namespace string, vector []float32, topK int, filters map[string]interface{}) ([]QueryResult, error) {
	ns := sanitizeNamespace(namespace)

	body := map[string]interface{}{
		"rank_by": []interface{}{"vector", "ANN", vector},
		"top_k":   topK,
		// Without this Turbopuffer returns only id + $dist.
		"include_attributes": true,
	}
	if len(filters) > 0 {
		body["filters"] = filters
	}

	endpoint := fmt.Sprintf("%s/v2/namespaces/%s/query", vs.baseURL, ns)
	respBody, err := vs.doRequest("POST", endpoint, body)
	if err != nil {
		return nil, err
	}

	// Turbopuffer v2 returns attributes FLATTENED onto each row
	// ({"id":..., "$dist":..., "file_path":...}), not nested under an
	// "attributes" key — parse generically and split them out.
	var queryResp struct {
		Rows []map[string]interface{} `json:"rows"`
	}
	if err := json.Unmarshal(respBody, &queryResp); err != nil {
		return nil, fmt.Errorf("turbopuffer: failed to parse query response: %w", err)
	}

	results := make([]QueryResult, 0, len(queryResp.Rows))
	for _, row := range queryResp.Rows {
		qr := QueryResult{Attributes: make(map[string]interface{})}
		for k, v := range row {
			switch k {
			case "id":
				if s, ok := v.(string); ok {
					qr.ID = s
				}
			case "$dist":
				if f, ok := v.(float64); ok {
					qr.Score = f
				}
			case "vector":
				// not needed in results
			default:
				qr.Attributes[k] = v
			}
		}
		results = append(results, qr)
	}

	return results, nil
}

// DeleteNamespace removes an entire namespace and all its vectors.
// Uses: DELETE /v2/namespaces/:namespace
func (vs *VectorStore) DeleteNamespace(namespace string) error {
	ns := sanitizeNamespace(namespace)
	endpoint := fmt.Sprintf("%s/v2/namespaces/%s", vs.baseURL, ns)
	_, err := vs.doRequest("DELETE", endpoint, nil)
	return err
}

// DeleteByIDs removes specific vectors by their IDs from a namespace.
func (vs *VectorStore) DeleteByIDs(namespace string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}

	ns := sanitizeNamespace(namespace)
	body := map[string]interface{}{
		"deletes": ids,
	}

	endpoint := fmt.Sprintf("%s/v2/namespaces/%s", vs.baseURL, ns)
	_, err := vs.doRequest("POST", endpoint, body)
	return err
}

// DeleteByFilePaths removes every vector whose file_path attribute is in the
// given set. Used to purge stale chunks when files change or are deleted —
// chunk IDs embed line ranges, so re-upserting alone orphans old chunks.
func (vs *VectorStore) DeleteByFilePaths(namespace string, paths []string) error {
	if len(paths) == 0 {
		return nil
	}

	ns := sanitizeNamespace(namespace)
	body := map[string]interface{}{
		"delete_by_filter": []interface{}{"file_path", "In", paths},
	}

	endpoint := fmt.Sprintf("%s/v2/namespaces/%s", vs.baseURL, ns)
	_, err := vs.doRequest("POST", endpoint, body)
	return err
}

// doRequest executes an HTTP request with retries on transient errors.
func (vs *VectorStore) doRequest(method, url string, body interface{}) ([]byte, error) {
	// Fail locally and immediately rather than sending a request with no
	// Authorization value: Turbopuffer would only reject it after a real
	// network round trip (and offline, the caller would wait out the full
	// client timeout for a problem that was knowable up front).
	if vs.apiKey == "" {
		return nil, fmt.Errorf("TURBOPUFFER_API_KEY not configured — vector store unavailable")
	}

	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("turbopuffer: failed to marshal request: %w", err)
		}
	}

	var lastErr error
	for attempt := 0; attempt <= turbopufferMaxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(1<<uint(attempt-1)) * 500 * time.Millisecond
			jitter := time.Duration(rand.Int63n(int64(backoff / 2)))
			time.Sleep(backoff + jitter)
		}

		var req *http.Request
		if payload != nil {
			req, err = http.NewRequest(method, url, bytes.NewReader(payload))
		} else {
			req, err = http.NewRequest(method, url, nil)
		}
		if err != nil {
			return nil, fmt.Errorf("turbopuffer: failed to create request: %w", err)
		}

		req.Header.Set("Authorization", "Bearer "+vs.apiKey)
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := vs.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("turbopuffer: request failed: %w", err)
			continue
		}

		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = fmt.Errorf("turbopuffer: read response failed: %w", err)
			continue
		}

		if resp.StatusCode == 200 {
			return respBody, nil
		}

		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("turbopuffer API error %d: %s", resp.StatusCode, string(respBody))
			continue
		}

		return nil, fmt.Errorf("turbopuffer API error %d: %s", resp.StatusCode, string(respBody))
	}

	return nil, fmt.Errorf("turbopuffer: max retries exceeded: %w", lastErr)
}
