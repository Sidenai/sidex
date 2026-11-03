package api

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/sidex-ai/sidex-server/internal/auth"
	"github.com/sidex-ai/sidex-server/internal/index"
)

// IndexHandler exposes HTTP endpoints for the indexing and semantic search system.
type IndexHandler struct {
	svc *index.IndexService
}

// NewIndexHandler creates a handler backed by the given IndexService.
func NewIndexHandler(svc *index.IndexService) *IndexHandler {
	return &IndexHandler{svc: svc}
}

// --- request/response types ---

type syncRequest struct {
	Namespace string            `json:"namespace"`
	RootHash  string            `json:"root_hash"`
	Files     map[string]string `json:"files"`
	// Full indicates the payload is a COMPLETE workspace snapshot. Deletion
	// inference ("in old tree, missing from payload") is only safe for full
	// snapshots — clients cap uploads, so a partial payload must never be
	// interpreted as mass deletion.
	Full bool `json:"full"`
}

type syncResponse struct {
	Indexed  int    `json:"indexed"`
	Skipped  int    `json:"skipped"`
	RootHash string `json:"root_hash"`
}

type searchRequest struct {
	Namespace string `json:"namespace"`
	Query     string `json:"query"`
	TopK      int    `json:"top_k"`
}

type searchResultJSON struct {
	File      string  `json:"file"`
	StartLine int     `json:"start_line"`
	EndLine   int     `json:"end_line"`
	Symbol    string  `json:"symbol"`
	Score     float64 `json:"score"`
	Snippet   string  `json:"snippet"`
}

type searchResponseJSON struct {
	Results []searchResultJSON `json:"results"`
}

type statusResponse struct {
	Namespace   string `json:"namespace"`
	TotalChunks int    `json:"total_chunks"`
	LastSynced  string `json:"last_synced"`
	RootHash    string `json:"root_hash"`
}

// --- handlers ---

// Sync handles POST /v1/index/sync — incremental workspace indexing via Merkle diff.
func (h *IndexHandler) Sync(w http.ResponseWriter, r *http.Request) {
	// Bound request size: full-repo JSON payloads must not be able to OOM the server.
	r.Body = http.MaxBytesReader(w, r.Body, 256<<20) // 256 MiB

	var req syncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeIndexError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Namespace == "" {
		writeIndexError(w, "namespace is required", http.StatusBadRequest)
		return
	}

	files := make(map[string][]byte, len(req.Files))
	for path, content := range req.Files {
		files[path] = []byte(content)
	}

	clientTree := index.BuildTree(files)

	// Check if client root matches server — if so, nothing changed.
	storedNamespace := scopedIndexNamespace(r, req.Namespace)
	serverTree := h.svc.State().Get(storedNamespace)
	if serverTree != nil && req.RootHash != "" && serverTree.RootHash() == req.RootHash {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(syncResponse{
			Indexed:  0,
			Skipped:  len(files),
			RootHash: serverTree.RootHash(),
		})
		return
	}

	// Determine which files changed and which were DELETED. Deletions must be
	// propagated to the vector store or the index goes permanently stale —
	// but ONLY when the client asserts a full snapshot: "absent from a
	// partial payload" is not "deleted on disk".
	changedPaths := index.Diff(serverTree, clientTree)
	changedFiles := make(map[string][]byte, len(changedPaths))
	var deletedPaths []string
	for _, p := range changedPaths {
		if content, ok := files[p]; ok {
			changedFiles[p] = content
		} else if req.Full {
			// Present in the old server tree but absent from the client's
			// complete snapshot → the file was deleted.
			deletedPaths = append(deletedPaths, p)
		}
	}

	// First sync: index everything provided.
	if serverTree == nil {
		changedFiles = files
		deletedPaths = nil
	}

	indexed, skipped, err := h.svc.SyncWorkspace(storedNamespace, clientTree, changedFiles, deletedPaths)
	if err != nil {
		writeIndexError(w, "sync failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(syncResponse{
		Indexed:  indexed,
		Skipped:  skipped,
		RootHash: clientTree.RootHash(),
	})
}

// Search handles POST /v1/index/search — semantic code search.
func (h *IndexHandler) Search(w http.ResponseWriter, r *http.Request) {
	var req searchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeIndexError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Namespace == "" {
		writeIndexError(w, "namespace is required", http.StatusBadRequest)
		return
	}
	if req.Query == "" {
		writeIndexError(w, "query is required", http.StatusBadRequest)
		return
	}
	if req.TopK <= 0 {
		req.TopK = 10
	}
	if req.TopK > 100 {
		req.TopK = 100
	}

	// Hybrid retrieval (vector ∥ grep → RRF → rerank). The namespace is the
	// workspace path, so on local deployments the grep stage activates too.
	storedNamespace := scopedIndexNamespace(r, req.Namespace)
	results, err := h.svc.HybridSearch(storedNamespace, req.Query, req.TopK, req.Namespace)
	if err != nil {
		writeIndexError(w, "search failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	out := make([]searchResultJSON, 0, len(results))
	for _, r := range results {
		out = append(out, searchResultJSON{
			File:      r.File,
			StartLine: r.StartLine,
			EndLine:   r.EndLine,
			Symbol:    r.Symbol,
			Score:     r.Score,
			Snippet:   r.Snippet,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(searchResponseJSON{Results: out})
}

// Status handles GET /v1/index/status — returns indexing status for a namespace.
func (h *IndexHandler) Status(w http.ResponseWriter, r *http.Request) {
	namespace := r.URL.Query().Get("namespace")
	if namespace == "" {
		writeIndexError(w, "namespace query parameter is required", http.StatusBadRequest)
		return
	}

	state := h.svc.State()
	storedNamespace := scopedIndexNamespace(r, namespace)
	rootHash := ""
	if tree := state.Get(storedNamespace); tree != nil {
		rootHash = tree.RootHash()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(statusResponse{
		Namespace:   namespace,
		TotalChunks: state.GetChunks(storedNamespace),
		LastSynced:  state.GetLastSynced(storedNamespace),
		RootHash:    rootHash,
	})
}

// DeleteIndex handles DELETE /v1/index/{namespace} — removes all indexed data.
func (h *IndexHandler) DeleteIndex(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	namespace := vars["namespace"]
	if rest := vars["rest"]; rest != "" {
		namespace = namespace + "/" + rest
	}
	if namespace == "" {
		writeIndexError(w, "namespace is required", http.StatusBadRequest)
		return
	}

	if err := h.svc.DeleteNamespace(scopedIndexNamespace(r, namespace)); err != nil {
		writeIndexError(w, "delete failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func scopedIndexNamespace(r *http.Request, namespace string) string {
	if user := auth.GetUser(r.Context()); user != nil && user.UserID != "" {
		return user.UserID + "::" + namespace
	}
	return "anonymous::" + namespace
}

// RegisterRoutes attaches index routes to a subrouter.
func (h *IndexHandler) RegisterRoutes(r *mux.Router) {
	r.HandleFunc("/index/sync", h.Sync).Methods("POST", "OPTIONS")
	r.HandleFunc("/index/search", h.Search).Methods("POST", "OPTIONS")
	r.HandleFunc("/index/status", h.Status).Methods("GET", "OPTIONS")
	r.HandleFunc("/index/{namespace}/{rest:.*}", h.DeleteIndex).Methods("DELETE", "OPTIONS")
	r.HandleFunc("/index/{namespace}", h.DeleteIndex).Methods("DELETE", "OPTIONS")
}

// writeIndexError sends a JSON error response.
func writeIndexError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
