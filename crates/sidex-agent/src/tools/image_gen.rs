use super::{get_str, get_str_or, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::process::Command;

pub fn generate(args: &Args, ctx: &ToolContext) -> Result<String> {
    let prompt = get_str(args, "prompt");
    if prompt.is_empty() {
        bail!("prompt parameter is required");
    }

    let size = get_str_or(args, "size", "1024x1024");
    let style = get_str_or(args, "style", "natural");
    let provider = get_str_or(args, "provider", "openai");
    let output_path_raw = get_str(args, "output_path");

    let output_path = if output_path_raw.is_empty() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!(".sidex/generated/{ts}.png")
    } else {
        output_path_raw.to_string()
    };

    let resolved = super::resolve_path(ctx, &output_path);

    if let Some(parent) = std::path::Path::new(&resolved).parent() {
        std::fs::create_dir_all(parent)?;
    }

    match provider {
        "openai" => generate_openai(prompt, size, style, &resolved),
        "stability" => generate_stability(prompt, size, &resolved),
        _ => bail!("unsupported provider: {provider}. Supported: openai, stability"),
    }?;

    Ok(format!(
        "Image generated successfully.\nPath: {resolved}\nPrompt: {prompt}\nSize: {size}\nStyle: {style}\nProvider: {provider}"
    ))
}

fn generate_openai(prompt: &str, size: &str, style: &str, output_path: &str) -> Result<()> {
    let api_key = std::env::var("OPENAI_API_KEY")
        .map_err(|_| anyhow::anyhow!("OPENAI_API_KEY environment variable not set"))?;

    let payload = serde_json::json!({
        "model": "dall-e-3",
        "prompt": prompt,
        "n": 1,
        "size": size,
        "style": style,
        "response_format": "b64_json"
    });

    let output = Command::new("curl")
        .args([
            "-s",
            "--max-time",
            "120",
            "-X",
            "POST",
            "https://api.openai.com/v1/images/generations",
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {api_key}"),
            "-d",
            &payload.to_string(),
        ])
        .output()?;

    if !output.status.success() {
        bail!(
            "OpenAI API request failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let body: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| anyhow::anyhow!("failed to parse OpenAI response: {e}"))?;

    if let Some(err) = body.get("error") {
        bail!("OpenAI API error: {}", err);
    }

    let b64 = body["data"][0]["b64_json"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no image data in response"))?;

    let bytes = base64_decode(b64)?;
    std::fs::write(output_path, &bytes)?;
    Ok(())
}

fn generate_stability(prompt: &str, size: &str, output_path: &str) -> Result<()> {
    let api_key = std::env::var("STABILITY_API_KEY")
        .map_err(|_| anyhow::anyhow!("STABILITY_API_KEY environment variable not set"))?;

    let (width, height) = parse_size(size)?;

    let payload = serde_json::json!({
        "text_prompts": [{"text": prompt, "weight": 1.0}],
        "cfg_scale": 7,
        "height": height,
        "width": width,
        "samples": 1,
        "steps": 30,
    });

    let output = Command::new("curl")
        .args([
            "-s",
            "--max-time",
            "120",
            "-X",
            "POST",
            "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image",
            "-H",
            "Content-Type: application/json",
            "-H",
            "Accept: application/json",
            "-H",
            &format!("Authorization: Bearer {api_key}"),
            "-d",
            &payload.to_string(),
        ])
        .output()?;

    if !output.status.success() {
        bail!(
            "Stability API request failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let body: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| anyhow::anyhow!("failed to parse Stability response: {e}"))?;

    if let Some(msg) = body.get("message") {
        bail!("Stability API error: {}", msg);
    }

    let b64 = body["artifacts"][0]["base64"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("no image data in Stability response"))?;

    let bytes = base64_decode(b64)?;
    std::fs::write(output_path, &bytes)?;
    Ok(())
}

fn parse_size(size: &str) -> Result<(u32, u32)> {
    let parts: Vec<&str> = size.split('x').collect();
    if parts.len() != 2 {
        bail!("invalid size format: {size} (expected WIDTHxHEIGHT)");
    }
    let w: u32 = parts[0]
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid width in size: {size}"))?;
    let h: u32 = parts[1]
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid height in size: {size}"))?;
    Ok((w, h))
}

fn base64_decode(input: &str) -> Result<Vec<u8>> {
    let output = Command::new("base64")
        .arg("-d")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match output {
        Ok(mut child) => {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                stdin.write_all(input.as_bytes())?;
            }
            let out = child.wait_with_output()?;
            if out.stdout.is_empty() {
                bail!("base64 decode produced empty output");
            }
            Ok(out.stdout)
        }
        Err(_) => {
            // Fallback: manual base64 decode
            Ok(manual_b64_decode(input)?)
        }
    }
}

fn manual_b64_decode(input: &str) -> Result<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let filtered: Vec<u8> = input
        .bytes()
        .filter(|&b| b != b'\n' && b != b'\r' && b != b'=')
        .collect();
    let mut out = Vec::with_capacity(filtered.len() * 3 / 4);

    for chunk in filtered.chunks(4) {
        let mut buf: u32 = 0;
        let mut count = 0;
        for &b in chunk {
            if let Some(v) = val(b) {
                buf = (buf << 6) | v as u32;
                count += 1;
            }
        }
        match count {
            4 => {
                out.push((buf >> 16) as u8);
                out.push((buf >> 8) as u8);
                out.push(buf as u8);
            }
            3 => {
                buf <<= 6;
                out.push((buf >> 16) as u8);
                out.push((buf >> 8) as u8);
            }
            2 => {
                buf <<= 12;
                out.push((buf >> 16) as u8);
            }
            _ => {}
        }
    }

    Ok(out)
}
