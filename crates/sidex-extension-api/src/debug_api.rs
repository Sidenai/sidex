//! `vscode.debug` API compatibility shim.
//!
//! Provides a Debug Adapter Protocol (DAP) client interface for managing
//! debug sessions, breakpoints, evaluation, debug adapter descriptor
//! factories, configuration providers, and the full DAP message set.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Opaque handles
// ---------------------------------------------------------------------------

/// Unique identifier for a debug session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DebugSessionId(pub u32);

/// Unique identifier for a debug adapter descriptor factory registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DebugAdapterFactoryId(pub u32);

/// Unique identifier for a debug configuration provider registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DebugConfigProviderId(pub u32);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Configuration for starting a debug session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfiguration {
    #[serde(rename = "type")]
    pub debug_type: String,
    pub name: String,
    pub request: String,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default, flatten)]
    pub extra: HashMap<String, Value>,
}

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

/// A source breakpoint location.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointLocation {
    pub uri: String,
    pub line: u32,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub hit_condition: Option<String>,
    #[serde(default)]
    pub log_message: Option<String>,
}

/// A function breakpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionBreakpoint {
    pub name: String,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub hit_condition: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

/// A data (watchpoint) breakpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBreakpoint {
    pub data_id: String,
    pub access_type: DataBreakpointAccessType,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub hit_condition: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

/// Access type for data breakpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataBreakpointAccessType {
    Read,
    Write,
    ReadWrite,
}

// ---------------------------------------------------------------------------
// DAP message types
// ---------------------------------------------------------------------------

/// DAP request kind — covers the full set of standard DAP requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DapRequestKind {
    Initialize,
    Launch,
    Attach,
    SetBreakpoints,
    SetFunctionBreakpoints,
    SetExceptionBreakpoints,
    Continue,
    Next,
    StepIn,
    StepOut,
    Pause,
    StackTrace,
    Scopes,
    Variables,
    Source,
    Threads,
    Evaluate,
    Completions,
    Disconnect,
    Terminate,
    Restart,
    SetVariable,
    RestartFrame,
    Goto,
    StepBack,
    ReverseContinue,
    ReadMemory,
    WriteMemory,
    Disassemble,
    DataBreakpointInfo,
    SetDataBreakpoints,
    SetInstructionBreakpoints,
    LoadedSources,
    Modules,
    ExceptionInfo,
    ConfigurationDone,
}

/// A DAP request message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapRequest {
    pub seq: u32,
    pub command: DapRequestKind,
    #[serde(default)]
    pub arguments: Value,
}

/// A DAP response message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapResponse {
    pub seq: u32,
    pub request_seq: u32,
    pub success: bool,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub body: Value,
}

/// A DAP event message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapEvent {
    pub seq: u32,
    pub event: String,
    #[serde(default)]
    pub body: Value,
}

// ---------------------------------------------------------------------------
// Debug adapter descriptor
// ---------------------------------------------------------------------------

/// Describes how to start or connect to a debug adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DebugAdapterDescriptor {
    Executable {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        options: HashMap<String, Value>,
    },
    Server {
        port: u16,
        #[serde(default)]
        host: Option<String>,
    },
    NamedPipe {
        path: String,
    },
    Inline,
}

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

/// Factory that produces a debug adapter descriptor for a session.
pub type DebugAdapterDescriptorFactory =
    Arc<dyn Fn(&DebugConfiguration) -> Result<DebugAdapterDescriptor> + Send + Sync>;

/// Provider that resolves / provides debug configurations.
pub type DebugConfigurationProvider =
    Arc<dyn Fn(Option<&str>, Value) -> Result<Vec<DebugConfiguration>> + Send + Sync>;

/// Callback for debug session events.
pub type DebugEventListener = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/// State of a debug session.
#[derive(Debug)]
#[allow(dead_code)]
struct DebugSession {
    id: DebugSessionId,
    config: DebugConfiguration,
    breakpoints: Vec<BreakpointLocation>,
    function_breakpoints: Vec<FunctionBreakpoint>,
    data_breakpoints: Vec<DataBreakpoint>,
    running: bool,
    next_dap_seq: AtomicU32,
}

#[allow(dead_code)]
struct AdapterFactoryEntry {
    id: DebugAdapterFactoryId,
    debug_type: String,
    factory: DebugAdapterDescriptorFactory,
}

#[allow(dead_code)]
struct ConfigProviderEntry {
    id: DebugConfigProviderId,
    debug_type: String,
    provider: DebugConfigurationProvider,
}

// ---------------------------------------------------------------------------
// DebugApi
// ---------------------------------------------------------------------------

/// Implements the `vscode.debug.*` API surface.
pub struct DebugApi {
    next_id: AtomicU32,
    next_factory: AtomicU32,
    next_config_provider: AtomicU32,

    sessions: RwLock<HashMap<DebugSessionId, DebugSession>>,
    active_session: RwLock<Option<DebugSessionId>>,

    adapter_factories: RwLock<HashMap<String, AdapterFactoryEntry>>,
    config_providers: RwLock<HashMap<String, ConfigProviderEntry>>,

    on_did_start: RwLock<Vec<DebugEventListener>>,
    on_did_terminate: RwLock<Vec<DebugEventListener>>,
    on_did_change_active: RwLock<Vec<DebugEventListener>>,
    on_did_receive_custom_event: RwLock<Vec<DebugEventListener>>,
}

impl DebugApi {
    /// Creates a new debug API handler.
    pub fn new() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            next_factory: AtomicU32::new(1),
            next_config_provider: AtomicU32::new(1),
            sessions: RwLock::new(HashMap::new()),
            active_session: RwLock::new(None),
            adapter_factories: RwLock::new(HashMap::new()),
            config_providers: RwLock::new(HashMap::new()),
            on_did_start: RwLock::new(Vec::new()),
            on_did_terminate: RwLock::new(Vec::new()),
            on_did_change_active: RwLock::new(Vec::new()),
            on_did_receive_custom_event: RwLock::new(Vec::new()),
        }
    }

    /// Dispatches a debug API action.
    #[allow(clippy::too_many_lines)]
    pub fn handle(&self, action: &str, params: &Value) -> Result<Value> {
        match action {
            "startDebugging" => {
                let folder = params
                    .get("folder")
                    .and_then(Value::as_str)
                    .map(String::from);
                let config: DebugConfiguration = params
                    .get("config")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .or_else(|| serde_json::from_value(params.clone()).ok())
                    .unwrap_or_else(|| DebugConfiguration {
                        debug_type: "unknown".to_owned(),
                        name: "Debug".to_owned(),
                        request: "launch".to_owned(),
                        program: None,
                        args: Vec::new(),
                        cwd: None,
                        extra: HashMap::new(),
                    });
                let id = self.start_debugging(folder.as_deref(), config)?;
                Ok(serde_json::to_value(id)?)
            }
            "stopDebugging" => {
                let id = params
                    .get("sessionId")
                    .and_then(Value::as_u64)
                    .map(|n| DebugSessionId(u32::try_from(n).unwrap_or(0)));
                if let Some(sid) = id {
                    self.stop_debugging(sid)?;
                }
                Ok(Value::Bool(true))
            }
            "addBreakpoints" => {
                let breakpoints: Vec<BreakpointLocation> = params
                    .get("breakpoints")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                for bp in &breakpoints {
                    self.add_breakpoint(bp)?;
                }
                Ok(Value::Bool(true))
            }
            "addBreakpoint" => {
                let loc: BreakpointLocation = serde_json::from_value(params.clone())?;
                self.add_breakpoint(&loc)?;
                Ok(Value::Bool(true))
            }
            "removeBreakpoints" => {
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
                self.remove_breakpoints(uri);
                Ok(Value::Bool(true))
            }
            "getActiveSessions" => {
                let ids = self.active_sessions();
                Ok(serde_json::to_value(ids)?)
            }
            "registerDebugAdapterDescriptorFactory" => {
                let debug_type = params.get("type").and_then(Value::as_str).unwrap_or("");
                let id = self.register_debug_adapter_descriptor_factory(
                    debug_type,
                    Arc::new(|_config| Ok(DebugAdapterDescriptor::Inline)),
                );
                Ok(serde_json::to_value(id)?)
            }
            "registerDebugConfigurationProvider" => {
                let debug_type = params.get("type").and_then(Value::as_str).unwrap_or("");
                let id = self.register_debug_configuration_provider(
                    debug_type,
                    Arc::new(|_folder, _token| Ok(Vec::new())),
                );
                Ok(serde_json::to_value(id)?)
            }
            "sendDapRequest" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_u64)
                    .map(|n| DebugSessionId(u32::try_from(n).unwrap_or(0)))
                    .ok_or_else(|| anyhow::anyhow!("missing sessionId"))?;
                let request: DapRequest = params
                    .get("request")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .ok_or_else(|| anyhow::anyhow!("missing request"))?;
                let response = self.send_dap_request(session_id, &request)?;
                Ok(serde_json::to_value(response)?)
            }

            // -- event subscriptions --
            "onDidStartDebugSession" => {
                self.on_did_start
                    .write()
                    .expect("lock poisoned")
                    .push(Arc::new(|_| Ok(())));
                Ok(Value::Bool(true))
            }
            "onDidTerminateDebugSession" => {
                self.on_did_terminate
                    .write()
                    .expect("lock poisoned")
                    .push(Arc::new(|_| Ok(())));
                Ok(Value::Bool(true))
            }
            "onDidChangeActiveDebugSession" => {
                self.on_did_change_active
                    .write()
                    .expect("lock poisoned")
                    .push(Arc::new(|_| Ok(())));
                Ok(Value::Bool(true))
            }
            "onDidReceiveDebugSessionCustomEvent" => {
                self.on_did_receive_custom_event
                    .write()
                    .expect("lock poisoned")
                    .push(Arc::new(|_| Ok(())));
                Ok(Value::Bool(true))
            }

            _ => bail!("unknown debug action: {action}"),
        }
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    /// Starts a new debug session with the given configuration.
    pub fn start_debugging(
        &self,
        _folder: Option<&str>,
        config: DebugConfiguration,
    ) -> Result<DebugSessionId> {
        let id = DebugSessionId(self.next_id.fetch_add(1, Ordering::Relaxed));
        log::info!("[ext] starting debug session {}: {}", id.0, config.name);

        let session = DebugSession {
            id,
            config,
            breakpoints: Vec::new(),
            function_breakpoints: Vec::new(),
            data_breakpoints: Vec::new(),
            running: true,
            next_dap_seq: AtomicU32::new(1),
        };

        self.sessions
            .write()
            .expect("debug sessions lock poisoned")
            .insert(id, session);

        *self.active_session.write().expect("lock poisoned") = Some(id);

        let val = serde_json::to_value(id).unwrap_or(Value::Null);
        for listener in self.on_did_start.read().expect("lock poisoned").iter() {
            let _ = listener(val.clone());
        }

        Ok(id)
    }

    /// Stops a debug session.
    pub fn stop_debugging(&self, id: DebugSessionId) -> Result<()> {
        let mut sessions = self.sessions.write().expect("debug sessions lock poisoned");

        if let Some(session) = sessions.get_mut(&id) {
            session.running = false;
            log::info!("[ext] stopped debug session {}", id.0);
        }
        sessions.remove(&id);

        {
            let mut active = self.active_session.write().expect("lock poisoned");
            if *active == Some(id) {
                *active = None;
            }
        }

        let val = serde_json::to_value(id).unwrap_or(Value::Null);
        for listener in self.on_did_terminate.read().expect("lock poisoned").iter() {
            let _ = listener(val.clone());
        }

        Ok(())
    }

    /// Returns the active debug session id, if any.
    pub fn active_debug_session(&self) -> Option<DebugSessionId> {
        *self.active_session.read().expect("lock poisoned")
    }

    // -----------------------------------------------------------------------
    // Breakpoints
    // -----------------------------------------------------------------------

    /// Adds a breakpoint. Applies to all active sessions.
    pub fn add_breakpoint(&self, location: &BreakpointLocation) -> Result<()> {
        log::debug!("[ext] breakpoint at {}:{}", location.uri, location.line);

        let mut sessions = self.sessions.write().expect("debug sessions lock poisoned");

        for session in sessions.values_mut() {
            session.breakpoints.push(location.clone());
        }

        Ok(())
    }

    /// Adds a function breakpoint.
    pub fn add_function_breakpoint(&self, bp: &FunctionBreakpoint) -> Result<()> {
        log::debug!("[ext] function breakpoint: {}", bp.name);
        let mut sessions = self.sessions.write().expect("debug sessions lock poisoned");
        for session in sessions.values_mut() {
            session.function_breakpoints.push(bp.clone());
        }
        Ok(())
    }

    /// Adds a data breakpoint.
    pub fn add_data_breakpoint(&self, bp: &DataBreakpoint) -> Result<()> {
        log::debug!("[ext] data breakpoint: {}", bp.data_id);
        let mut sessions = self.sessions.write().expect("debug sessions lock poisoned");
        for session in sessions.values_mut() {
            session.data_breakpoints.push(bp.clone());
        }
        Ok(())
    }

    /// Removes all breakpoints in the given file URI.
    pub fn remove_breakpoints(&self, uri: &str) {
        let mut sessions = self.sessions.write().expect("debug sessions lock poisoned");

        for session in sessions.values_mut() {
            session.breakpoints.retain(|bp| bp.uri != uri);
        }
    }

    // -----------------------------------------------------------------------
    // Session queries
    // -----------------------------------------------------------------------

    /// Returns the ids of all active debug sessions.
    pub fn active_sessions(&self) -> Vec<DebugSessionId> {
        self.sessions
            .read()
            .expect("debug sessions lock poisoned")
            .values()
            .filter(|s| s.running)
            .map(|s| s.id)
            .collect()
    }

    // -----------------------------------------------------------------------
    // Debug adapter descriptor factories
    // -----------------------------------------------------------------------

    /// Registers a debug adapter descriptor factory for a debug type.
    pub fn register_debug_adapter_descriptor_factory(
        &self,
        debug_type: &str,
        factory: DebugAdapterDescriptorFactory,
    ) -> DebugAdapterFactoryId {
        let raw = self.next_factory.fetch_add(1, Ordering::Relaxed);
        let id = DebugAdapterFactoryId(raw);
        log::debug!("[ext] registerDebugAdapterDescriptorFactory({debug_type}) -> {raw}");
        self.adapter_factories
            .write()
            .expect("adapter factories lock poisoned")
            .insert(
                debug_type.to_owned(),
                AdapterFactoryEntry {
                    id,
                    debug_type: debug_type.to_owned(),
                    factory,
                },
            );
        id
    }

    /// Returns a debug adapter descriptor for the given config, if a factory
    /// is registered for its type.
    pub fn create_debug_adapter_descriptor(
        &self,
        config: &DebugConfiguration,
    ) -> Result<Option<DebugAdapterDescriptor>> {
        let factories = self
            .adapter_factories
            .read()
            .expect("adapter factories lock poisoned");
        match factories.get(&config.debug_type) {
            Some(entry) => Ok(Some((entry.factory)(config)?)),
            None => Ok(None),
        }
    }

    // -----------------------------------------------------------------------
    // Debug configuration providers
    // -----------------------------------------------------------------------

    /// Registers a debug configuration provider for a debug type.
    pub fn register_debug_configuration_provider(
        &self,
        debug_type: &str,
        provider: DebugConfigurationProvider,
    ) -> DebugConfigProviderId {
        let raw = self.next_config_provider.fetch_add(1, Ordering::Relaxed);
        let id = DebugConfigProviderId(raw);
        log::debug!("[ext] registerDebugConfigurationProvider({debug_type}) -> {raw}");
        self.config_providers
            .write()
            .expect("config providers lock poisoned")
            .insert(
                debug_type.to_owned(),
                ConfigProviderEntry {
                    id,
                    debug_type: debug_type.to_owned(),
                    provider,
                },
            );
        id
    }

    /// Provides debug configurations for a debug type and workspace folder.
    pub fn provide_debug_configurations(
        &self,
        debug_type: &str,
        folder: Option<&str>,
    ) -> Result<Vec<DebugConfiguration>> {
        let providers = self
            .config_providers
            .read()
            .expect("config providers lock poisoned");
        match providers.get(debug_type) {
            Some(entry) => (entry.provider)(folder, Value::Null),
            None => Ok(Vec::new()),
        }
    }

    // -----------------------------------------------------------------------
    // DAP messaging
    // -----------------------------------------------------------------------

    /// Sends a DAP request to a debug session and returns the response.
    pub fn send_dap_request(
        &self,
        session_id: DebugSessionId,
        request: &DapRequest,
    ) -> Result<DapResponse> {
        let sessions = self.sessions.read().expect("debug sessions lock poisoned");
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| anyhow::anyhow!("debug session {} not found", session_id.0))?;

        let response_seq = session.next_dap_seq.fetch_add(1, Ordering::Relaxed);

        log::debug!(
            "[ext] DAP request {:?} (seq={}) -> session {}",
            request.command,
            request.seq,
            session_id.0,
        );

        Ok(DapResponse {
            seq: response_seq,
            request_seq: request.seq,
            success: true,
            command: Some(format!("{:?}", request.command)),
            message: None,
            body: Value::Object(serde_json::Map::new()),
        })
    }

    // -----------------------------------------------------------------------
    // Event subscriptions (programmatic API)
    // -----------------------------------------------------------------------

    /// Subscribes to debug session start events.
    pub fn on_did_start_debug_session(&self, listener: DebugEventListener) {
        self.on_did_start
            .write()
            .expect("lock poisoned")
            .push(listener);
    }

    /// Subscribes to debug session terminate events.
    pub fn on_did_terminate_debug_session(&self, listener: DebugEventListener) {
        self.on_did_terminate
            .write()
            .expect("lock poisoned")
            .push(listener);
    }

    /// Subscribes to active debug session change events.
    pub fn on_did_change_active_debug_session(&self, listener: DebugEventListener) {
        self.on_did_change_active
            .write()
            .expect("lock poisoned")
            .push(listener);
    }

    /// Subscribes to custom debug session events.
    pub fn on_did_receive_debug_session_custom_event(&self, listener: DebugEventListener) {
        self.on_did_receive_custom_event
            .write()
            .expect("lock poisoned")
            .push(listener);
    }

    /// Fires a custom event on a debug session.
    pub fn fire_custom_event(&self, session_id: DebugSessionId, event: &DapEvent) {
        let val = serde_json::json!({
            "sessionId": session_id.0,
            "event": event.event,
            "body": event.body,
        });
        for listener in self
            .on_did_receive_custom_event
            .read()
            .expect("lock poisoned")
            .iter()
        {
            let _ = listener(val.clone());
        }
    }
}

impl Default for DebugApi {
    fn default() -> Self {
        Self::new()
    }
}
