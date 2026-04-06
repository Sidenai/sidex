//! High-performance process and terminal management module for SideX
//! 
//! Features:
//! - PTY (pseudo-terminal) support with full terminal emulation
//! - Ring buffer for output to prevent memory exhaustion
//! - Backpressure handling to slow down processes when frontend can't keep up
//! - Multiple shell support (bash, zsh, powershell, cmd, fish)
//! - Process tree management for proper cleanup

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicU32, AtomicBool, Ordering}};
use std::time::{SystemTime, UNIX_EPOCH, Duration};
use tauri::{AppHandle, Emitter, State};
use crossbeam::channel::{bounded, Sender, Receiver};

// ============================================================================
// Constants
// ============================================================================

/// Default ring buffer capacity (lines)
const DEFAULT_RING_BUFFER_CAPACITY: usize = 10_000;

/// Maximum output channel size (backpressure threshold)
const OUTPUT_CHANNEL_SIZE: usize = 1_000;

/// Default read timeout for exec command (ms)
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 30_000;

/// Buffer size for PTY reads
const PTY_READ_BUFFER_SIZE: usize = 8192;

// ============================================================================
// Data Structures
// ============================================================================

/// Unique handle for a terminal instance
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Hash, Eq, PartialEq)]
pub struct TermHandle(pub u32);

impl TermHandle {
    fn next() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(1);
        TermHandle(COUNTER.fetch_add(1, Ordering::SeqCst))
    }
}

/// A single line of terminal output
#[derive(Debug, Clone, Serialize)]
pub struct OutputLine {
    pub text: String,
    pub is_stderr: bool,
    pub timestamp: u64,
}

impl OutputLine {
    fn new(text: String, is_stderr: bool) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self { text, is_stderr, timestamp }
    }
}

/// Terminal information
#[derive(Debug, Clone, Serialize)]
pub struct TermInfo {
    pub handle: TermHandle,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub is_alive: bool,
    pub output_lines_total: usize,
}

/// Result of a simple command execution
#[derive(Debug, Serialize)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Shell information
#[derive(Debug, Clone, Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

// ============================================================================
// Ring Buffer
// ============================================================================

/// Ring buffer for terminal output with overflow tracking
struct RingBuffer {
    capacity: usize,
    buffer: VecDeque<OutputLine>,
    dropped_count: usize,
    total_count: usize,
}

impl RingBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            buffer: VecDeque::with_capacity(capacity),
            dropped_count: 0,
            total_count: 0,
        }
    }

    /// Push a line to the buffer, dropping oldest if at capacity
    fn push(&mut self, line: OutputLine) {
        self.total_count += 1;
        if self.buffer.len() >= self.capacity {
            self.buffer.pop_front();
            self.dropped_count += 1;
        }
        self.buffer.push_back(line);
    }

    /// Get lines from the buffer (up to max_lines)
    fn get_lines(&self, max_lines: Option<usize>) -> Vec<OutputLine> {
        let max = max_lines.unwrap_or(100).min(self.buffer.len());
        self.buffer.iter().rev().take(max).rev().cloned().collect()
    }

    /// Get and clear the dropped count
    fn take_dropped_count(&mut self) -> usize {
        let count = self.dropped_count;
        self.dropped_count = 0;
        count
    }

    fn total_count(&self) -> usize {
        self.total_count
    }
}

// ============================================================================
// Output Reader Thread
// ============================================================================

/// Message types for output channel
enum OutputMessage {
    Data(OutputLine),
    Shutdown,
}

/// Spawn a reader thread that reads PTY output and sends to channel
fn spawn_output_reader(
    mut reader: Box<dyn Read + Send>,
    sender: Sender<OutputMessage>,
    _handle: TermHandle,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; PTY_READ_BUFFER_SIZE];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF reached
                    let _ = sender.send(OutputMessage::Shutdown);
                    break;
                }
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let line = OutputLine::new(text, false);
                    if sender.send(OutputMessage::Data(line)).is_err() {
                        // Channel closed, exit reader
                        break;
                    }
                }
                Err(e) => {
                    // Read error, send error message
                    let error_text = format!("\r\n[Terminal read error: {}]\r\n", e);
                    let _ = sender.send(OutputMessage::Data(OutputLine::new(error_text, true)));
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    })
}

// ============================================================================
// Terminal Instance
// ============================================================================

/// Internal terminal state
pub struct Terminal {
    _handle: TermHandle,
    shell: String,
    cwd: String,
    _pty: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: Arc<Mutex<RingBuffer>>,
    _sender: Sender<OutputMessage>,
    child: Box<dyn portable_pty::Child + Send>,
    _reader_handle: Option<std::thread::JoinHandle<()>>,
    cols: u16,
    rows: u16,
    is_alive: Arc<AtomicBool>,
}

impl Terminal {
    fn new(
        handle: TermHandle,
        shell: String,
        cwd: String,
        pty: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        reader: Box<dyn Read + Send>,
        child: Box<dyn portable_pty::Child + Send>,
        cols: u16,
        rows: u16,
    ) -> (Self, Receiver<OutputMessage>) {
        let output = Arc::new(Mutex::new(RingBuffer::new(DEFAULT_RING_BUFFER_CAPACITY)));
        let (sender, receiver) = bounded(OUTPUT_CHANNEL_SIZE);
        
        // Spawn reader thread
        let reader_handle = spawn_output_reader(reader, sender.clone(), handle);
        
        let terminal = Self {
            _handle: handle,
            shell,
            cwd,
            _pty: pty,
            writer,
            output: output.clone(),
            _sender: sender,
            child,
            _reader_handle: Some(reader_handle),
            cols,
            rows,
            is_alive: Arc::new(AtomicBool::new(true)),
        };
        
        (terminal, receiver)
    }

    fn write(&mut self, data: &str) -> Result<(), String> {
        self.writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write: {}", e))?;
        self.writer
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self._pty
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize: {}", e))?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }

    fn try_wait(&mut self) -> Result<Option<portable_pty::ExitStatus>, String> {
        self.child.try_wait().map_err(|e| e.to_string())
    }

    fn kill(&mut self) -> Result<(), String> {
        self.is_alive.store(false, Ordering::SeqCst);
        self.child.kill().map_err(|e| format!("Failed to kill: {}", e))
    }
}

// ============================================================================
// Process Store
// ============================================================================

/// Store for managing all terminal instances
pub struct ProcessStore {
    terminals: Mutex<HashMap<TermHandle, Terminal>>,
    output_receivers: Mutex<HashMap<TermHandle, Receiver<OutputMessage>>>,
}

impl ProcessStore {
    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            output_receivers: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_app_handle(&self, _handle: AppHandle) {}

    fn insert(&self, handle: TermHandle, terminal: Terminal, receiver: Receiver<OutputMessage>) {
        self.terminals.lock().unwrap().insert(handle, terminal);
        self.output_receivers.lock().unwrap().insert(handle, receiver);
    }

    fn remove(&self, handle: TermHandle) -> Option<Terminal> {
        self.output_receivers.lock().unwrap().remove(&handle);
        self.terminals.lock().unwrap().remove(&handle)
    }

    fn handles(&self) -> Vec<TermHandle> {
        self.terminals.lock().unwrap().keys().cloned().collect()
    }
}

// ============================================================================
// Shell Detection
// ============================================================================

/// Detect available shells on the system
fn detect_shells() -> Vec<ShellInfo> {
    let default_shell = std::env::var("SHELL").unwrap_or_default();
    
    let candidates: Vec<(&str, &str)> = if cfg!(target_os = "windows") {
        vec![
            ("PowerShell", "powershell.exe"),
            ("PowerShell Core", "pwsh.exe"),
            ("Command Prompt", "cmd.exe"),
            ("Git Bash", "bash.exe"),
            ("WSL", "wsl.exe"),
        ]
    } else {
        vec![
            ("zsh", "/bin/zsh"),
            ("zsh", "/usr/bin/zsh"),
            ("zsh", "/usr/local/bin/zsh"),
            ("bash", "/bin/bash"),
            ("bash", "/usr/bin/bash"),
            ("fish", "/usr/bin/fish"),
            ("fish", "/usr/local/bin/fish"),
            ("fish", "/opt/homebrew/bin/fish"),
            ("sh", "/bin/sh"),
            ("sh", "/usr/bin/sh"),
        ]
    };

    let mut seen_names = std::collections::HashSet::new();
    let mut shells = Vec::new();

    for (name, path) in candidates {
        let full_path = if path.starts_with('/') || path.contains(':') || path.starts_with("C:\\") {
            path.to_string()
        } else {
            // Try to find in PATH
            which::which(path).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
        };
        
        if !full_path.is_empty() && std::path::Path::new(&full_path).exists() && seen_names.insert(name.to_string()) {
            shells.push(ShellInfo {
                name: name.to_string(),
                path: full_path.clone(),
                is_default: full_path == default_shell || 
                    (default_shell.is_empty() && shells.is_empty()),
            });
        }
    }

    // Ensure we have at least something
    if shells.is_empty() {
        if cfg!(target_os = "windows") {
            shells.push(ShellInfo {
                name: "PowerShell".to_string(),
                path: "powershell.exe".to_string(),
                is_default: true,
            });
        } else {
            shells.push(ShellInfo {
                name: "sh".to_string(),
                path: "/bin/sh".to_string(),
                is_default: true,
            });
        }
    }

    shells
}

/// Get the best available shell
fn get_best_shell(preferred: Option<&str>) -> (String, String) {
    let shells = detect_shells();
    
    if let Some(pref) = preferred {
        // Try to find exact match first
        for shell in &shells {
            if shell.name.to_lowercase() == pref.to_lowercase() ||
               shell.path.to_lowercase().contains(&pref.to_lowercase()) {
                return (shell.name.clone(), shell.path.clone());
            }
        }
    }
    
    // Return default or first available
    for shell in &shells {
        if shell.is_default {
            return (shell.name.clone(), shell.path.clone());
        }
    }
    
    shells.first()
        .map(|s| (s.name.clone(), s.path.clone()))
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                ("PowerShell".to_string(), "powershell.exe".to_string())
            } else {
                ("sh".to_string(), "/bin/sh".to_string())
            }
        })
}

// ============================================================================
// Process Tree Management
// ============================================================================

/// Kill a process and all its children
#[cfg(unix)]
fn kill_process_tree(pid: u32) -> Result<(), String> {
    use std::process::Command;
    
    // Try to get child PIDs using pgrep (Linux/macOS)
    let output = Command::new("pgrep")
        .args(&["-P", &pid.to_string()])
        .output();
    
    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Ok(child_pid) = line.trim().parse::<u32>() {
                // Recursively kill children first
                let _ = kill_process_tree(child_pid);
            }
        }
    }
    
    // Kill the main process
    unsafe {
        let result = libc::kill(pid as i32, libc::SIGTERM);
        if result != 0 {
            // Try SIGKILL if SIGTERM fails
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    
    Ok(())
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    
    // Use taskkill /T to kill process tree on Windows
    let result = Command::new("taskkill")
        .args(&["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    
    match result {
        Ok(output) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("taskkill failed: {}", stderr));
            }
            Ok(())
        }
        Err(e) => Err(format!("Failed to execute taskkill: {}", e)),
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Spawn a new terminal/shell
#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    state: State<'_, Arc<ProcessStore>>,
    shell: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TermHandle, String> {
    let pty_system = native_pty_system();

    let pty_cols = cols.unwrap_or(80);
    let pty_rows = rows.unwrap_or(24);

    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Get shell with auto-detection
    let (shell_name, shell_path) = get_best_shell(shell.as_deref());

    // Build command
    let mut cmd = CommandBuilder::new(&shell_path);
    
    // Add login flag for Unix shells
    let shell_basename = std::path::Path::new(&shell_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    
    match shell_basename {
        "zsh" | "bash" | "sh" | "fish" => {
            cmd.arg("-l");
        }
        "powershell.exe" | "pwsh.exe" => {
            cmd.arg("-NoExit");
        }
        _ => {}
    }

    // Set environment variables
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "SideX");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    // Copy essential environment (platform-aware)
    if cfg!(target_os = "windows") {
        for key in ["PATH", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA",
                     "HOMEDRIVE", "HOMEPATH", "COMSPEC", "SystemRoot", "HOME", "TEMP", "TMP"] {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, val);
            }
        }
    } else {
        for key in ["HOME", "USER", "PATH", "LANG", "SHELL"] {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, val);
            }
        }
    }
    
    // Set LANG if not set
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    // Set working directory
    let cwd_str = cwd.unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .or_else(|_| std::env::current_dir().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_else(|_| ".".to_string())
        } else {
            std::env::var("HOME")
                .or_else(|_| std::env::current_dir().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_else(|_| ".".to_string())
        }
    });
    cmd.cwd(&cwd_str);

    // Set custom environment variables
    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    // Spawn the shell
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{}': {}", shell_path, e))?;

    // Get PTY I/O handles
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

    let pid = child.process_id().unwrap_or(0);
    let handle = TermHandle::next();

    // Create terminal instance
    let (terminal, receiver) = Terminal::new(
        handle,
        shell_name.clone(),
        cwd_str.clone(),
        pair.master,
        writer,
        reader,
        child,
        pty_cols,
        pty_rows,
    );

    // Store terminal
    state.insert(handle, terminal, receiver);

    // Emit term-started event
    let _ = app.emit("term-started", TermStartedEvent {
        handle,
        shell: shell_name,
        pid,
        cwd: cwd_str,
    });

    Ok(handle)
}

/// Event emitted when terminal starts
#[derive(Debug, Clone, Serialize)]
struct TermStartedEvent {
    handle: TermHandle,
    shell: String,
    pid: u32,
    cwd: String,
}

/// Write input to terminal
#[tauri::command]
pub fn term_write(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
    data: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get_mut(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    terminal.write(&data)
}

/// Resize terminal (PTY)
#[tauri::command]
pub fn term_resize(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get_mut(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    terminal.resize(cols, rows)
}

/// Read terminal output (poll-based)
#[tauri::command]
pub fn term_read(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
    max_lines: Option<usize>,
) -> Result<TermReadResult, String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get_mut(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    // Process any pending messages from the receiver
    if let Ok(receivers) = state.output_receivers.try_lock() {
        if let Some(receiver) = receivers.get(&handle) {
            loop {
                match receiver.try_recv() {
                    Ok(OutputMessage::Data(line)) => {
                        terminal.output.lock().unwrap().push(line);
                    }
                    Ok(OutputMessage::Shutdown) => {
                        terminal.is_alive.store(false, Ordering::SeqCst);
                        break;
                    }
                    Err(_) => break,
                }
            }
        }
    }

    let mut output = terminal.output.lock().map_err(|e| e.to_string())?;
    let lines = output.get_lines(max_lines);
    let dropped = output.take_dropped_count();
    let total = output.total_count();

    Ok(TermReadResult {
        lines,
        dropped,
        total,
        is_alive: terminal.is_alive.load(Ordering::SeqCst),
    })
}

/// Result of reading terminal output
#[derive(Debug, Serialize)]
pub struct TermReadResult {
    pub lines: Vec<OutputLine>,
    pub dropped: usize,
    pub total: usize,
    pub is_alive: bool,
}

/// Kill terminal and all child processes
#[tauri::command]
pub fn term_kill(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
) -> Result<(), String> {
    let pid = {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        let terminal = terminals
            .get_mut(&handle)
            .ok_or_else(|| format!("Terminal {:?} not found", handle))?;
        terminal.pid()
    };

    // Kill process tree if we have a PID
    if let Some(pid) = pid {
        kill_process_tree(pid)?;
    }

    // Remove from store
    if let Some(mut terminal) = state.remove(handle) {
        // Try to kill directly as fallback
        let _ = terminal.kill();
    }

    Ok(())
}

/// Get terminal info
#[tauri::command]
pub fn term_info(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
) -> Result<TermInfo, String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    let pid = terminal.pid().unwrap_or(0);
    let output = terminal.output.lock().map_err(|e| e.to_string())?;

    Ok(TermInfo {
        handle,
        shell: terminal.shell.clone(),
        cwd: terminal.cwd.clone(),
        pid,
        cols: terminal.cols,
        rows: terminal.rows,
        is_alive: terminal.is_alive.load(Ordering::SeqCst),
        output_lines_total: output.total_count(),
    })
}

/// List active terminals
#[tauri::command]
pub fn term_list(
    state: State<'_, Arc<ProcessStore>>,
) -> Result<Vec<TermHandle>, String> {
    Ok(state.handles())
}

/// Get available shells
#[tauri::command]
pub fn term_get_shells() -> Result<Vec<ShellInfo>, String> {
    Ok(detect_shells())
}

/// Check if a terminal is alive
#[tauri::command]
pub fn term_is_alive(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
) -> Result<bool, String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get_mut(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    // Check if process has exited
    if terminal.is_alive.load(Ordering::SeqCst) {
        match terminal.try_wait() {
            Ok(Some(_)) => {
                terminal.is_alive.store(false, Ordering::SeqCst);
                Ok(false)
            }
            _ => Ok(true),
        }
    } else {
        Ok(false)
    }
}

// ============================================================================
// Simple Command Execution
// ============================================================================

/// Execute a simple command (non-interactive)
#[tauri::command]
pub async fn exec(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    use tokio::process::Command;
    use tokio::time::{timeout, Duration};

    let timeout_duration = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS));

    let mut cmd = Command::new(&command);
    cmd.args(&args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    
    // Set working directory
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    
    // Set environment
    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    // Spawn the process
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", command, e))?;

    // Wait with timeout
    let result = timeout(timeout_duration, child.wait()).await;

    match result {
        Ok(Ok(status)) => {
            // Process completed
            let stdout = if let Some(mut stdout) = child.stdout.take() {
                let mut buf = String::new();
                use tokio::io::AsyncReadExt;
                let _ = stdout.read_to_string(&mut buf).await;
                buf
            } else {
                String::new()
            };

            let stderr = if let Some(mut stderr) = child.stderr.take() {
                let mut buf = String::new();
                use tokio::io::AsyncReadExt;
                let _ = stderr.read_to_string(&mut buf).await;
                buf
            } else {
                String::new()
            };

            Ok(ExecResult {
                stdout,
                stderr,
                exit_code: status.code(),
                timed_out: false,
            })
        }
        Ok(Err(e)) => {
            // Process error
            Err(format!("Process error: {}", e))
        }
        Err(_) => {
            // Timeout - kill the process
            let _ = child.kill().await;
            
            // Try to get any output before killing
            let stdout = if let Some(mut stdout) = child.stdout.take() {
                let mut buf = String::new();
                use tokio::io::AsyncReadExt;
                let _ = stdout.read_to_string(&mut buf).await;
                buf
            } else {
                String::new()
            };

            let stderr = if let Some(mut stderr) = child.stderr.take() {
                let mut buf = String::new();
                use tokio::io::AsyncReadExt;
                let _ = stderr.read_to_string(&mut buf).await;
                buf
            } else {
                String::new()
            };

            Ok(ExecResult {
                stdout,
                stderr,
                exit_code: None,
                timed_out: true,
            })
        }
    }
}

// ============================================================================
// Additional Utility Commands
// ============================================================================

/// Clear terminal output buffer
#[tauri::command]
pub fn term_clear_buffer(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get_mut(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    *terminal.output.lock().map_err(|e| e.to_string())? = 
        RingBuffer::new(DEFAULT_RING_BUFFER_CAPACITY);
    
    Ok(())
}

const ALLOWED_SIGNALS: &[i32] = &[
    2,  // SIGINT
    9,  // SIGKILL
    15, // SIGTERM
    18, // SIGCONT
    19, // SIGSTOP
];

/// Send signal to terminal process (Unix only)
#[cfg(unix)]
#[tauri::command]
pub fn term_signal(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
    signal: i32,
) -> Result<(), String> {
    if !ALLOWED_SIGNALS.contains(&signal) {
        return Err(format!("Signal {} is not in the allowed list", signal));
    }

    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    if let Some(pid) = terminal.pid() {
        let pid_i32: i32 = pid
            .try_into()
            .map_err(|_| format!("PID {} overflows i32", pid))?;
        unsafe {
            let result = libc::kill(pid_i32, signal);
            if result != 0 {
                return Err(format!("Failed to send signal {} to {}", signal, pid));
            }
        }
    }

    Ok(())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn term_signal(
    _state: State<'_, Arc<ProcessStore>>,
    _handle: TermHandle,
    _signal: i32,
) -> Result<(), String> {
    Err("Signals are only supported on Unix systems".to_string())
}

/// Change terminal working directory (via shell command)
#[tauri::command]
pub fn term_set_cwd(
    state: State<'_, Arc<ProcessStore>>,
    handle: TermHandle,
    cwd: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let terminal = terminals
        .get_mut(&handle)
        .ok_or_else(|| format!("Terminal {:?} not found", handle))?;

    // Send cd command via shell (platform-aware quoting)
    let cd_cmd = if cfg!(target_os = "windows") {
        format!("cd /d \"{}\"\n", cwd.replace('"', "\"\""))
    } else {
        format!("cd '{}'\n", cwd.replace('\'', "'\"'\"'"))
    };
    terminal.write(&cd_cmd)?;
    terminal.cwd = cwd;
    
    Ok(())
}
