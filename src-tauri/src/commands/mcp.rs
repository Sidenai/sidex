use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const CONFIG_FILENAME: &str = "mcp-servers.json";

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_transport")]
    pub transport: String,
    pub url: Option<String>,
}

fn default_transport() -> String {
    "stdio".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server: String,
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    pub content: Vec<McpContent>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpContent {
    pub r#type: String,
    pub text: Option<String>,
    pub data: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub transport: String,
    pub connected: bool,
    pub tool_count: usize,
}

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[allow(dead_code)]
    data: Option<serde_json::Value>,
}

// ─── Connection ──────────────────────────────────────────────────────────────

struct McpConnection {
    child: Child,
    stdin: tokio::process::ChildStdin,
    reader: Arc<Mutex<BufReader<tokio::process::ChildStdout>>>,
    next_id: u64,
    tools: Vec<McpTool>,
    config: McpServerConfig,
}

impl McpConnection {
    async fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn MCP server '{}' (command: '{}'): {}",
                config.name, config.command, e
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Failed to capture stdin for '{}'", config.name))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Failed to capture stdout for '{}'", config.name))?;

        let reader = Arc::new(Mutex::new(BufReader::new(stdout)));

        let mut conn = Self {
            child,
            stdin,
            reader,
            next_id: 1,
            tools: Vec::new(),
            config: config.clone(),
        };

        conn.initialize().await?;
        conn.discover_tools().await?;

        Ok(conn)
    }

    async fn initialize(&mut self) -> Result<(), String> {
        let params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "roots": { "listChanged": true },
                "sampling": {}
            },
            "clientInfo": {
                "name": "sidex",
                "version": env!("CARGO_PKG_VERSION")
            }
        });

        let response = self.send_request("initialize", Some(params)).await?;

        if response.is_none() {
            return Err(format!(
                "MCP server '{}' returned empty initialize response",
                self.config.name
            ));
        }

        self.send_notification("notifications/initialized", None)
            .await?;

        Ok(())
    }

    async fn discover_tools(&mut self) -> Result<(), String> {
        let response = self
            .send_request("tools/list", None)
            .await?
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

        let tools_array = response
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        self.tools = tools_array
            .into_iter()
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?.to_string();
                let description = t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string();
                let input_schema = t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

                Some(McpTool {
                    server: self.config.name.clone(),
                    name,
                    description,
                    input_schema,
                })
            })
            .collect();

        Ok(())
    }

    async fn call_tool(
        &mut self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpToolResult, String> {
        let params = serde_json::json!({
            "name": tool_name,
            "arguments": arguments,
        });

        let response = self.send_request("tools/call", Some(params)).await?;

        let response = response.ok_or_else(|| {
            format!(
                "MCP server '{}' returned empty response for tool '{}'",
                self.config.name, tool_name
            )
        })?;

        let is_error = response
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let content_array = response
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let content = content_array
            .into_iter()
            .map(|c| McpContent {
                r#type: c
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("text")
                    .to_string(),
                text: c.get("text").and_then(|t| t.as_str()).map(String::from),
                data: c.get("data").and_then(|d| d.as_str()).map(String::from),
                mime_type: c.get("mimeType").and_then(|m| m.as_str()).map(String::from),
            })
            .collect();

        Ok(McpToolResult { content, is_error })
    }

    async fn send_request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<Option<serde_json::Value>, String> {
        let id = self.next_id;
        self.next_id += 1;

        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };

        let mut msg =
            serde_json::to_string(&request).map_err(|e| format!("Serialize error: {e}"))?;
        msg.push('\n');

        timeout(DEFAULT_TIMEOUT, self.stdin.write_all(msg.as_bytes()))
            .await
            .map_err(|_| format!("Timeout writing to MCP server '{}'", self.config.name))?
            .map_err(|e| {
                format!(
                    "Failed to write to MCP server '{}': {}",
                    self.config.name, e
                )
            })?;

        timeout(DEFAULT_TIMEOUT, self.stdin.flush())
            .await
            .map_err(|_| format!("Timeout flushing to MCP server '{}'", self.config.name))?
            .map_err(|e| {
                format!(
                    "Failed to flush to MCP server '{}': {}",
                    self.config.name, e
                )
            })?;

        let response = self.read_response(id).await?;

        if let Some(ref err) = response.error {
            return Err(format!(
                "MCP server '{}' error ({}): {}",
                self.config.name, err.code, err.message
            ));
        }

        Ok(response.result)
    }

    async fn send_notification(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<(), String> {
        #[derive(Serialize)]
        struct JsonRpcNotification {
            jsonrpc: &'static str,
            method: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            params: Option<serde_json::Value>,
        }

        let notification = JsonRpcNotification {
            jsonrpc: "2.0",
            method: method.to_string(),
            params,
        };

        let mut msg =
            serde_json::to_string(&notification).map_err(|e| format!("Serialize error: {e}"))?;
        msg.push('\n');

        timeout(DEFAULT_TIMEOUT, self.stdin.write_all(msg.as_bytes()))
            .await
            .map_err(|_| format!("Timeout writing notification to '{}'", self.config.name))?
            .map_err(|e| {
                format!(
                    "Failed to write notification to '{}': {}",
                    self.config.name, e
                )
            })?;

        timeout(DEFAULT_TIMEOUT, self.stdin.flush())
            .await
            .map_err(|_| format!("Timeout flushing notification to '{}'", self.config.name))?
            .map_err(|e| {
                format!(
                    "Failed to flush notification to '{}': {}",
                    self.config.name, e
                )
            })?;

        Ok(())
    }

    async fn read_response(&mut self, expected_id: u64) -> Result<JsonRpcResponse, String> {
        let reader = Arc::clone(&self.reader);
        let server_name = self.config.name.clone();

        let result = timeout(DEFAULT_TIMEOUT, async {
            let mut reader_guard = reader.lock().await;
            let mut line = String::new();

            loop {
                line.clear();
                let bytes_read = reader_guard
                    .read_line(&mut line)
                    .await
                    .map_err(|e| format!("Failed to read from MCP server '{server_name}': {e}"))?;

                if bytes_read == 0 {
                    return Err(format!(
                        "MCP server '{server_name}' closed connection unexpectedly"
                    ));
                }

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let parsed: JsonRpcResponse = match serde_json::from_str(trimmed) {
                    Ok(r) => r,
                    Err(_) => continue, // Skip notifications and malformed lines
                };

                if parsed.id == Some(expected_id) {
                    return Ok(parsed);
                }
            }
        })
        .await
        .map_err(|_| format!("Timeout waiting for response from MCP server '{server_name}'"))?;

        result
    }

    fn is_alive(&mut self) -> bool {
        self.child
            .try_wait()
            .ok()
            .map_or(true, |status| status.is_none())
    }

    async fn shutdown(&mut self) {
        let _ = self
            .send_notification("notifications/cancelled", None)
            .await;
        let _ = self.child.kill().await;
    }
}

// ─── State ───────────────────────────────────────────────────────────────────

/// Map entry: the connection itself lives behind its own lock so that I/O on
/// one server never blocks commands touching other servers. The discovered
/// tool list is cached here (updated at connect/reconnect time) so listing
/// commands never need to lock a connection.
struct McpServerEntry {
    conn: Arc<Mutex<McpConnection>>,
    tools: Vec<McpTool>,
}

pub struct McpState {
    servers: Mutex<HashMap<String, McpServerEntry>>,
    configs: Mutex<Vec<McpServerConfig>>,
    config_path: Mutex<String>,
}

impl McpState {
    pub fn new() -> Self {
        let config_path = crate::app_dirs::app_data_dir()
            .join(CONFIG_FILENAME)
            .to_string_lossy()
            .to_string();

        Self {
            servers: Mutex::new(HashMap::new()),
            configs: Mutex::new(Vec::new()),
            config_path: Mutex::new(config_path),
        }
    }

    pub async fn load_config(&self) -> Result<(), String> {
        let path = self.config_path.lock().await.clone();
        let path = std::path::Path::new(&path);

        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create config directory: {e}"))?;
            }
            std::fs::write(path, "[]").map_err(|e| format!("Failed to create config file: {e}"))?;
        }

        let contents =
            std::fs::read_to_string(path).map_err(|e| format!("Failed to read config: {e}"))?;

        let configs: Vec<McpServerConfig> =
            serde_json::from_str(&contents).map_err(|e| format!("Invalid config JSON: {e}"))?;

        *self.configs.lock().await = configs;
        Ok(())
    }

    async fn save_config(&self) -> Result<(), String> {
        let path = self.config_path.lock().await.clone();
        let json = {
            let configs = self.configs.lock().await;
            serde_json::to_string_pretty(&*configs)
                .map_err(|e| format!("Failed to serialize config: {e}"))?
        };

        // Atomic write (tmp + rename) off the async executor: a crash
        // mid-write must not corrupt mcp-servers.json.
        tokio::task::spawn_blocking(move || {
            let tmp = format!("{path}.tmp.{}", std::process::id());
            std::fs::write(&tmp, json).map_err(|e| format!("Failed to write config: {e}"))?;
            std::fs::rename(&tmp, &path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("Failed to publish config: {e}")
            })
        })
        .await
        .map_err(|e| format!("config write task failed: {e}"))??;
        Ok(())
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn mcp_list_servers(state: State<'_, McpState>) -> Result<Vec<McpServerStatus>, String> {
    let configs = state.configs.lock().await;
    let servers = state.servers.lock().await;

    let statuses = configs
        .iter()
        .map(|c| {
            let connected = servers.contains_key(&c.name);
            let tool_count = servers
                .get(&c.name)
                .map(|entry| entry.tools.len())
                .unwrap_or(0);

            McpServerStatus {
                name: c.name.clone(),
                transport: c.transport.clone(),
                connected,
                tool_count,
            }
        })
        .collect();

    Ok(statuses)
}

#[tauri::command]
pub async fn mcp_connect(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<McpServerStatus, String> {
    let config = {
        let configs = state.configs.lock().await;
        configs
            .iter()
            .find(|c| c.name == server_name)
            .cloned()
            .ok_or_else(|| format!("Server '{}' not found in config", server_name))?
    };

    if config.transport != "stdio" {
        return Err(format!(
            "Transport '{}' not yet supported; only 'stdio' is implemented",
            config.transport
        ));
    }

    // Disconnect existing connection if any: remove from the map first
    // (brief lock), then shut down under the connection's own lock.
    let existing = state.servers.lock().await.remove(&server_name);
    if let Some(entry) = existing {
        entry.conn.lock().await.shutdown().await;
    }

    let conn = McpConnection::spawn(&config).await?;
    let tools = conn.tools.clone();
    let tool_count = tools.len();

    state.servers.lock().await.insert(
        server_name.clone(),
        McpServerEntry {
            conn: Arc::new(Mutex::new(conn)),
            tools,
        },
    );

    Ok(McpServerStatus {
        name: server_name,
        transport: config.transport,
        connected: true,
        tool_count,
    })
}

#[tauri::command]
pub async fn mcp_disconnect(state: State<'_, McpState>, server_name: String) -> Result<(), String> {
    // Remove from the map first (brief lock), then clean up under the
    // connection's own lock.
    let entry = state.servers.lock().await.remove(&server_name);
    if let Some(entry) = entry {
        entry.conn.lock().await.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, McpState>) -> Result<Vec<McpTool>, String> {
    let servers = state.servers.lock().await;
    let tools: Vec<McpTool> = servers
        .values()
        .flat_map(|entry| entry.tools.clone())
        .collect();
    Ok(tools)
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, McpState>,
    server: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<McpToolResult, String> {
    // Hold the map lock only long enough to clone the connection's Arc;
    // all I/O happens under the per-connection lock.
    let conn_arc = {
        let servers = state.servers.lock().await;
        servers
            .get(&server)
            .map(|entry| Arc::clone(&entry.conn))
            .ok_or_else(|| format!("Server '{}' is not connected", server))?
    };

    {
        let mut conn = conn_arc.lock().await;
        if conn.is_alive() {
            return conn.call_tool(&tool_name, arguments).await;
        }
    }

    // Auto-reconnect: spawn a fresh connection without holding any lock,
    // then briefly lock the map to replace the entry (and its tool cache).
    let config = {
        let configs = state.configs.lock().await;
        configs
            .iter()
            .find(|c| c.name == server)
            .cloned()
            .ok_or_else(|| format!("Server '{}' not found in config", server))?
    };

    let new_conn = McpConnection::spawn(&config).await?;
    let tools = new_conn.tools.clone();
    let new_arc = Arc::new(Mutex::new(new_conn));

    {
        let mut servers = state.servers.lock().await;
        servers.insert(
            server.clone(),
            McpServerEntry {
                conn: Arc::clone(&new_arc),
                tools,
            },
        );
    }

    let mut conn = new_arc.lock().await;
    conn.call_tool(&tool_name, arguments).await
}

#[tauri::command]
pub async fn mcp_add_server(
    state: State<'_, McpState>,
    config: McpServerConfig,
) -> Result<(), String> {
    let mut configs = state.configs.lock().await;

    if configs.iter().any(|c| c.name == config.name) {
        return Err(format!("Server '{}' already exists", config.name));
    }

    configs.push(config);
    drop(configs);

    state.save_config().await
}

#[tauri::command]
pub async fn mcp_remove_server(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<(), String> {
    // Disconnect if running: remove from the map first (brief lock), then
    // clean up under the connection's own lock.
    let entry = state.servers.lock().await.remove(&server_name);
    if let Some(entry) = entry {
        entry.conn.lock().await.shutdown().await;
    }

    let mut configs = state.configs.lock().await;
    configs.retain(|c| c.name != server_name);
    drop(configs);

    state.save_config().await
}

#[tauri::command]
pub async fn mcp_reload_config(state: State<'_, McpState>) -> Result<Vec<McpServerStatus>, String> {
    state.load_config().await?;
    mcp_list_servers(state).await
}
