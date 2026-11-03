//! DAP client — manages a debug session lifecycle against a debug adapter process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::launch_config::{AttachConfig, LaunchConfig};
use crate::protocol::{
    Breakpoint, Capabilities, CompletionItem, DapCommand, DapEvent, DapMessage, DapRequest,
    DapResponse, DataBreakpoint, ExceptionDetails, FunctionBreakpoint, InstructionBreakpoint,
    Module, Scope, SourceBreakpoint, StackFrame, Thread, Variable,
};
use crate::transport::DapTransport;

type PendingRequests = HashMap<i64, oneshot::Sender<DapResponse>>;
type EventCallback = Box<dyn Fn(DapEvent) + Send + Sync>;

/// A client connection to a single debug adapter process.
pub struct DebugClient {
    transport: Arc<DapTransport>,
    seq: AtomicI64,
    pending: Arc<Mutex<PendingRequests>>,
    capabilities: Mutex<Capabilities>,
    event_handler: Arc<Mutex<Option<EventCallback>>>,
    recv_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl DebugClient {
    /// Launches a debug adapter process and initializes a debug session with a launch request.
    pub async fn launch(adapter_command: &str, config: &LaunchConfig) -> Result<Self> {
        let parts: Vec<&str> = adapter_command.split_whitespace().collect();
        let (cmd, args) = parts
            .split_first()
            .ok_or_else(|| anyhow::anyhow!("empty adapter command"))?;

        let mut adapter_cmd = Command::new(cmd);
        adapter_cmd
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(windows)]
        {
            adapter_cmd.creation_flags(0x0800_0000);
        }

        let mut child = adapter_cmd
            .spawn()
            .with_context(|| format!("failed to spawn debug adapter: {adapter_command}"))?;

        let stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;

        let client = Self::from_transport(DapTransport::new(stdin, stdout));
        client.start_recv_loop().await;
        client.initialize().await?;

        let launch_args = json!({
            "program": config.program,
            "args": config.args,
            "cwd": config.cwd,
            "env": config.env,
            "noDebug": false,
        });
        client.send_request(DapCommand::Launch, launch_args).await?;
        client
            .send_request(DapCommand::ConfigurationDone, Value::Null)
            .await?;

        Ok(client)
    }

    /// Attaches to a running process via a debug adapter.
    pub async fn attach(adapter_command: &str, config: &AttachConfig) -> Result<Self> {
        let parts: Vec<&str> = adapter_command.split_whitespace().collect();
        let (cmd, args) = parts
            .split_first()
            .ok_or_else(|| anyhow::anyhow!("empty adapter command"))?;

        let mut adapter_cmd = Command::new(cmd);
        adapter_cmd
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        #[cfg(windows)]
        {
            adapter_cmd.creation_flags(0x0800_0000);
        }

        let mut child = adapter_cmd
            .spawn()
            .with_context(|| format!("failed to spawn debug adapter: {adapter_command}"))?;

        let stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;

        let client = Self::from_transport(DapTransport::new(stdin, stdout));
        client.start_recv_loop().await;
        client.initialize().await?;

        let attach_args = json!({
            "processId": config.process_id,
            "port": config.port,
        });
        client.send_request(DapCommand::Attach, attach_args).await?;
        client
            .send_request(DapCommand::ConfigurationDone, Value::Null)
            .await?;

        Ok(client)
    }

    /// Creates a client from an existing transport (for testing or custom connections).
    pub fn from_transport(transport: DapTransport) -> Self {
        Self {
            transport: Arc::new(transport),
            seq: AtomicI64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            capabilities: Mutex::new(Capabilities::default()),
            event_handler: Arc::new(Mutex::new(None)),
            recv_task: Mutex::new(None),
        }
    }

    /// Starts the background receive loop that dispatches responses and events.
    async fn start_recv_loop(&self) {
        let transport = Arc::clone(&self.transport);
        let pending = Arc::clone(&self.pending);
        let handler = Arc::clone(&self.event_handler);

        let task = tokio::spawn(async move {
            loop {
                let msg = match transport.recv().await {
                    Ok(m) => m,
                    Err(e) => {
                        log::debug!("DAP recv loop ended: {e}");
                        break;
                    }
                };

                match msg {
                    DapMessage::Response(resp) => {
                        let mut map = pending.lock().await;
                        if let Some(tx) = map.remove(&resp.request_seq) {
                            let _ = tx.send(resp);
                        }
                    }
                    DapMessage::Event(event) => {
                        let cb = handler.lock().await;
                        if let Some(ref f) = *cb {
                            f(event);
                        }
                    }
                    DapMessage::Request(_) => {
                        log::warn!("unexpected reverse request from adapter (not yet supported)");
                    }
                }
            }
        });

        *self.recv_task.lock().await = Some(task);
    }

    /// Sends a request and waits for the matching response.
    async fn send_request(&self, command: DapCommand, arguments: Value) -> Result<DapResponse> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(seq, tx);

        let request = DapMessage::Request(DapRequest::new(seq, command, arguments));
        self.transport.send(&request).await?;

        let response = rx.await.context("response channel closed")?;
        if !response.success {
            let msg = response.message.as_deref().unwrap_or("unknown error");
            bail!("DAP request failed: {msg}");
        }
        Ok(response)
    }

    /// Sends the initialize request and stores resulting capabilities.
    async fn initialize(&self) -> Result<()> {
        let args = json!({
            "clientID": "sidex",
            "clientName": "SideX",
            "adapterID": "sidex-dap",
            "linesStartAt1": true,
            "columnsStartAt1": true,
            "pathFormat": "path",
            "supportsVariableType": true,
            "supportsVariablePaging": true,
            "supportsRunInTerminalRequest": false,
            "locale": "en-us",
        });
        let resp = self.send_request(DapCommand::Initialize, args).await?;
        if !resp.body.is_null() {
            let caps: Capabilities = serde_json::from_value(resp.body)?;
            *self.capabilities.lock().await = caps;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Sets breakpoints for a source file, returning confirmed breakpoints.
    pub async fn set_breakpoints(
        &self,
        source_path: &str,
        breakpoints: &[SourceBreakpoint],
    ) -> Result<Vec<Breakpoint>> {
        let args = json!({
            "source": { "path": source_path },
            "breakpoints": breakpoints,
        });
        let resp = self.send_request(DapCommand::SetBreakpoints, args).await?;
        let bps: Vec<Breakpoint> = resp
            .body
            .get("breakpoints")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(bps)
    }

    /// Continues execution of a thread.
    pub async fn continue_execution(&self, thread_id: i64) -> Result<()> {
        self.send_request(DapCommand::Continue, json!({"threadId": thread_id}))
            .await?;
        Ok(())
    }

    /// Steps over (next) in a thread.
    pub async fn next(&self, thread_id: i64) -> Result<()> {
        self.send_request(DapCommand::Next, json!({"threadId": thread_id}))
            .await?;
        Ok(())
    }

    /// Steps into a function call.
    pub async fn step_in(&self, thread_id: i64) -> Result<()> {
        self.send_request(DapCommand::StepIn, json!({"threadId": thread_id}))
            .await?;
        Ok(())
    }

    /// Steps out of the current function.
    pub async fn step_out(&self, thread_id: i64) -> Result<()> {
        self.send_request(DapCommand::StepOut, json!({"threadId": thread_id}))
            .await?;
        Ok(())
    }

    /// Pauses a thread.
    pub async fn pause(&self, thread_id: i64) -> Result<()> {
        self.send_request(DapCommand::Pause, json!({"threadId": thread_id}))
            .await?;
        Ok(())
    }

    /// Gets the stack trace for a thread.
    pub async fn stack_trace(&self, thread_id: i64) -> Result<Vec<StackFrame>> {
        let resp = self
            .send_request(DapCommand::StackTrace, json!({"threadId": thread_id}))
            .await?;
        let frames: Vec<StackFrame> = resp
            .body
            .get("stackFrames")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(frames)
    }

    /// Gets the scopes for a stack frame.
    pub async fn scopes(&self, frame_id: i64) -> Result<Vec<Scope>> {
        let resp = self
            .send_request(DapCommand::Scopes, json!({"frameId": frame_id}))
            .await?;
        let scopes: Vec<Scope> = resp
            .body
            .get("scopes")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(scopes)
    }

    /// Gets variables for a variables reference (scope or structured variable).
    pub async fn variables(&self, variables_reference: i64) -> Result<Vec<Variable>> {
        let resp = self
            .send_request(
                DapCommand::Variables,
                json!({"variablesReference": variables_reference}),
            )
            .await?;
        let vars: Vec<Variable> = resp
            .body
            .get("variables")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(vars)
    }

    /// Evaluates an expression in the context of a stack frame.
    pub async fn evaluate(&self, expression: &str, frame_id: Option<i64>) -> Result<String> {
        let mut args = json!({"expression": expression, "context": "repl"});
        if let Some(fid) = frame_id {
            args["frameId"] = json!(fid);
        }
        let resp = self.send_request(DapCommand::Evaluate, args).await?;
        let result = resp
            .body
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        Ok(result)
    }

    /// Lists all threads in the debuggee.
    pub async fn threads(&self) -> Result<Vec<Thread>> {
        let resp = self.send_request(DapCommand::Threads, Value::Null).await?;
        let threads: Vec<Thread> = resp
            .body
            .get("threads")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(threads)
    }

    /// Steps backward (reverse debugging).
    pub async fn step_back(&self, thread_id: i64) -> Result<()> {
        self.send_request(DapCommand::StepBack, json!({"threadId": thread_id}))
            .await?;
        Ok(())
    }

    /// Reverse-continues execution (reverse debugging).
    pub async fn reverse_continue(&self, thread_id: i64) -> Result<()> {
        self.send_request(DapCommand::ReverseContinue, json!({"threadId": thread_id}))
            .await?;
        Ok(())
    }

    /// Restarts a specific stack frame.
    pub async fn restart_frame(&self, frame_id: i64) -> Result<()> {
        self.send_request(DapCommand::RestartFrame, json!({"frameId": frame_id}))
            .await?;
        Ok(())
    }

    /// Jumps to a target location.
    pub async fn goto(&self, thread_id: i64, target_id: i64) -> Result<()> {
        self.send_request(
            DapCommand::Goto,
            json!({"threadId": thread_id, "targetId": target_id}),
        )
        .await?;
        Ok(())
    }

    /// Terminates the debuggee.
    pub async fn terminate(&self) -> Result<()> {
        let _ = self
            .send_request(DapCommand::Terminate, json!({"restart": false}))
            .await;
        Ok(())
    }

    /// Restarts the debug session.
    pub async fn restart(&self) -> Result<()> {
        self.send_request(DapCommand::Restart, Value::Null).await?;
        Ok(())
    }

    /// Sets function breakpoints, returning confirmed breakpoints.
    pub async fn set_function_breakpoints(
        &self,
        breakpoints: &[FunctionBreakpoint],
    ) -> Result<Vec<Breakpoint>> {
        let args = json!({ "breakpoints": breakpoints });
        let resp = self
            .send_request(DapCommand::SetFunctionBreakpoints, args)
            .await?;
        let bps: Vec<Breakpoint> = resp
            .body
            .get("breakpoints")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(bps)
    }

    /// Sets data breakpoints, returning confirmed breakpoints.
    pub async fn set_data_breakpoints(
        &self,
        breakpoints: &[DataBreakpoint],
    ) -> Result<Vec<Breakpoint>> {
        let args = json!({ "breakpoints": breakpoints });
        let resp = self
            .send_request(DapCommand::SetDataBreakpoints, args)
            .await?;
        let bps: Vec<Breakpoint> = resp
            .body
            .get("breakpoints")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(bps)
    }

    /// Sets instruction breakpoints, returning confirmed breakpoints.
    pub async fn set_instruction_breakpoints(
        &self,
        breakpoints: &[InstructionBreakpoint],
    ) -> Result<Vec<Breakpoint>> {
        let args = json!({ "breakpoints": breakpoints });
        let resp = self
            .send_request(DapCommand::SetInstructionBreakpoints, args)
            .await?;
        let bps: Vec<Breakpoint> = resp
            .body
            .get("breakpoints")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(bps)
    }

    /// Sets exception breakpoint filters.
    pub async fn set_exception_breakpoints(&self, filters: &[String]) -> Result<()> {
        self.send_request(
            DapCommand::SetExceptionBreakpoints,
            json!({"filters": filters}),
        )
        .await?;
        Ok(())
    }

    /// Terminates specific threads.
    pub async fn terminate_threads(&self, thread_ids: &[i64]) -> Result<()> {
        self.send_request(
            DapCommand::TerminateThreads,
            json!({"threadIds": thread_ids}),
        )
        .await?;
        Ok(())
    }

    /// Gets loaded modules.
    pub async fn modules(&self) -> Result<Vec<Module>> {
        let resp = self
            .send_request(
                DapCommand::Modules,
                json!({"startModule": 0, "moduleCount": 1000}),
            )
            .await?;
        let modules: Vec<Module> = resp
            .body
            .get("modules")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(modules)
    }

    /// Gets all loaded source files.
    pub async fn loaded_sources(&self) -> Result<Vec<crate::protocol::Source>> {
        let resp = self
            .send_request(DapCommand::LoadedSources, Value::Null)
            .await?;
        let sources: Vec<crate::protocol::Source> = resp
            .body
            .get("sources")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(sources)
    }

    /// Sets the value of a variable.
    pub async fn set_variable(
        &self,
        variables_reference: i64,
        name: &str,
        value: &str,
    ) -> Result<String> {
        let resp = self
            .send_request(
                DapCommand::SetVariable,
                json!({
                    "variablesReference": variables_reference,
                    "name": name,
                    "value": value,
                }),
            )
            .await?;
        Ok(resp
            .body
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned())
    }

    /// Sets the value of an expression.
    pub async fn set_expression(
        &self,
        expression: &str,
        value: &str,
        frame_id: Option<i64>,
    ) -> Result<String> {
        let mut args = json!({"expression": expression, "value": value});
        if let Some(fid) = frame_id {
            args["frameId"] = json!(fid);
        }
        let resp = self.send_request(DapCommand::SetExpression, args).await?;
        Ok(resp
            .body
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned())
    }

    /// Gets exception information for the given thread.
    pub async fn exception_info(&self, thread_id: i64) -> Result<ExceptionDetails> {
        let resp = self
            .send_request(DapCommand::ExceptionInfo, json!({"threadId": thread_id}))
            .await?;
        let details: ExceptionDetails = serde_json::from_value(resp.body)?;
        Ok(details)
    }

    /// Gets completions for the REPL.
    pub async fn completions(
        &self,
        text: &str,
        column: i64,
        frame_id: Option<i64>,
    ) -> Result<Vec<CompletionItem>> {
        let mut args = json!({"text": text, "column": column});
        if let Some(fid) = frame_id {
            args["frameId"] = json!(fid);
        }
        let resp = self.send_request(DapCommand::Completions, args).await?;
        let items: Vec<CompletionItem> = resp
            .body
            .get("targets")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        Ok(items)
    }

    /// Reads memory from the debuggee.
    pub async fn read_memory(
        &self,
        memory_reference: &str,
        offset: i64,
        count: i64,
    ) -> Result<Option<String>> {
        let resp = self
            .send_request(
                DapCommand::ReadMemory,
                json!({
                    "memoryReference": memory_reference,
                    "offset": offset,
                    "count": count,
                }),
            )
            .await?;
        Ok(resp
            .body
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    /// Writes memory to the debuggee.
    pub async fn write_memory(
        &self,
        memory_reference: &str,
        offset: i64,
        data: &str,
    ) -> Result<()> {
        self.send_request(
            DapCommand::WriteMemory,
            json!({
                "memoryReference": memory_reference,
                "offset": offset,
                "data": data,
            }),
        )
        .await?;
        Ok(())
    }

    /// Cancels a pending request.
    pub async fn cancel(&self, request_id: Option<i64>, progress_id: Option<&str>) -> Result<()> {
        let mut args = json!({});
        if let Some(rid) = request_id {
            args["requestId"] = json!(rid);
        }
        if let Some(pid) = progress_id {
            args["progressId"] = json!(pid);
        }
        let _ = self.send_request(DapCommand::Cancel, args).await;
        Ok(())
    }

    /// Disconnects from the debug adapter.
    pub async fn disconnect(&self) -> Result<()> {
        let _ = self
            .send_request(DapCommand::Disconnect, json!({"terminateDebuggee": true}))
            .await;

        if let Some(task) = self.recv_task.lock().await.take() {
            task.abort();
        }
        Ok(())
    }

    /// Registers a callback to handle events from the debug adapter.
    pub async fn on_event(&self, handler: impl Fn(DapEvent) + Send + Sync + 'static) {
        *self.event_handler.lock().await = Some(Box::new(handler));
    }

    /// Returns a snapshot of the adapter's capabilities.
    pub async fn capabilities(&self) -> Capabilities {
        self.capabilities.lock().await.clone()
    }
}
