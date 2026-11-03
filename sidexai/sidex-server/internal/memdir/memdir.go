package memdir

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sidex-ai/sidex-server/internal/paths"
)

const (
	EntrypointFile     = "memory.md"
	MaxEntrypointLines = 200
)

// Deprecated paths (kept for migration only)
const legacyMemoryDir = ".sidex/memory"
const legacyEntrypointFile = "MEMORY.md"

// MemoryEntry represents a single memory from the filesystem.
type MemoryEntry struct {
	Key      string
	Value    string
	Category string // user, project, feedback, reference
	FilePath string
	ModTime  time.Time
}

// EnsureDir creates the project state directory in ~/.sidex/projects/<slug>/.
func EnsureDir(projectDir string) error {
	return paths.EnsureProjectDirs(projectDir)
}

// LoadMemoryPrompt reads the memory file and builds a prompt section
// containing all memories. This is injected into the system prompt.
// Memory is stored at ~/.sidex/projects/<slug>/memory.md, NOT in the user's repo.
func LoadMemoryPrompt(projectDir string) string {
	entrypoint := paths.ProjectMemoryMD(projectDir)

	// Fall back to legacy location for migration
	if _, err := os.Stat(entrypoint); os.IsNotExist(err) {
		legacy := filepath.Join(projectDir, legacyMemoryDir, legacyEntrypointFile)
		if _, err2 := os.Stat(legacy); err2 == nil {
			migrateMemory(legacy, entrypoint)
		} else {
			return ""
		}
	}

	content, err := os.ReadFile(entrypoint)
	if err != nil {
		return ""
	}

	lines := strings.Split(string(content), "\n")
	if len(lines) > MaxEntrypointLines {
		lines = lines[:MaxEntrypointLines]
	}

	body := strings.TrimSpace(strings.Join(lines, "\n"))
	if body == "" {
		return ""
	}

	return fmt.Sprintf("# Project Memory\n\nThe following memories are from previous sessions. Trust them as useful context but verify before acting on anything consequential.\n\n%s", body)
}

// SaveMemory writes a memory entry. Stored at ~/.sidex/projects/<slug>/memory.md.
func SaveMemory(projectDir, key, value, category string) error {
	if err := paths.EnsureProjectDirs(projectDir); err != nil {
		return err
	}

	entrypoint := paths.ProjectMemoryMD(projectDir)

	entry := fmt.Sprintf("\n## %s\n\n**Category**: %s\n**Updated**: %s\n\n%s\n",
		key, category, time.Now().Format("2006-01-02 15:04"), value)

	f, err := os.OpenFile(entrypoint, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = f.WriteString(entry)
	return err
}

// ListMemories returns all memory entries by parsing memory.md sections.
func ListMemories(projectDir string) []MemoryEntry {
	entrypoint := paths.ProjectMemoryMD(projectDir)

	content, err := os.ReadFile(entrypoint)
	if err != nil {
		return nil
	}

	return parseMemoryEntries(string(content))
}

func parseMemoryEntries(content string) []MemoryEntry {
	var entries []MemoryEntry
	sections := strings.Split(content, "\n## ")

	for _, section := range sections[1:] { // skip header
		lines := strings.SplitN(section, "\n", 2)
		if len(lines) < 2 {
			continue
		}
		key := strings.TrimSpace(lines[0])
		body := strings.TrimSpace(lines[1])

		category := "project"
		for _, line := range strings.Split(body, "\n") {
			if strings.HasPrefix(line, "**Category**: ") {
				category = strings.TrimPrefix(line, "**Category**: ")
				break
			}
		}

		entries = append(entries, MemoryEntry{
			Key:      key,
			Value:    body,
			Category: category,
		})
	}
	return entries
}

// migrateMemory copies a legacy in-repo MEMORY.md to the new location
// and removes the legacy file so it no longer pollutes the user's git.
func migrateMemory(legacyPath, newPath string) {
	dir := filepath.Dir(newPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return
	}

	data, err := os.ReadFile(legacyPath)
	if err != nil {
		return
	}

	if err := os.WriteFile(newPath, data, 0644); err != nil {
		return
	}

	// Remove legacy file and empty parent dirs
	os.Remove(legacyPath)
	legacyDir := filepath.Dir(legacyPath)
	os.Remove(legacyDir) // only succeeds if empty
	sidexDir := filepath.Dir(legacyDir)
	entries, _ := os.ReadDir(sidexDir)
	if len(entries) == 0 {
		os.Remove(sidexDir)
	}
}
