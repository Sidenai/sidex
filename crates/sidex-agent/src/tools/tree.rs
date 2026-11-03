use super::{get_int, get_str_or, resolve_path, Args};
use crate::ToolContext;
use anyhow::Result;
use std::fs;

pub fn run(args: &Args, ctx: &ToolContext) -> Result<String> {
    let dir = resolve_path(ctx, get_str_or(args, "path", "."));
    let depth = get_int(args, "depth", 3) as usize;
    let mut out = Vec::new();
    build_tree(&dir, "", 0, depth, &mut out);
    Ok(out.join("\n"))
}

const NOISE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    ".next",
    "dist",
    "build",
    ".DS_Store",
];

fn build_tree(dir: &str, prefix: &str, level: usize, max_depth: usize, out: &mut Vec<String>) {
    if level >= max_depth {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());

    let count = items.len();
    for (i, entry) in items.iter().enumerate() {
        let name = entry.file_name().to_string_lossy().to_string();
        if NOISE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let is_last = i == count - 1;
        let connector = if is_last { "└── " } else { "├── " };
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let suffix = if is_dir { "/" } else { "" };
        out.push(format!("{prefix}{connector}{name}{suffix}"));

        if is_dir {
            let next_prefix = format!("{}{}", prefix, if is_last { "    " } else { "│   " });
            build_tree(
                &entry.path().display().to_string(),
                &next_prefix,
                level + 1,
                max_depth,
                out,
            );
        }
    }
}
