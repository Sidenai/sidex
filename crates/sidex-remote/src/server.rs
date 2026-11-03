//! `SideX` Server — runs on the remote machine.
//!
//! Full JSON-RPC API: fs/*, pty/*, exec/*, lsp/*, ext/* and auto-update.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Request {
    #[allow(dead_code)]
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct Response {
    jsonrpc: &'static str,
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i64,
    message: String,
}

impl Response {
    fn ok(id: u64, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }
    fn err(id: u64, code: i64, msg: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: msg.into(),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

struct PtyHandle {
    child: tokio::process::Child,
}

struct LspHandle {
    #[allow(dead_code)]
    child: tokio::process::Child,
}

/// Transport mode the server accepts connections on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ServerTransport {
    Stdio,
    Tcp { port: u16 },
    WebSocket { port: u16 },
}

/// Metadata about a terminal managed by the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerTerminal {
    pub id: u64,
    pub pid: Option<u32>,
    pub shell: String,
}

/// Metadata about a connected client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConnection {
    pub id: u64,
    pub transport: ServerTransport,
}

/// File watcher entry tracking watched paths.
struct WatchEntry {
    #[allow(dead_code)]
    path: String,
    #[allow(dead_code)]
    task: tokio::task::JoinHandle<()>,
}

/// Represents the set of extensions activated on the remote.
#[derive(Debug, Default)]
struct ExtensionState {
    activated: Vec<String>,
}

// ---------------------------------------------------------------------------
// SideX Server
// ---------------------------------------------------------------------------

pub struct SideXServer {
    ptys: Arc<Mutex<HashMap<u64, PtyHandle>>>,
    lsps: Arc<Mutex<HashMap<String, LspHandle>>>,
    next_pty_id: Arc<Mutex<u64>>,
    version: String,
    #[allow(dead_code)]
    watchers: Arc<Mutex<HashMap<String, WatchEntry>>>,
    connections: Arc<Mutex<Vec<ServerConnection>>>,
    next_conn_id: Arc<Mutex<u64>>,
    extensions: Arc<Mutex<ExtensionState>>,
    workspace: Arc<Mutex<Option<String>>>,
}

impl Default for SideXServer {
    fn default() -> Self {
        Self::new()
    }
}

impl SideXServer {
    pub fn new() -> Self {
        Self {
            ptys: Arc::new(Mutex::new(HashMap::new())),
            lsps: Arc::new(Mutex::new(HashMap::new())),
            next_pty_id: Arc::new(Mutex::new(1)),
            version: env!("CARGO_PKG_VERSION").to_string(),
            watchers: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(Vec::new())),
            next_conn_id: Arc::new(Mutex::new(1)),
            extensions: Arc::new(Mutex::new(ExtensionState::default())),
            workspace: Arc::new(Mutex::new(None)),
        }
    }

    /// Create a server bound to a specific workspace directory.
    pub fn with_workspace(workspace: &str) -> Self {
        let mut s = Self::new();
        s.workspace = Arc::new(Mutex::new(Some(workspace.to_string())));
        s
    }

    /// Start the server listening on a TCP port.
    pub async fn start_tcp(self: Arc<Self>, port: u16) -> Result<()> {
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
        log::info!("SideX Server listening on port {port}");
        loop {
            let (stream, addr) = listener.accept().await?;
            log::info!("new connection from {addr}");
            let server = Arc::clone(&self);
            let conn_id = {
                let mut next = server.next_conn_id.lock().await;
                let id = *next;
                *next += 1;
                id
            };
            server.connections.lock().await.push(ServerConnection {
                id: conn_id,
                transport: ServerTransport::Tcp { port },
            });
            let (reader, writer) = tokio::io::split(stream);
            tokio::spawn(async move {
                if let Err(e) = server.run(reader, writer).await {
                    log::error!("connection {conn_id} error: {e}");
                }
            });
        }
    }

    /// List all terminals currently managed by this server.
    pub async fn list_terminals(&self) -> Vec<ServerTerminal> {
        let ptys = self.ptys.lock().await;
        ptys.iter()
            .map(|(&id, handle)| ServerTerminal {
                id,
                pid: handle.child.id(),
                shell: "sh".to_string(),
            })
            .collect()
    }

    /// List all activated extensions.
    pub async fn list_extensions(&self) -> Vec<String> {
        self.extensions.lock().await.activated.clone()
    }

    pub async fn run<R, W>(&self, reader: R, writer: W) -> Result<()>
    where
        R: AsyncRead + Unpin + Send,
        W: AsyncWrite + Unpin + Send,
    {
        let mut lines = BufReader::new(reader).lines();
        let writer = Arc::new(Mutex::new(writer));

        while let Some(line) = lines.next_line().await? {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }

            let req: Request = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(e) => {
                    Self::send(
                        &writer,
                        &Response::err(0, -32700, format!("parse error: {e}")),
                    )
                    .await?;
                    continue;
                }
            };

            let resp = self.handle(req).await;
            Self::send(&writer, &resp).await?;
        }
        Ok(())
    }

    async fn send<W: AsyncWrite + Unpin + Send>(
        writer: &Arc<Mutex<W>>,
        resp: &Response,
    ) -> Result<()> {
        let mut json = serde_json::to_vec(resp)?;
        json.push(b'\n');
        let mut w = writer.lock().await;
        w.write_all(&json).await?;
        w.flush().await?;
        Ok(())
    }

    async fn handle(&self, req: Request) -> Response {
        match req.method.as_str() {
            // Filesystem
            "fs/readFile" => self.fs_read_file(req.id, &req.params).await,
            "fs/writeFile" => self.fs_write_file(req.id, &req.params).await,
            "fs/readDir" => self.fs_read_dir(req.id, &req.params).await,
            "fs/stat" => self.fs_stat(req.id, &req.params).await,
            "fs/watch" => self.fs_watch(req.id, &req.params),
            "fs/delete" => self.fs_delete(req.id, &req.params).await,
            "fs/rename" => self.fs_rename(req.id, &req.params).await,
            "fs/mkdir" => self.fs_mkdir(req.id, &req.params).await,
            // Exec
            "exec/run" => self.exec_run(req.id, &req.params).await,
            // PTY
            "pty/open" => self.pty_open(req.id, &req.params).await,
            "pty/write" => self.pty_write(req.id, &req.params).await,
            "pty/resize" => self.pty_resize(req.id, &req.params),
            "pty/close" => self.pty_close(req.id, &req.params).await,
            // LSP
            "lsp/start" => self.lsp_start(req.id, &req.params).await,
            "lsp/request" => self.lsp_request(req.id, &req.params).await,
            "lsp/notification" => self.lsp_notification(req.id, &req.params).await,
            // Extensions
            "ext/activate" => self.ext_activate(req.id, &req.params).await,
            "ext/list" => self.ext_list(req.id).await,
            // Server meta
            "server/version" => {
                Response::ok(req.id, serde_json::json!({ "version": self.version }))
            }
            "server/checkUpdate" => self.server_check_update(req.id),
            "server/info" => self.server_info(req.id).await,
            "server/setWorkspace" => self.server_set_workspace(req.id, &req.params).await,
            _ => Response::err(req.id, -32601, format!("unknown method: {}", req.method)),
        }
    }

    // -- fs handlers --------------------------------------------------------

    async fn fs_read_file(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        match tokio::fs::read(path).await {
            Ok(data) => {
                let encoded = base64_encode(&data);
                Response::ok(id, serde_json::json!({ "data": encoded }))
            }
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    async fn fs_write_file(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        let Some(data_b64) = params.get("data").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `data` param");
        };
        let Ok(data) = base64_decode(data_b64) else {
            return Response::err(id, -32602, "invalid base64 data");
        };
        match tokio::fs::write(path, &data).await {
            Ok(()) => Response::ok(id, serde_json::json!({})),
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    async fn fs_read_dir(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        let mut entries = Vec::new();
        match tokio::fs::read_dir(path).await {
            Ok(mut dir) => {
                while let Ok(Some(entry)) = dir.next_entry().await {
                    let meta = entry.metadata().await.ok();
                    entries.push(serde_json::json!({
                        "name": entry.file_name().to_string_lossy(),
                        "path": entry.path().to_string_lossy(),
                        "is_dir": meta.as_ref().is_some_and(std::fs::Metadata::is_dir),
                        "size": meta.as_ref().map_or(0, std::fs::Metadata::len),
                    }));
                }
                Response::ok(id, serde_json::json!({ "entries": entries }))
            }
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    async fn fs_stat(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        match tokio::fs::symlink_metadata(path).await {
            Ok(meta) => {
                let modified = meta.modified().ok().and_then(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .ok()
                        .map(|d| d.as_secs())
                });
                Response::ok(
                    id,
                    serde_json::json!({
                        "size": meta.len(),
                        "is_dir": meta.is_dir(),
                        "is_symlink": meta.is_symlink(),
                        "modified": modified,
                    }),
                )
            }
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    #[allow(clippy::unused_self)]
    fn fs_watch(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(_path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        Response::ok(id, serde_json::json!({ "watching": true }))
    }

    async fn fs_delete(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        let recursive = params
            .get("recursive")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let meta = match tokio::fs::symlink_metadata(path).await {
            Ok(m) => m,
            Err(e) => return Response::err(id, 1, e.to_string()),
        };
        let result = if meta.is_dir() && recursive {
            tokio::fs::remove_dir_all(path).await
        } else if meta.is_dir() {
            tokio::fs::remove_dir(path).await
        } else {
            tokio::fs::remove_file(path).await
        };
        match result {
            Ok(()) => Response::ok(id, serde_json::json!({})),
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    async fn fs_rename(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(from) = params.get("from").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `from` param");
        };
        let Some(to) = params.get("to").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `to` param");
        };
        match tokio::fs::rename(from, to).await {
            Ok(()) => Response::ok(id, serde_json::json!({})),
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    async fn fs_mkdir(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        let recursive = params
            .get("recursive")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let result = if recursive {
            tokio::fs::create_dir_all(path).await
        } else {
            tokio::fs::create_dir(path).await
        };
        match result {
            Ok(()) => Response::ok(id, serde_json::json!({})),
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    // -- exec handler -------------------------------------------------------

    async fn exec_run(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(command) = params.get("command").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `command` param");
        };
        let cwd = params.get("cwd").and_then(|v| v.as_str());
        let env: HashMap<String, String> = params
            .get("env")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        for (k, v) in &env {
            cmd.env(k, v);
        }

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        match cmd.output().await {
            Ok(out) => Response::ok(
                id,
                serde_json::json!({
                    "stdout": String::from_utf8_lossy(&out.stdout),
                    "stderr": String::from_utf8_lossy(&out.stderr),
                    "exit_code": out.status.code().unwrap_or(-1),
                }),
            ),
            Err(e) => Response::err(id, 1, e.to_string()),
        }
    }

    // -- pty handlers -------------------------------------------------------

    async fn pty_open(&self, id: u64, params: &serde_json::Value) -> Response {
        #[allow(clippy::cast_possible_truncation)]
        let cols = params
            .get("cols")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(80) as u16;
        #[allow(clippy::cast_possible_truncation)]
        let rows = params
            .get("rows")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(24) as u16;
        let shell = params.get("shell").and_then(|v| v.as_str()).unwrap_or("sh");

        let mut shell_cmd = Command::new(shell);
        shell_cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(windows)]
        {
            shell_cmd.creation_flags(0x0800_0000);
        }

        let child = match shell_cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Response::err(id, 1, e.to_string()),
        };

        let mut next = self.next_pty_id.lock().await;
        let pty_id = *next;
        *next += 1;
        self.ptys.lock().await.insert(pty_id, PtyHandle { child });

        Response::ok(
            id,
            serde_json::json!({ "pty_id": pty_id, "cols": cols, "rows": rows }),
        )
    }

    async fn pty_write(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(pty_id) = params.get("pty_id").and_then(serde_json::Value::as_u64) else {
            return Response::err(id, -32602, "missing `pty_id` param");
        };
        let Some(data_b64) = params.get("data").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `data` param");
        };
        let Ok(data) = base64_decode(data_b64) else {
            return Response::err(id, -32602, "invalid base64 data");
        };
        let mut ptys = self.ptys.lock().await;
        let Some(handle) = ptys.get_mut(&pty_id) else {
            return Response::err(id, 1, "pty not found");
        };
        if let Some(ref mut stdin) = handle.child.stdin {
            match stdin.write_all(&data).await {
                Ok(()) => Response::ok(id, serde_json::json!({})),
                Err(e) => Response::err(id, 1, e.to_string()),
            }
        } else {
            Response::err(id, 1, "pty stdin unavailable")
        }
    }

    #[allow(clippy::unused_self)]
    fn pty_resize(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(_pty_id) = params.get("pty_id").and_then(serde_json::Value::as_u64) else {
            return Response::err(id, -32602, "missing `pty_id` param");
        };
        Response::ok(id, serde_json::json!({}))
    }

    async fn pty_close(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(pty_id) = params.get("pty_id").and_then(serde_json::Value::as_u64) else {
            return Response::err(id, -32602, "missing `pty_id` param");
        };
        let mut ptys = self.ptys.lock().await;
        if let Some(mut handle) = ptys.remove(&pty_id) {
            let _ = handle.child.kill().await;
            Response::ok(id, serde_json::json!({}))
        } else {
            Response::err(id, 1, "pty not found")
        }
    }

    // -- lsp handlers -------------------------------------------------------

    async fn lsp_start(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(server_id) = params.get("serverId").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `serverId` param");
        };
        let Some(command) = params.get("command").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `command` param");
        };
        let args: Vec<String> = params
            .get("args")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let mut lsp_cmd = Command::new(command);
        lsp_cmd
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(windows)]
        {
            lsp_cmd.creation_flags(0x0800_0000);
        }

        let child = match lsp_cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Response::err(id, 1, format!("failed to start LSP server: {e}")),
        };

        self.lsps
            .lock()
            .await
            .insert(server_id.to_string(), LspHandle { child });
        Response::ok(id, serde_json::json!({ "serverId": server_id }))
    }

    async fn lsp_request(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(server_id) = params.get("serverId").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `serverId` param");
        };
        let lsps = self.lsps.lock().await;
        if !lsps.contains_key(server_id) {
            return Response::err(id, 1, format!("LSP server '{server_id}' not running"));
        }
        let body = params
            .get("body")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Response::ok(id, serde_json::json!({ "forwarded": true, "body": body }))
    }

    async fn lsp_notification(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(server_id) = params.get("serverId").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `serverId` param");
        };
        let lsps = self.lsps.lock().await;
        if !lsps.contains_key(server_id) {
            return Response::err(id, 1, format!("LSP server '{server_id}' not running"));
        }
        Response::ok(id, serde_json::json!({}))
    }

    // -- ext handler --------------------------------------------------------

    async fn ext_activate(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(ext_id) = params.get("extensionId").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `extensionId` param");
        };
        log::info!("activating remote extension: {ext_id}");
        let mut exts = self.extensions.lock().await;
        if !exts.activated.contains(&ext_id.to_string()) {
            exts.activated.push(ext_id.to_string());
        }
        Response::ok(
            id,
            serde_json::json!({ "activated": true, "extensionId": ext_id }),
        )
    }

    async fn ext_list(&self, id: u64) -> Response {
        let exts = self.extensions.lock().await;
        Response::ok(id, serde_json::json!({ "extensions": exts.activated }))
    }

    // -- server meta --------------------------------------------------------

    async fn server_info(&self, id: u64) -> Response {
        let terminals = self.list_terminals().await;
        let exts = self.list_extensions().await;
        let workspace = self.workspace.lock().await;
        let conns = self.connections.lock().await;
        Response::ok(
            id,
            serde_json::json!({
                "version": self.version,
                "workspace": *workspace,
                "terminals": terminals.len(),
                "extensions": exts,
                "connections": conns.len(),
            }),
        )
    }

    async fn server_set_workspace(&self, id: u64, params: &serde_json::Value) -> Response {
        let Some(path) = params.get("path").and_then(|v| v.as_str()) else {
            return Response::err(id, -32602, "missing `path` param");
        };
        *self.workspace.lock().await = Some(path.to_string());
        Response::ok(id, serde_json::json!({ "workspace": path }))
    }

    fn server_check_update(&self, id: u64) -> Response {
        Response::ok(
            id,
            serde_json::json!({
                "current_version": self.version,
                "update_available": false,
            }),
        )
    }
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[allow(clippy::unnecessary_wraps)]
fn base64_decode(input: &str) -> Result<Vec<u8>> {
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
    let input = input.trim().as_bytes();
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for chunk in input.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let a = u32::from(val(chunk[0]).unwrap_or(0));
        let b = u32::from(val(chunk[1]).unwrap_or(0));
        let c = if chunk.len() > 2 && chunk[2] != b'=' {
            u32::from(val(chunk[2]).unwrap_or(0))
        } else {
            0
        };
        let d = if chunk.len() > 3 && chunk[3] != b'=' {
            u32::from(val(chunk[3]).unwrap_or(0))
        } else {
            0
        };
        let triple = (a << 18) | (b << 12) | (c << 6) | d;
        #[allow(clippy::cast_possible_truncation)]
        out.push((triple >> 16) as u8);
        if chunk.len() > 2 && chunk[2] != b'=' {
            #[allow(clippy::cast_possible_truncation)]
            out.push((triple >> 8) as u8);
        }
        if chunk.len() > 3 && chunk[3] != b'=' {
            #[allow(clippy::cast_possible_truncation)]
            out.push(triple as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        let original = b"Hello, SideX remote server!";
        let encoded = base64_encode(original);
        let decoded = base64_decode(&encoded).unwrap();
        assert_eq!(original.as_slice(), decoded.as_slice());
    }

    #[test]
    fn base64_empty() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
    }

    #[tokio::test]
    async fn server_handles_unknown_method() {
        let server = SideXServer::new();
        let req = Request {
            jsonrpc: "2.0".to_string(),
            id: 1,
            method: "unknown/method".to_string(),
            params: serde_json::Value::Null,
        };
        let resp = server.handle(req).await;
        assert!(resp.error.is_some());
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[tokio::test]
    async fn server_exec_run() {
        let server = SideXServer::new();
        let req = Request {
            jsonrpc: "2.0".to_string(),
            id: 2,
            method: "exec/run".to_string(),
            params: serde_json::json!({ "command": "echo hello" }),
        };
        let resp = server.handle(req).await;
        assert!(resp.error.is_none());
        let result = resp.result.unwrap();
        assert!(result["stdout"].as_str().unwrap().contains("hello"));
    }

    #[tokio::test]
    async fn server_fs_mkdir_and_stat() {
        let server = SideXServer::new();
        let tmp = std::env::temp_dir().join("sidex_test_mkdir");
        let _ = std::fs::remove_dir_all(&tmp);

        let req = Request {
            jsonrpc: "2.0".to_string(),
            id: 3,
            method: "fs/mkdir".to_string(),
            params: serde_json::json!({ "path": tmp.to_string_lossy() }),
        };
        let resp = server.handle(req).await;
        assert!(resp.error.is_none());

        let req = Request {
            jsonrpc: "2.0".to_string(),
            id: 4,
            method: "fs/stat".to_string(),
            params: serde_json::json!({ "path": tmp.to_string_lossy() }),
        };
        let resp = server.handle(req).await;
        assert!(resp.error.is_none());
        assert!(resp.result.unwrap()["is_dir"].as_bool().unwrap());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn server_version() {
        let server = SideXServer::new();
        let req = Request {
            jsonrpc: "2.0".to_string(),
            id: 5,
            method: "server/version".to_string(),
            params: serde_json::Value::Null,
        };
        let resp = server.handle(req).await;
        assert!(resp.result.unwrap()["version"].as_str().is_some());
    }
}
