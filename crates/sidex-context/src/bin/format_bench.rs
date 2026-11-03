use std::fmt::Write as FmtWrite;

fn main() {
    println!("=== SideX Token Efficiency & Accuracy Benchmark ===\n");

    let search_results = generate_search_results(50);
    let file_tree = generate_file_tree(20);
    let diagnostics = generate_diagnostics(10);
    let code_chunks = generate_code_chunks(5, 15);

    println!("--- Scenario 1: Mixed Context (50 search + 20 tree + 10 diag + 5 chunks) ---\n");
    run_benchmark(&search_results, &file_tree, &diagnostics, &code_chunks);

    let large_symbols = generate_search_results(100);
    let large_tree = generate_file_tree(200);
    let large_diags = generate_diagnostics(30);
    let large_chunks = generate_code_chunks(5, 50);

    println!(
        "\n--- Scenario 2: Code-Specific (100 symbols + 200 tree + 30 diag + 5 large chunks) ---\n"
    );
    run_benchmark(&large_symbols, &large_tree, &large_diags, &large_chunks);
}

// --- Data Structures ---

struct SearchResult {
    file_path: String,
    line: usize,
    name: String,
    kind: String,
    score: f64,
    snippet: String,
}

struct FileTreeEntry {
    path: String,
    size: u64,
    modified: String,
}

struct Diagnostic {
    file: String,
    line: usize,
    severity: String,
    message: String,
    code: String,
}

struct CodeChunk {
    path: String,
    start_line: usize,
    end_line: usize,
    content: String,
}

// --- Data Generation ---

fn generate_search_results(n: usize) -> Vec<SearchResult> {
    let files = [
        "src/auth/handler.rs",
        "src/api/routes.rs",
        "src/db/connection.rs",
        "src/models/user.rs",
        "src/services/payment.rs",
        "src/utils/crypto.rs",
        "src/middleware/cors.rs",
        "src/config/settings.rs",
        "src/cache/redis.rs",
        "src/events/dispatcher.rs",
        "lib/parser/ast.ts",
        "lib/compiler/codegen.ts",
        "pkg/http/client.go",
        "internal/store/postgres.go",
        "cmd/server/main.go",
    ];
    let names = [
        "parse_request",
        "handle_auth",
        "connect_db",
        "validate_token",
        "encrypt_payload",
        "send_notification",
        "process_webhook",
        "serialize_response",
        "check_permission",
        "rate_limit",
        "build_query",
        "transform_ast",
        "emit_event",
        "cache_lookup",
        "retry_with_backoff",
        "spawn_worker",
        "aggregate_metrics",
        "flush_buffer",
        "resolve_dependency",
        "compile_template",
    ];
    let kinds = ["Function", "Method", "Struct", "Trait", "Impl", "Enum"];
    let snippets = [
        "pub fn parse_request(req: &Request) -> Result<ParsedBody> {",
        "async fn handle_auth(token: &str) -> AuthResult {",
        "impl Connection { pub fn new(url: &str) -> Self {",
        "fn validate_token(jwt: &str) -> Claims {",
        "pub fn encrypt_payload(data: &[u8], key: &Key) -> Vec<u8> {",
        "fn send_notification(user_id: UserId, msg: &str) -> Result<()> {",
        "async fn process_webhook(payload: WebhookPayload) -> Response {",
        "fn serialize_response<T: Serialize>(data: T) -> String {",
        "pub fn check_permission(user: &User, action: Action) -> bool {",
        "fn rate_limit(ip: IpAddr, window: Duration) -> bool {",
    ];

    (0..n)
        .map(|i| SearchResult {
            file_path: files[i % files.len()].to_string(),
            line: 10 + i * 7,
            name: names[i % names.len()].to_string(),
            kind: kinds[i % kinds.len()].to_string(),
            score: 1.0 - (i as f64 * 0.015),
            snippet: snippets[i % snippets.len()].to_string(),
        })
        .collect()
}

fn generate_file_tree(n: usize) -> Vec<FileTreeEntry> {
    let dirs = [
        "src/auth",
        "src/api",
        "src/db",
        "src/models",
        "src/services",
        "src/utils",
        "src/middleware",
        "src/config",
        "src/cache",
        "src/events",
        "tests/unit",
        "tests/integration",
        "docs",
        "scripts",
        "migrations",
        "lib/core",
        "lib/parser",
        "pkg/http",
        "internal/store",
        "cmd/server",
    ];
    let extensions = ["rs", "ts", "go", "py", "js", "toml", "yaml", "md"];

    (0..n)
        .map(|i| FileTreeEntry {
            path: format!(
                "{}/file_{}.{}",
                dirs[i % dirs.len()],
                i,
                extensions[i % extensions.len()]
            ),
            size: 1024 + (i as u64 * 347) % 50000,
            modified: format!(
                "2025-01-{:02}T{:02}:{}:00Z",
                (i % 28) + 1,
                i % 24,
                (i * 7) % 60
            ),
        })
        .collect()
}

fn generate_diagnostics(n: usize) -> Vec<Diagnostic> {
    let files = [
        "src/main.rs",
        "src/lib.rs",
        "src/api/routes.rs",
        "src/models/user.rs",
        "src/services/payment.rs",
    ];
    let severities = ["error", "warning", "info", "hint"];
    let messages = [
        "unused variable `x`",
        "cannot find value `config` in this scope",
        "mismatched types: expected `String`, found `&str`",
        "this function has too many arguments (8/6)",
        "consider using `impl Trait` instead of `Box<dyn Trait>`",
        "field `name` is never read",
        "unreachable pattern",
        "lifetime may not live long enough",
        "use of deprecated function `old_api`",
        "unnecessary `mut` binding",
    ];
    let codes = [
        "E0599", "E0308", "E0425", "W0611", "W0612", "E0106", "E0277", "C0301", "W0614", "E0382",
    ];

    (0..n)
        .map(|i| Diagnostic {
            file: files[i % files.len()].to_string(),
            line: 5 + i * 13,
            severity: severities[i % severities.len()].to_string(),
            message: messages[i % messages.len()].to_string(),
            code: codes[i % codes.len()].to_string(),
        })
        .collect()
}

fn generate_code_chunks(n: usize, lines_per_chunk: usize) -> Vec<CodeChunk> {
    let templates = [
        (
            "src/auth/handler.rs",
            r#"pub async fn authenticate(req: &Request) -> Result<AuthToken> {
    let header = req.headers().get("Authorization")
        .ok_or(AuthError::MissingHeader)?;
    let token = header.to_str()?.strip_prefix("Bearer ")
        .ok_or(AuthError::InvalidFormat)?;
    let claims = decode_jwt(token, &CONFIG.jwt_secret)?;
    if claims.exp < Utc::now().timestamp() {
        return Err(AuthError::Expired.into());
    }
    let user = db::users::find_by_id(claims.sub).await?;
    if user.is_disabled {
        return Err(AuthError::AccountDisabled.into());
    }
    Ok(AuthToken { user_id: user.id, roles: user.roles.clone(), exp: claims.exp })
}"#,
        ),
        (
            "src/db/connection.rs",
            r#"pub struct ConnectionPool {
    pool: Pool<Postgres>,
    max_size: u32,
    timeout: Duration,
}

impl ConnectionPool {
    pub async fn new(config: &DbConfig) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(config.max_connections)
            .acquire_timeout(Duration::from_secs(config.timeout_secs))
            .connect(&config.url)
            .await?;
        Ok(Self { pool, max_size: config.max_connections, timeout: Duration::from_secs(config.timeout_secs) })
    }
}"#,
        ),
        (
            "src/api/routes.rs",
            r#"pub fn configure_routes(cfg: &mut ServiceConfig) {
    cfg.service(
        web::scope("/api/v1")
            .route("/users", web::get().to(list_users))
            .route("/users/{id}", web::get().to(get_user))
            .route("/users", web::post().to(create_user))
            .route("/users/{id}", web::put().to(update_user))
            .route("/users/{id}", web::delete().to(delete_user))
            .route("/auth/login", web::post().to(login))
            .route("/auth/refresh", web::post().to(refresh_token))
            .route("/health", web::get().to(health_check))
            .wrap(middleware::auth::AuthMiddleware)
            .wrap(middleware::cors::CorsConfig::permissive())
    );
}"#,
        ),
        (
            "src/models/user.rs",
            r#"#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub username: String,
    pub password_hash: String,
    pub roles: Vec<Role>,
    pub is_disabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_login: Option<DateTime<Utc>>,
    pub avatar_url: Option<String>,
    pub preferences: serde_json::Value,
    pub org_id: Option<Uuid>,
}"#,
        ),
        (
            "src/services/payment.rs",
            r#"pub async fn process_payment(order: &Order, method: PaymentMethod) -> Result<PaymentResult> {
    let amount = order.total_cents();
    let idempotency_key = format!("pay_{}_{}", order.id, Utc::now().timestamp());
    let charge = match method {
        PaymentMethod::Card(card) => {
            stripe::charges::create(&stripe_client(), &CreateCharge {
                amount, currency: "usd", source: card.token.clone(),
                idempotency_key: Some(&idempotency_key), ..Default::default()
            }).await?
        }
        PaymentMethod::Wallet(w) => wallet::debit(w.id, amount).await?,
    };
    db::payments::record(order.id, &charge).await?;
    Ok(PaymentResult { charge_id: charge.id, status: charge.status })
}"#,
        ),
    ];

    (0..n)
        .map(|i| {
            let (path, content) = templates[i % templates.len()];
            let lines: Vec<&str> = content.lines().take(lines_per_chunk).collect();
            let actual_content = lines.join("\n");
            CodeChunk {
                path: path.to_string(),
                start_line: 1 + i * 20,
                end_line: 1 + i * 20 + lines.len(),
                content: actual_content,
            }
        })
        .collect()
}

// --- Format Serializers ---

fn to_json_pretty(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    ch: &[CodeChunk],
) -> String {
    let mut out = String::from("{\n  \"search_results\": [\n");
    for (i, r) in sr.iter().enumerate() {
        write!(out, "    {{\n      \"file\": \"{}\",\n      \"line\": {},\n      \"name\": \"{}\",\n      \"kind\": \"{}\",\n      \"score\": {:.3},\n      \"snippet\": \"{}\"\n    }}",
            r.file_path, r.line, r.name, r.kind, r.score, escape_json(&r.snippet)).unwrap();
        if i < sr.len() - 1 {
            out.push_str(",\n");
        } else {
            out.push('\n');
        }
    }
    out.push_str("  ],\n  \"file_tree\": [\n");
    for (i, f) in ft.iter().enumerate() {
        write!(out, "    {{\n      \"path\": \"{}\",\n      \"size\": {},\n      \"modified\": \"{}\"\n    }}",
            f.path, f.size, f.modified).unwrap();
        if i < ft.len() - 1 {
            out.push_str(",\n");
        } else {
            out.push('\n');
        }
    }
    out.push_str("  ],\n  \"diagnostics\": [\n");
    for (i, d) in dg.iter().enumerate() {
        write!(out, "    {{\n      \"file\": \"{}\",\n      \"line\": {},\n      \"severity\": \"{}\",\n      \"message\": \"{}\",\n      \"code\": \"{}\"\n    }}",
            d.file, d.line, d.severity, escape_json(&d.message), d.code).unwrap();
        if i < dg.len() - 1 {
            out.push_str(",\n");
        } else {
            out.push('\n');
        }
    }
    out.push_str("  ],\n  \"code_chunks\": [\n");
    for (i, c) in ch.iter().enumerate() {
        write!(out, "    {{\n      \"path\": \"{}\",\n      \"start_line\": {},\n      \"end_line\": {},\n      \"content\": \"{}\"\n    }}",
            c.path, c.start_line, c.end_line, escape_json(&c.content)).unwrap();
        if i < ch.len() - 1 {
            out.push_str(",\n");
        } else {
            out.push('\n');
        }
    }
    out.push_str("  ]\n}");
    out
}

fn to_json_min(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    ch: &[CodeChunk],
) -> String {
    let mut out = String::from("{\"search_results\":[");
    for (i, r) in sr.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write!(out, "{{\"file\":\"{}\",\"line\":{},\"name\":\"{}\",\"kind\":\"{}\",\"score\":{:.3},\"snippet\":\"{}\"}}",
            r.file_path, r.line, r.name, r.kind, r.score, escape_json(&r.snippet)).unwrap();
    }
    out.push_str("],\"file_tree\":[");
    for (i, f) in ft.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write!(
            out,
            "{{\"path\":\"{}\",\"size\":{},\"modified\":\"{}\"}}",
            f.path, f.size, f.modified
        )
        .unwrap();
    }
    out.push_str("],\"diagnostics\":[");
    for (i, d) in dg.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write!(out, "{{\"file\":\"{}\",\"line\":{},\"severity\":\"{}\",\"message\":\"{}\",\"code\":\"{}\"}}",
            d.file, d.line, d.severity, escape_json(&d.message), d.code).unwrap();
    }
    out.push_str("],\"code_chunks\":[");
    for (i, c) in ch.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write!(
            out,
            "{{\"path\":\"{}\",\"start_line\":{},\"end_line\":{},\"content\":\"{}\"}}",
            c.path,
            c.start_line,
            c.end_line,
            escape_json(&c.content)
        )
        .unwrap();
    }
    out.push_str("]}");
    out
}

fn to_yaml(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    ch: &[CodeChunk],
) -> String {
    let mut out = String::from("search_results:\n");
    for r in sr {
        write!(out, "  - file: \"{}\"\n    line: {}\n    name: \"{}\"\n    kind: \"{}\"\n    score: {:.3}\n    snippet: \"{}\"\n",
            r.file_path, r.line, r.name, r.kind, r.score, escape_json(&r.snippet)).unwrap();
    }
    out.push_str("file_tree:\n");
    for f in ft {
        write!(
            out,
            "  - path: \"{}\"\n    size: {}\n    modified: \"{}\"\n",
            f.path, f.size, f.modified
        )
        .unwrap();
    }
    out.push_str("diagnostics:\n");
    for d in dg {
        write!(out, "  - file: \"{}\"\n    line: {}\n    severity: \"{}\"\n    message: \"{}\"\n    code: \"{}\"\n",
            d.file, d.line, d.severity, escape_json(&d.message), d.code).unwrap();
    }
    out.push_str("code_chunks:\n");
    for c in ch {
        write!(
            out,
            "  - path: \"{}\"\n    start_line: {}\n    end_line: {}\n    content: |\n",
            c.path, c.start_line, c.end_line
        )
        .unwrap();
        for line in c.content.lines() {
            write!(out, "      {}\n", line).unwrap();
        }
    }
    out
}

fn to_csv(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    _ch: &[CodeChunk],
) -> String {
    let mut out = String::from("# search_results\nfile,line,name,kind,score,snippet\n");
    for r in sr {
        write!(
            out,
            "{},{},{},{},{:.3},\"{}\"\n",
            r.file_path,
            r.line,
            r.name,
            r.kind,
            r.score,
            escape_csv(&r.snippet)
        )
        .unwrap();
    }
    out.push_str("\n# file_tree\npath,size,modified\n");
    for f in ft {
        write!(out, "{},{},{}\n", f.path, f.size, f.modified).unwrap();
    }
    out.push_str("\n# diagnostics\nfile,line,severity,message,code\n");
    for d in dg {
        write!(
            out,
            "{},{},{},\"{}\",{}\n",
            d.file,
            d.line,
            d.severity,
            escape_csv(&d.message),
            d.code
        )
        .unwrap();
    }
    out
}

fn to_markdown(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    ch: &[CodeChunk],
) -> String {
    let mut out = String::from("## Search Results\n\n| File | Line | Name | Kind | Score | Snippet |\n|------|------|------|------|-------|---------|\n");
    for r in sr {
        write!(
            out,
            "| {} | {} | {} | {} | {:.3} | `{}` |\n",
            r.file_path,
            r.line,
            r.name,
            r.kind,
            r.score,
            truncate(&r.snippet, 40)
        )
        .unwrap();
    }
    out.push_str("\n## File Tree\n\n| Path | Size | Modified |\n|------|------|----------|\n");
    for f in ft {
        write!(out, "| {} | {} | {} |\n", f.path, f.size, f.modified).unwrap();
    }
    out.push_str("\n## Diagnostics\n\n| File | Line | Severity | Message | Code |\n|------|------|----------|---------|------|\n");
    for d in dg {
        write!(
            out,
            "| {} | {} | {} | {} | {} |\n",
            d.file, d.line, d.severity, d.message, d.code
        )
        .unwrap();
    }
    out.push_str("\n## Code Chunks\n\n");
    for c in ch {
        write!(
            out,
            "### `{}` (L{}-L{})\n\n```\n{}\n```\n\n",
            c.path, c.start_line, c.end_line, c.content
        )
        .unwrap();
    }
    out
}

fn to_toon(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    ch: &[CodeChunk],
) -> String {
    let mut out = String::from("[search_results]\n");
    for r in sr {
        write!(
            out,
            "  {} :{}  {}({}) ={:.2}\n    > {}\n",
            r.file_path, r.line, r.name, r.kind, r.score, r.snippet
        )
        .unwrap();
    }
    out.push_str("\n[file_tree]\n");
    for f in ft {
        write!(out, "  {} [{}B] @{}\n", f.path, f.size, f.modified).unwrap();
    }
    out.push_str("\n[diagnostics]\n");
    for d in dg {
        write!(
            out,
            "  {} :{} [{}] {} ({})\n",
            d.file, d.line, d.severity, d.message, d.code
        )
        .unwrap();
    }
    out.push_str("\n[code]\n");
    for c in ch {
        write!(
            out,
            "  --- {} L{}-{} ---\n",
            c.path, c.start_line, c.end_line
        )
        .unwrap();
        for line in c.content.lines() {
            write!(out, "  {}\n", line).unwrap();
        }
    }
    out
}

fn to_plain(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    ch: &[CodeChunk],
) -> String {
    let mut out = String::new();
    for r in sr {
        write!(
            out,
            "{}:{} {} {} {:.2} {}\n",
            r.file_path, r.line, r.name, r.kind, r.score, r.snippet
        )
        .unwrap();
    }
    out.push('\n');
    for f in ft {
        write!(out, "{} {} {}\n", f.path, f.size, f.modified).unwrap();
    }
    out.push('\n');
    for d in dg {
        write!(
            out,
            "{}:{} {} {} {}\n",
            d.file, d.line, d.severity, d.message, d.code
        )
        .unwrap();
    }
    out.push('\n');
    for c in ch {
        write!(
            out,
            "=== {} L{}-{}\n{}\n",
            c.path, c.start_line, c.end_line, c.content
        )
        .unwrap();
    }
    out
}

fn to_scf(
    sr: &[SearchResult],
    ft: &[FileTreeEntry],
    dg: &[Diagnostic],
    ch: &[CodeChunk],
) -> String {
    let mut out = String::from("@S\n");
    for r in sr {
        write!(
            out,
            "s|{}|{}|{}|{}|{:.2}|{}\n",
            r.file_path,
            r.line,
            r.name,
            r.kind.chars().next().unwrap(),
            r.score,
            r.snippet
        )
        .unwrap();
    }
    out.push_str("@F\n");
    for f in ft {
        write!(out, "f|{}|{}|{}\n", f.path, f.size, f.modified).unwrap();
    }
    out.push_str("@D\n");
    for d in dg {
        write!(
            out,
            "d|{}|{}|{}|{}|{}\n",
            d.file,
            d.line,
            d.severity.chars().next().unwrap(),
            d.message,
            d.code
        )
        .unwrap();
    }
    out.push_str("@C\n");
    for c in ch {
        write!(
            out,
            "c|{}|{}|{}|{}\n",
            c.path,
            c.start_line,
            c.end_line,
            c.content.replace('\n', "\\n")
        )
        .unwrap();
    }
    out
}

// --- Measurement & Reporting ---

fn run_benchmark(sr: &[SearchResult], ft: &[FileTreeEntry], dg: &[Diagnostic], ch: &[CodeChunk]) {
    let formats: Vec<(&str, String)> = vec![
        ("JSON (pretty)", to_json_pretty(sr, ft, dg, ch)),
        ("JSON (minified)", to_json_min(sr, ft, dg, ch)),
        ("YAML", to_yaml(sr, ft, dg, ch)),
        ("CSV", to_csv(sr, ft, dg, ch)),
        ("Markdown table", to_markdown(sr, ft, dg, ch)),
        ("TOON", to_toon(sr, ft, dg, ch)),
        ("Plain text", to_plain(sr, ft, dg, ch)),
        ("SCF (pipe-delim)", to_scf(sr, ft, dg, ch)),
    ];

    let data_points = sr.len() + ft.len() + dg.len() + ch.len();
    let baseline_bytes = formats[0].1.len();
    let baseline_tokens = estimate_tokens(&formats[0].1);

    println!(
        "{:<18} {:>10} {:>10} {:>8} {:>10} {:>10} {:>12}",
        "Format", "Bytes", "Est.Tokens", "Tok/Byte", "vs JSON(%)", "Chars/Pt", "Overhead%"
    );
    println!("{}", "-".repeat(82));

    for (name, content) in &formats {
        let bytes = content.len();
        let tokens = estimate_tokens(content);
        let tok_per_byte = tokens as f64 / bytes as f64;
        let savings_vs_json = (1.0 - tokens as f64 / baseline_tokens as f64) * 100.0;
        let chars_per_point = bytes as f64 / data_points as f64;
        let overhead = compute_overhead(content);

        println!(
            "{:<18} {:>10} {:>10} {:>8.3} {:>+9.1}% {:>10.1} {:>11.1}%",
            name,
            bytes,
            tokens,
            tok_per_byte,
            savings_vs_json,
            chars_per_point,
            overhead * 100.0
        );
    }

    println!(
        "\n  Data points: {}  |  Baseline (JSON pretty): {} bytes, {} tokens",
        data_points, baseline_bytes, baseline_tokens
    );
}

fn estimate_tokens(s: &str) -> usize {
    // More realistic cl100k_base approximation:
    // - Whitespace/newlines compress well (~6 chars/token)
    // - Structural chars ({, [, :, etc.) are often 1 char = 1 token
    // - Code identifiers average ~4 chars/token
    // - Path separators and punctuation are ~1-2 chars/token
    let mut token_est: f64 = 0.0;
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b' ' | b'\t' => {
                let mut run = 0;
                while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
                    run += 1;
                    i += 1;
                }
                token_est += (run as f64 / 4.0).ceil();
            }
            b'\n' | b'\r' => {
                token_est += 1.0;
                i += 1;
            }
            b'{' | b'}' | b'[' | b']' | b'(' | b')' | b',' | b';' => {
                token_est += 1.0;
                i += 1;
            }
            b'"' | b':' | b'|' | b'/' | b'.' | b'@' | b'#' | b'>' | b'<' | b'-' | b'=' => {
                token_est += 1.0;
                i += 1;
            }
            _ => {
                let mut run = 0;
                while i < bytes.len()
                    && !matches!(
                        bytes[i],
                        b' ' | b'\t'
                            | b'\n'
                            | b'\r'
                            | b'{'
                            | b'}'
                            | b'['
                            | b']'
                            | b'('
                            | b')'
                            | b','
                            | b';'
                            | b'"'
                            | b':'
                            | b'|'
                            | b'/'
                            | b'.'
                            | b'@'
                            | b'#'
                            | b'>'
                            | b'<'
                            | b'-'
                            | b'='
                    )
                {
                    run += 1;
                    i += 1;
                }
                token_est += (run as f64 / 3.8).ceil();
            }
        }
    }
    token_est.ceil() as usize
}

fn compute_overhead(content: &str) -> f64 {
    let structural_chars: usize = content
        .chars()
        .filter(|c| {
            matches!(
                c,
                '{' | '}' | '[' | ']' | '"' | ',' | ':' | '|' | '-' | '+' | '=' | '#' | '>' | '<'
            )
        })
        .count();
    structural_chars as f64 / content.len().max(1) as f64
}

// --- Helpers ---

fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn escape_csv(s: &str) -> String {
    s.replace('"', "\"\"")
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}
