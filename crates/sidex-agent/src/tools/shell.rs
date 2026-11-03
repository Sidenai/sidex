use super::{get_int, get_str, get_str_or, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub fn run(args: &Args, ctx: &ToolContext) -> Result<String> {
    let command = get_str(args, "command");
    if command.is_empty() {
        bail!("command is required");
    }
    let timeout_sec = get_int(args, "timeout", 30).min(300).max(1) as u64;
    let work_dir = resolve_path(ctx, get_str_or(args, "working_directory", &ctx.cwd));

    if !std::path::Path::new(&work_dir).is_dir() {
        bail!("working_directory {work_dir:?} does not exist");
    }

    let mut child = Command::new("sh")
        .args(["-c", command])
        .current_dir(&work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn: {e}"))?;

    let pid = child.id();
    let timeout = Duration::from_secs(timeout_sec);
    let start = Instant::now();

    // Spawn a watchdog thread that kills the process after timeout
    let handle = thread::spawn(move || {
        thread::sleep(timeout);
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    });

    let status = child.wait();
    let elapsed = start.elapsed();

    // If we finished before timeout, the watchdog thread is harmless (process already exited)
    drop(handle);

    match status {
        Ok(s) => {
            if elapsed >= timeout {
                bail!("command timed out after {timeout_sec}s and was killed");
            }

            let mut result = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                let mut buf = String::new();
                let _ = stdout.read_to_string(&mut buf);
                result.push_str(&buf);
            }
            if let Some(mut stderr) = child.stderr.take() {
                let mut buf = String::new();
                let _ = stderr.read_to_string(&mut buf);
                if !buf.is_empty() {
                    result.push_str(&buf);
                }
            }
            if !s.success() {
                if let Some(code) = s.code() {
                    result.push_str(&format!("\nexit code: {code}"));
                }
            }
            if result.is_empty() {
                result = "(command produced no output)".into();
            }
            if result.len() > 100_000 {
                result.truncate(100_000);
                result.push_str("\n...(truncated)");
            }
            Ok(result)
        }
        Err(e) => bail!("failed to wait on process: {e}"),
    }
}
