package index

import (
	"crypto/sha256"
	"fmt"
	"testing"
)

func mkChunk(file, symbol string, kind SymbolKind, start, end int, content string) Chunk {
	return Chunk{
		FilePath:    file,
		SymbolName:  symbol,
		SymbolKind:  kind,
		StartLine:   start,
		EndLine:     end,
		Content:     content,
		ContentHash: sha256.Sum256([]byte(content)),
	}
}

func TestGraphExpandFindsCallers(t *testing.T) {
	g := NewCodeGraph()
	g.UpdateFiles("ns", []Chunk{
		mkChunk("auth.go", "Login", KindFunction, 10, 30,
			"func Login(u string) error { return checkPassword(u) }"),
		mkChunk("auth.go", "checkPassword", KindFunction, 32, 50,
			"func checkPassword(u string) error { return nil }"),
		mkChunk("other.go", "Unrelated", KindFunction, 1, 5,
			"func Unrelated() {}"),
	})

	// Retrieval surfaced the checkPassword chunk → expansion should pull in
	// Login (its caller), not Unrelated.
	seeds := []string{fmt.Sprintf("ns:%s:%d-%d", "auth.go", 32, 50)}
	nodes := g.Expand("ns", seeds, 5)

	found := false
	for _, n := range nodes {
		if n.Symbol == "Unrelated" {
			t.Error("expansion must not include structurally unrelated code")
		}
		if n.Symbol == "Login" {
			found = true
			if n.Snippet == "" || n.StartLine != 10 {
				t.Errorf("expanded node must carry real chunk data, got %+v", n)
			}
		}
	}
	if !found {
		t.Error("expected caller Login in expansion results")
	}
}

func TestGraphIsNamespaceScoped(t *testing.T) {
	g := NewCodeGraph()
	g.UpdateFiles("ns-a", []Chunk{
		mkChunk("a.go", "Foo", KindFunction, 1, 5, "func Foo() { Bar() }"),
		mkChunk("a.go", "Bar", KindFunction, 7, 9, "func Bar() {}"),
	})

	if nodes := g.Expand("ns-b", []string{"ns-b:a.go:7-9"}, 5); len(nodes) != 0 {
		t.Errorf("graph data must not leak across namespaces, got %d nodes", len(nodes))
	}
}

func TestGraphIncrementalUpdateReplacesFile(t *testing.T) {
	g := NewCodeGraph()
	g.UpdateFiles("ns", []Chunk{
		mkChunk("x.go", "Old", KindFunction, 1, 5, "func Old() {}"),
	})
	// Re-index the same file with a renamed symbol.
	g.UpdateFiles("ns", []Chunk{
		mkChunk("x.go", "New", KindFunction, 1, 5, "func New2() { helperFn() }"),
	})

	if callers := g.FindCallers("ns", "Old"); len(callers) != 0 {
		t.Error("stale symbol survived a file re-index")
	}
	nodes, _ := g.Stats("ns")
	if nodes != 1 {
		t.Errorf("expected exactly 1 node after replacement, got %d", nodes)
	}
}

func TestGraphDeleteNamespace(t *testing.T) {
	g := NewCodeGraph()
	g.UpdateFiles("ns", []Chunk{
		mkChunk("a.go", "Foo", KindFunction, 1, 5, "func Foo() {}"),
	})
	g.DeleteNamespace("ns")
	if nodes, edges := g.Stats("ns"); nodes != 0 || edges != 0 {
		t.Errorf("namespace not fully deleted: %d nodes, %d edges", nodes, edges)
	}
}
