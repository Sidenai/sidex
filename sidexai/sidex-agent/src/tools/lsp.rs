use super::{get_int, get_str, resolve_path, Args};
use crate::ToolContext;
use anyhow::Result;

pub fn hover(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let line = get_int(args, "line", 0);
    let character = get_int(args, "character", 0);
    Ok(format!(
        "LSP hover request: {}:{}:{}\nNote: LSP execution requires active language server in the IDE.",
        path, line, character
    ))
}

pub fn definition(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let line = get_int(args, "line", 0);
    let character = get_int(args, "character", 0);
    Ok(format!(
        "LSP definition request: {}:{}:{}\nNote: LSP execution requires active language server in the IDE.",
        path, line, character
    ))
}

pub fn references(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let line = get_int(args, "line", 0);
    let character = get_int(args, "character", 0);
    Ok(format!(
        "LSP references request: {}:{}:{}\nNote: LSP execution requires active language server in the IDE.",
        path, line, character
    ))
}

pub fn diagnostics(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    Ok(format!(
        "LSP diagnostics request: {}\nNote: LSP execution requires active language server in the IDE.",
        path
    ))
}
