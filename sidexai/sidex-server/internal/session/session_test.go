package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/memory"
)

func tempStore(t *testing.T) *memory.Store {
	t.Helper()
	dir := t.TempDir()
	s, err := memory.NewBoltStore(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCreateAndGetSession(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)

	sess := mgr.Create("/tmp")
	if sess.ID == "" {
		t.Fatal("expected non-empty session ID")
	}
	if sess.CWD != "/tmp" {
		t.Fatalf("expected CWD /tmp, got %s", sess.CWD)
	}

	got := mgr.Get(sess.ID)
	if got == nil {
		t.Fatal("expected to find session by ID")
	}
	if got.ID != sess.ID {
		t.Fatalf("expected ID %s, got %s", sess.ID, got.ID)
	}
}

func TestAddAndGetMessages(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)
	sess := mgr.Create("/tmp")

	sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: "hello"})
	sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: "hi there"})

	msgs := sess.GetMessages()
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Content != "hello" {
		t.Fatalf("expected first message 'hello', got %q", msgs[0].Content)
	}
	if msgs[1].Content != "hi there" {
		t.Fatalf("expected second message 'hi there', got %q", msgs[1].Content)
	}
}

func TestSaveAndLoadTranscript(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)
	sess := mgr.Create("/tmp")

	sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: "What is Go?"})
	sess.AddMessage(ai.Message{Role: ai.RoleAssistant, Content: "Go is a programming language."})
	sess.Title = "Go question"
	sess.TokensIn = 10
	sess.TokensOut = 20

	if err := mgr.SaveTranscript(sess); err != nil {
		t.Fatalf("save transcript: %v", err)
	}

	// Remove from in-memory map to force a load from disk.
	mgr.sessions.Delete(sess.ID)
	if mgr.Get(sess.ID) != nil {
		t.Fatal("session should not be in memory after delete")
	}

	loaded, err := mgr.LoadTranscript(sess.ID)
	if err != nil {
		t.Fatalf("load transcript: %v", err)
	}

	if loaded.ID != sess.ID {
		t.Fatalf("expected ID %s, got %s", sess.ID, loaded.ID)
	}
	if loaded.Title != "Go question" {
		t.Fatalf("expected title 'Go question', got %q", loaded.Title)
	}
	if loaded.CWD != "/tmp" {
		t.Fatalf("expected CWD /tmp, got %s", loaded.CWD)
	}
	if loaded.TokensIn != 10 || loaded.TokensOut != 20 {
		t.Fatalf("expected tokens 10/20, got %d/%d", loaded.TokensIn, loaded.TokensOut)
	}

	msgs := loaded.GetMessages()
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages after load, got %d", len(msgs))
	}
	if msgs[0].Content != "What is Go?" {
		t.Fatalf("expected first message 'What is Go?', got %q", msgs[0].Content)
	}
	if msgs[1].Content != "Go is a programming language." {
		t.Fatalf("expected second message, got %q", msgs[1].Content)
	}

	// Loaded session should now be in the in-memory map.
	if mgr.Get(sess.ID) == nil {
		t.Fatal("loaded session should be in memory map")
	}
}

func TestListTranscripts(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)

	s1 := mgr.Create("/tmp")
	s1.Title = "Session One"
	s1.AddMessage(ai.Message{Role: ai.RoleUser, Content: "msg1"})
	mgr.SaveTranscript(s1)

	s2 := mgr.Create("/tmp")
	s2.Title = "Session Two"
	s2.AddMessage(ai.Message{Role: ai.RoleUser, Content: "msg2"})
	mgr.SaveTranscript(s2)

	transcripts, err := mgr.ListTranscripts()
	if err != nil {
		t.Fatalf("list transcripts: %v", err)
	}
	if len(transcripts) != 2 {
		t.Fatalf("expected 2 transcripts, got %d", len(transcripts))
	}
	for _, tr := range transcripts {
		if tr.Messages != nil {
			t.Fatal("list transcripts should omit messages")
		}
		if tr.Title == "" {
			t.Fatal("transcript should have a title")
		}
	}
}

func TestDeleteRemovesTranscript(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)

	sess := mgr.Create("/tmp")
	sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: "bye"})
	mgr.SaveTranscript(sess)

	mgr.Delete(sess.ID)

	if mgr.Get(sess.ID) != nil {
		t.Fatal("session should be removed from memory")
	}
	if _, err := mgr.LoadTranscript(sess.ID); err == nil {
		t.Fatal("transcript should be deleted from disk")
	}
}

func TestGenerateTitle(t *testing.T) {
	tests := []struct {
		input    string
		maxLen   int
		expected string
	}{
		{"", 50, "New Session"},
		{"short", 50, "short"},
		{"Hello world", 50, "Hello world"},
		{"This is a very long message that exceeds the fifty character limit by quite a bit", 50, "This is a very long message that exceeds the…"},
		{"NoSpacesHereInThisVeryLongStringThatExceedsLimit!!", 50, "NoSpacesHereInThisVeryLongStringThatExceedsLimit!!"},
	}

	for _, tt := range tests {
		got := GenerateTitle(tt.input, tt.maxLen)
		if got != tt.expected {
			t.Errorf("GenerateTitle(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.expected)
		}
	}
}

func TestSetTitle(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)

	sess := mgr.Create("/tmp")
	sess.AddMessage(ai.Message{Role: ai.RoleUser, Content: "test"})
	mgr.SaveTranscript(sess)

	if err := mgr.SetTitle(sess.ID, "My Title"); err != nil {
		t.Fatalf("set title: %v", err)
	}

	if sess.Title != "My Title" {
		t.Fatalf("expected title 'My Title', got %q", sess.Title)
	}

	// Reload from disk to verify persistence.
	mgr.sessions.Delete(sess.ID)
	loaded, err := mgr.LoadTranscript(sess.ID)
	if err != nil {
		t.Fatalf("load after set title: %v", err)
	}
	if loaded.Title != "My Title" {
		t.Fatalf("persisted title should be 'My Title', got %q", loaded.Title)
	}
}

func TestSetTitleNotFound(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)

	err := mgr.SetTitle("nonexistent", "title")
	if err == nil {
		t.Fatal("expected error for nonexistent session")
	}
}

func TestLoadTranscriptNotFound(t *testing.T) {
	store := tempStore(t)
	mgr := NewManager(store)

	_, err := mgr.LoadTranscript("does-not-exist")
	if err == nil {
		t.Fatal("expected error for missing transcript")
	}
}

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
