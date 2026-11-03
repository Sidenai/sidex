//! Tool dispatch and module index.

pub mod context;
pub mod cwd;
pub mod edit_file;
pub mod file_ops;
pub mod git;
pub mod grep;
pub mod image;
pub mod image_gen;
pub mod lsp;
pub mod monitor;
pub mod shell;
pub mod tree;
pub mod web;
pub mod worktree;

use crate::ToolContext;
use anyhow::Result;
use std::collections::HashMap;

type Args = HashMap<String, serde_json::Value>;

pub fn dispatch(name: &str, args: &Args, ctx: &ToolContext) -> Result<String> {
    match name {
        "cwd" => cwd::run(ctx),
        "read_file" => file_ops::read_file(args, ctx),
        "write_file" => file_ops::write_file(args, ctx),
        "delete_file" => file_ops::delete_file(args, ctx),
        "edit_file" => edit_file::run(args, ctx),
        "multi_edit" => edit_file::multi_edit(args, ctx),
        "list_dir" => file_ops::list_dir(args, ctx),
        "tree" => tree::run(args, ctx),
        "glob" | "search_files" => file_ops::glob(args, ctx),
        "grep" => grep::run(args, ctx),
        "file_info" => file_ops::file_info(args, ctx),
        "batch_read" => file_ops::batch_read(args, ctx),
        "shell" => shell::run(args, ctx),
        "git_status" => git::status(args, ctx),
        "git_log" => git::log(args, ctx),
        "git_diff_file" | "diff" => git::diff(args, ctx),
        "git_commit" => git::commit(args, ctx),
        "image_read" => image::read(args, ctx),
        "lsp_hover" => lsp::hover(args, ctx),
        "lsp_definition" => lsp::definition(args, ctx),
        "lsp_references" => lsp::references(args, ctx),
        "lsp_diagnostics" => lsp::diagnostics(args, ctx),
        "skill" => run_skill(args, ctx),
        "context_index" => context::index(args, ctx),
        "context_search" => context::search(args, ctx),
        "context_watch" => context::watch(args, ctx),
        "context_status" => context::status(args, ctx),
        "web_search" => web::search(args, ctx),
        "web_fetch" => web::fetch(args, ctx),
        "image_gen" | "generate_image" => image_gen::generate(args, ctx),
        "monitor_start" | "monitor" => monitor::start(args, ctx),
        "monitor_poll" => monitor::poll(args, ctx),
        "monitor_stop" => monitor::stop(args, ctx),
        "monitor_list" => monitor::list(args, ctx),
        "enter_worktree" | "create_worktree" => worktree::create_worktree(args, ctx),
        "exit_worktree" | "remove_worktree" => worktree::remove_worktree(args, ctx),
        "list_worktrees" => worktree::list_worktrees(args, ctx),
        _ => anyhow::bail!("tool not implemented locally: {name}"),
    }
}

// --- helpers used across tools ---

pub fn get_str<'a>(args: &'a Args, key: &str) -> &'a str {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

pub fn get_str_or<'a>(args: &'a Args, key: &str, default: &'a str) -> &'a str {
    let v = get_str(args, key);
    if v.is_empty() {
        default
    } else {
        v
    }
}

pub fn get_int(args: &Args, key: &str, default: i64) -> i64 {
    args.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
}

pub fn get_bool(args: &Args, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

pub fn resolve_path(ctx: &ToolContext, p: &str) -> String {
    if p.is_empty() {
        return ctx.cwd.clone();
    }
    if std::path::Path::new(p).is_absolute() {
        p.to_string()
    } else {
        format!("{}/{}", ctx.cwd, p)
    }
}

fn run_skill(args: &Args, ctx: &ToolContext) -> Result<String> {
    let name = get_str(args, "name").trim().trim_start_matches('/');
    if name.is_empty() {
        anyhow::bail!("skill name is required");
    }

    let project_dir = std::path::Path::new(&ctx.cwd);
    let skills = crate::skills::load_skills(project_dir);

    if let Some(skill) = crate::skills::find_skill(&skills, name) {
        Ok(format!("[skill: {}]\n\n{}", skill.name, skill.body))
    } else {
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        anyhow::bail!(
            "unknown skill {:?} — available: {}",
            name,
            if names.is_empty() {
                "(none — create .sidex/skills/*.md)".to_string()
            } else {
                names.join(", ")
            }
        );
    }
}
