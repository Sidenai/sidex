//! Read an image file and return it as base64 for Claude vision.

use super::{get_int, get_str, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::fs;
use std::path::Path;

const MAX_IMAGE_SIZE: usize = 10 * 1024 * 1024; // 10MB

pub fn read(args: &Args, ctx: &ToolContext) -> Result<String> {
    let path = resolve_path(ctx, get_str(args, "path"));
    let max_size = get_int(args, "max_size", MAX_IMAGE_SIZE as i64) as usize;

    let metadata = fs::metadata(&path)?;
    if metadata.len() as usize > max_size {
        bail!(
            "image too large: {} bytes (max {})",
            metadata.len(),
            max_size
        );
    }

    let data = fs::read(&path)?;
    let mime = detect_mime(&path);
    let b64 = base64_encode(&data);

    Ok(format!(
        r#"{{"mime_type":"{}","base64_data":"{}","size":{}}}"#,
        mime,
        b64,
        data.len()
    ))
}

fn detect_mime(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}
