use super::{get_int, get_str, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::process::Command;

pub fn status(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let cwd = if path.is_empty() { &ctx.cwd } else { &path };
    git_cmd(cwd, &["status", "--short", "--branch"])
}

pub fn log(args: &Args, ctx: &ToolContext) -> Result<String> {
    let count = get_int(args, "count", 10).max(1).min(100);
    git_cmd(&ctx.cwd, &["log", &format!("-{count}"), "--oneline", "--decorate"])
}

pub fn diff(args: &Args, ctx: &ToolContext) -> Result<String> {
    let file = get_str(args, "path");
    if file.is_empty() {
        git_cmd(&ctx.cwd, &["diff", "HEAD"])
    } else {
        git_cmd(&ctx.cwd, &["diff", "--", file])
    }
}

pub fn commit(args: &Args, ctx: &ToolContext) -> Result<String> {
    let message = get_str(args, "message");
    if message.is_empty() {
        bail!("commit message required");
    }
    let files = get_str(args, "files");
    if files.is_empty() || files == "." {
        git_cmd(&ctx.cwd, &["add", "-A"])?;
    } else {
        for f in files.split(',') {
            let f = f.trim();
            if !f.is_empty() {
                let _ = git_cmd(&ctx.cwd, &["add", f]);
            }
        }
    }
    git_cmd(&ctx.cwd, &["commit", "-m", message])
}

fn git_cmd(cwd: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");

    if combined.trim().is_empty() {
        Ok("(no output)".into())
    } else {
        Ok(combined)
    }
}
