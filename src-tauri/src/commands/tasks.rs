use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

fn shell_escape(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/' || c == ':'
    }) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

struct TaskProcessHandle {
    child: Child,
}

pub struct TaskProcessStore {
    tasks: Mutex<HashMap<u32, TaskProcessHandle>>,
    next_id: Mutex<u32>,
}

impl TaskProcessStore {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct TaskOutputEvent {
    task_id: u32,
    data: String,
    stream: String, // "stdout" or "stderr"
}

#[derive(Debug, Clone, Serialize)]
struct TaskExitEvent {
    task_id: u32,
    exit_code: Option<i32>,
}

/// Spawn a task process (non-PTY) and return its task_id.
/// Output is emitted as `task-output` events, exit as `task-exit`.
#[tauri::command]
pub fn task_spawn(
    app: AppHandle,
    state: State<'_, Arc<TaskProcessStore>>,
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    shell: Option<bool>,
) -> Result<u32, String> {
    let use_shell = shell.unwrap_or(true);

    let mut cmd = if use_shell {
        let shell_path = if cfg!(target_os = "windows") {
            "powershell".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        };

        let mut c = Command::new(&shell_path);
        if cfg!(target_os = "windows") {
            c.args(&["-NoProfile", "-Command"]);
            let full_cmd = if let Some(ref a) = args {
                let mut parts = vec![command.clone()];
                parts.extend(a.iter().map(|arg| {
                    if arg.contains(' ') || arg.contains('"') {
                        format!("\"{}\"", arg.replace('"', "`\""))
                    } else {
                        arg.clone()
                    }
                }));
                parts.join(" ")
            } else {
                command.clone()
            };
            c.arg(&full_cmd);
        } else {
            c.arg("-c");
            let full_cmd = if let Some(ref a) = args {
                let mut parts = vec![shell_escape(&command)];
                parts.extend(a.iter().map(|arg| shell_escape(arg)));
                parts.join(" ")
            } else {
                shell_escape(&command)
            };
            c.arg(&full_cmd);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        c
    } else {
        let mut c = Command::new(&command);
        if let Some(ref a) = args {
            c.args(a);
        }
        c
    };

    if let Some(ref dir) = cwd {
        if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
            cmd.current_dir(dir);
        }
    }

    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn task '{}': {}", command, e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let id = {
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        let id = *next;
        *next += 1;
        id
    };

    {
        let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
        tasks.insert(id, TaskProcessHandle { child });
    }

    let task_id = id;
    let state_clone = state.inner().clone();

    if let Some(stdout) = stdout {
        let app_out = app.clone();
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_out.emit(
                            "task-output",
                            TaskOutputEvent {
                                task_id,
                                data: text,
                                stream: "stdout".to_string(),
                            },
                        );
                    }
                    Err(_) => break,
                }
            }

            let exit_code = {
                let mut tasks = match state_clone.tasks.lock() {
                    Ok(t) => t,
                    Err(_) => {
                        let _ = app_out.emit(
                            "task-exit",
                            TaskExitEvent {
                                task_id,
                                exit_code: None,
                            },
                        );
                        return;
                    }
                };
                if let Some(handle) = tasks.get_mut(&task_id) {
                    match handle.child.wait() {
                        Ok(status) => status.code(),
                        Err(_) => None,
                    }
                } else {
                    None
                }
            };

            let _ = app_out.emit("task-exit", TaskExitEvent { task_id, exit_code });
        });
    }

    if let Some(stderr) = stderr {
        let app_err = app.clone();
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_err.emit(
                            "task-output",
                            TaskOutputEvent {
                                task_id,
                                data: text,
                                stream: "stderr".to_string(),
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    Ok(id)
}

/// Kill a running task process.
#[tauri::command]
pub fn task_kill(state: State<'_, Arc<TaskProcessStore>>, task_id: u32) -> Result<(), String> {
    let mut tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    let mut handle = tasks
        .remove(&task_id)
        .ok_or_else(|| format!("Task {} not found", task_id))?;

    handle
        .child
        .kill()
        .map_err(|e| format!("Failed to kill task {}: {}", task_id, e))?;

    let _ = handle.child.wait();

    Ok(())
}

/// List currently running task process IDs.
#[tauri::command]
pub fn task_list(state: State<'_, Arc<TaskProcessStore>>) -> Result<Vec<u32>, String> {
    let tasks = state.tasks.lock().map_err(|e| e.to_string())?;
    Ok(tasks.keys().cloned().collect())
}
