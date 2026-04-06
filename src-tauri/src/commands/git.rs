use serde::{Deserialize, Serialize};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Create a `Command` for git with CREATE_NO_WINDOW on Windows.
fn git_command() -> Command {
    let mut cmd = Command::new("git");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub changes: Vec<GitChange>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_hashes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insertions: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command()
        .current_dir(path)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git error: {}", stderr.trim()))
    }
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    let output = run_git(&path, &["status", "--porcelain=v1", "-b"])?;
    let mut lines = output.lines();

    let branch = lines
        .next()
        .unwrap_or("## HEAD (no branch)")
        .trim_start_matches("## ")
        .split("...")
        .next()
        .unwrap_or("HEAD")
        .to_string();

    let changes = lines
        .filter(|l| !l.is_empty())
        .map(|line| {
            let xy = &line[..2];
            let file_path = line[3..].trim().to_string();
            let x = xy.chars().next().unwrap_or(' ');
            let y = xy.chars().nth(1).unwrap_or(' ');

            let (status, staged) = if x != ' ' && x != '?' {
                (format!("{}", x), true)
            } else {
                (format!("{}", y), false)
            };

            let status = match status.as_str() {
                "M" => "modified".to_string(),
                "A" => "added".to_string(),
                "D" => "deleted".to_string(),
                "R" => "renamed".to_string(),
                "C" => "copied".to_string(),
                "?" => "untracked".to_string(),
                "!" => "ignored".to_string(),
                other => other.to_string(),
            };

            GitChange {
                path: file_path,
                status,
                staged,
            }
        })
        .collect();

    Ok(GitStatus { branch, changes })
}

#[tauri::command]
pub async fn git_diff(path: String, file: Option<String>, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--staged");
    }
    if let Some(ref f) = file {
        args.push("--");
        args.push(f.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub async fn git_log(path: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let limit_str = format!("-{}", limit.unwrap_or(50));
    let output = run_git(&path, &["log", "--format=%H%n%s%n%an%n%aI", &limit_str])?;

    let lines: Vec<&str> = output.lines().collect();
    let entries = lines
        .chunks(4)
        .filter(|chunk| chunk.len() == 4)
        .map(|chunk| GitLogEntry {
            hash: chunk[0].to_string(),
            message: chunk[1].to_string(),
            author: chunk[2].to_string(),
            date: chunk[3].to_string(),
            parent_hashes: None,
            email: None,
            files_changed: None,
            insertions: None,
            deletions: None,
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn git_add(path: String, files: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    let refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(refs);
    run_git(&path, &args)?;
    Ok(())
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git(&path, &["commit", "-m", &message])?;
    let hash = run_git(&path, &["rev-parse", "HEAD"])?;
    Ok(hash.trim().to_string())
}

#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<(), String> {
    run_git(&path, &["checkout", &branch])?;
    Ok(())
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<GitBranch>, String> {
    let output = run_git(&path, &["branch", "-a"])?;

    let branches = output
        .lines()
        .filter(|l| !l.is_empty())
        .filter(|l| !l.contains("->"))
        .map(|line| {
            let current = line.starts_with('*');
            let name = line.trim_start_matches('*').trim().to_string();
            let remote = name.starts_with("remotes/");
            let name = name.trim_start_matches("remotes/").to_string();

            GitBranch {
                name,
                current,
                remote,
            }
        })
        .collect();

    Ok(branches)
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<(), String> {
    run_git(&path, &["init"])?;
    Ok(())
}

#[tauri::command]
pub async fn git_is_repo(path: String) -> Result<bool, String> {
    let output = git_command()
        .current_dir(&path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    Ok(output.status.success())
}

#[tauri::command]
pub async fn git_push(
    path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["push"];
    if let Some(ref r) = remote {
        args.push(r.as_str());
    }
    if let Some(ref b) = branch {
        args.push(b.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub async fn git_pull(
    path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["pull"];
    if let Some(ref r) = remote {
        args.push(r.as_str());
    }
    if let Some(ref b) = branch {
        args.push(b.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub async fn git_fetch(path: String, remote: Option<String>) -> Result<String, String> {
    let mut args = vec!["fetch"];
    if let Some(ref r) = remote {
        args.push(r.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub async fn git_stash(
    path: String,
    action: String,
    message: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["stash"];
    args.push(match action.as_str() {
        "push" => "push",
        "pop" => "pop",
        "list" => "list",
        "drop" => "drop",
        other => return Err(format!("Unknown stash action: {}", other)),
    });
    if action == "push" {
        if let Some(ref m) = message {
            args.push("-m");
            args.push(m.as_str());
        }
    }
    run_git(&path, &args)
}

#[tauri::command]
pub async fn git_create_branch(
    path: String,
    name: String,
    start_point: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["checkout", "-b", name.as_str()];
    if let Some(ref sp) = start_point {
        args.push(sp.as_str());
    }
    run_git(&path, &args)?;
    Ok(())
}

#[tauri::command]
pub async fn git_delete_branch(path: String, name: String) -> Result<(), String> {
    run_git(&path, &["branch", "-d", &name])?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
    #[serde(rename = "type")]
    pub remote_type: String,
}

#[tauri::command]
pub async fn git_remote_list(path: String) -> Result<Vec<GitRemote>, String> {
    let output = run_git(&path, &["remote", "-v"])?;
    let mut remotes = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            let remote_type = parts[2].trim_matches(|c| c == '(' || c == ')').to_string();
            remotes.push(GitRemote {
                name: parts[0].to_string(),
                url: parts[1].to_string(),
                remote_type,
            });
        }
    }
    Ok(remotes)
}

#[tauri::command]
pub async fn git_clone(url: String, path: String) -> Result<(), String> {
    if let Ok(parsed) = reqwest::Url::parse(&url) {
        match parsed.scheme() {
            "https" | "http" | "ssh" | "git" => {}
            scheme => return Err(format!("git clone: blocked URL scheme '{}'", scheme)),
        }
    }

    let canon_path = std::path::Path::new(&path);
    if canon_path
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return Err("git clone: path must not contain '..'".to_string());
    }

    let output = git_command()
        .args(["clone", "--no-checkout", &url, &path])
        .output()
        .map_err(|e| format!("Failed to execute git clone: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git clone error: {}", stderr.trim()));
    }

    // Complete checkout with hooks disabled
    let checkout = git_command()
        .current_dir(&path)
        .args(["-c", "core.hooksPath=/dev/null", "checkout"])
        .output()
        .map_err(|e| format!("Failed to execute git checkout: {}", e))?;

    if checkout.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&checkout.stderr);
        Err(format!("git checkout error: {}", stderr.trim()))
    }
}

#[tauri::command]
pub async fn git_reset(path: String, files: Vec<String>) -> Result<(), String> {
    let mut cmd = vec!["reset", "HEAD", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    cmd.extend(file_refs);
    run_git(&path, &cmd)?;
    Ok(())
}

#[tauri::command]
pub async fn git_show(path: String, file: String) -> Result<Vec<u8>, String> {
    let rev_file = format!("HEAD:{}", file);
    let output = git_command()
        .current_dir(&path)
        .args(["show", &rev_file])
        .output()
        .map_err(|e| format!("Failed to execute git show: {}", e))?;

    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git show error: {}", stderr.trim()))
    }
}

const BLOCKED_GIT_FLAGS: &[&str] = &[
    "-c",
    "--exec",
    "--upload-pack",
    "--receive-pack",
    "--config",
    "--exec-path",
];

const ALLOWED_GIT_SUBCOMMANDS: &[&str] = &[
    "add",
    "am",
    "apply",
    "archive",
    "bisect",
    "blame",
    "branch",
    "cat-file",
    "cherry-pick",
    "checkout",
    "clone",
    "commit",
    "describe",
    "diff",
    "diff-tree",
    "fetch",
    "for-each-ref",
    "format-patch",
    "gc",
    "grep",
    "hash-object",
    "init",
    "log",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "merge",
    "pack-refs",
    "prune",
    "pull",
    "push",
    "rebase",
    "reflog",
    "remote",
    "reset",
    "revert",
    "rev-parse",
    "shortlog",
    "show",
    "stash",
    "status",
    "submodule",
    "tag",
    "worktree",
    "clean",
];

fn validate_git_args(args: &[String]) -> Result<(), String> {
    let subcommand = args.first().map(|s| s.as_str()).unwrap_or("");
    if !ALLOWED_GIT_SUBCOMMANDS.contains(&subcommand) {
        return Err(format!("git subcommand '{}' is not allowed", subcommand));
    }
    for arg in args.iter().skip(1) {
        let lower = arg.to_lowercase();
        for blocked in BLOCKED_GIT_FLAGS {
            if lower == *blocked || lower.starts_with(&format!("{}=", blocked)) {
                return Err(format!("git flag '{}' is not allowed", arg));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn git_run(path: String, args: Vec<String>) -> Result<String, String> {
    validate_git_args(&args)?;
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(&path, &arg_refs)
}

#[tauri::command]
pub async fn git_log_graph(path: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let limit_str = format!("-{}", limit.unwrap_or(50));
    let output = run_git(
        &path,
        &[
            "log",
            "--format=%H%n%P%n%s%n%an%n%ae%n%aI",
            "--shortstat",
            &limit_str,
        ],
    )?;

    let mut entries = Vec::new();
    let mut lines = output.lines().peekable();

    while lines.peek().is_some() {
        let hash = match lines.next() {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => break,
        };
        let parents_line = lines.next().unwrap_or("");
        let subject = lines.next().unwrap_or("").to_string();
        let author = lines.next().unwrap_or("").to_string();
        let email = lines.next().unwrap_or("").to_string();
        let date = lines.next().unwrap_or("").to_string();

        let mut files_changed: Option<u32> = None;
        let mut insertions: Option<u32> = None;
        let mut deletions: Option<u32> = None;

        // Skip empty lines and parse shortstat line if present
        while let Some(&next) = lines.peek() {
            if next.is_empty() {
                lines.next();
                continue;
            }
            if next.contains("file") && next.contains("changed") {
                let stat_line = lines.next().unwrap_or("");
                for part in stat_line.split(',') {
                    let part = part.trim();
                    if part.contains("file") {
                        files_changed = part.split_whitespace().next().and_then(|n| n.parse().ok());
                    } else if part.contains("insertion") {
                        insertions = part.split_whitespace().next().and_then(|n| n.parse().ok());
                    } else if part.contains("deletion") {
                        deletions = part.split_whitespace().next().and_then(|n| n.parse().ok());
                    }
                }
                break;
            }
            break;
        }

        let parent_hashes: Vec<String> = parents_line
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();

        entries.push(GitLogEntry {
            hash,
            message: subject,
            author,
            date,
            parent_hashes: Some(parent_hashes),
            email: if email.is_empty() { None } else { Some(email) },
            files_changed,
            insertions,
            deletions,
        });
    }

    Ok(entries)
}
