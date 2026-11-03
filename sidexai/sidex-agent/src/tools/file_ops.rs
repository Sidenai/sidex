use super::{get_int, get_str, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::fs;
use std::path::Path;

pub fn read_file(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let content = fs::read_to_string(&path)?;

    let offset = get_int(args, "offset", 0) as usize;
    let limit = get_int(args, "limit", 0) as usize;
    let lines: Vec<&str> = content.lines().collect();

    let start = if offset > 0 {
        (offset - 1).min(lines.len().saturating_sub(1))
    } else {
        0
    };
    let end = if limit > 0 {
        (start + limit).min(lines.len())
    } else {
        lines.len()
    };

    let mut out = String::with_capacity(content.len());
    for (i, line) in lines[start..end].iter().enumerate() {
        use std::fmt::Write;
        let _ = writeln!(out, "{:>6}|{}", start + i + 1, line);
    }
    Ok(out)
}

pub fn write_file(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let content = get_str(args, "content");

    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, content)?;
    Ok(format!("wrote {} ({} bytes)", path, content.len()))
}

pub fn list_dir(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, super::get_str_or(args, "path", "."));
    let mut entries: Vec<_> = fs::read_dir(&path)?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    let mut out = String::new();
    for entry in entries {
        let meta = entry.metadata()?;
        let kind = if meta.is_dir() { "dir " } else { "file" };
        let size = meta.len();
        use std::fmt::Write;
        let _ = writeln!(out, "{}  {:>8}  {}", kind, size, entry.file_name().to_string_lossy());
    }
    Ok(out)
}

pub fn file_info(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let meta = fs::metadata(&path)?;
    let modified = meta.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    Ok(format!(
        "name: {}\nsize: {}\nis_dir: {}\nmodified: {}",
        Path::new(&path).file_name().unwrap_or_default().to_string_lossy(),
        meta.len(),
        meta.is_dir(),
        modified,
    ))
}

pub fn batch_read(args: &Args, ctx: &ToolContext) -> Result<String> {
    let paths = args.get("paths")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
        .unwrap_or_default();
    if paths.is_empty() {
        bail!("paths must be a non-empty array");
    }

    let mut out = String::new();
    for p in paths {
        let abs = resolve_path(ctx, p);
        use std::fmt::Write;
        match fs::read_to_string(&abs) {
            Ok(content) => {
                let truncated = if content.len() > 10_000 {
                    format!("{}...(truncated)", &content[..10_000])
                } else {
                    content
                };
                let _ = writeln!(out, "=== {} ===\n{}\n", abs, truncated);
            }
            Err(e) => {
                let _ = writeln!(out, "=== {} ===\nERROR: {}\n", abs, e);
            }
        }
    }
    Ok(out)
}

pub fn glob(args: &Args, ctx: &ToolContext) -> Result<String> {
    let pattern = get_str(args, "pattern");
    if pattern.is_empty() {
        bail!("pattern is required");
    }
    let base = resolve_path(ctx, super::get_str_or(args, "path", "."));

    let matcher = globset::GlobBuilder::new(pattern)
        .literal_separator(false)
        .build()?
        .compile_matcher();

    let mut matches = Vec::new();
    for entry in ignore::WalkBuilder::new(&base).hidden(false).build().flatten() {
        if entry.file_type().map_or(true, |ft| ft.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if matcher.is_match(name.as_ref()) {
            if let Ok(rel) = entry.path().strip_prefix(&base) {
                matches.push(rel.display().to_string());
            }
        }
        if matches.len() >= 500 {
            break;
        }
    }
    Ok(matches.join("\n"))
}
