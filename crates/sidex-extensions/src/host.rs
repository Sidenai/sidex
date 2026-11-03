//! Node.js extension host process management.
//!
//! Spawns the VS Code-compatible Node.js extension host as a child process and
//! communicates via JSON-RPC over stdin/stdout with length-prefixed messages.
//! Supports multiple host kinds (local Node.js, remote, web worker), activation
//! queues, crash recovery, and memory monitoring.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

use crate::activation::ActivationEvent;
use crate::manifest::ExtensionManifest;

// ---------------------------------------------------------------------------
// Host kinds and state
// ---------------------------------------------------------------------------

/// The runtime kind of an extension host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionHostKind {
    /// Node.js process on the local machine.
    LocalProcess,
    /// Node.js process on a remote machine (SSH / container).
    RemoteProcess,
    /// Web worker (for browser/web extensions).
    WebWorker,
}

/// Lifecycle state of an extension host process.
#[derive(Debug, Clone)]
pub enum HostState {
    Starting,
    Ready,
    Activating,
    Running,
    Crashed { exit_code: i32, stderr: String },
    Terminated,
}

impl HostState {
    pub fn is_alive(&self) -> bool {
        matches!(
            self,
            HostState::Starting | HostState::Ready | HostState::Activating | HostState::Running
        )
    }
}

// ---------------------------------------------------------------------------
// Protocol tracking
// ---------------------------------------------------------------------------

/// Tracks in-flight JSON-RPC requests and generates request ids.
pub struct HostProtocol {
    pub pending_requests: HashMap<u64, PendingRequest>,
    pub next_request_id: u64,
}

impl HostProtocol {
    pub fn new() -> Self {
        Self {
            pending_requests: HashMap::new(),
            next_request_id: 1,
        }
    }

    pub fn next_id(&mut self) -> u64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }

    pub fn track(&mut self, id: u64, method: &str) {
        self.pending_requests.insert(
            id,
            PendingRequest {
                method: method.to_owned(),
                sent_at: Instant::now(),
            },
        );
    }

    pub fn resolve(&mut self, id: u64) -> Option<PendingRequest> {
        self.pending_requests.remove(&id)
    }

    pub fn timed_out_requests(&self, timeout: std::time::Duration) -> Vec<u64> {
        let now = Instant::now();
        self.pending_requests
            .iter()
            .filter(|(_, req)| now.duration_since(req.sent_at) > timeout)
            .map(|(id, _)| *id)
            .collect()
    }
}

impl Default for HostProtocol {
    fn default() -> Self {
        Self::new()
    }
}

/// A pending JSON-RPC request awaiting its response.
pub struct PendingRequest {
    pub method: String,
    pub sent_at: Instant,
}

// ---------------------------------------------------------------------------
// Activation queue
// ---------------------------------------------------------------------------

/// A queued extension activation request.
#[derive(Debug, Clone)]
pub struct ActivationRequest {
    pub extension_id: String,
    pub activation_event: ActivationEvent,
}

// ---------------------------------------------------------------------------
// Memory monitoring thresholds
// ---------------------------------------------------------------------------

const MEMORY_WARNING_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB
const MEMORY_CRITICAL_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB
const MAX_CRASH_RESTARTS: u32 = 3;

// ---------------------------------------------------------------------------
// JSON-RPC wire format
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct JsonRpcMessage {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

/// Callback invoked when the extension host sends a request to the editor.
pub type RequestHandler = Arc<dyn Fn(&str, Value) -> Result<Value> + Send + Sync>;

/// Callback invoked when the extension host sends a notification to the editor.
pub type NotificationHandler = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Callback invoked when an extension host crashes.
pub type CrashHandler = Arc<dyn Fn(u32, i32, &str) + Send + Sync>;

/// Oneshot channel used to resolve pending requests.
type PendingResponseSender = oneshot::Sender<Result<Value>>;

// ---------------------------------------------------------------------------
// ExtensionHost — single host process
// ---------------------------------------------------------------------------

/// Manages the lifecycle of a single Node.js extension host child process.
///
/// Communicates using JSON-RPC 2.0 over stdin/stdout with newline-delimited
/// messages, allowing the editor to invoke extension-host APIs and vice versa.
pub struct ExtensionHost {
    pub id: u32,
    pub kind: ExtensionHostKind,
    pub state: HostState,
    pub loaded_extensions: Vec<String>,
    pub started_at: Instant,
    pub memory_usage: u64,
    pub crash_count: u32,

    child: Option<Child>,
    next_id: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<u64, PendingResponseSender>>>,
    writer_tx: mpsc::Sender<String>,
    shutdown_signal: Arc<Notify>,
    protocol: Arc<Mutex<HostProtocol>>,

    node_path: String,
    host_script: std::path::PathBuf,
    extensions_dir: std::path::PathBuf,
}

impl ExtensionHost {
    /// Spawns the Node.js extension host process.
    ///
    /// * `id` — unique host id assigned by the manager.
    /// * `kind` — runtime kind (local, remote, web worker).
    /// * `node_path` — path to the `node` binary.
    /// * `host_script` — path to the JS entry point for the extension host.
    /// * `extensions_dir` — directory containing installed extensions.
    pub fn start(
        id: u32,
        kind: ExtensionHostKind,
        node_path: &str,
        host_script: &Path,
        extensions_dir: &Path,
    ) -> Result<Self> {
        let mut host_cmd = Command::new(node_path);
        host_cmd
            .arg(host_script)
            .arg("--extensions-dir")
            .arg(extensions_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            host_cmd.creation_flags(0x0800_0000);
        }

        let mut child = host_cmd
            .spawn()
            .context("failed to spawn Node.js extension host")?;

        let stdout = child.stdout.take().context("missing stdout")?;
        let stdin = child.stdin.take().context("missing stdin")?;

        let pending: Arc<Mutex<HashMap<u64, PendingResponseSender>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let next_id = Arc::new(AtomicU64::new(1));
        let shutdown_signal = Arc::new(Notify::new());
        let protocol = Arc::new(Mutex::new(HostProtocol::new()));

        let (writer_tx, mut writer_rx) = mpsc::channel::<String>(256);

        // Writer task — serialises outbound messages to stdin.
        let shutdown_w = shutdown_signal.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            loop {
                tokio::select! {
                    msg = writer_rx.recv() => {
                        match msg {
                            Some(line) => {
                                if stdin.write_all(line.as_bytes()).await.is_err() {
                                    break;
                                }
                                let _ = stdin.flush().await;
                            }
                            None => break,
                        }
                    }
                    () = shutdown_w.notified() => break,
                }
            }
        });

        // Reader task — reads JSON-RPC responses from stdout and resolves
        // pending futures.
        let pending_r = pending.clone();
        let shutdown_r = shutdown_signal.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            loop {
                tokio::select! {
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(text)) => {
                                Self::handle_incoming_line(&text, &pending_r).await;
                            }
                            Ok(None) | Err(_) => break,
                        }
                    }
                    () = shutdown_r.notified() => break,
                }
            }
        });

        Ok(Self {
            id,
            kind,
            state: HostState::Starting,
            loaded_extensions: Vec::new(),
            started_at: Instant::now(),
            memory_usage: 0,
            crash_count: 0,
            child: Some(child),
            next_id,
            pending,
            writer_tx,
            shutdown_signal,
            protocol,
            node_path: node_path.to_owned(),
            host_script: host_script.to_owned(),
            extensions_dir: extensions_dir.to_owned(),
        })
    }

    /// Sends a JSON-RPC request and waits for the response.
    pub async fn send_request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let msg = JsonRpcMessage {
            jsonrpc: "2.0".to_owned(),
            id: Some(id),
            method: Some(method.to_owned()),
            params: Some(params),
            result: None,
            error: None,
        };

        {
            let mut proto = self.protocol.lock().await;
            proto.track(id, method);
        }

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let line = serde_json::to_string(&msg)? + "\n";
        self.writer_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("host writer channel closed"))?;

        let result = rx
            .await
            .map_err(|_| anyhow::anyhow!("response channel dropped"))?;

        {
            let mut proto = self.protocol.lock().await;
            proto.resolve(id);
        }

        result
    }

    /// Sends a fire-and-forget notification to the extension host.
    pub async fn send_notification(&self, method: &str, params: Value) -> Result<()> {
        let msg = JsonRpcMessage {
            jsonrpc: "2.0".to_owned(),
            id: None,
            method: Some(method.to_owned()),
            params: Some(params),
            result: None,
            error: None,
        };
        let line = serde_json::to_string(&msg)? + "\n";
        self.writer_tx
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("host writer channel closed"))?;
        Ok(())
    }

    /// Handles an incoming JSON-RPC message from the extension host.
    pub async fn handle_message(&self, raw: &[u8]) -> Result<()> {
        let text = std::str::from_utf8(raw).context("invalid UTF-8 from extension host")?;
        Self::handle_incoming_line(text, &self.pending).await;
        Ok(())
    }

    /// Asks the extension host to activate a specific extension.
    pub async fn activate_extension(
        &self,
        extension_id: &str,
        event: &ActivationEvent,
    ) -> Result<()> {
        self.send_request(
            "$activateExtension",
            serde_json::json!({
                "extensionId": extension_id,
                "activationEvent": event.to_raw(),
            }),
        )
        .await?;
        Ok(())
    }

    /// Asks the extension host to deactivate a specific extension.
    pub async fn deactivate_extension(&self, extension_id: &str) -> Result<()> {
        self.send_request(
            "$deactivateExtension",
            serde_json::json!({ "extensionId": extension_id }),
        )
        .await?;
        Ok(())
    }

    /// Marks the host state as `Running`.
    pub fn mark_ready(&mut self) {
        self.state = HostState::Running;
    }

    /// Returns the uptime of this host.
    pub fn uptime(&self) -> std::time::Duration {
        self.started_at.elapsed()
    }

    /// Returns how many requests are still in-flight.
    pub async fn pending_request_count(&self) -> usize {
        self.protocol.lock().await.pending_requests.len()
    }

    /// Returns true if memory usage exceeds the warning threshold.
    pub fn memory_warning(&self) -> bool {
        self.memory_usage > MEMORY_WARNING_BYTES
    }

    /// Returns true if memory usage exceeds the critical threshold.
    pub fn memory_critical(&self) -> bool {
        self.memory_usage > MEMORY_CRITICAL_BYTES
    }

    /// Updates the cached memory usage (called periodically by the manager).
    pub fn update_memory_usage(&mut self, bytes: u64) {
        self.memory_usage = bytes;
        if self.memory_warning() {
            log::warn!(
                "extension host {} memory usage: {} MiB",
                self.id,
                bytes / (1024 * 1024)
            );
        }
    }

    /// Restarts this host, preserving the loaded extension list.
    pub async fn restart(&mut self) -> Result<()> {
        let extensions = self.loaded_extensions.clone();
        self.shutdown().await?;
        self.crash_count += 1;

        let mut new_host = Self::start(
            self.id,
            self.kind,
            &self.node_path,
            &self.host_script,
            &self.extensions_dir,
        )?;
        new_host.crash_count = self.crash_count;
        new_host.loaded_extensions = extensions;

        self.child = new_host.child.take();
        self.next_id = new_host.next_id;
        self.pending = new_host.pending;
        self.writer_tx = new_host.writer_tx;
        self.shutdown_signal = new_host.shutdown_signal;
        self.protocol = new_host.protocol;
        self.started_at = Instant::now();
        self.state = HostState::Starting;
        self.memory_usage = 0;

        Ok(())
    }

    /// Gracefully shuts down the extension host process.
    pub async fn shutdown(&mut self) -> Result<()> {
        self.shutdown_signal.notify_waiters();

        let _ = self.send_notification("shutdown", Value::Null).await;

        if let Some(ref mut child) = self.child {
            match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => return Err(e).context("error waiting for extension host"),
                Err(_) => {
                    child
                        .kill()
                        .await
                        .context("failed to kill extension host")?;
                }
            }
        }

        self.state = HostState::Terminated;
        self.child = None;
        Ok(())
    }

    /// Processes an incoming JSON-RPC line from the extension host.
    async fn handle_incoming_line(
        text: &str,
        pending: &Arc<Mutex<HashMap<u64, PendingResponseSender>>>,
    ) {
        let Ok(msg) = serde_json::from_str::<JsonRpcMessage>(text) else {
            log::warn!("malformed JSON-RPC from extension host: {text}");
            return;
        };

        if let Some(id) = msg.id {
            if msg.result.is_some() || msg.error.is_some() {
                if let Some(tx) = pending.lock().await.remove(&id) {
                    let result = if let Some(err) = msg.error {
                        Err(anyhow::anyhow!("extension host error: {err}"))
                    } else {
                        Ok(msg.result.unwrap_or(Value::Null))
                    };
                    let _ = tx.send(result);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ExtensionHostManager — orchestrates multiple hosts
// ---------------------------------------------------------------------------

/// Manages multiple extension host processes, activation queuing, and crash
/// recovery.
pub struct ExtensionHostManager {
    pub hosts: Vec<ExtensionHost>,
    pub activation_queue: VecDeque<ActivationRequest>,
    next_host_id: u32,
    crash_handler: Option<CrashHandler>,
}

impl ExtensionHostManager {
    pub fn new() -> Self {
        Self {
            hosts: Vec::new(),
            activation_queue: VecDeque::new(),
            next_host_id: 1,
            crash_handler: None,
        }
    }

    /// Registers a callback invoked when any host crashes.
    pub fn set_crash_handler(&mut self, handler: CrashHandler) {
        self.crash_handler = Some(handler);
    }

    /// Spawns a new extension host of the given kind and returns its id.
    pub fn spawn_host(
        &mut self,
        kind: ExtensionHostKind,
        node_path: &str,
        host_script: &Path,
        extensions_dir: &Path,
        extensions: &[ExtensionManifest],
    ) -> Result<u32> {
        let id = self.next_host_id;
        self.next_host_id += 1;

        let mut host = ExtensionHost::start(id, kind, node_path, host_script, extensions_dir)?;
        host.loaded_extensions = extensions
            .iter()
            .map(super::manifest::ExtensionManifest::canonical_id)
            .collect();
        host.state = HostState::Ready;

        log::info!(
            "spawned extension host {} ({:?}) with {} extensions",
            id,
            kind,
            extensions.len()
        );

        self.hosts.push(host);
        Ok(id)
    }

    /// Returns a reference to a host by id.
    pub fn get_host(&self, host_id: u32) -> Option<&ExtensionHost> {
        self.hosts.iter().find(|h| h.id == host_id)
    }

    /// Returns a mutable reference to a host by id.
    pub fn get_host_mut(&mut self, host_id: u32) -> Option<&mut ExtensionHost> {
        self.hosts.iter_mut().find(|h| h.id == host_id)
    }

    /// Sends a JSON-RPC request to a specific host.
    pub async fn send_request(&self, host_id: u32, method: &str, params: Value) -> Result<Value> {
        let host = self
            .hosts
            .iter()
            .find(|h| h.id == host_id)
            .ok_or_else(|| anyhow::anyhow!("host {host_id} not found"))?;
        host.send_request(method, params).await
    }

    /// Sends a notification to a specific host.
    pub async fn send_notification(&self, host_id: u32, method: &str, params: Value) -> Result<()> {
        let host = self
            .hosts
            .iter()
            .find(|h| h.id == host_id)
            .ok_or_else(|| anyhow::anyhow!("host {host_id} not found"))?;
        host.send_notification(method, params).await
    }

    /// Sends a notification to ALL running hosts.
    pub async fn broadcast_notification(&self, method: &str, params: Value) -> Result<()> {
        for host in &self.hosts {
            if host.state.is_alive() {
                host.send_notification(method, params.clone()).await?;
            }
        }
        Ok(())
    }

    /// Queues an activation request; it will be drained on the next tick.
    pub fn queue_activation(&mut self, extension_id: &str, event: ActivationEvent) {
        self.activation_queue.push_back(ActivationRequest {
            extension_id: extension_id.to_owned(),
            activation_event: event,
        });
    }

    /// Drains the activation queue, sending `$activateExtension` to the
    /// appropriate host for each queued request.
    pub async fn drain_activation_queue(&mut self) -> Result<()> {
        while let Some(req) = self.activation_queue.pop_front() {
            let host = self
                .hosts
                .iter()
                .find(|h| h.state.is_alive() && h.loaded_extensions.contains(&req.extension_id));

            if let Some(host) = host {
                if let Err(e) = host
                    .activate_extension(&req.extension_id, &req.activation_event)
                    .await
                {
                    log::error!(
                        "failed to activate extension {} on host {}: {e}",
                        req.extension_id,
                        host.id
                    );
                }
            } else {
                log::warn!(
                    "no running host found for extension {}; dropping activation",
                    req.extension_id
                );
            }
        }
        Ok(())
    }

    /// Deactivates an extension on the host that has it loaded.
    pub async fn deactivate_extension(&self, extension_id: &str) -> Result<()> {
        for host in &self.hosts {
            if host.state.is_alive() && host.loaded_extensions.contains(&extension_id.to_owned()) {
                host.deactivate_extension(extension_id).await?;
                return Ok(());
            }
        }
        anyhow::bail!("extension {extension_id} not found on any running host");
    }

    /// Checks all hosts for crashes and attempts restart (up to
    /// `MAX_CRASH_RESTARTS` times).
    pub async fn check_and_recover_crashed(&mut self) -> Result<()> {
        for host in &mut self.hosts {
            if let HostState::Crashed {
                exit_code,
                ref stderr,
            } = host.state
            {
                if let Some(ref handler) = self.crash_handler {
                    handler(host.id, exit_code, stderr);
                }

                if host.crash_count < MAX_CRASH_RESTARTS {
                    log::warn!(
                        "extension host {} crashed (exit {}), restarting ({}/{})",
                        host.id,
                        exit_code,
                        host.crash_count + 1,
                        MAX_CRASH_RESTARTS
                    );
                    host.restart().await?;
                } else {
                    log::error!(
                        "extension host {} exceeded max restarts ({}), not restarting",
                        host.id,
                        MAX_CRASH_RESTARTS
                    );
                }
            }
        }
        Ok(())
    }

    /// Updates memory usage for all hosts and logs warnings.
    pub fn update_memory_usage(&mut self, usage_by_host: &HashMap<u32, u64>) {
        for host in &mut self.hosts {
            if let Some(&bytes) = usage_by_host.get(&host.id) {
                host.update_memory_usage(bytes);
            }
        }
    }

    /// Gracefully shuts down all extension hosts.
    pub async fn shutdown_all(&mut self) -> Result<()> {
        for host in &mut self.hosts {
            if host.state.is_alive() {
                host.shutdown().await?;
            }
        }
        Ok(())
    }

    /// Restarts a specific host by id.
    pub async fn restart_host(&mut self, host_id: u32) -> Result<()> {
        let host = self
            .hosts
            .iter_mut()
            .find(|h| h.id == host_id)
            .ok_or_else(|| anyhow::anyhow!("host {host_id} not found"))?;
        host.restart().await
    }

    /// Returns a summary of all hosts for diagnostics.
    pub fn host_summary(&self) -> Vec<HostSummary> {
        self.hosts
            .iter()
            .map(|h| HostSummary {
                id: h.id,
                kind: h.kind,
                state: h.state.clone(),
                extension_count: h.loaded_extensions.len(),
                uptime_secs: h.uptime().as_secs(),
                memory_bytes: h.memory_usage,
                crash_count: h.crash_count,
            })
            .collect()
    }
}

impl Default for ExtensionHostManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Diagnostic summary of a single extension host.
#[derive(Debug)]
pub struct HostSummary {
    pub id: u32,
    pub kind: ExtensionHostKind,
    pub state: HostState,
    pub extension_count: usize,
    pub uptime_secs: u64,
    pub memory_bytes: u64,
    pub crash_count: u32,
}
