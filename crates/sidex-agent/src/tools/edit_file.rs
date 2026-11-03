use super::{get_bool, get_str, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::fs;

pub fn run(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let old_str = get_str(args, "old_string");
    let new_str = get_str(args, "new_string");
    let replace_all = get_bool(args, "replace_all", false);

    if old_str.is_empty() {
        bail!("old_string is required and cannot be empty");
    }

    let content = fs::read_to_string(&path)?;
    let count = content.matches(old_str).count();

    if count == 0 {
        bail!(
            "old_string not found in file. {}",
            not_found_hint(&content, old_str)
        );
    }

    if count > 1 && !replace_all {
        let preview = ambiguity_preview(&content, old_str);
        bail!("old_string matches {count} times. Pass replace_all=true or provide more context.\n{preview}");
    }

    let updated = if replace_all {
        content.replace(old_str, new_str)
    } else {
        content.replacen(old_str, new_str, 1)
    };

    fs::write(&path, &updated)?;
    Ok(format!("edited {} ({} replacement(s))", path, count))
}

pub fn multi_edit(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let edits = args
        .get("edits")
        .and_then(|v| v.as_array())
        .map(|a| a.to_vec())
        .unwrap_or_default();

    if edits.is_empty() {
        bail!("edits must be a non-empty array");
    }

    let mut content = fs::read_to_string(&path)?;
    let mut applied = 0;

    for edit in &edits {
        let old = edit
            .get("old_text")
            .and_then(|v| v.as_str())
            .or_else(|| edit.get("old").and_then(|v| v.as_str()))
            .or_else(|| edit.get("old_string").and_then(|v| v.as_str()))
            .unwrap_or("");
        let new = edit
            .get("new_text")
            .and_then(|v| v.as_str())
            .or_else(|| edit.get("new").and_then(|v| v.as_str()))
            .or_else(|| edit.get("new_string").and_then(|v| v.as_str()))
            .unwrap_or("");
        if old.is_empty() {
            continue;
        }
        if content.contains(old) {
            content = content.replacen(old, new, 1);
            applied += 1;
        }
    }

    if applied == 0 {
        bail!("none of the old strings matched");
    }

    fs::write(&path, &content)?;
    Ok(format!(
        "applied {}/{} edits to {}",
        applied,
        edits.len(),
        path
    ))
}

fn not_found_hint(content: &str, old: &str) -> String {
    let lines: Vec<&str> = old.split('\n').collect();
    for i in (1..=lines.len()).rev() {
        let candidate: String = lines[..i].join("\n");
        if !candidate.is_empty() && candidate != old && content.contains(&candidate) {
            let shown = if candidate.len() > 160 {
                format!("{}...", &candidate[..160])
            } else {
                candidate
            };
            return format!(
                "First {} line(s) DO appear. Re-read and correct the rest. Prefix:\n{shown}",
                i
            );
        }
    }
    "Re-read the file; the text doesn't appear. Check whitespace/indentation.".into()
}

fn ambiguity_preview(content: &str, old: &str) -> String {
    let mut locations = Vec::new();
    let mut pos = 0;
    let mut line = 1;
    while let Some(idx) = content[pos..].find(old) {
        let abs = pos + idx;
        line += content[pos..abs].chars().filter(|&c| c == '\n').count();
        locations.push(line);
        pos = abs + old.len();
        if locations.len() >= 3 {
            break;
        }
    }
    locations
        .iter()
        .enumerate()
        .map(|(i, ln)| format!("  match {} at line {}", i + 1, ln))
        .collect::<Vec<_>>()
        .join("\n")
}
