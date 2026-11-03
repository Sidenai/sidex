use super::{get_int, get_str, get_str_or, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::process::Command;

pub fn run(args: &Args, ctx: &ToolContext) -> Result<String> {
    let command = get_str(args, "command");
    if command.is_empty() {
        bail!("command is required");
    }
    let _timeout_sec = get_int(args, "timeout", 30).min(300).max(1) as u64;
    let work_dir = resolve_path(ctx, get_str_or(args, "working_directory", &ctx.cwd));

    if !std::path::Path::new(&work_dir).is_dir() {
        bail!("working_directory {work_dir:?} does not exist");
    }

    let output = Command::new("sh")
        .args(["-c", command])
        .current_dir(&work_dir)
        .output();

    match output {
        Ok(o) => {
            let mut result = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr);
            if !stderr.is_empty() {
                result.push_str(&stderr);
            }
            if !o.status.success() {
                if let Some(code) = o.status.code() {
                    result.push_str(&format!("\nexit code: {code}"));
                }
            }
            if result.is_empty() {
                result = "(command produced no output)".into();
            }
            // Truncate if huge
            if result.len() > 100_000 {
                result.truncate(100_000);
                result.push_str("\n...(truncated)");
            }
            Ok(result)
        }
        Err(e) => bail!("failed to execute: {e}"),
    }
}
