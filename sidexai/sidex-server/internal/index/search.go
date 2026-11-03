package index

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
)

// HybridSearch performs a multi-stage retrieval pipeline:
//  1. Vector search → top 100 candidates
//  2. Grep search → additional candidates
//  3. RRF fusion → combined ranked list
//  4. Graph expansion → structurally related chunks
//  5. Cohere Rerank → final top-K with relevance scores
func (s *IndexService) HybridSearch(namespace string, query string, topK int, workDir string) ([]SearchResult, error) {
	const candidateMultiplier = 5
	candidateLimit := topK * candidateMultiplier
	if candidateLimit < 100 {
		candidateLimit = 100
	}

	type vecResult struct {
		results []SearchResult
		err     error
	}
	type grepResult struct {
		results []SearchResult
		err     error
	}

	vecCh := make(chan vecResult, 1)
	grepCh := make(chan grepResult, 1)

	go func() {
		r, err := s.Search(namespace, query, candidateLimit)
		vecCh <- vecResult{r, err}
	}()

	go func() {
		// Grep only works when the workspace actually exists on THIS
		// machine's filesystem (local deployments); remote servers don't
		// have the user's repo on disk.
		if workDir == "" || !dirExists(workDir) {
			grepCh <- grepResult{nil, nil}
			return
		}
		r, err := grepSearch(query, candidateLimit, workDir)
		grepCh <- grepResult{r, err}
	}()

	vr := <-vecCh
	gr := <-grepCh

	if vr.err != nil && gr.err != nil {
		return nil, fmt.Errorf("both searches failed: vector=%v, grep=%v", vr.err, gr.err)
	}

	var vectorResults, grepResults []SearchResult
	if vr.err == nil {
		vectorResults = vr.results
	}
	if gr.err == nil {
		grepResults = gr.results
	}

	// Stage 3: RRF fusion (grep hits are keyed to the vector chunk that
	// contains them, so both retrievers can actually agree on a result)
	merged := fuseVectorAndGrep(vectorResults, grepResults, 60)

	// Stage 4: Graph expansion — add structurally related chunks (callers /
	// callees of the retrieved code) that pure similarity search misses.
	if s.codeGraph != nil && len(merged) > 0 {
		fusionIDs := make([]string, 0, len(merged))
		for _, r := range merged {
			fusionIDs = append(fusionIDs, fmt.Sprintf("%s:%s:%d-%d", namespace, r.File, r.StartLine, r.EndLine))
		}

		maxExpansion := topK / 4
		if maxExpansion < 5 {
			maxExpansion = 5
		}
		for _, node := range s.codeGraph.Expand(namespace, fusionIDs, maxExpansion) {
			alreadyPresent := false
			for _, existing := range merged {
				if existing.File == node.FilePath &&
					node.StartLine <= existing.EndLine && node.EndLine >= existing.StartLine {
					alreadyPresent = true
					break
				}
			}
			if !alreadyPresent {
				merged = append(merged, SearchResult{
					File:      node.FilePath,
					StartLine: node.StartLine,
					EndLine:   node.EndLine,
					Symbol:    node.Symbol,
					Snippet:   node.Snippet,
					// Low seed score: the reranker decides their final
					// position based on actual relevance to the query.
					Score: 0.001,
				})
			}
		}
	}

	// Stage 5: Cohere Rerank
	if s.reranker != nil && len(merged) > 0 {
		reranked, err := s.rerankResults(query, merged, topK)
		if err == nil && len(reranked) > 0 {
			// Stage 6: recency boost — recently edited/read files win ties
			// against semantically similar but stale code.
			s.recency.ApplyRecency(namespace, reranked)
			return reranked, nil
		}
		// On rerank failure, fall through to pre-rerank results.
	}

	if len(merged) > topK {
		merged = merged[:topK]
	}
	s.recency.ApplyRecency(namespace, merged)
	return merged, nil
}

// rerankResults sends merged candidates through the Cohere reranker and returns
// the final ranked results.
func (s *IndexService) rerankResults(query string, candidates []SearchResult, topK int) ([]SearchResult, error) {
	documents := make([]string, len(candidates))
	for i, c := range candidates {
		doc := c.Snippet
		if doc == "" {
			doc = fmt.Sprintf("%s:%d-%d %s", c.File, c.StartLine, c.EndLine, c.Symbol)
		}
		documents[i] = doc
	}

	reranked, err := s.reranker.Rerank(query, documents, topK)
	if err != nil {
		return nil, err
	}

	results := make([]SearchResult, 0, len(reranked))
	for _, rr := range reranked {
		if rr.Index < 0 || rr.Index >= len(candidates) {
			continue
		}
		sr := candidates[rr.Index]
		sr.Score = rr.Score
		results = append(results, sr)
	}
	return results, nil
}

func grepSearch(query string, limit int, workDir string) ([]SearchResult, error) {
	keywords := extractKeywords(query)
	if len(keywords) == 0 {
		return nil, nil
	}

	// Quote each keyword — query tokens like "(", "+", "*" must not produce
	// invalid (silently failing) regex patterns.
	quoted := make([]string, len(keywords))
	for i, kw := range keywords {
		quoted[i] = regexp.QuoteMeta(kw)
	}
	pattern := strings.Join(quoted, "|")

	args := []string{
		"--no-heading", "--line-number",
		"--max-filesize", "1M",
		"--max-count", fmt.Sprintf("%d", limit),
		"-i",
		pattern,
		workDir,
	}

	cmd := exec.Command("rg", args...)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return nil, nil
	}

	return parseGrepOutput(string(out)), nil
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func parseGrepOutput(output string) []SearchResult {
	lines := strings.Split(strings.TrimSpace(output), "\n")

	var results []SearchResult
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 3)
		if len(parts) < 3 {
			continue
		}

		filePath := parts[0]
		lineNum := 0
		fmt.Sscanf(parts[1], "%d", &lineNum)

		results = append(results, SearchResult{
			File:      filePath,
			StartLine: lineNum,
			EndLine:   lineNum,
			Snippet:   parts[2],
			Score:     0,
		})
	}
	return results
}

func extractKeywords(query string) []string {
	stopWords := map[string]bool{
		"the": true, "a": true, "an": true, "is": true, "are": true,
		"was": true, "were": true, "be": true, "been": true, "being": true,
		"have": true, "has": true, "had": true, "do": true, "does": true,
		"did": true, "will": true, "would": true, "could": true, "should": true,
		"may": true, "might": true, "can": true, "this": true, "that": true,
		"these": true, "those": true, "i": true, "you": true, "he": true,
		"she": true, "it": true, "we": true, "they": true, "what": true,
		"which": true, "who": true, "whom": true, "where": true, "when": true,
		"why": true, "how": true, "and": true, "or": true, "but": true,
		"in": true, "on": true, "at": true, "to": true, "for": true,
		"of": true, "with": true, "by": true, "from": true, "as": true,
		"into": true, "through": true, "during": true, "before": true,
		"after": true, "above": true, "below": true, "between": true,
		"not": true, "no": true, "all": true, "each": true, "every": true,
		"both": true, "few": true, "more": true, "most": true, "other": true,
		"some": true, "such": true, "only": true, "own": true, "same": true,
		"than": true, "too": true, "very": true, "just": true,
	}

	words := strings.Fields(strings.ToLower(query))
	var keywords []string
	for _, w := range words {
		w = strings.Trim(w, ".,;:!?\"'()[]{}")
		if len(w) < 2 || stopWords[w] {
			continue
		}
		keywords = append(keywords, w)
	}
	return keywords
}

// fuseVectorAndGrep merges vector-chunk results with line-level grep hits
// using Reciprocal Rank Fusion. A grep hit whose line falls inside a vector
// chunk's range is fused into that chunk (key by chunk range) instead of
// being treated as a separate result — keying by exact start line meant the
// two lists could never agree.
func fuseVectorAndGrep(vectorList, grepList []SearchResult, k int) []SearchResult {
	type scored struct {
		result SearchResult
		score  float64
	}

	chunkKey := func(r SearchResult) string {
		return fmt.Sprintf("%s:%d-%d", r.File, r.StartLine, r.EndLine)
	}

	scoreMap := make(map[string]*scored)

	// Index vector chunks by file for line-containment lookup.
	chunksByFile := make(map[string][]SearchResult)
	for rank, r := range vectorList {
		key := chunkKey(r)
		rrfScore := 1.0 / float64(k+rank+1)
		if existing, ok := scoreMap[key]; ok {
			existing.score += rrfScore
		} else {
			scoreMap[key] = &scored{result: r, score: rrfScore}
		}
		chunksByFile[r.File] = append(chunksByFile[r.File], r)
	}

	for rank, g := range grepList {
		rrfScore := 1.0 / float64(k+rank+1)

		// Find a containing vector chunk for this grep hit.
		fused := false
		for _, c := range chunksByFile[g.File] {
			if g.StartLine >= c.StartLine && g.StartLine <= c.EndLine {
				if existing, ok := scoreMap[chunkKey(c)]; ok {
					existing.score += rrfScore
					fused = true
				}
				break
			}
		}
		if fused {
			continue
		}

		key := chunkKey(g)
		if existing, ok := scoreMap[key]; ok {
			existing.score += rrfScore
		} else {
			scoreMap[key] = &scored{result: g, score: rrfScore}
		}
	}

	merged := make([]SearchResult, 0, len(scoreMap))
	for _, s := range scoreMap {
		s.result.Score = s.score
		merged = append(merged, s.result)
	}

	sort.Slice(merged, func(i, j int) bool {
		return merged[i].Score > merged[j].Score
	})

	return merged
}
