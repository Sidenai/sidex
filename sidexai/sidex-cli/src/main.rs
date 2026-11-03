mod config;

use clap::{Parser, Subcommand};
use colored::Colorize;
use config::Config;
use futures_util::{SinkExt, StreamExt};
use rustyline::DefaultEditor;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Instant;
use tokio_tungstenite::connect_async;

#[derive(Parser)]
#[command(name = "sidex", version, about = "Sidex AI")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(short, long, default_value = "ws://localhost:7433")]
    server: String,

    #[arg(short = 'd', long)]
    cwd: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Commands {
    Ask { message: Vec<String> },
    Status,
}

#[derive(Serialize)]
struct ChatMsg {
    session_id: String,
    message: String,
    cwd: String,
}

#[allow(dead_code)]
#[derive(Deserialize, Debug)]
struct Chunk {
    #[serde(rename = "type")]
    kind: Option<String>,
    content: Option<String>,
    tool_calls: Option<Vec<ToolCall>>,
    done: Option<bool>,
    error: Option<String>,
    tokens_used: Option<TokenUsage>,
}

#[derive(Deserialize, Debug, Clone, Default)]
struct TokenUsage {
    prompt_tokens: i64,
    completion_tokens: i64,
    #[allow(dead_code)]
    total_tokens: i64,
}

#[allow(dead_code)]
#[derive(Deserialize, Debug)]
struct ToolCall {
    id: String,
    function: ToolFunc,
}

#[derive(Deserialize, Debug)]
struct ToolFunc {
    name: String,
    arguments: String,
}

struct Stats {
    input_tokens: i64,
    output_tokens: i64,
    tool_calls: u32,
    turns: u32,
    subagents: u32,
    start: Instant,
}

impl Stats {
    fn new() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            tool_calls: 0,
            turns: 0,
            subagents: 0,
            start: Instant::now(),
        }
    }

    fn cost(&self) -> f64 {
        let input_cost = self.input_tokens as f64 * 0.003 / 1000.0;
        let output_cost = self.output_tokens as f64 * 0.015 / 1000.0;
        input_cost + output_cost
    }

    fn elapsed_str(&self) -> String {
        let ms = self.start.elapsed().as_millis();
        if ms < 1000 {
            format!("{}ms", ms)
        } else {
            format!("{:.1}s", ms as f64 / 1000.0)
        }
    }

    fn summary(&self) -> String {
        let cost = self.cost();
        let cost_str = if cost < 0.01 {
            format!("${:.4}", cost)
        } else {
            format!("${:.2}", cost)
        };

        let mut parts = vec![self.elapsed_str()];

        if self.input_tokens > 0 || self.output_tokens > 0 {
            parts.push(format!("{}in/{}out tokens", fmt_num(self.input_tokens), fmt_num(self.output_tokens)));
        }
        if self.tool_calls > 0 {
            parts.push(format!("{} tool calls", self.tool_calls));
        }
        if self.subagents > 0 {
            parts.push(format!("{} subagents", self.subagents));
        }
        if self.turns > 1 {
            parts.push(format!("{} turns", self.turns));
        }
        parts.push(cost_str);

        parts.join("  ·  ")
    }
}

fn fmt_num(n: i64) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        format!("{}", n)
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let cwd = cli.cwd.unwrap_or_else(|| std::env::current_dir().unwrap());
    let server = std::env::var("SIDEX_SERVER").unwrap_or(cli.server);
    let cfg = Config { server_url: server, cwd };

    match cli.command {
        Some(Commands::Ask { message }) => {
            let msg = message.join(" ");
            if msg.is_empty() {
                eprintln!("{}", "Provide a message.".red());
                std::process::exit(1);
            }
            stream_one(&cfg, &msg).await;
        }
        Some(Commands::Status) => {
            let url = format!("{}/v1/health", cfg.http_url());
            match reqwest::get(&url).await {
                Ok(_) => println!("{} Connected", "●".green()),
                Err(e) => println!("{} {}", "●".red(), e),
            }
        }
        None => repl(&cfg).await,
    }
}

async fn repl(cfg: &Config) {
    println!();
    println!("  {}", "Sidex".bold().white());
    println!("  {}", cfg.cwd.display().to_string().dimmed());
    println!();

    let health = format!("{}/v1/health", cfg.http_url());
    if reqwest::get(&health).await.is_err() {
        println!("  {} {}", "●".red(), "Server not running. Start: cd sidex-server && go run cmd/server/main.go".red());
        return;
    }

    let ws_url = cfg.ws_url("/v1/stream");
    let (ws, _) = match connect_async(&ws_url).await {
        Ok(s) => s,
        Err(e) => {
            println!("  {} {}", "●".red(), e);
            return;
        }
    };
    let (mut write, mut read) = ws.split();
    let cwd_str = cfg.cwd.to_string_lossy().to_string();

    let mut rl = DefaultEditor::new().unwrap();
    let mut total_cost = 0.0f64;
    let mut total_tokens: i64 = 0;

    loop {
        let prompt = format!("{} ", ">".bold().white());
        let input = match rl.readline(&prompt) {
            Ok(line) => line,
            Err(_) => break,
        };

        let input = input.trim().to_string();
        if input.is_empty() {
            continue;
        }
        let _ = rl.add_history_entry(&input);

        match input.as_str() {
            "/quit" | "/q" | "/exit" => break,
            "/clear" => { print!("\x1B[2J\x1B[1;1H"); continue; }
            "/stats" => {
                println!("  {} total tokens  {}", fmt_num(total_tokens), format!("${:.4}", total_cost).dimmed());
                continue;
            }
            "/help" => {
                println!("  {}: send message    {}: quit    {}: clear    {}: usage stats",
                    "Enter".bold(), "/quit".dimmed(), "/clear".dimmed(), "/stats".dimmed());
                continue;
            }
            _ => {}
        }

        let payload = serde_json::to_string(&ChatMsg {
            session_id: String::new(),
            message: input,
            cwd: cwd_str.clone(),
        }).unwrap();

        if write.send(tokio_tungstenite::tungstenite::Message::Text(payload.into())).await.is_err() {
            println!("  {}", "Connection lost.".red());
            break;
        }

        println!();
        let stats = handle_stream(&mut read).await;
        println!();
        println!("  {}", stats.summary().dimmed());
        println!();

        total_cost += stats.cost();
        total_tokens += stats.input_tokens + stats.output_tokens;
    }
}

async fn stream_one(cfg: &Config, message: &str) {
    let ws_url = cfg.ws_url("/v1/stream");
    let (ws, _) = match connect_async(&ws_url).await {
        Ok(s) => s,
        Err(e) => { eprintln!("{} {}", "Error:".red(), e); return; }
    };
    let (mut write, mut read) = ws.split();

    let payload = serde_json::to_string(&ChatMsg {
        session_id: String::new(),
        message: message.to_string(),
        cwd: cfg.cwd.to_string_lossy().to_string(),
    }).unwrap();

    if write.send(tokio_tungstenite::tungstenite::Message::Text(payload.into())).await.is_err() {
        eprintln!("{}", "Send failed.".red());
        return;
    }

    let stats = handle_stream(&mut read).await;
    println!();
    eprintln!("{}", stats.summary().dimmed());
}

async fn handle_stream<S>(read: &mut S) -> Stats
where
    S: StreamExt<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut stats = Stats::new();
    let mut tool_start: Option<Instant> = None;

    while let Some(Ok(msg)) = read.next().await {
        let text = match msg {
            tokio_tungstenite::tungstenite::Message::Text(t) => t.to_string(),
            _ => continue,
        };

        let chunk: Chunk = match serde_json::from_str(&text) {
            Ok(c) => c,
            Err(_) => continue,
        };

        match chunk.kind.as_deref() {
            Some("text") => {
                if let Some(c) = chunk.content {
                    print!("{}", c);
                    io::stdout().flush().ok();
                }
            }
            Some("tool_call") => {
                stats.tool_calls += 1;
                tool_start = Some(Instant::now());
                if let Some(calls) = chunk.tool_calls {
                    for tc in calls {
                        let name = tc.function.name.cyan().bold();
                        let args = summarize_args(&tc.function.arguments);
                        println!("\n  {} {} {}", "▸".dimmed(), name, args.dimmed());
                    }
                }
            }
            Some("tool_running") => {
                tool_start = Some(Instant::now());
            }
            Some("tool_result") => {
                let elapsed = tool_start.map(|t| t.elapsed().as_millis()).unwrap_or(0);
                if let Some(c) = chunk.content {
                    let is_err = c.starts_with("ERROR:");
                    let lines: Vec<&str> = c.lines().collect();
                    let show = if lines.len() <= 3 { lines.len() } else { 3 };
                    for l in &lines[..show] {
                        let styled = if is_err { l.red().to_string() } else { l.dimmed().to_string() };
                        println!("    {}", styled);
                    }
                    if lines.len() > 3 {
                        println!("    {}", format!("… {} more lines", lines.len() - 3).dimmed());
                    }
                    if elapsed > 0 {
                        println!("    {}", format!("{}ms", elapsed).dimmed());
                    }
                }
                tool_start = None;
            }
            Some("turn_complete") => {
                stats.turns += 1;
                println!();
            }
            Some("subagent_start") => {
                if let Some(c) = chunk.content {
                    println!("\n  {} {}", "◆".bright_magenta().bold(), c.bright_magenta());
                }
            }
            Some("subagent_running") => {
                stats.subagents += 1;
                if let Some(c) = chunk.content {
                    println!("    {} {}", "→".dimmed(), c.dimmed());
                }
            }
            Some("subagent_tool") => {
                stats.tool_calls += 1;
                if let Some(c) = chunk.content {
                    print!("    {} {}", "·".dimmed(), c.dimmed());
                    io::stdout().flush().ok();
                    println!();
                }
            }
            Some("subagent_done") => {
                if let Some(c) = chunk.content {
                    if c.contains("✓") {
                        println!("    {} {}", "✓".green(), c.green());
                    } else {
                        println!("    {} {}", "✗".red(), c.red());
                    }
                }
            }
            Some("subagent_complete") => {
                if let Some(c) = chunk.content {
                    println!("  {} {}", "◆".bright_magenta().bold(), c.bright_magenta());
                    println!();
                }
            }
            Some("usage") => {
                if let Some(u) = chunk.tokens_used {
                    if u.prompt_tokens > 0 {
                        stats.input_tokens = u.prompt_tokens;
                    }
                    if u.completion_tokens > 0 {
                        stats.output_tokens += u.completion_tokens;
                    }
                }
            }
            Some("done") => {
                stats.turns += 1;
                break;
            }
            Some("error") => {
                if let Some(e) = chunk.error {
                    eprintln!("\n  {} {}", "error:".red().bold(), e);
                }
                break;
            }
            _ => {}
        }
    }

    stats
}

fn summarize_args(args: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(args) {
        if let Some(obj) = parsed.as_object() {
            let parts: Vec<String> = obj.iter().map(|(k, v)| {
                let val = match v {
                    serde_json::Value::String(s) => {
                        if s.len() > 40 { format!("{}…", &s[..40]) } else { s.clone() }
                    }
                    other => {
                        let s = other.to_string();
                        if s.len() > 30 { format!("{}…", &s[..30]) } else { s }
                    }
                };
                format!("{}={}", k, val)
            }).collect();
            return parts.join(" ");
        }
    }
    if args.len() > 80 {
        format!("{}…", &args[..80])
    } else {
        args.to_string()
    }
}
