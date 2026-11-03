package tools

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sidex-ai/sidex-server/internal/memory"
	sidexpaths "github.com/sidex-ai/sidex-server/internal/paths"
)

func TestReadWriteEditCycle(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(dir)

	// write a file
	res := r.Execute("write_file", `{"path":"hello.txt","content":"hello world"}`)
	if res.Error != "" {
		t.Fatalf("write_file failed: %s", res.Error)
	}

	// read it
	res = r.Execute("read_file", `{"path":"hello.txt"}`)
	if res.Error != "" {
		t.Fatalf("read_file failed: %s", res.Error)
	}
	if !strings.Contains(res.Output, "hello world") {
		t.Fatalf("read content mismatch: %q", res.Output)
	}

	// edit it (read-before-write requirement already satisfied)
	res = r.Execute("edit_file", `{"path":"hello.txt","old_string":"hello","new_string":"goodbye"}`)
	if res.Error != "" {
		t.Fatalf("edit_file failed: %s", res.Error)
	}

	// confirm
	body, _ := os.ReadFile(filepath.Join(dir, "hello.txt"))
	if string(body) != "goodbye world" {
		t.Fatalf("edit not applied: %q", body)
	}
}

func TestEditWithoutReadFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.txt")
	_ = os.WriteFile(path, []byte("abc"), 0644)

	r := NewRegistry(dir)
	res := r.Execute("edit_file", `{"path":"x.txt","old_string":"a","new_string":"z"}`)
	if res.Error == "" {
		t.Fatalf("expected error for edit without read, got output=%q", res.Output)
	}
	if !strings.Contains(res.Error, "has not been read") {
		t.Fatalf("unexpected error: %s", res.Error)
	}
}

func TestShellValidatesWorkingDirectory(t *testing.T) {
	r := NewRegistry("/tmp")
	res := r.Execute("shell", `{"command":"echo hi","working_directory":"/definitely/not/a/real/path/here"}`)
	if res.Error == "" {
		t.Fatalf("expected error for missing working_directory, got output=%q", res.Output)
	}
	if !strings.Contains(res.Error, "does not exist") {
		t.Fatalf("unexpected error: %s", res.Error)
	}
}

func TestShellHappyPath(t *testing.T) {
	r := NewRegistry("/tmp")
	res := r.Execute("shell", `{"command":"echo hello-sidex"}`)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if !strings.Contains(res.Output, "hello-sidex") {
		t.Fatalf("unexpected output: %q", res.Output)
	}
}

func TestWebFetchBlocksPrivateAddresses(t *testing.T) {
	r := NewRegistry(t.TempDir())
	for _, rawURL := range []string{
		"http://127.0.0.1:1234",
		"http://localhost:1234",
		"http://169.254.169.254/latest/meta-data",
	} {
		res := r.Execute("web_fetch", fmt.Sprintf(`{"url":%q}`, rawURL))
		if res.Error == "" {
			t.Fatalf("expected %s to be blocked, got output=%q", rawURL, res.Output)
		}
	}
}

func TestMemoryToolsAreUserScoped(t *testing.T) {
	store, err := memory.NewBoltStore(filepath.Join(t.TempDir(), "memory.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	userA := NewRegistryForUser(t.TempDir(), "user-a", store)
	userB := NewRegistryForUser(t.TempDir(), "user-b", store)

	if res := userA.Execute("memory_store", `{"key":"stack","value":"go"}`); res.Error != "" {
		t.Fatalf("memory_store failed: %s", res.Error)
	}
	if res := userB.Execute("memory_search", `{"query":"stack"}`); !strings.Contains(res.Output, "no memories found") {
		t.Fatalf("expected no cross-user memory, got %q", res.Output)
	}
	if res := userA.Execute("memory_search", `{"query":"stack"}`); !strings.Contains(res.Output, "go") {
		t.Fatalf("expected owned memory, got %q", res.Output)
	}
}

func TestListDirAndTree(t *testing.T) {
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "sub"), 0755)
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("A"), 0644)
	_ = os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("B"), 0644)

	r := NewRegistry(dir)

	res := r.Execute("list_dir", `{"path":"."}`)
	if res.Error != "" {
		t.Fatalf("list_dir error: %s", res.Error)
	}
	if !strings.Contains(res.Output, "a.txt") || !strings.Contains(res.Output, "sub") {
		t.Fatalf("list_dir missing entries: %q", res.Output)
	}

	res = r.Execute("tree", `{"path":".","depth":2}`)
	if res.Error != "" {
		t.Fatalf("tree error: %s", res.Error)
	}
	if !strings.Contains(res.Output, "b.txt") {
		t.Fatalf("tree missing nested file: %q", res.Output)
	}
}

func TestGlobAndSearchFiles(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.go"), []byte("package a"), 0644)
	_ = os.WriteFile(filepath.Join(dir, "y.txt"), []byte("hi"), 0644)
	_ = os.Mkdir(filepath.Join(dir, "deep"), 0755)
	_ = os.WriteFile(filepath.Join(dir, "deep", "z.go"), []byte("package b"), 0644)

	r := NewRegistry(dir)
	res := r.Execute("glob", `{"pattern":"*.go"}`)
	if res.Error != "" {
		t.Fatalf("glob error: %s", res.Error)
	}
	if !strings.Contains(res.Output, "x.go") || !strings.Contains(res.Output, "z.go") {
		t.Fatalf("glob missing matches: %q", res.Output)
	}

	res = r.Execute("search_files", `{"pattern":"*.txt"}`)
	if !strings.Contains(res.Output, "y.txt") {
		t.Fatalf("search_files missing match: %q", res.Output)
	}
}

func TestCwdTool(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(dir)
	res := r.Execute("cwd", `{}`)
	if res.Error != "" {
		t.Fatalf("cwd error: %s", res.Error)
	}
	if !strings.Contains(res.Output, dir) || !strings.Contains(res.Output, "exists: true") {
		t.Fatalf("cwd output bad: %q", res.Output)
	}
}

func TestBackgroundShellLifecycle(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(dir)

	res := r.Execute("run_background", `{"command":"for i in 1 2 3; do echo line-$i; sleep 0.05; done"}`)
	if res.Error != "" {
		t.Fatalf("run_background error: %s", res.Error)
	}
	// extract id
	var id string
	for _, line := range strings.Split(res.Output, "\n") {
		if strings.HasPrefix(line, "started background shell ") {
			id = strings.TrimPrefix(line, "started background shell ")
			break
		}
	}
	if id == "" {
		t.Fatalf("could not find id in output: %q", res.Output)
	}

	// wait for completion
	deadline := time.Now().Add(5 * time.Second)
	var out string
	for time.Now().Before(deadline) {
		res = r.Execute("shell_output", `{"id":"`+id+`"}`)
		out += res.Output
		if strings.Contains(res.Output, "completed") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(out, "line-1") || !strings.Contains(out, "line-3") {
		t.Fatalf("missing expected background output: %q", out)
	}

	// list_shells
	res = r.Execute("list_shells", `{}`)
	if !strings.Contains(res.Output, id) {
		t.Fatalf("list_shells missing id %s: %q", id, res.Output)
	}
}

func TestBackgroundShellRejectsBadDir(t *testing.T) {
	r := NewRegistry("/tmp")
	res := r.Execute("run_background", `{"command":"echo hi","working_directory":"/nope/does/not/exist"}`)
	if res.Error == "" {
		t.Fatalf("expected error for bad dir, got: %q", res.Output)
	}
}

func TestMultiEditAndRegexReplace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "code.txt")
	_ = os.WriteFile(path, []byte("alpha beta gamma"), 0644)

	r := NewRegistry(dir)
	// multi_edit enforces read-before-edit, matching edit_file's contract
	if res := r.Execute("read_file", `{"path":"code.txt"}`); res.Error != "" {
		t.Fatalf("read_file error: %s", res.Error)
	}
	res := r.Execute("multi_edit", `{"path":"code.txt","edits":[{"old":"alpha","new":"one"},{"old":"beta","new":"two"}]}`)
	if res.Error != "" {
		t.Fatalf("multi_edit error: %s", res.Error)
	}
	body, _ := os.ReadFile(path)
	if string(body) != "one two gamma" {
		t.Fatalf("multi_edit unexpected body: %q", body)
	}

	// regex_replace
	res = r.Execute("regex_replace", `{"path":"code.txt","pattern":"(one|two)","replacement":"X"}`)
	if res.Error != "" {
		t.Fatalf("regex_replace error: %s", res.Error)
	}
	body, _ = os.ReadFile(path)
	if string(body) != "X X gamma" {
		t.Fatalf("regex_replace unexpected body: %q", body)
	}
}

func TestTodoWrite(t *testing.T) {
	r := NewRegistry(t.TempDir())
	res := r.Execute("todo_write", `{"todos":[{"id":"a","content":"do x","status":"pending"},{"id":"b","content":"do y","status":"in_progress"}]}`)
	if res.Error != "" {
		t.Fatalf("todo_write error: %s", res.Error)
	}
	if !strings.Contains(res.Output, "[~] b") || !strings.Contains(res.Output, "[ ] a") {
		t.Fatalf("todo_write output bad: %q", res.Output)
	}
	if len(r.Todos) != 2 {
		t.Fatalf("expected 2 todos, got %d", len(r.Todos))
	}
}

func TestReadFileOffsetLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "lines.txt")
	_ = os.WriteFile(path, []byte("a\nb\nc\nd\ne"), 0644)
	r := NewRegistry(dir)
	res := r.Execute("read_file", `{"path":"lines.txt","offset":2,"limit":2}`)
	if res.Error != "" {
		t.Fatalf("read_file error: %s", res.Error)
	}
	if !strings.Contains(res.Output, "b") || !strings.Contains(res.Output, "c") {
		t.Fatalf("offset/limit wrong lines: %q", res.Output)
	}
	if strings.Contains(res.Output, "|a") || strings.Contains(res.Output, "|d") {
		t.Fatalf("offset/limit included wrong lines: %q", res.Output)
	}
}

func TestReadFileSupportsPNGImages(t *testing.T) {
	dir := t.TempDir()
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatalf("decode png fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pixel.png"), data, 0644); err != nil {
		t.Fatalf("write png fixture: %v", err)
	}

	r := NewRegistry(dir)
	res := r.Execute("read_file", `{"path":"pixel.png"}`)
	if res.Error != "" {
		t.Fatalf("read_file image error: %s", res.Error)
	}

	var parsed struct {
		MimeType   string         `json:"mime_type"`
		Base64Data string         `json:"base64_data"`
		FileSize   int            `json:"file_size"`
		Dimensions map[string]int `json:"dimensions"`
	}
	if err := json.Unmarshal([]byte(res.Output), &parsed); err != nil {
		t.Fatalf("image output should be JSON: %v\n%s", err, res.Output)
	}
	if parsed.MimeType != "image/png" {
		t.Fatalf("mime_type = %q, want image/png", parsed.MimeType)
	}
	if parsed.Base64Data != base64.StdEncoding.EncodeToString(data) {
		t.Fatalf("base64_data mismatch")
	}
	if parsed.FileSize != len(data) {
		t.Fatalf("file_size = %d, want %d", parsed.FileSize, len(data))
	}
	if parsed.Dimensions["width"] != 1 || parsed.Dimensions["height"] != 1 {
		t.Fatalf("dimensions = %#v, want 1x1", parsed.Dimensions)
	}
}

func TestReadFileSupportsProjectAssetImages(t *testing.T) {
	workspace := t.TempDir()
	assetsDir := sidexpaths.ProjectAssetsDir(workspace)
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatalf("decode png fixture: %v", err)
	}
	assetPath := filepath.Join(assetsDir, "attached.png")
	if err := os.WriteFile(assetPath, data, 0644); err != nil {
		t.Fatalf("write attached image: %v", err)
	}

	r := NewRegistry(workspace)
	res := r.Execute("read_file", fmt.Sprintf(`{"path":%q}`, assetPath))
	if res.Error != "" {
		t.Fatalf("read_file project asset image error: %s", res.Error)
	}
	if !strings.Contains(res.Output, `"mime_type":"image/png"`) {
		t.Fatalf("expected image payload, got: %s", res.Output)
	}
}

func TestExecuteTreatsEmptyArgsAsEmptyObject(t *testing.T) {
	r := NewRegistry(t.TempDir())
	// cwd takes no args; empty-string arguments from some providers
	// must not produce a JSON parse error.
	res := r.Execute("cwd", "")
	if res.Error != "" {
		t.Fatalf("empty args should be treated as {}: %s", res.Error)
	}
	if !strings.Contains(res.Output, "cwd:") {
		t.Fatalf("unexpected output: %q", res.Output)
	}
	// whitespace-only too
	res = r.Execute("cwd", "   ")
	if res.Error != "" {
		t.Fatalf("whitespace args should be treated as {}: %s", res.Error)
	}
}

func TestUnknownToolError(t *testing.T) {
	r := NewRegistry(t.TempDir())
	res := r.Execute("not_a_real_tool", `{}`)
	if res.Error == "" {
		t.Fatalf("expected error for unknown tool")
	}
}
