package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditNotFoundHintSurfacesMatchingPrefix(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.go")
	body := "package a\nfunc Hello() string {\n  return \"hi\"\n}\n"
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	r := NewRegistry(dir)
	// read first so checkStale is happy
	if res := r.Execute("read_file", `{"path":"f.go"}`); res.Error != "" {
		t.Fatal(res.Error)
	}
	// old_string starts with real text, then diverges
	res := r.Execute("edit_file", `{"path":"f.go","old_string":"func Hello() string {\n  return \"bye\"\n}","new_string":"X"}`)
	if res.Error == "" {
		t.Fatalf("expected error, got %q", res.Output)
	}
	if !strings.Contains(res.Error, "old_string not found") {
		t.Fatalf("missing headline: %s", res.Error)
	}
	if !strings.Contains(res.Error, "DO appear") {
		t.Fatalf("hint should point to matching prefix: %s", res.Error)
	}
}

func TestEditAmbiguityPreviewShowsMatchLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	body := "first\ndup\nsecond\ndup\nthird\ndup\n"
	_ = os.WriteFile(path, []byte(body), 0644)
	r := NewRegistry(dir)
	_ = r.Execute("read_file", `{"path":"f.txt"}`)

	res := r.Execute("edit_file", `{"path":"f.txt","old_string":"dup","new_string":"X"}`)
	if res.Error == "" {
		t.Fatalf("expected ambiguity error, got %q", res.Output)
	}
	if !strings.Contains(res.Error, "matches 3 times") {
		t.Fatalf("expected count in error: %s", res.Error)
	}
	// should include at least one numbered match line
	if !strings.Contains(res.Error, "match 1 at line") {
		t.Fatalf("expected preview: %s", res.Error)
	}
}

func TestEditEmptyOldStringRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	_ = os.WriteFile(path, []byte("hello"), 0644)
	r := NewRegistry(dir)
	_ = r.Execute("read_file", `{"path":"f.txt"}`)

	res := r.Execute("edit_file", `{"path":"f.txt","old_string":"","new_string":"x"}`)
	if res.Error == "" || !strings.Contains(res.Error, "old_string is required") {
		t.Fatalf("expected required error: %v", res.Error)
	}
}

func TestTodoWriteActiveFormUsedForInProgress(t *testing.T) {
	r := NewRegistry(t.TempDir())
	payload := `{"todos":[
		{"id":"a","content":"Run the tests","activeForm":"Running the tests","status":"in_progress"},
		{"id":"b","content":"Ship it","status":"pending"}
	]}`
	res := r.Execute("todo_write", payload)
	if res.Error != "" {
		t.Fatalf("todo_write: %s", res.Error)
	}
	if !strings.Contains(res.Output, "[~] a: Running the tests") {
		t.Fatalf("expected activeForm for in_progress: %q", res.Output)
	}
	if !strings.Contains(res.Output, "[ ] b: Ship it") {
		t.Fatalf("expected content for pending: %q", res.Output)
	}
	if len(r.Todos) != 2 {
		t.Fatalf("expected 2 todos, got %d", len(r.Todos))
	}
	if r.Todos[0].ActiveForm != "Running the tests" {
		t.Fatalf("activeForm not preserved: %+v", r.Todos[0])
	}
}

func TestEditSuccessfulReplaceTracksRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hello.txt")
	_ = os.WriteFile(path, []byte("hello"), 0644)
	r := NewRegistry(dir)
	_ = r.Execute("read_file", `{"path":"hello.txt"}`)

	// first edit
	res := r.Execute("edit_file", `{"path":"hello.txt","old_string":"hello","new_string":"world"}`)
	if res.Error != "" {
		t.Fatalf("first edit: %s", res.Error)
	}
	// second edit should NOT error as stale even though we just wrote — trackRead is called after write
	res = r.Execute("edit_file", `{"path":"hello.txt","old_string":"world","new_string":"!"}`)
	if res.Error != "" {
		t.Fatalf("second edit should succeed after chain: %s", res.Error)
	}
}
