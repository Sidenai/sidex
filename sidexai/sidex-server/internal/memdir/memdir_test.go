package memdir

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sidex-ai/sidex-server/internal/paths"
)

func TestEnsureDir(t *testing.T) {
	sidexHome := t.TempDir()
	t.Setenv("SIDEX_HOME", sidexHome)

	projectDir := "/tmp/fake-project"
	if err := EnsureDir(projectDir); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}

	dir := paths.ProjectDir(projectDir)
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("directory not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("expected directory, got file")
	}
}

func TestSaveAndLoadMemoryPrompt(t *testing.T) {
	sidexHome := t.TempDir()
	t.Setenv("SIDEX_HOME", sidexHome)

	projectDir := "/tmp/fake-project"

	if got := LoadMemoryPrompt(projectDir); got != "" {
		t.Fatalf("expected empty prompt before save, got %q", got)
	}

	if err := SaveMemory(projectDir, "Tech Stack", "Go + React + Tauri", "project"); err != nil {
		t.Fatalf("SaveMemory: %v", err)
	}
	if err := SaveMemory(projectDir, "Preferred Style", "Concise, no emojis", "user"); err != nil {
		t.Fatalf("SaveMemory: %v", err)
	}

	prompt := LoadMemoryPrompt(projectDir)
	if prompt == "" {
		t.Fatal("expected non-empty prompt after save")
	}
	if !strings.Contains(prompt, "# Project Memory") {
		t.Error("prompt missing header")
	}
	if !strings.Contains(prompt, "Tech Stack") {
		t.Error("prompt missing first memory key")
	}
	if !strings.Contains(prompt, "Go + React + Tauri") {
		t.Error("prompt missing first memory value")
	}
	if !strings.Contains(prompt, "Preferred Style") {
		t.Error("prompt missing second memory key")
	}
}

func TestListMemories(t *testing.T) {
	sidexHome := t.TempDir()
	t.Setenv("SIDEX_HOME", sidexHome)

	projectDir := "/tmp/fake-project"

	entries := ListMemories(projectDir)
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries before save, got %d", len(entries))
	}

	_ = SaveMemory(projectDir, "DB Choice", "PostgreSQL", "project")
	_ = SaveMemory(projectDir, "Deploy Target", "AWS ECS", "reference")

	entries = ListMemories(projectDir)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}

	if entries[0].Key != "DB Choice" {
		t.Errorf("first key = %q, want %q", entries[0].Key, "DB Choice")
	}
	if entries[0].Category != "project" {
		t.Errorf("first category = %q, want %q", entries[0].Category, "project")
	}
	if entries[1].Key != "Deploy Target" {
		t.Errorf("second key = %q, want %q", entries[1].Key, "Deploy Target")
	}
	if entries[1].Category != "reference" {
		t.Errorf("second category = %q, want %q", entries[1].Category, "reference")
	}
}

func TestLoadMemoryPromptTruncation(t *testing.T) {
	sidexHome := t.TempDir()
	t.Setenv("SIDEX_HOME", sidexHome)

	projectDir := "/tmp/fake-project"
	if err := EnsureDir(projectDir); err != nil {
		t.Fatal(err)
	}

	var b strings.Builder
	for i := 0; i < MaxEntrypointLines+50; i++ {
		b.WriteString("line content\n")
	}
	entrypoint := paths.ProjectMemoryMD(projectDir)
	dir := filepath.Dir(entrypoint)
	os.MkdirAll(dir, 0755)
	if err := os.WriteFile(entrypoint, []byte(b.String()), 0644); err != nil {
		t.Fatal(err)
	}

	prompt := LoadMemoryPrompt(projectDir)
	lines := strings.Split(prompt, "\n")
	if len(lines) > MaxEntrypointLines+10 {
		t.Errorf("expected truncation, got %d lines", len(lines))
	}
}

func TestParseMemoryEntries_Empty(t *testing.T) {
	entries := parseMemoryEntries("")
	if len(entries) != 0 {
		t.Errorf("expected 0 entries for empty input, got %d", len(entries))
	}
}

func TestMigrateFromLegacy(t *testing.T) {
	sidexHome := t.TempDir()
	t.Setenv("SIDEX_HOME", sidexHome)

	projectDir := t.TempDir()

	// Create legacy memory file in the project repo
	legacyDir := filepath.Join(projectDir, ".sidex", "memory")
	os.MkdirAll(legacyDir, 0755)
	legacyContent := "## old_memory\n\n**Category**: project\n**Updated**: 2026-01-01 00:00\n\nlegacy value\n"
	os.WriteFile(filepath.Join(legacyDir, "MEMORY.md"), []byte(legacyContent), 0644)

	// LoadMemoryPrompt should migrate and return the content
	prompt := LoadMemoryPrompt(projectDir)
	if !strings.Contains(prompt, "old_memory") {
		t.Error("migration failed: expected legacy content in prompt")
	}

	// The new location should now have the file
	newPath := paths.ProjectMemoryMD(projectDir)
	if _, err := os.Stat(newPath); err != nil {
		t.Errorf("new memory file not created: %v", err)
	}

	// The old location should be cleaned up
	if _, err := os.Stat(filepath.Join(legacyDir, "MEMORY.md")); !os.IsNotExist(err) {
		t.Error("legacy file not cleaned up after migration")
	}
}
