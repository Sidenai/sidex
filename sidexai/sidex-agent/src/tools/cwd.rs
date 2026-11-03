use crate::ToolContext;
use anyhow::Result;

pub fn run(ctx: &ToolContext) -> Result<String> {
    let abs = std::fs::canonicalize(&ctx.cwd)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| ctx.cwd.clone());
    let exists = std::fs::metadata(&ctx.cwd)
        .map(|m| m.is_dir())
        .unwrap_or(false);
    Ok(format!("cwd: {}\nabsolute: {abs}\nexists: {exists}", ctx.cwd))
}
