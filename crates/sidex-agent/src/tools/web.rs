use super::{get_str, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::process::Command;

pub fn search(args: &Args, _ctx: &ToolContext) -> Result<String> {
    let query = get_str(args, "query");
    if query.is_empty() {
        bail!("query parameter is required");
    }

    let encoded = urlencoding::encode(&query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", encoded);

    let output = Command::new("curl")
        .args(["-sL", "--max-time", "10", &url])
        .output()?;

    let body = String::from_utf8_lossy(&output.stdout);

    // Extract text results from DuckDuckGo HTML
    let mut results = Vec::new();
    for line in body.lines() {
        if line.contains("result__snippet") || line.contains("result__title") {
            let text = strip_html_tags(line.trim());
            if !text.is_empty() && text.len() > 10 {
                results.push(text);
            }
        }
        if results.len() >= 10 {
            break;
        }
    }

    if results.is_empty() {
        Ok(format!("No results found for: {query}"))
    } else {
        Ok(results.join("\n\n"))
    }
}

pub fn fetch(args: &Args, _ctx: &ToolContext) -> Result<String> {
    let url = get_str(args, "url");
    if url.is_empty() {
        bail!("url parameter is required");
    }

    // Validate URL
    if !url.starts_with("http://") && !url.starts_with("https://") {
        bail!("URL must start with http:// or https://");
    }

    let output = Command::new("curl")
        .args([
            "-sL",
            "--max-time",
            "15",
            "-H",
            "User-Agent: Sidex/1.0",
            &url,
        ])
        .output()?;

    if !output.status.success() {
        bail!(
            "Failed to fetch URL: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let body = String::from_utf8_lossy(&output.stdout);

    // Convert HTML to readable text (basic)
    let text = html_to_text(&body);

    // Truncate to reasonable size
    if text.len() > 50000 {
        Ok(format!(
            "{}\n\n[content truncated at 50000 chars]",
            &text[..50000]
        ))
    } else {
        Ok(text)
    }
}

fn strip_html_tags(s: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

fn html_to_text(html: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    let mut tag_name = String::new();
    let mut in_script = false;
    let mut in_style = false;

    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag_name.clear();
            }
            '>' => {
                in_tag = false;
                let tag_lower = tag_name.to_lowercase();
                if tag_lower.starts_with("script") {
                    in_script = true;
                }
                if tag_lower.starts_with("/script") {
                    in_script = false;
                }
                if tag_lower.starts_with("style") {
                    in_style = true;
                }
                if tag_lower.starts_with("/style") {
                    in_style = false;
                }
                if matches!(
                    tag_lower.as_str(),
                    "br" | "br/"
                        | "p"
                        | "/p"
                        | "div"
                        | "/div"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "/h1"
                        | "/h2"
                        | "/h3"
                        | "/h4"
                        | "li"
                        | "tr"
                ) {
                    text.push('\n');
                }
            }
            _ if in_tag => {
                tag_name.push(c);
            }
            _ if !in_script && !in_style => {
                text.push(c);
            }
            _ => {}
        }
    }

    // Clean up entities and whitespace
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
