package index

import (
	"crypto/sha256"
	"fmt"
	"log"
	"sync"
	"time"
)

// IndexService orchestrates the chunk → embed → upsert pipeline
// and provides incremental sync via Merkle trees.
type IndexService struct {
	// nsLocks holds one mutex per namespace so indexing one repo never
	// blocks syncs or searches for other repos/users.
	nsLocks sync.Map // namespace → *sync.Mutex

	embedder  *Embedder
	store     *VectorStore
	chunker   *Chunker
	state     *NamespaceState
	reranker  *Reranker
	codeGraph *CodeGraph
	recency   *RecencyTracker
}

// NewIndexService creates an IndexService wired to the embedder and vector store.
func NewIndexService(turbopufferKey string) *IndexService {
	return &IndexService{
		embedder:  NewEmbedder(),
		store:     NewVectorStore(turbopufferKey),
		chunker:   NewDefaultChunker(),
		state:     NewNamespaceState(),
		reranker:  NewReranker(),
		codeGraph: NewCodeGraph(),
		recency:   NewRecencyTracker(),
	}
}

// RecordRead marks a file as recently read by the agent (recency ranking signal).
func (s *IndexService) RecordRead(namespace, path string) {
	s.recency.RecordRead(namespace, path)
}

// IndexStatus summarizes a namespace's index for status reporting.
type IndexStatus struct {
	Indexed    bool   `json:"indexed"`
	Files      int    `json:"files"`
	Chunks     int    `json:"chunks"`
	GraphNodes int    `json:"graph_nodes"`
	GraphEdges int    `json:"graph_edges"`
	LastSynced string `json:"last_synced"`
}

// Status returns the current index state for a namespace.
func (s *IndexService) Status(namespace string) IndexStatus {
	st := IndexStatus{
		Chunks:     s.state.GetChunks(namespace),
		LastSynced: s.state.GetLastSynced(namespace),
	}
	if tree := s.state.Get(namespace); tree != nil {
		st.Indexed = true
		st.Files = tree.FileCount()
	}
	st.GraphNodes, st.GraphEdges = s.codeGraph.Stats(namespace)
	return st
}

// State returns the namespace state tracker for status queries.
func (s *IndexService) State() *NamespaceState {
	return s.state
}

// LockNamespace acquires the per-namespace lock and returns an unlock func.
// Callers that need diff-then-index atomicity (the sync handler) hold this
// across the whole read-diff-index-set sequence.
func (s *IndexService) LockNamespace(namespace string) func() {
	muIface, _ := s.nsLocks.LoadOrStore(namespace, &sync.Mutex{})
	mu := muIface.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

const (
	// maxIndexableFileSize skips huge files (minified bundles, data blobs).
	maxIndexableFileSize = 1 << 20 // 1 MiB
	// snippetMaxLen caps stored snippet length (rune-safe).
	snippetMaxLen = 1200
)

// IndexFiles runs the full chunk → embed → upsert pipeline for the given files.
// Stale vectors for each (re)indexed file are deleted first so edits and
// renames never leave orphaned chunks behind.
// Returns the number of chunks indexed; skipped is retained for API
// compatibility and reports chunks not indexed (currently always 0 — binary
// and oversized files are filtered before chunking).
// Callers must hold the namespace lock (LockNamespace) or use SyncWorkspace.
func (s *IndexService) IndexFiles(namespace string, files map[string][]byte) (indexed, skipped int, err error) {
	var allChunks []Chunk
	var changedPaths []string
	for path, content := range files {
		if len(content) > maxIndexableFileSize || isBinary(content) {
			continue
		}
		changedPaths = append(changedPaths, path)
		chunks, chunkErr := s.chunker.ChunkFile(path, content)
		if chunkErr != nil {
			log.Printf("index: chunking %s failed (falling back to raw): %v", path, chunkErr)
			chunks = fallbackChunk(path, content)
		}
		allChunks = append(allChunks, chunks...)
	}

	if len(allChunks) == 0 {
		return 0, 0, nil
	}

	// Keep the structural code graph in lockstep with the vector index so
	// graph expansion in HybridSearch operates on real, current data.
	s.codeGraph.UpdateFiles(namespace, allChunks)

	// Purge stale vectors for every file we're about to re-index. Chunk IDs
	// embed line ranges, so upserting alone strands old chunks under
	// different IDs after any edit.
	if err := s.store.DeleteByFilePaths(namespace, changedPaths); err != nil {
		log.Printf("index: stale-vector purge failed for %s (continuing): %v", namespace, err)
	}

	// Every chunk of a changed file must be re-embedded and re-upserted:
	// the purge above removed all of the file's vectors, and unchanged files
	// never reach this function (the Merkle diff filters them out). A
	// content-hash skip cache here would silently DROP unchanged chunks of
	// edited files — vectors deleted, then "skipped" — so there isn't one.
	toEmbed := allChunks

	// Embed and upsert in batches: bounded memory, and partial progress is
	// preserved if a later batch fails.
	const batchSize = 100
	for batchStart := 0; batchStart < len(toEmbed); batchStart += batchSize {
		batchEnd := batchStart + batchSize
		if batchEnd > len(toEmbed) {
			batchEnd = len(toEmbed)
		}
		batch := toEmbed[batchStart:batchEnd]

		texts := make([]string, len(batch))
		for i, c := range batch {
			texts[i] = c.Content
		}

		embeddings, embedErr := s.embedder.EmbedBatch(texts)
		if embedErr != nil {
			return indexed, skipped, fmt.Errorf("embedding batch failed: %w", embedErr)
		}
		if len(embeddings) != len(batch) {
			return indexed, skipped, fmt.Errorf("embedding batch returned %d vectors for %d inputs", len(embeddings), len(batch))
		}

		vectors := make([]Vector, 0, len(batch))
		for i, c := range batch {
			id := fmt.Sprintf("%s:%s:%d-%d", namespace, c.FilePath, c.StartLine, c.EndLine)
			vectors = append(vectors, Vector{
				ID:     id,
				Vector: embeddings[i],
				Attributes: map[string]interface{}{
					"file_path":  c.FilePath,
					"line_start": c.StartLine,
					"line_end":   c.EndLine,
					"symbol":     c.SymbolName,
					"language":   c.Language,
					"content":    truncateRunes(c.Content, snippetMaxLen),
				},
			})
		}

		if err := s.store.Upsert(namespace, vectors); err != nil {
			return indexed, skipped, fmt.Errorf("vector upsert failed: %w", err)
		}
		indexed += len(batch)
	}

	s.state.SetChunks(namespace, s.state.GetChunks(namespace)+indexed)
	return indexed, skipped, nil
}

// DeleteFiles removes all vectors belonging to the given file paths.
// Used to propagate file deletions detected by the Merkle diff.
func (s *IndexService) DeleteFiles(namespace string, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	return s.store.DeleteByFilePaths(namespace, paths)
}

// SyncWorkspace performs incremental sync: indexes changed files, removes
// deleted ones, then commits the new tree state. Holds the namespace lock for
// the whole operation so concurrent syncs can't interleave diff/index/set.
func (s *IndexService) SyncWorkspace(namespace string, tree *MerkleTree, changedFiles map[string][]byte, deletedPaths []string) (indexed, skipped int, err error) {
	unlock := s.LockNamespace(namespace)
	defer unlock()

	if err := s.DeleteFiles(namespace, deletedPaths); err != nil {
		log.Printf("index: deletion propagation failed for %s (continuing): %v", namespace, err)
	}

	indexed, skipped, err = s.IndexFiles(namespace, changedFiles)
	if err != nil {
		return indexed, skipped, err
	}

	// Changed files in a sync were just modified in the IDE — the strongest
	// recency signal we have. Feed the ranking booster.
	for path := range changedFiles {
		s.recency.RecordEdit(namespace, path)
	}

	s.state.Set(namespace, tree)
	s.state.SetLastSynced(namespace, time.Now().UTC().Format(time.RFC3339))
	return indexed, skipped, nil
}

// Search performs semantic code search within a namespace.
func (s *IndexService) Search(namespace string, query string, topK int) ([]SearchResult, error) {
	queryVec, err := s.embedder.Embed(query)
	if err != nil {
		return nil, fmt.Errorf("failed to embed query: %w", err)
	}

	results, err := s.store.Query(namespace, queryVec, topK, nil)
	if err != nil {
		return nil, fmt.Errorf("vector query failed: %w", err)
	}

	out := make([]SearchResult, 0, len(results))
	for _, r := range results {
		sr := SearchResult{
			// Turbopuffer returns cosine DISTANCE in [0,2]; normalize to a
			// similarity score in [0,1].
			Score: 1.0 - r.Score/2.0,
		}
		if v, ok := r.Attributes["file_path"].(string); ok {
			sr.File = v
		}
		if v, ok := r.Attributes["line_start"].(float64); ok {
			sr.StartLine = int(v)
		}
		if v, ok := r.Attributes["line_end"].(float64); ok {
			sr.EndLine = int(v)
		}
		if v, ok := r.Attributes["symbol"].(string); ok {
			sr.Symbol = v
		}
		if v, ok := r.Attributes["content"].(string); ok {
			sr.Snippet = v
		}
		out = append(out, sr)
	}
	return out, nil
}

// DeleteNamespace removes all indexed data for a namespace.
func (s *IndexService) DeleteNamespace(namespace string) error {
	unlock := s.LockNamespace(namespace)
	defer unlock()

	s.state.Delete(namespace)
	s.codeGraph.DeleteNamespace(namespace)
	return s.store.DeleteNamespace(namespace)
}

// --- helpers ---

// isBinary reports whether content looks like a binary file.
func isBinary(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	for _, b := range data[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}

func fallbackChunk(path string, content []byte) []Chunk {
	h := sha256.Sum256(content)
	return []Chunk{{
		FilePath:    path,
		Language:    "text",
		StartLine:   1,
		EndLine:     countLines(content),
		Content:     string(content),
		ContentHash: h,
	}}
}

func countLines(data []byte) int {
	n := 1
	for _, b := range data {
		if b == '\n' {
			n++
		}
	}
	return n
}

// truncateRunes caps s at maxLen bytes without splitting a UTF-8 rune.
func truncateRunes(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	cut := maxLen
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut]
}
