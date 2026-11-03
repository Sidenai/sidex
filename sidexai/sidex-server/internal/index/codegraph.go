package index

import (
	"strings"
	"sync"
)

// CodeGraph overlays structural relationships (calls, imports, contains) on top
// of indexed code chunks, per namespace. It enables graph expansion: given a
// set of retrieved chunks, pull in structurally related code (callers,
// callees, imports) that pure semantic similarity would miss.
type CodeGraph struct {
	mu     sync.RWMutex
	graphs map[string]*namespaceGraph // namespace → graph
}

// namespaceGraph holds one workspace's structural graph.
type namespaceGraph struct {
	nodes map[string]*GraphNode
	// adjacency: nodeID → neighbor nodeIDs (both directions merged)
	neighbors map[string][]string
	// symbolIndex: bare symbol name → node IDs defining it (for call resolution)
	symbolIndex map[string][]string
}

// GraphNode represents a single entity in the code graph — a symbol within a
// file, carrying enough chunk data to surface as a real search result.
type GraphNode struct {
	ID        string // "filepath#symbol"
	FilePath  string
	Symbol    string
	Kind      string // function, class, type, interface, file
	StartLine int
	EndLine   int
	Snippet   string
}

// NewCodeGraph creates an empty code dependency graph.
func NewCodeGraph() *CodeGraph {
	return &CodeGraph{graphs: make(map[string]*namespaceGraph)}
}

// UpdateFiles incrementally (re)builds graph entries for the given files'
// chunks within a namespace. Called from the indexing pipeline on every sync,
// so the graph always mirrors the vector index.
func (g *CodeGraph) UpdateFiles(namespace string, chunks []Chunk) {
	g.mu.Lock()
	defer g.mu.Unlock()

	ng, ok := g.graphs[namespace]
	if !ok {
		ng = &namespaceGraph{
			nodes:       make(map[string]*GraphNode),
			neighbors:   make(map[string][]string),
			symbolIndex: make(map[string][]string),
		}
		g.graphs[namespace] = ng
	}

	// Drop existing entries for the files being re-indexed.
	touched := make(map[string]bool)
	for i := range chunks {
		touched[chunks[i].FilePath] = true
	}
	ng.removeFiles(touched)

	// First pass: create nodes and the symbol index.
	type pendingRefs struct {
		fromID string
		names  []string
	}
	var pending []pendingRefs

	for i := range chunks {
		ch := &chunks[i]
		if ch.SymbolName == "" || ch.SymbolKind == KindImport {
			continue
		}
		id := ch.FilePath + "#" + ch.SymbolName
		if _, exists := ng.nodes[id]; exists {
			continue
		}
		snippet := ch.Content
		if len(snippet) > snippetMaxLen {
			snippet = truncateRunes(snippet, snippetMaxLen)
		}
		ng.nodes[id] = &GraphNode{
			ID:        id,
			FilePath:  ch.FilePath,
			Symbol:    ch.SymbolName,
			Kind:      string(ch.SymbolKind),
			StartLine: ch.StartLine,
			EndLine:   ch.EndLine,
			Snippet:   snippet,
		}
		ng.symbolIndex[ch.SymbolName] = append(ng.symbolIndex[ch.SymbolName], id)
		pending = append(pending, pendingRefs{fromID: id, names: extractReferences(ch.Content, ch.SymbolName)})
	}

	// Second pass: resolve call references against the symbol index so edges
	// connect real node IDs (bare names would dangle).
	for _, p := range pending {
		for _, name := range p.names {
			for _, toID := range ng.symbolIndex[name] {
				if toID == p.fromID {
					continue
				}
				ng.neighbors[p.fromID] = appendUnique(ng.neighbors[p.fromID], toID)
				ng.neighbors[toID] = appendUnique(ng.neighbors[toID], p.fromID)
			}
		}
	}
}

// removeFiles drops all nodes/edges belonging to the given file set.
func (ng *namespaceGraph) removeFiles(files map[string]bool) {
	var dead []string
	for id, node := range ng.nodes {
		if files[node.FilePath] {
			dead = append(dead, id)
		}
	}
	if len(dead) == 0 {
		return
	}
	deadSet := make(map[string]bool, len(dead))
	for _, id := range dead {
		deadSet[id] = true
	}
	for _, id := range dead {
		node := ng.nodes[id]
		delete(ng.nodes, id)
		delete(ng.neighbors, id)
		// Remove from the symbol index.
		ids := ng.symbolIndex[node.Symbol]
		kept := ids[:0]
		for _, sid := range ids {
			if sid != id {
				kept = append(kept, sid)
			}
		}
		if len(kept) == 0 {
			delete(ng.symbolIndex, node.Symbol)
		} else {
			ng.symbolIndex[node.Symbol] = kept
		}
	}
	// Prune dangling neighbor references.
	for id, ns := range ng.neighbors {
		kept := ns[:0]
		for _, n := range ns {
			if !deadSet[n] {
				kept = append(kept, n)
			}
		}
		ng.neighbors[id] = kept
	}
}

// DeleteNamespace drops a workspace's graph entirely.
func (g *CodeGraph) DeleteNamespace(namespace string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.graphs, namespace)
}

// Expand takes retrieved chunk IDs ("namespace:filepath:start-end") and
// returns structurally related nodes (callers/callees), ranked by how many
// seed chunks they connect to.
func (g *CodeGraph) Expand(namespace string, chunkIDs []string, maxExpansion int) []*GraphNode {
	g.mu.RLock()
	defer g.mu.RUnlock()

	ng, ok := g.graphs[namespace]
	if !ok || maxExpansion <= 0 {
		return nil
	}

	seedFiles := make(map[string]bool)
	seedNodes := make(map[string]bool)
	for _, chunkID := range chunkIDs {
		filePath, startLine, endLine := parseChunkID(chunkID)
		if filePath == "" {
			continue
		}
		seedFiles[filePath] = true
		// Match the chunk to its overlapping symbol nodes in that file.
		for id, node := range ng.nodes {
			if node.FilePath != filePath {
				continue
			}
			if startLine <= node.EndLine && endLine >= node.StartLine {
				seedNodes[id] = true
			}
		}
	}

	counts := make(map[string]int)
	for id := range seedNodes {
		for _, neighbor := range ng.neighbors[id] {
			if seedNodes[neighbor] {
				continue
			}
			counts[neighbor]++
		}
	}

	type ranked struct {
		id    string
		count int
	}
	sorted := make([]ranked, 0, len(counts))
	for id, c := range counts {
		sorted = append(sorted, ranked{id, c})
	}
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j].count > sorted[j-1].count; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}

	out := make([]*GraphNode, 0, maxExpansion)
	for _, r := range sorted {
		if len(out) >= maxExpansion {
			break
		}
		out = append(out, ng.nodes[r.id])
	}
	return out
}

// FindCallers returns nodes connected to any definition of the given symbol.
func (g *CodeGraph) FindCallers(namespace, symbol string) []*GraphNode {
	g.mu.RLock()
	defer g.mu.RUnlock()

	ng, ok := g.graphs[namespace]
	if !ok {
		return nil
	}
	var callers []*GraphNode
	seen := make(map[string]bool)
	for _, defID := range ng.symbolIndex[symbol] {
		for _, n := range ng.neighbors[defID] {
			if !seen[n] {
				seen[n] = true
				if node, ok := ng.nodes[n]; ok {
					callers = append(callers, node)
				}
			}
		}
	}
	return callers
}

// Stats returns node/edge counts for a namespace (for status reporting).
func (g *CodeGraph) Stats(namespace string) (nodes, edges int) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	ng, ok := g.graphs[namespace]
	if !ok {
		return 0, 0
	}
	for _, ns := range ng.neighbors {
		edges += len(ns)
	}
	return len(ng.nodes), edges / 2
}

// parseChunkID splits "namespace:filepath:start-end" into its parts.
func parseChunkID(chunkID string) (filePath string, startLine, endLine int) {
	parts := strings.SplitN(chunkID, ":", 3)
	if len(parts) < 3 {
		return "", 0, 0
	}
	filePath = parts[1]
	rangeStr := parts[2]
	if dash := strings.IndexByte(rangeStr, '-'); dash > 0 {
		startLine = atoiSafe(rangeStr[:dash])
		endLine = atoiSafe(rangeStr[dash+1:])
	}
	return filePath, startLine, endLine
}

func atoiSafe(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int(s[i]-'0')
	}
	return n
}

func appendUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

// extractReferences extracts identifiers from chunk content that look like
// function/method calls (simple heuristic: word followed by '(').
func extractReferences(content string, selfSymbol string) []string {
	seen := make(map[string]bool)
	var refs []string

	for i := 0; i < len(content); i++ {
		if content[i] == '(' && i > 0 {
			end := i
			start := end - 1
			for start > 0 && isIdentChar(content[start-1]) {
				start--
			}
			if start < end {
				name := content[start:end]
				if name != selfSymbol && isValidIdent(name) && !seen[name] {
					seen[name] = true
					refs = append(refs, name)
				}
			}
		}
	}
	return refs
}

func isIdentChar(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
}

func isValidIdent(s string) bool {
	if len(s) < 2 {
		return false
	}
	first := s[0]
	return (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_'
}
