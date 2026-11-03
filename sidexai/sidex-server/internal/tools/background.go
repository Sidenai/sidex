package tools

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// BackgroundShell is a long-lived shell process whose output can be polled.
type BackgroundShell struct {
	ID        string
	Command   string
	Dir       string
	StartedAt time.Time
	EndedAt   time.Time
	ExitCode  int
	ExitErr   string
	Finished  bool

	cmd    *exec.Cmd
	buf    *syncBuffer
	cursor int
	mu     sync.Mutex
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) Bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte{}, s.buf.Bytes()...)
}

func (s *syncBuffer) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Len()
}

// BackgroundMgr tracks background shells.
type BackgroundMgr struct {
	mu     sync.Mutex
	shells map[string]*BackgroundShell
}

func NewBackgroundMgr() *BackgroundMgr {
	return &BackgroundMgr{shells: make(map[string]*BackgroundShell)}
}

func (m *BackgroundMgr) Start(command, dir string) (*BackgroundShell, error) {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("working_directory %q does not exist", dir)
	}

	id := "bg-" + uuid.New().String()[:8]
	bs := &BackgroundShell{
		ID:        id,
		Command:   command,
		Dir:       dir,
		StartedAt: time.Now(),
		buf:       &syncBuffer{},
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", command)
	} else {
		cmd = exec.Command("sh", "-c", command)
	}
	cmd.Dir = dir
	cmd.Stdout = bs.buf
	cmd.Stderr = bs.buf

	if err := cmd.Start(); err != nil {
		return nil, err
	}
	bs.cmd = cmd

	m.mu.Lock()
	m.shells[id] = bs
	m.mu.Unlock()

	go func() {
		err := cmd.Wait()
		bs.mu.Lock()
		bs.Finished = true
		bs.EndedAt = time.Now()
		if err != nil {
			bs.ExitErr = err.Error()
			if ee, ok := err.(*exec.ExitError); ok {
				bs.ExitCode = ee.ExitCode()
			} else {
				bs.ExitCode = -1
			}
		}
		bs.mu.Unlock()
	}()

	// Collect reaper: after 24h, drop finished shells to prevent unbounded growth.
	go func() {
		time.Sleep(24 * time.Hour)
		m.mu.Lock()
		delete(m.shells, id)
		m.mu.Unlock()
	}()

	return bs, nil
}

func (m *BackgroundMgr) Get(id string) *BackgroundShell {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.shells[id]
}

func (m *BackgroundMgr) List() []*BackgroundShell {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*BackgroundShell
	for _, s := range m.shells {
		out = append(out, s)
	}
	return out
}

func (m *BackgroundMgr) Kill(id string) error {
	bs := m.Get(id)
	if bs == nil {
		return fmt.Errorf("no background shell with id %q", id)
	}
	bs.mu.Lock()
	finished := bs.Finished
	cmd := bs.cmd
	bs.mu.Unlock()
	if finished {
		return fmt.Errorf("shell %q already finished", id)
	}
	if cmd != nil && cmd.Process != nil {
		return cmd.Process.Kill()
	}
	return nil
}

// CleanupAll kills all running background shells and clears the registry.
func (m *BackgroundMgr) CleanupAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.shells))
	for id := range m.shells {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	for _, id := range ids {
		_ = m.Kill(id)
	}

	m.mu.Lock()
	m.shells = make(map[string]*BackgroundShell)
	m.mu.Unlock()
}

// ReadNew returns only output produced since the last ReadNew call.
func (bs *BackgroundShell) ReadNew(maxBytes int) (string, bool, int, string) {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	all := bs.buf.Bytes()
	if bs.cursor > len(all) {
		bs.cursor = len(all)
	}
	chunk := all[bs.cursor:]
	if maxBytes > 0 && len(chunk) > maxBytes {
		chunk = chunk[:maxBytes]
	}
	bs.cursor += len(chunk)
	status := "running"
	exitInfo := ""
	if bs.Finished {
		status = "completed"
		exitInfo = fmt.Sprintf("exit=%d", bs.ExitCode)
		if bs.ExitErr != "" {
			exitInfo += " err=" + bs.ExitErr
		}
	}
	return string(chunk), bs.Finished, bs.ExitCode, status + " " + exitInfo
}

func init_background(r *Registry) {
	r.tools["run_background"] = Tool{
		Name: "run_background",
		Description: `Start a long-running shell command in the background and get a shell ID for polling. Use this for dev servers (npm run dev, uvicorn), file watchers, test --watch, or any command that runs continuously or takes longer than 30 seconds.

Do NOT use for short commands that finish quickly — use shell instead. Do NOT add '&' to the command. After starting, use shell_output to read new output, or kill_shell to stop the process. The command runs until it exits naturally or you kill it.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"command":           map[string]interface{}{"type": "string", "description": "Command to run."},
				"working_directory": map[string]interface{}{"type": "string", "description": "Directory to run in; must exist. Defaults to cwd."},
			},
			"required": []string{"command"},
		},
	}

	r.tools["shell_output"] = Tool{
		Name: "shell_output",
		Description: `Read NEW output from a background shell since your last read. Returns only bytes produced since the previous shell_output call (or since launch if first call), plus the current status ("running" or "completed exit=N").

Use this to check on dev servers, watch for test results, or confirm a process started correctly. Do NOT poll in a tight loop — check once, then do other work and check again later if needed. If no new output exists and the shell is still running, returns "(no new output)".`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id":        map[string]interface{}{"type": "string", "description": "Background shell id from run_background."},
				"max_bytes": map[string]interface{}{"type": "integer", "description": "Max bytes to return (default 20000)."},
			},
			"required": []string{"id"},
		},
	}

	r.tools["kill_shell"] = Tool{
		Name:        "kill_shell",
		Description: `Terminate a running background shell by ID. Use this to shut down a dev server you no longer need, stop a hung process, or clean up before ending the session. Has no effect on already-finished processes (returns an error instead).`,
		Dangerous:   true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{"type": "string", "description": "Background shell id."},
			},
			"required": []string{"id"},
		},
	}

	r.tools["list_shells"] = Tool{
		Name:        "list_shells",
		Description: `List all background shells in this session with their IDs, status (running/completed), start times, byte counts, and commands. Use this when you've lost track of a shell ID, need to check what's still running, or want to clean up stale processes.`,
		Parameters: map[string]interface{}{
			"type": "object", "properties": map[string]interface{}{},
		},
	}
}

// tool entry points

func (r *Registry) runBackground(args map[string]interface{}) ExecutionResult {
	if r.bg == nil {
		r.bg = NewBackgroundMgr()
	}
	command := str(args, "command")
	if command == "" {
		return ExecutionResult{Error: "command is required"}
	}
	dir := strOr(args, "working_directory", r.cwd)
	bs, err := r.bg.Start(command, dir)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	return ExecutionResult{Output: fmt.Sprintf("started background shell %s\ncommand: %s\ncwd: %s\npoll with shell_output id=%s", bs.ID, bs.Command, bs.Dir, bs.ID)}
}

func (r *Registry) shellOutput(args map[string]interface{}) ExecutionResult {
	if r.bg == nil {
		return ExecutionResult{Error: "no background shells running"}
	}
	id := str(args, "id")
	if id == "" {
		return ExecutionResult{Error: "id is required"}
	}
	bs := r.bg.Get(id)
	if bs == nil {
		ids := []string{}
		for _, s := range r.bg.List() {
			ids = append(ids, s.ID)
		}
		return ExecutionResult{Error: fmt.Sprintf("no background shell with id %q; known ids: %s", id, strings.Join(ids, ", "))}
	}
	maxBytes := intOr(args, "max_bytes", 20000)
	chunk, finished, _, status := bs.ReadNew(maxBytes)
	if chunk == "" && !finished {
		chunk = "(no new output)"
	}
	return ExecutionResult{Output: fmt.Sprintf("status: %s\ncommand: %s\n\n%s", status, bs.Command, chunk)}
}

func (r *Registry) killShell(args map[string]interface{}) ExecutionResult {
	if r.bg == nil {
		return ExecutionResult{Error: "no background shells running"}
	}
	id := str(args, "id")
	if id == "" {
		return ExecutionResult{Error: "id is required"}
	}
	if err := r.bg.Kill(id); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	return ExecutionResult{Output: "killed " + id}
}

func (r *Registry) listShells(args map[string]interface{}) ExecutionResult {
	if r.bg == nil || len(r.bg.List()) == 0 {
		return ExecutionResult{Output: "(no background shells)"}
	}
	var b strings.Builder
	for _, s := range r.bg.List() {
		s.mu.Lock()
		status := "running"
		if s.Finished {
			status = fmt.Sprintf("completed (exit=%d)", s.ExitCode)
		}
		fmt.Fprintf(&b, "%s  %s  [%s]  bytes=%d\n  %s\n", s.ID, s.StartedAt.Format("15:04:05"), status, s.buf.Len(), s.Command)
		s.mu.Unlock()
	}
	return ExecutionResult{Output: b.String()}
}
