//! LSP client that manages communication with a language server process.
//!
//! [`LspClient`] spawns a language server, performs the initialization
//! handshake, and exposes async methods for all common LSP requests and
//! notifications defined in the 3.17 specification.

use std::str::FromStr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use lsp_types::{
    ClientCapabilities, ClientInfo, CodeActionContext, CodeActionOrCommand, CodeActionParams,
    CompletionParams, CompletionResponse, Diagnostic, DidChangeTextDocumentParams,
    DidCloseTextDocumentParams, DidOpenTextDocumentParams, DidSaveTextDocumentParams,
    DocumentFormattingParams, DocumentSymbolParams, DocumentSymbolResponse, FormattingOptions,
    GotoDefinitionParams, GotoDefinitionResponse, Hover, HoverParams, InitializeParams,
    InitializeResult, InitializedParams, InlayHint, InlayHintParams, Location, PartialResultParams,
    ReferenceContext, ReferenceParams, RenameParams, ServerCapabilities, SignatureHelp,
    SignatureHelpParams, SymbolInformation, TextDocumentContentChangeEvent, TextDocumentIdentifier,
    TextDocumentItem, TextDocumentPositionParams, TextEdit, Uri, VersionedTextDocumentIdentifier,
    WorkDoneProgressParams, WorkspaceEdit, WorkspaceSymbolParams,
};
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::capabilities::ServerCaps;
use crate::transport::{JsonRpcMessage, LspTransport, RequestId};

/// Callback type for handling server-sent notifications.
pub type NotificationHandler = Arc<dyn Fn(String, Value) + Send + Sync>;

/// An LSP client connected to a running language server process.
pub struct LspClient {
    transport: Arc<Mutex<LspTransport>>,
    next_id: AtomicI64,
    server_capabilities: Option<ServerCaps>,
    notification_handler: Option<NotificationHandler>,
    child: tokio::process::Child,
}

impl LspClient {
    /// Spawns a language server and completes the `initialize` / `initialized`
    /// handshake.
    ///
    /// # Arguments
    /// * `command` — executable name or path for the language server.
    /// * `args` — command-line arguments.
    /// * `root_uri` — workspace root URI (e.g. `"file:///home/user/project"`).
    pub async fn start(command: &str, args: &[&str], root_uri: &str) -> Result<Self> {
        let mut server_cmd = Command::new(command);
        server_cmd
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            server_cmd.creation_flags(0x0800_0000);
        }

        let mut child = server_cmd
            .spawn()
            .with_context(|| format!("failed to spawn language server: {command}"))?;

        let stdin = child.stdin.take().context("missing server stdin")?;
        let stdout = child.stdout.take().context("missing server stdout")?;
        let transport = Arc::new(Mutex::new(LspTransport::new(stdin, stdout)));

        let mut client = Self {
            transport,
            next_id: AtomicI64::new(1),
            server_capabilities: None,
            notification_handler: None,
            child,
        };

        let caps = client.initialize(root_uri).await?;
        client.server_capabilities = Some(ServerCaps::new(caps));

        client
            .send_notification(
                "initialized",
                Some(serde_json::to_value(InitializedParams {})?),
            )
            .await?;

        Ok(client)
    }

    /// Returns the negotiated server capabilities, if initialization completed.
    pub fn server_capabilities(&self) -> Option<&ServerCaps> {
        self.server_capabilities.as_ref()
    }

    /// Registers a handler for server-sent notifications.
    pub fn on_notification(&mut self, handler: impl Fn(String, Value) + Send + Sync + 'static) {
        self.notification_handler = Some(Arc::new(handler));
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    async fn initialize(&mut self, root_uri: &str) -> Result<ServerCapabilities> {
        #[allow(deprecated)]
        let params = InitializeParams {
            root_uri: Some(Uri::from_str(root_uri).context("invalid root_uri")?),
            capabilities: ClientCapabilities::default(),
            process_id: Some(std::process::id()),
            root_path: None,
            initialization_options: None,
            trace: None,
            workspace_folders: None,
            client_info: Some(ClientInfo {
                name: "sidex".to_owned(),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            }),
            locale: None,
            work_done_progress_params: WorkDoneProgressParams {
                work_done_token: None,
            },
        };

        let result = self
            .send_request("initialize", Some(serde_json::to_value(params)?))
            .await?;
        let init: InitializeResult =
            serde_json::from_value(result).context("failed to parse InitializeResult")?;
        Ok(init.capabilities)
    }

    /// Sends `shutdown` followed by `exit` and waits for the process.
    pub async fn shutdown(&mut self) -> Result<()> {
        let _ = self.send_request("shutdown", None).await;
        self.send_notification("exit", None).await?;
        self.child
            .wait()
            .await
            .context("failed waiting for server to exit")?;
        Ok(())
    }

    // ── Requests ───────────────────────────────────────────────────────

    /// `textDocument/completion`
    pub async fn completion(
        &self,
        uri: &str,
        position: lsp_types::Position,
    ) -> Result<CompletionResponse> {
        let params = CompletionParams {
            text_document_position: Self::text_document_position(uri, position)?,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
            context: None,
        };
        let result = self
            .send_request(
                "textDocument/completion",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        serde_json::from_value(result).context("failed to parse CompletionResponse")
    }

    /// `textDocument/hover`
    pub async fn hover(&self, uri: &str, position: lsp_types::Position) -> Result<Option<Hover>> {
        let params = HoverParams {
            text_document_position_params: Self::text_document_position(uri, position)?,
            work_done_progress_params: WorkDoneProgressParams::default(),
        };
        let result = self
            .send_request("textDocument/hover", Some(serde_json::to_value(params)?))
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        serde_json::from_value(result).context("failed to parse Hover")
    }

    /// `textDocument/definition`
    pub async fn goto_definition(
        &self,
        uri: &str,
        position: lsp_types::Position,
    ) -> Result<GotoDefinitionResponse> {
        let params = GotoDefinitionParams {
            text_document_position_params: Self::text_document_position(uri, position)?,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        };
        let result = self
            .send_request(
                "textDocument/definition",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        serde_json::from_value(result).context("failed to parse GotoDefinitionResponse")
    }

    /// `textDocument/references`
    pub async fn references(
        &self,
        uri: &str,
        position: lsp_types::Position,
    ) -> Result<Vec<Location>> {
        let params = ReferenceParams {
            text_document_position: Self::text_document_position(uri, position)?,
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
            context: ReferenceContext {
                include_declaration: true,
            },
        };
        let result = self
            .send_request(
                "textDocument/references",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        if result.is_null() {
            return Ok(vec![]);
        }
        serde_json::from_value(result).context("failed to parse references")
    }

    /// `textDocument/rename`
    pub async fn rename(
        &self,
        uri: &str,
        position: lsp_types::Position,
        new_name: &str,
    ) -> Result<Option<WorkspaceEdit>> {
        let params = RenameParams {
            text_document_position: Self::text_document_position(uri, position)?,
            new_name: new_name.to_owned(),
            work_done_progress_params: WorkDoneProgressParams::default(),
        };
        let result = self
            .send_request("textDocument/rename", Some(serde_json::to_value(params)?))
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        serde_json::from_value(result).context("failed to parse WorkspaceEdit")
    }

    /// `textDocument/formatting`
    pub async fn formatting(&self, uri: &str, options: FormattingOptions) -> Result<Vec<TextEdit>> {
        let params = DocumentFormattingParams {
            text_document: TextDocumentIdentifier::new(Uri::from_str(uri).context("invalid URI")?),
            options,
            work_done_progress_params: WorkDoneProgressParams::default(),
        };
        let result = self
            .send_request(
                "textDocument/formatting",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        if result.is_null() {
            return Ok(vec![]);
        }
        serde_json::from_value(result).context("failed to parse formatting edits")
    }

    /// `textDocument/codeAction`
    pub async fn code_action(
        &self,
        uri: &str,
        range: lsp_types::Range,
        diagnostics: Vec<Diagnostic>,
    ) -> Result<Vec<CodeActionOrCommand>> {
        let params = CodeActionParams {
            text_document: TextDocumentIdentifier::new(Uri::from_str(uri).context("invalid URI")?),
            range,
            context: CodeActionContext {
                diagnostics,
                only: None,
                trigger_kind: None,
            },
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        };
        let result = self
            .send_request(
                "textDocument/codeAction",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        if result.is_null() {
            return Ok(vec![]);
        }
        serde_json::from_value(result).context("failed to parse code actions")
    }

    /// `textDocument/signatureHelp`
    pub async fn signature_help(
        &self,
        uri: &str,
        position: lsp_types::Position,
    ) -> Result<Option<SignatureHelp>> {
        let params = SignatureHelpParams {
            text_document_position_params: Self::text_document_position(uri, position)?,
            work_done_progress_params: WorkDoneProgressParams::default(),
            context: None,
        };
        let result = self
            .send_request(
                "textDocument/signatureHelp",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        serde_json::from_value(result).context("failed to parse SignatureHelp")
    }

    /// `textDocument/documentSymbol`
    pub async fn document_symbols(&self, uri: &str) -> Result<DocumentSymbolResponse> {
        let params = DocumentSymbolParams {
            text_document: TextDocumentIdentifier::new(Uri::from_str(uri).context("invalid URI")?),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        };
        let result = self
            .send_request(
                "textDocument/documentSymbol",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        serde_json::from_value(result).context("failed to parse DocumentSymbolResponse")
    }

    /// `workspace/symbol`
    #[allow(deprecated)]
    pub async fn workspace_symbols(&self, query: &str) -> Result<Vec<SymbolInformation>> {
        let params = WorkspaceSymbolParams {
            query: query.to_owned(),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        };
        let result = self
            .send_request("workspace/symbol", Some(serde_json::to_value(params)?))
            .await?;
        if result.is_null() {
            return Ok(vec![]);
        }
        serde_json::from_value(result).context("failed to parse workspace symbols")
    }

    /// `textDocument/inlayHint`
    pub async fn inlay_hints(&self, uri: &str, range: lsp_types::Range) -> Result<Vec<InlayHint>> {
        let params = InlayHintParams {
            text_document: TextDocumentIdentifier::new(Uri::from_str(uri).context("invalid URI")?),
            range,
            work_done_progress_params: WorkDoneProgressParams::default(),
        };
        let result = self
            .send_request(
                "textDocument/inlayHint",
                Some(serde_json::to_value(params)?),
            )
            .await?;
        if result.is_null() {
            return Ok(vec![]);
        }
        serde_json::from_value(result).context("failed to parse inlay hints")
    }

    // ── Notifications ──────────────────────────────────────────────────

    /// `textDocument/didOpen`
    pub async fn did_open(
        &self,
        uri: &str,
        language_id: &str,
        version: i32,
        text: &str,
    ) -> Result<()> {
        let params = DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: Uri::from_str(uri).context("invalid URI")?,
                language_id: language_id.to_owned(),
                version,
                text: text.to_owned(),
            },
        };
        self.send_notification("textDocument/didOpen", Some(serde_json::to_value(params)?))
            .await
    }

    /// `textDocument/didChange`
    pub async fn did_change(
        &self,
        uri: &str,
        version: i32,
        changes: Vec<TextDocumentContentChangeEvent>,
    ) -> Result<()> {
        let params = DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier {
                uri: Uri::from_str(uri).context("invalid URI")?,
                version,
            },
            content_changes: changes,
        };
        self.send_notification(
            "textDocument/didChange",
            Some(serde_json::to_value(params)?),
        )
        .await
    }

    /// `textDocument/didSave`
    pub async fn did_save(&self, uri: &str, text: Option<String>) -> Result<()> {
        let params = DidSaveTextDocumentParams {
            text_document: TextDocumentIdentifier::new(Uri::from_str(uri).context("invalid URI")?),
            text,
        };
        self.send_notification("textDocument/didSave", Some(serde_json::to_value(params)?))
            .await
    }

    /// `textDocument/didClose`
    pub async fn did_close(&self, uri: &str) -> Result<()> {
        let params = DidCloseTextDocumentParams {
            text_document: TextDocumentIdentifier::new(Uri::from_str(uri).context("invalid URI")?),
        };
        self.send_notification("textDocument/didClose", Some(serde_json::to_value(params)?))
            .await
    }

    // ── Internals ──────────────────────────────────────────────────────

    /// Sends a raw JSON-RPC request and returns the result value.
    ///
    /// This is useful for engine modules that construct their own params.
    pub async fn raw_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        self.send_request(method, params).await
    }

    fn next_request_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn text_document_position(
        uri: &str,
        position: lsp_types::Position,
    ) -> Result<TextDocumentPositionParams> {
        Ok(TextDocumentPositionParams {
            text_document: TextDocumentIdentifier::new(Uri::from_str(uri).context("invalid URI")?),
            position,
        })
    }

    async fn send_request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = self.next_request_id();
        let msg = JsonRpcMessage::request(id, method, params);

        let mut transport = self.transport.lock().await;
        transport.send(&msg).await?;

        loop {
            let response = transport.recv().await?;
            match response {
                JsonRpcMessage::Response {
                    id: resp_id,
                    result,
                    error,
                    ..
                } if resp_id == RequestId::Number(id) => {
                    if let Some(err) = error {
                        bail!("LSP error {}: {}", err.code, err.message);
                    }
                    return Ok(result.unwrap_or(Value::Null));
                }
                JsonRpcMessage::Notification { method, params, .. } => {
                    if let Some(ref handler) = self.notification_handler {
                        handler(method, params.unwrap_or(Value::Null));
                    }
                }
                _ => {
                    log::debug!("ignoring unexpected message while waiting for response {id}");
                }
            }
        }
    }

    async fn send_notification(&self, method: &str, params: Option<Value>) -> Result<()> {
        let msg = JsonRpcMessage::notification(method, params);
        let mut transport = self.transport.lock().await;
        transport.send(&msg).await
    }
}
