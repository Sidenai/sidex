package paths

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceSlug(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"/Users/bob/code/myapp", "Users-bob-code-myapp"},
		{"/home/alice/projects/web", "home-alice-projects-web"},
		{"/tmp/test", "tmp-test"},
	}

	for _, tt := range tests {
		got := WorkspaceSlug(tt.input)
		if got != tt.want {
			t.Errorf("WorkspaceSlug(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestProjectDir(t *testing.T) {
	os.Setenv("SIDEX_HOME", "/tmp/test-sidex-home")
	defer os.Unsetenv("SIDEX_HOME")

	got := ProjectDir("/Users/bob/code/myapp")
	want := filepath.Join("/tmp/test-sidex-home", "projects", "Users-bob-code-myapp")
	if got != want {
		t.Errorf("ProjectDir = %q, want %q", got, want)
	}
}

func TestProjectMemoryMD(t *testing.T) {
	os.Setenv("SIDEX_HOME", "/tmp/test-sidex-home")
	defer os.Unsetenv("SIDEX_HOME")

	got := ProjectMemoryMD("/Users/bob/code/myapp")
	want := filepath.Join("/tmp/test-sidex-home", "projects", "Users-bob-code-myapp", "memory.md")
	if got != want {
		t.Errorf("ProjectMemoryMD = %q, want %q", got, want)
	}
}

func TestSidexHomeDefault(t *testing.T) {
	os.Unsetenv("SIDEX_HOME")
	home, _ := os.UserHomeDir()
	got := SidexHome()
	want := filepath.Join(home, ".sidex")
	if got != want {
		t.Errorf("SidexHome() = %q, want %q", got, want)
	}
}

func TestSidexHomeOverride(t *testing.T) {
	os.Setenv("SIDEX_HOME", "/custom/path")
	defer os.Unsetenv("SIDEX_HOME")

	got := SidexHome()
	if got != "/custom/path" {
		t.Errorf("SidexHome() = %q, want /custom/path", got)
	}
}
