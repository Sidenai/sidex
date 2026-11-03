use super::{get_str, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::process::Command;

pub fn create_worktree(args: &Args, ctx: &ToolContext) -> Result<String> {
    if !is_git_repo(&ctx.cwd) {
        bail!("current directory is not inside a git repository");
    }

    let suffix = get_str(args, "branch");
    let id = short_id();
    let branch = if suffix.is_empty() {
        format!("sidex/wt-{id}")
    } else {
        format!("sidex/wt-{suffix}-{id}")
    };

    let wt_dir = std::env::temp_dir().join("sidex-worktrees").join(&id);
    let wt_path = wt_dir.to_string_lossy().to_string();

    if let Some(parent) = wt_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let output = Command::new("git")
        .args(["worktree", "add", &wt_path, "-b", &branch])
        .current_dir(&ctx.cwd)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        bail!("git worktree add failed: {stderr}");
    }

    Ok(format!(
        "Worktree created.\n  branch: {branch}\n  path:   {wt_path}\n  source: {}\n{stdout}{stderr}",
        ctx.cwd
    ))
}

pub fn remove_worktree(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = get_str(args, "path");
    if path.is_empty() {
        bail!("path to the worktree is required");
    }

    let delete_branch = get_str(args, "delete_branch") == "true"
        || args
            .get("delete_branch")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

    let output = Command::new("git")
        .args(["worktree", "remove", "--force", path])
        .current_dir(&ctx.cwd)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        bail!("git worktree remove failed: {stderr}");
    }

    let mut result = format!("Worktree removed: {path}\n{stdout}{stderr}");

    if delete_branch {
        let branch = get_str(args, "branch");
        if !branch.is_empty() {
            let br_out = Command::new("git")
                .args(["branch", "-D", branch])
                .current_dir(&ctx.cwd)
                .output()?;
            let br_stdout = String::from_utf8_lossy(&br_out.stdout);
            let br_stderr = String::from_utf8_lossy(&br_out.stderr);
            result.push_str(&format!("\n{br_stdout}{br_stderr}"));
        }
    }

    let _ = std::fs::remove_dir_all(path);

    Ok(result)
}

pub fn list_worktrees(_args: &Args, ctx: &ToolContext) -> Result<String> {
    if !is_git_repo(&ctx.cwd) {
        bail!("not inside a git repository");
    }

    let output = Command::new("git")
        .args(["worktree", "list"])
        .current_dir(&ctx.cwd)
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");

    if combined.trim().is_empty() {
        Ok("(no worktrees)".into())
    } else {
        Ok(combined)
    }
}

fn is_git_repo(dir: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

fn short_id() -> String {
    use std::time::SystemTime;
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let rand_part: u32 = (ts as u32).wrapping_mul(2654435761);
    format!("{:x}-{:04x}", ts / 1000, rand_part & 0xFFFF)
}
