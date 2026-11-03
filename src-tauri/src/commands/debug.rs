use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

struct DebugAdapterHandle {
    child: Child,
    stdin: Option<std::process::ChildStdin>,
}

pub struct DebugAdapterStore {
    adapters: Mutex<HashMap<u32, DebugAdapterHandle>>,
    next_id: Mutex<u32>,
}

impl DebugAdapterStore {
    pub fn new() -> Self {
        Self {
            adapters: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    /// Kill every running debug adapter. Called on app exit.
    pub fn kill_all(&self) {
        let mut adapters = self.adapters.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut handle) in adapters.drain() {
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct DebugOutputEvent {
    adapter_id: u32,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct DebugErrorEvent {
    adapter_id: u32,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct DebugExitEvent {
    adapter_id: u32,
    exit_code: Option<i32>,
}

/// Spawn a debug adapter process and return its `adapter_id`.
/// The adapter communicates via stdin/stdout using the DAP wire protocol.
#[allow(clippy::too_many_lines, clippy::needless_pass_by_value)]
#[tauri::command]
pub fn debug_spawn_adapter(
    app: AppHandle,
    state: State<'_, Arc<DebugAdapterStore>>,
    executable: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let mut cmd = Command::new(&executable);

    if let Some(ref a) = args {
        cmd.args(a);
    }

    if let Some(ref dir) = cwd {
        if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
            cmd.current_dir(dir);
        }
    }

    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn debug adapter '{executable}': {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture debug adapter stdin".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture debug adapter stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture debug adapter stderr".to_string())?;

    let id = {
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        let id = *next;
        *next += 1;
        id
    };

    {
        let mut adapters = state.adapters.lock().map_err(|e| e.to_string())?;
        adapters.insert(
            id,
            DebugAdapterHandle {
                child,
                stdin: Some(stdin),
            },
        );
    }

    let adapter_id = id;
    let app_stdout = app.clone();
    let state_clone = state.inner().clone();

    // Stdout reader thread: emits `debug-output` events with raw DAP wire data
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_stdout.emit(
                        "debug-output",
                        DebugOutputEvent {
                            adapter_id,
                            data: text,
                        },
                    );
                }
            }
        }

        // Process exited (stdout EOF) — remove the handle from the map FIRST,
        // then reap with a real wait() OUTSIDE the lock. try_wait() under the
        // lock left zombies (Ok(None) when the process hadn't fully exited)
        // and leaked the map entry forever.
        let handle = {
            let Ok(mut adapters) = state_clone.adapters.lock() else {
                let _ = app_stdout.emit(
                    "debug-exit",
                    DebugExitEvent {
                        adapter_id,
                        exit_code: None,
                    },
                );
                return;
            };
            adapters.remove(&adapter_id)
        };

        let exit_code = match handle {
            Some(mut handle) => match handle.child.wait() {
                Ok(status) => status.code(),
                Err(_) => None,
            },
            None => None,
        };

        let _ = app_stdout.emit(
            "debug-exit",
            DebugExitEvent {
                adapter_id,
                exit_code,
            },
        );
    });

    // Stderr reader thread: emits `debug-error` events
    let app_stderr = app.clone();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_stderr.emit(
                        "debug-error",
                        DebugErrorEvent {
                            adapter_id,
                            data: text,
                        },
                    );
                }
            }
        }
    });

    Ok(id)
}

/// Send raw data (DAP wire-format bytes) to the debug adapter's stdin.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn debug_send(
    state: State<'_, Arc<DebugAdapterStore>>,
    adapter_id: u32,
    data: String,
) -> Result<(), String> {
    let mut adapters = state.adapters.lock().map_err(|e| e.to_string())?;
    let handle = adapters
        .get_mut(&adapter_id)
        .ok_or_else(|| format!("Debug adapter {adapter_id} not found"))?;

    let stdin = handle
        .stdin
        .as_mut()
        .ok_or_else(|| format!("Debug adapter {adapter_id} stdin not available"))?;

    stdin
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to debug adapter {adapter_id}: {e}"))?;

    stdin
        .flush()
        .map_err(|e| format!("Failed to flush debug adapter {adapter_id}: {e}"))?;

    Ok(())
}

/// Kill a running debug adapter process.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn debug_kill(state: State<'_, Arc<DebugAdapterStore>>, adapter_id: u32) -> Result<(), String> {
    let mut adapters = state.adapters.lock().map_err(|e| e.to_string())?;
    let mut handle = adapters
        .remove(&adapter_id)
        .ok_or_else(|| format!("Debug adapter {adapter_id} not found"))?;

    handle.stdin.take();

    handle
        .child
        .kill()
        .map_err(|e| format!("Failed to kill debug adapter {adapter_id}: {e}"))?;

    let _ = handle.child.wait();

    Ok(())
}

/// List currently running debug adapter IDs.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn debug_list_adapters(state: State<'_, Arc<DebugAdapterStore>>) -> Result<Vec<u32>, String> {
    let adapters = state.adapters.lock().map_err(|e| e.to_string())?;
    Ok(adapters.keys().copied().collect())
}

// ---------------------------------------------------------------------------
// sidex-dap integration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapLaunchConfigResponse {
    pub configs: Vec<sidex_dap::LaunchConfig>,
    pub compounds: Vec<sidex_dap::CompoundLaunchConfig>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugAdapterInfo {
    pub type_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub runtime: Option<String>,
    pub command_line: String,
}

/// Parse `.vscode/launch.json` (JSONC) from the given workspace root.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn dap_get_launch_configs(workspace: String) -> Result<DapLaunchConfigResponse, String> {
    let launch_path = PathBuf::from(&workspace).join(".vscode/launch.json");
    if !launch_path.is_file() {
        return Ok(DapLaunchConfigResponse {
            configs: Vec::new(),
            compounds: Vec::new(),
        });
    }
    let (configs, compounds) =
        sidex_dap::parse_launch_json(&launch_path).map_err(|e| e.to_string())?;
    Ok(DapLaunchConfigResponse { configs, compounds })
}

/// Return the built-in debug adapter registry.
#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn dap_get_adapter_registry() -> Result<Vec<DebugAdapterInfo>, String> {
    let registry = sidex_dap::DebugAdapterRegistry::with_builtins();
    let infos = registry
        .registered_types()
        .into_iter()
        .filter_map(|t| {
            let desc = registry.get(t)?;
            Some(DebugAdapterInfo {
                type_name: desc.type_name.clone(),
                command: desc.command.clone(),
                args: desc.args.clone(),
                runtime: desc.runtime.clone(),
                command_line: registry.command_line(t).unwrap_or_default(),
            })
        })
        .collect();
    Ok(infos)
}

// ---------------------------------------------------------------------------
// High-level DAP client (sidex-dap DebugClient)
// ---------------------------------------------------------------------------

pub struct DapClientStore {
    clients: AsyncMutex<HashMap<u32, Arc<sidex_dap::DebugClient>>>,
    next_id: AsyncMutex<u32>,
}

impl DapClientStore {
    pub fn new() -> Self {
        Self {
            clients: AsyncMutex::new(HashMap::new()),
            next_id: AsyncMutex::new(1),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapEventPayload {
    pub adapter_id: u32,
    pub event: sidex_dap::DapEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapStartResult {
    pub adapter_id: u32,
    pub capabilities: sidex_dap::Capabilities,
}

/// Launch a debug session via `sidex-dap`. Resolves `type_name` against the
/// built-in adapter registry, spawns the adapter, performs the initialize
/// handshake, and sends the launch request.
#[tauri::command]
pub async fn dap_start_adapter(
    app: AppHandle,
    state: State<'_, Arc<DapClientStore>>,
    type_name: String,
    config: sidex_dap::LaunchConfig,
) -> Result<DapStartResult, String> {
    let registry = sidex_dap::DebugAdapterRegistry::with_builtins();
    let command_line = registry
        .command_line(&type_name)
        .ok_or_else(|| format!("debug adapter type '{type_name}' is not registered"))?;

    let client = sidex_dap::DebugClient::launch(&command_line, &config)
        .await
        .map_err(|e| e.to_string())?;

    let id = {
        let mut next = state.next_id.lock().await;
        let id = *next;
        *next += 1;
        id
    };

    let app_for_events = app.clone();
    client
        .on_event(move |event| {
            let _ = app_for_events.emit(
                "dap-event",
                DapEventPayload {
                    adapter_id: id,
                    event,
                },
            );
        })
        .await;

    let capabilities = client.capabilities().await;
    state.clients.lock().await.insert(id, Arc::new(client));

    Ok(DapStartResult {
        adapter_id: id,
        capabilities,
    })
}

/// Send a raw DAP request through a managed `DebugClient` session.
#[tauri::command]
#[allow(clippy::too_many_lines)]
pub async fn dap_send_request(
    state: State<'_, Arc<DapClientStore>>,
    adapter_id: u32,
    command: String,
    arguments: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let client = {
        let clients = state.clients.lock().await;
        clients
            .get(&adapter_id)
            .cloned()
            .ok_or_else(|| format!("DAP adapter {adapter_id} not found"))?
    };
    let args = arguments.unwrap_or(serde_json::Value::Null);

    match command.as_str() {
        "continue" => {
            let thread_id = args
                .get("threadId")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing threadId")?;
            client
                .continue_execution(thread_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "next" => {
            let thread_id = args
                .get("threadId")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing threadId")?;
            client.next(thread_id).await.map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "stepIn" => {
            let thread_id = args
                .get("threadId")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing threadId")?;
            client.step_in(thread_id).await.map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "stepOut" => {
            let thread_id = args
                .get("threadId")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing threadId")?;
            client
                .step_out(thread_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "pause" => {
            let thread_id = args
                .get("threadId")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing threadId")?;
            client.pause(thread_id).await.map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "stackTrace" => {
            let thread_id = args
                .get("threadId")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing threadId")?;
            let frames = client
                .stack_trace(thread_id)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(frames).map_err(|e| e.to_string())
        }
        "scopes" => {
            let frame_id = args
                .get("frameId")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing frameId")?;
            let scopes = client.scopes(frame_id).await.map_err(|e| e.to_string())?;
            serde_json::to_value(scopes).map_err(|e| e.to_string())
        }
        "variables" => {
            let vars_ref = args
                .get("variablesReference")
                .and_then(serde_json::Value::as_i64)
                .ok_or("missing variablesReference")?;
            let vars = client
                .variables(vars_ref)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(vars).map_err(|e| e.to_string())
        }
        "threads" => {
            let threads = client.threads().await.map_err(|e| e.to_string())?;
            serde_json::to_value(threads).map_err(|e| e.to_string())
        }
        "evaluate" => {
            let expression = args
                .get("expression")
                .and_then(serde_json::Value::as_str)
                .ok_or("missing expression")?;
            let frame_id = args.get("frameId").and_then(serde_json::Value::as_i64);
            let result = client
                .evaluate(expression, frame_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "result": result }))
        }
        "setBreakpoints" => {
            let path = args
                .get("source")
                .and_then(|s| s.get("path"))
                .and_then(serde_json::Value::as_str)
                .ok_or("missing source.path")?;
            let breakpoints: Vec<sidex_dap::SourceBreakpoint> = args
                .get("breakpoints")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            let confirmed = client
                .set_breakpoints(path, &breakpoints)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(confirmed).map_err(|e| e.to_string())
        }
        _ => Err(format!("unsupported DAP command: {command}")),
    }
}

/// Disconnect and remove a managed debug client.
#[tauri::command]
pub async fn dap_stop_adapter(
    state: State<'_, Arc<DapClientStore>>,
    adapter_id: u32,
) -> Result<(), String> {
    let client = {
        let mut clients = state.clients.lock().await;
        clients
            .remove(&adapter_id)
            .ok_or_else(|| format!("DAP adapter {adapter_id} not found"))?
    };
    client.disconnect().await.map_err(|e| e.to_string())?;
    Ok(())
}
