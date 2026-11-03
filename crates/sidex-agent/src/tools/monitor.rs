use super::{get_int, get_str, get_str_or, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

static MONITORS: LazyLock<Mutex<HashMap<String, MonitorSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MonitorStatus {
    Running,
    Completed,
    Failed,
}

impl std::fmt::Display for MonitorStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Running => write!(f, "running"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

struct MonitorSession {
    id: String,
    command: String,
    label: String,
    pid: u32,
    status: MonitorStatus,
    stdout_lines: Vec<String>,
    stderr_lines: Vec<String>,
    poll_cursor: usize,
    exit_code: Option<i32>,
    started_at: u64,
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn generate_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = now_epoch_secs() % 100_000;
    format!("mon_{ts}_{n}")
}

pub fn start(args: &Args, ctx: &ToolContext) -> Result<String> {
    let command = get_str(args, "command");
    if command.is_empty() {
        bail!("command is required for monitor_start");
    }
    let work_dir = resolve_path(ctx, get_str_or(args, "cwd", &ctx.cwd));
    let label = get_str(args, "label").to_string();

    if !std::path::Path::new(&work_dir).is_dir() {
        bail!("working directory {work_dir:?} does not exist");
    }

    let mut child: Child = Command::new("sh")
        .args(["-c", command])
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn command: {e}"))?;

    let id = generate_id();
    let pid = child.id();

    let session = MonitorSession {
        id: id.clone(),
        command: command.to_string(),
        label: if label.is_empty() {
            command.chars().take(40).collect()
        } else {
            label
        },
        pid,
        status: MonitorStatus::Running,
        stdout_lines: Vec::new(),
        stderr_lines: Vec::new(),
        poll_cursor: 0,
        exit_code: None,
        started_at: now_epoch_secs(),
    };

    {
        let mut monitors = MONITORS.lock().unwrap();
        monitors.insert(id.clone(), session);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Stdout reader thread
    let id_stdout = id.clone();
    if let Some(pipe) = stdout {
        thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let mut monitors = MONITORS.lock().unwrap();
                if let Some(session) = monitors.get_mut(&id_stdout) {
                    session.stdout_lines.push(line);
                } else {
                    break;
                }
            }
        });
    }

    // Stderr reader thread
    let id_stderr = id.clone();
    if let Some(pipe) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let mut monitors = MONITORS.lock().unwrap();
                if let Some(session) = monitors.get_mut(&id_stderr) {
                    session.stderr_lines.push(line);
                } else {
                    break;
                }
            }
        });
    }

    // Waiter thread — detects process exit
    let id_waiter = id.clone();
    thread::spawn(move || {
        let status = child.wait();
        let mut monitors = MONITORS.lock().unwrap();
        if let Some(session) = monitors.get_mut(&id_waiter) {
            match status {
                Ok(s) => {
                    let code = s.code().unwrap_or(-1);
                    session.exit_code = Some(code);
                    session.status = if code == 0 {
                        MonitorStatus::Completed
                    } else {
                        MonitorStatus::Failed
                    };
                }
                Err(_) => {
                    session.status = MonitorStatus::Failed;
                    session.exit_code = Some(-1);
                }
            }
        }
    });

    Ok(format!(
        "Monitor started.\n  id: {id}\n  pid: {pid}\n  command: {command}\n\nUse monitor_poll with id=\"{id}\" to check output."
    ))
}

pub fn poll(args: &Args, _ctx: &ToolContext) -> Result<String> {
    let id = get_str(args, "id");
    if id.is_empty() {
        bail!("id is required for monitor_poll");
    }
    let max_lines = get_int(args, "lines", 50).max(1).min(5000) as usize;

    let mut monitors = MONITORS.lock().unwrap();
    let session = monitors
        .get_mut(id)
        .ok_or_else(|| anyhow::anyhow!("no monitor with id={id:?}"))?;

    let total_lines = session.stdout_lines.len() + session.stderr_lines.len();
    let cursor = session.poll_cursor;

    // Interleave stdout/stderr with labels — we expose new lines since last poll
    let mut output_parts: Vec<String> = Vec::new();

    let stdout_start = cursor.min(session.stdout_lines.len());
    let new_stdout: Vec<String> = session.stdout_lines[stdout_start..]
        .iter()
        .take(max_lines)
        .cloned()
        .collect();

    let stderr_start = cursor
        .saturating_sub(session.stdout_lines.len())
        .min(session.stderr_lines.len());
    let remaining = max_lines.saturating_sub(new_stdout.len());
    let new_stderr: Vec<String> = session.stderr_lines[stderr_start..]
        .iter()
        .take(remaining)
        .cloned()
        .collect();

    let lines_returned = new_stdout.len() + new_stderr.len();
    session.poll_cursor = cursor + lines_returned;

    if !new_stdout.is_empty() {
        output_parts.push(format!("[stdout] ({} new lines)", new_stdout.len()));
        output_parts.push(new_stdout.join("\n"));
    }

    if !new_stderr.is_empty() {
        output_parts.push(format!("[stderr] ({} new lines)", new_stderr.len()));
        output_parts.push(new_stderr.join("\n"));
    }

    let status_line = match session.status {
        MonitorStatus::Running => {
            let elapsed = now_epoch_secs().saturating_sub(session.started_at);
            format!(
                "status: running ({}s elapsed, {} total lines)",
                elapsed, total_lines
            )
        }
        MonitorStatus::Completed => {
            format!(
                "status: completed (exit code: {})",
                session.exit_code.unwrap_or(-1)
            )
        }
        MonitorStatus::Failed => {
            format!(
                "status: failed (exit code: {})",
                session.exit_code.unwrap_or(-1)
            )
        }
    };

    if output_parts.is_empty() {
        Ok(format!("{status_line}\n(no new output since last poll)"))
    } else {
        Ok(format!("{status_line}\n\n{}", output_parts.join("\n")))
    }
}

pub fn stop(args: &Args, _ctx: &ToolContext) -> Result<String> {
    let id = get_str(args, "id");
    if id.is_empty() {
        bail!("id is required for monitor_stop");
    }

    let pid = {
        let monitors = MONITORS.lock().unwrap();
        let session = monitors
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("no monitor with id={id:?}"))?;

        if session.status != MonitorStatus::Running {
            return Ok(format!(
                "Monitor {id} already stopped (status: {}, exit code: {:?})",
                session.status, session.exit_code
            ));
        }
        session.pid
    };

    // Send SIGTERM
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }

    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .output();
    }

    thread::sleep(std::time::Duration::from_millis(500));

    let monitors = MONITORS.lock().unwrap();
    if let Some(session) = monitors.get(id) {
        if session.status == MonitorStatus::Running {
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .output();
            }
            #[cfg(not(unix))]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
        }
    }

    Ok(format!("Monitor {id} (pid {pid}) terminated."))
}

pub fn list(_args: &Args, _ctx: &ToolContext) -> Result<String> {
    let monitors = MONITORS.lock().unwrap();

    if monitors.is_empty() {
        return Ok("No active monitors.".into());
    }

    let now = now_epoch_secs();
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "{:<14} {:<10} {:<8} {}",
        "ID", "STATUS", "RUNTIME", "COMMAND"
    ));
    lines.push("-".repeat(70));

    for session in monitors.values() {
        let runtime = if session.status == MonitorStatus::Running {
            let elapsed = now.saturating_sub(session.started_at);
            format!("{}s", elapsed)
        } else {
            "done".into()
        };
        let display = if session.label == session.command {
            session.label.chars().take(40).collect()
        } else {
            format!(
                "{} ({})",
                session.label,
                session.command.chars().take(30).collect::<String>()
            )
        };
        lines.push(format!(
            "{:<14} {:<10} {:<8} {}",
            session.id, session.status, runtime, display
        ));
    }

    Ok(lines.join("\n"))
}
