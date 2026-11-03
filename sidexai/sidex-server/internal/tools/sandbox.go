package tools

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Sandbox manages an isolated execution environment via the Daytona API.
// When active, all shell commands and file operations execute inside the sandbox.
type Sandbox struct {
	SandboxID string
	WorkDir   string
	Image     string
	Active    bool

	apiKey string
	apiURL string
	client *http.Client
	mu     sync.Mutex
}

const (
	daytonaDefaultAPI = "https://app.daytona.io/api"
	daytonaTimeout    = 120 * time.Second
)

type daytonaCreateReq struct {
	Image              string            `json:"image,omitempty"`
	Snapshot           string            `json:"snapshot,omitempty"`
	Language           string            `json:"language,omitempty"`
	Resources          *daytonaResources `json:"resources,omitempty"`
	EnvVars            map[string]string `json:"envVars,omitempty"`
	Labels             map[string]string `json:"labels,omitempty"`
	AutoDeleteInterval int               `json:"autoDeleteInterval"` // 0 = ephemeral (auto-delete on stop)
	AutoStopInterval   int               `json:"autoStopInterval"`   // minutes before auto-stop
}

type daytonaResources struct {
	CPU    int `json:"cpu,omitempty"`
	Memory int `json:"memory,omitempty"`
}

type daytonaExecReq struct {
	Command string `json:"command"`
	Cwd     string `json:"cwd,omitempty"`
	Timeout int    `json:"timeout,omitempty"`
}

type daytonaExecResp struct {
	ExitCode int    `json:"exitCode"`
	Result   string `json:"result"`
}

type daytonaSandboxResp struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

// Start creates a Daytona sandbox from the given image.
func (s *Sandbox) Start(workDir string, image string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.Active {
		return fmt.Errorf("sandbox already active (id %s)", s.SandboxID)
	}

	s.apiKey = getEnvOrDefault("DAYTONA_API_KEY", "")
	s.apiURL = getEnvOrDefault("DAYTONA_API_URL", daytonaDefaultAPI)
	s.client = &http.Client{Timeout: daytonaTimeout}

	// Fall back to Docker only if no Daytona key
	if s.apiKey == "" {
		return s.startDocker(workDir, image)
	}

	body := daytonaCreateReq{
		Snapshot: image, // image field doubles as snapshot name for Daytona
		Language: "python",
		Resources: &daytonaResources{
			CPU:    4,
			Memory: 8,
		},
		AutoDeleteInterval: 0,  // ephemeral — auto-delete when stopped
		AutoStopInterval:   15, // stop after 15 min inactivity
		Labels: map[string]string{
			"sidex":       "true",
			"instance_id": image,
		},
	}

	resp, err := s.doRequest("POST", "/sandbox", body)
	if err != nil {
		return fmt.Errorf("daytona create failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("daytona create: status %d: %s", resp.StatusCode, string(b))
	}

	var sandbox daytonaSandboxResp
	if err := json.NewDecoder(resp.Body).Decode(&sandbox); err != nil {
		return fmt.Errorf("daytona decode response: %w", err)
	}

	s.SandboxID = sandbox.ID
	s.WorkDir = workDir
	s.Image = image
	s.Active = true
	return nil
}

// Exec runs a command inside the sandbox.
func (s *Sandbox) Exec(command string, cwd string) (stdout string, stderr string, exitCode int, err error) {
	s.mu.Lock()
	if !s.Active {
		s.mu.Unlock()
		return "", "", -1, fmt.Errorf("sandbox is not active")
	}
	sandboxID := s.SandboxID
	apiKey := s.apiKey
	s.mu.Unlock()

	// Daytona mode
	if apiKey != "" {
		return s.execDaytona(sandboxID, command, cwd)
	}
	// Docker fallback
	return s.execDocker(sandboxID, command, cwd)
}

func (s *Sandbox) execDaytona(sandboxID, command, cwd string) (string, string, int, error) {
	// Don't send cwd to Daytona — commands use 'cd' explicitly.
	// Sending a non-existent cwd causes "fork/exec bash: no such file or directory".
	body := daytonaExecReq{
		Command: command,
	}

	resp, err := s.doRequest("POST",
		fmt.Sprintf("/toolbox/%s/toolbox/process/execute", sandboxID), body)
	if err != nil {
		return "", "", -1, fmt.Errorf("daytona exec: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", string(respBody), -1, fmt.Errorf("daytona exec: status %d", resp.StatusCode)
	}

	var result daytonaExecResp
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", "", -1, fmt.Errorf("daytona exec decode: %w", err)
	}

	if result.ExitCode != 0 {
		return "", result.Result, result.ExitCode, nil
	}
	return result.Result, "", result.ExitCode, nil
}

// Stop destroys the sandbox.
func (s *Sandbox) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.Active {
		return nil
	}

	if s.apiKey != "" {
		resp, err := s.doRequest("DELETE", fmt.Sprintf("/sandbox/%s", s.SandboxID), nil)
		if err != nil {
			return fmt.Errorf("daytona delete: %w", err)
		}
		resp.Body.Close()
	} else {
		s.stopDocker()
	}

	s.Active = false
	s.SandboxID = ""
	return nil
}

// ReadFile reads a file from inside the sandbox.
func (s *Sandbox) ReadFile(path string) (string, error) {
	if !s.Active {
		return "", fmt.Errorf("sandbox is not active")
	}

	if s.apiKey != "" {
		out, _, code, err := s.execDaytona(s.SandboxID, "cat "+path, "")
		if err != nil {
			return "", err
		}
		if code != 0 {
			return "", fmt.Errorf("cat %s: exit %d", path, code)
		}
		return out, nil
	}
	return s.readFileDocker(path)
}

// WriteFile writes content to a file inside the sandbox.
func (s *Sandbox) WriteFile(path, content string) error {
	if !s.Active {
		return fmt.Errorf("sandbox is not active")
	}

	if s.apiKey != "" {
		// Use heredoc to safely write arbitrary content
		cmd := fmt.Sprintf("cat > %s << 'SIDEX_EOF'\n%s\nSIDEX_EOF", path, content)
		_, stderr, code, err := s.execDaytona(s.SandboxID, cmd, "")
		if err != nil {
			return err
		}
		if code != 0 {
			return fmt.Errorf("write %s: %s", path, stderr)
		}
		return nil
	}
	return s.writeFileDocker(path, content)
}

// FileExists checks if a file exists inside the sandbox.
func (s *Sandbox) FileExists(path string) bool {
	if !s.Active {
		return false
	}
	if s.apiKey != "" {
		_, _, code, _ := s.execDaytona(s.SandboxID, "test -f "+path, "")
		return code == 0
	}
	return s.fileExistsDocker(path)
}

// ─── HTTP Helper ─────────────────────────────────────────────────────────────

func (s *Sandbox) doRequest(method, path string, body interface{}) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, s.apiURL+path, reqBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	return s.client.Do(req)
}

// ─── Docker Fallback (for local dev without Daytona) ─────────────────────────

func (s *Sandbox) startDocker(workDir, image string) error {
	args := []string{"run", "--detach", "--rm", "--platform", "linux/amd64"}
	if workDir != "" {
		args = append(args, "-w", workDir)
	}
	args = append(args, image, "sleep", "infinity")

	out, err := execCmd("docker", args...)
	if err != nil {
		return fmt.Errorf("docker run failed: %w", err)
	}

	containerID := strings.TrimSpace(out)
	if containerID == "" {
		return fmt.Errorf("docker run returned empty container ID")
	}

	s.SandboxID = containerID
	s.WorkDir = workDir
	s.Image = image
	s.Active = true
	return nil
}

func (s *Sandbox) execDocker(containerID, command, cwd string) (string, string, int, error) {
	args := []string{"exec"}
	if cwd != "" {
		args = append(args, "-w", cwd)
	}
	wrappedCmd := "source activate testbed 2>/dev/null; " + command
	args = append(args, containerID, "bash", "-c", wrappedCmd)

	return execCmdWithExit("docker", args...)
}

func (s *Sandbox) stopDocker() {
	execCmd("docker", "kill", s.SandboxID)
}

func (s *Sandbox) readFileDocker(path string) (string, error) {
	out, err := execCmd("docker", "exec", s.SandboxID, "cat", path)
	if err != nil {
		return "", err
	}
	return out, nil
}

func (s *Sandbox) writeFileDocker(path, content string) error {
	args := []string{"exec", "-i", s.SandboxID, "bash", "-c", fmt.Sprintf("cat > %s", path)}
	return execCmdStdin("docker", content, args...)
}

func (s *Sandbox) fileExistsDocker(path string) bool {
	_, err := execCmd("docker", "exec", s.SandboxID, "test", "-f", path)
	return err == nil
}

// ─── Exec helpers ────────────────────────────────────────────────────────────

func getEnvOrDefault(key, def string) string {
	if v := getEnv(key); v != "" {
		return v
	}
	return def
}

func getEnv(key string) string {
	return os.Getenv(key)
}

func execCmd(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s: %s", err, errBuf.String())
	}
	return out.String(), nil
}

func execCmdWithExit(name string, args ...string) (string, string, int, error) {
	cmd := exec.Command(name, args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	runErr := cmd.Run()
	exitCode := 0
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return "", "", -1, fmt.Errorf("exec failed: %w", runErr)
		}
	}
	return outBuf.String(), errBuf.String(), exitCode, nil
}

func execCmdStdin(name string, stdin string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(stdin)
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %s", err, errBuf.String())
	}
	return nil
}
