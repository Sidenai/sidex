use crate::commands::extension_platform::ExtensionManifest;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::State;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

// ---------------------------------------------------------------------------
// tsserver process manager
// ---------------------------------------------------------------------------

struct TsServerProcess {
    child: Child,
    stdin: ChildStdin,
    reader: std::io::BufReader<std::process::ChildStdout>,
    seq: u32,
}

impl TsServerProcess {
    fn find_tsserver(workspace_folders: &[String]) -> Option<String> {
        for folder in workspace_folders {
            let p = std::path::Path::new(folder).join("node_modules/typescript/bin/tsserver");
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }

        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let candidates = [
            "node_modules/typescript/bin/tsserver",
            "../node_modules/typescript/bin/tsserver",
            "../../node_modules/typescript/bin/tsserver",
        ];
        for rel in &candidates {
            let p = cwd.join(rel);
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }

        let global_paths = [
            "/usr/local/lib/node_modules/typescript/bin/tsserver",
            "/opt/homebrew/lib/node_modules/typescript/bin/tsserver",
        ];
        for p in &global_paths {
            if std::path::Path::new(p).exists() {
                return Some(p.to_string());
            }
        }

        if let Ok(out) = std::process::Command::new("which").arg("tsserver").output() {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }

        None
    }

    fn spawn(workspace_folders: &[String]) -> Option<Self> {
        let tsserver_path = Self::find_tsserver(workspace_folders)?;

        let node_bin = std::env::var("SIDEX_NODE_BINARY").unwrap_or_else(|_| "node".to_string());

        let mut cmd = Command::new(&node_bin);
        cmd.arg(&tsserver_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = cmd
            .spawn()
            .map_err(|e| {
                log::error!("[tsserver] spawn failed: {e}");
                e
            })
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let reader = std::io::BufReader::with_capacity(256 * 1024, stdout);

        log::info!(
            "[tsserver] spawned (pid={}) via {node_bin} {tsserver_path}",
            child.id()
        );
        Some(Self {
            child,
            stdin,
            reader,
            seq: 0,
        })
    }

    /// tsserver reads plain newline-terminated JSON on stdin.
    fn send_notification(&mut self, command: &str, arguments: &str) {
        self.seq += 1;
        let seq = self.seq;
        let msg = format!(
            r#"{{"seq":{seq},"type":"request","command":"{command}","arguments":{arguments}}}"#
        );
        let _ = self.stdin.write_all(msg.as_bytes());
        let _ = self.stdin.write_all(b"\n");
        let _ = self.stdin.flush();
        log::debug!("[tsserver] sent notification {command} seq={seq}");
    }

    /// tsserver reads newline-terminated JSON on stdin, outputs Content-Length framed JSON on stdout.
    fn request_sync(&mut self, command: &str, arguments: &str) -> Option<String> {
        self.seq += 1;
        let seq = self.seq;
        let msg = format!(
            r#"{{"seq":{seq},"type":"request","command":"{command}","arguments":{arguments}}}"#
        );
        self.stdin.write_all(msg.as_bytes()).ok()?;
        self.stdin.write_all(b"\n").ok()?;
        self.stdin.flush().ok()?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);

        loop {
            if std::time::Instant::now() > deadline {
                log::warn!("[tsserver] TIMEOUT {command} seq={seq}");
                return None;
            }

            let mut content_length: usize = 0;
            loop {
                let mut header_line = String::new();
                match self.reader.read_line(&mut header_line) {
                    Ok(0) => {
                        log::warn!("[tsserver] EOF reading headers for {command}");
                        return None;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        log::warn!("[tsserver] header read error: {e}");
                        return None;
                    }
                }
                let line = header_line.trim_end_matches(['\r', '\n', ' ']);
                if line.is_empty() {
                    break;
                }
                if let Some(rest) = line.strip_prefix("Content-Length: ") {
                    content_length = rest.trim().parse().unwrap_or(0);
                }
            }

            if content_length == 0 {
                continue;
            }

            let mut body = vec![0u8; content_length];
            use std::io::Read;
            if self.reader.read_exact(&mut body).is_err() {
                log::warn!("[tsserver] failed to read {content_length} byte body");
                return None;
            }

            let body_str = String::from_utf8_lossy(&body).to_string();

            if body_str.contains(&format!(r#""request_seq":{seq}"#))
                || body_str.contains(&format!(r#""request_seq": {seq}"#))
            {
                return Some(body_str);
            }
            log::debug!("[tsserver] skip (not seq {seq})");
        }
    }
}

impl Drop for TsServerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

// ---------------------------------------------------------------------------
// Generic LSP client — JSON-RPC over stdin/stdout with Content-Length framing
// ---------------------------------------------------------------------------

struct LspServerProcess {
    child: Child,
    stdin: ChildStdin,
    reader: std::io::BufReader<std::process::ChildStdout>,
    req_id: u64,
    server_name: String,
    initialized: bool,
}

impl LspServerProcess {
    fn spawn(name: &str, cmd: &str, args: &[&str], root_uri: &str) -> Option<Self> {
        let mut command = Command::new(cmd);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = command
            .spawn()
            .map_err(|e| {
                log::error!("[lsp:{name}] spawn failed: {e}");
                e
            })
            .ok()?;

        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let reader = std::io::BufReader::with_capacity(256 * 1024, stdout);

        let mut proc = Self {
            child,
            stdin,
            reader,
            req_id: 0,
            server_name: name.to_string(),
            initialized: false,
        };

        let init_params = format!(
            r#"{{"processId":{},"rootUri":"{}","capabilities":{{"textDocument":{{"completion":{{"completionItem":{{"snippetSupport":true}}}},"hover":{{"contentFormat":["markdown","plaintext"]}},"signatureHelp":{{"signatureInformation":{{"parameterInformation":{{"labelOffsetSupport":true}}}}}}}},"workspace":{{"workspaceFolders":true}}}}}}"#,
            std::process::id(),
            root_uri,
        );

        let resp = proc.request_sync("initialize", &init_params)?;
        log::info!("[lsp:{name}] initialized: {}b response", resp.len());

        proc.send_notification("initialized", "{}");
        proc.initialized = true;

        Some(proc)
    }

    fn send_notification(&mut self, method: &str, params: &str) {
        let msg = format!(r#"{{"jsonrpc":"2.0","method":"{method}","params":{params}}}"#);
        let frame = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
        let _ = self.stdin.write_all(frame.as_bytes());
        let _ = self.stdin.flush();
    }

    fn request_sync(&mut self, method: &str, params: &str) -> Option<String> {
        self.req_id += 1;
        let id = self.req_id;
        let msg = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params}}}"#);
        let frame = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
        self.stdin.write_all(frame.as_bytes()).ok()?;
        self.stdin.flush().ok()?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let name = &self.server_name;

        loop {
            if std::time::Instant::now() > deadline {
                log::warn!("[lsp:{name}] timeout {method} id={id}");
                return None;
            }

            let mut content_length: usize = 0;
            loop {
                let mut header = String::new();
                match self.reader.read_line(&mut header) {
                    Ok(0) => return None,
                    Ok(_) => {}
                    Err(_) => return None,
                }
                let line = header.trim();
                if line.is_empty() {
                    break;
                }
                if let Some(rest) = line.strip_prefix("Content-Length: ") {
                    content_length = rest.trim().parse().unwrap_or(0);
                }
            }
            if content_length == 0 {
                continue;
            }

            let mut body = vec![0u8; content_length];
            use std::io::Read;
            if self.reader.read_exact(&mut body).is_err() {
                return None;
            }
            let body_str = String::from_utf8_lossy(&body).to_string();

            if body_str.contains(&format!(r#""id":{id}"#))
                || body_str.contains(&format!(r#""id": {id}"#))
            {
                return Some(body_str);
            }
        }
    }

    fn open_file(&mut self, uri: &str, language_id: &str, text: &str) {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t");
        let params = format!(
            r#"{{"textDocument":{{"uri":"{}","languageId":"{}","version":1,"text":"{}"}}}}"#,
            uri.replace('"', "\\\""),
            language_id,
            escaped,
        );
        self.send_notification("textDocument/didOpen", &params);
    }
}

impl Drop for LspServerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        log::info!("[lsp:{}] killed", self.server_name);
    }
}

/// Find a binary on PATH or common install locations
fn find_binary(name: &str, extra_paths: &[&str]) -> Option<String> {
    if let Ok(out) = std::process::Command::new("which").arg(name).output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    for p in extra_paths {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    None
}

#[allow(unsafe_code, clippy::all, unused)]
mod wit_bindings {
    wasmtime::component::bindgen!({
        world: "sidex-extension",
        path: "wit/world.wit",
    });
}

use wit_bindings::sidex::extension::common_types as wit_types;
use wit_bindings::SidexExtension;

// ---------------------------------------------------------------------------
// Host state — the data accessible to WASM extensions via host imports
// ---------------------------------------------------------------------------

struct WasmHostState {
    table: ResourceTable,
    wasi_ctx: WasiCtx,
    documents: HashMap<String, DocumentData>,
    workspace_folders: Vec<String>,
    workspace_name: Option<String>,
    configuration: HashMap<String, HashMap<String, String>>,
    diagnostics: HashMap<String, Vec<wit_types::Diagnostic>>,
    status_bar_items: HashMap<String, wit_types::StatusBarItem>,
    status_bar_messages: HashMap<u64, String>,
    next_status_bar_handle: u64,
    log_buffer: Vec<String>,
    output_channels: HashMap<String, Vec<String>>,
    tsserver: Option<TsServerProcess>,
    tsserver_open_files: std::collections::HashSet<String>,
    lsp_servers: HashMap<String, LspServerProcess>,
    lsp_open_files: HashMap<String, std::collections::HashSet<String>>,
    extension_id: String,
    extension_path: String,
    extension_version: String,
    // Storage (in-memory)
    storage: HashMap<String, String>,
    global_storage: HashMap<String, String>,
    workspace_state: HashMap<String, String>,
    secrets: HashMap<String, String>,
    decoration_types: HashMap<u64, wit_types::DecorationRenderOptions>,
    next_decoration_handle: u64,
    scm_handles: HashMap<u64, ScmSourceControl>,
    next_scm_handle: u64,
    active_editor_uri: Option<String>,
    active_editor_language_id: Option<String>,
    progress_tasks: HashMap<String, ProgressTask>,
    test_controllers: HashMap<u64, TestController>,
    next_test_handle: u64,
    test_runs: HashMap<u64, TestRun>,
    next_run_handle: u64,
    notebook_handles: HashMap<u64, String>,
    next_notebook_handle: u64,
    task_providers: HashMap<u64, String>,
    next_task_handle: u64,
    debug_adapters: HashMap<u64, String>,
    next_debug_handle: u64,
    lang_config_handles: HashMap<u64, wit_types::LanguageConfiguration>,
    next_lang_config_handle: u64,
}

struct ScmSourceControl {
    id: String,
    label: String,
    root_uri: Option<String>,
    input_box_value: String,
    count: u32,
}

struct ProgressTask {
    message: Option<String>,
    increment: f64,
    cancelled: bool,
}

struct TestController {
    id: String,
    label: String,
    items: Vec<wit_types::TestItem>,
}

struct TestRun {
    controller_handle: u64,
    name: Option<String>,
    results: Vec<wit_types::TestResult>,
}

struct DocumentData {
    text: String,
    language_id: String,
}

impl WasiView for WasmHostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi_ctx,
            table: &mut self.table,
        }
    }
}

impl WasmHostState {
    fn new() -> Self {
        let wasi_ctx = WasiCtxBuilder::new()
            .inherit_stdout()
            .inherit_stderr()
            .build();
        Self {
            table: ResourceTable::new(),
            wasi_ctx,
            documents: HashMap::new(),
            workspace_folders: Vec::new(),
            workspace_name: None,
            configuration: HashMap::new(),
            diagnostics: HashMap::new(),
            status_bar_items: HashMap::new(),
            status_bar_messages: HashMap::new(),
            next_status_bar_handle: 1,
            log_buffer: Vec::new(),
            output_channels: HashMap::new(),
            tsserver: None,
            tsserver_open_files: std::collections::HashSet::new(),
            lsp_servers: HashMap::new(),
            lsp_open_files: HashMap::new(),
            extension_id: String::new(),
            extension_path: String::new(),
            extension_version: String::new(),
            storage: HashMap::new(),
            global_storage: HashMap::new(),
            workspace_state: HashMap::new(),
            secrets: HashMap::new(),
            decoration_types: HashMap::new(),
            next_decoration_handle: 1,
            scm_handles: HashMap::new(),
            next_scm_handle: 1,
            active_editor_uri: None,
            active_editor_language_id: None,
            progress_tasks: HashMap::new(),
            test_controllers: HashMap::new(),
            next_test_handle: 1,
            test_runs: HashMap::new(),
            next_run_handle: 1,
            notebook_handles: HashMap::new(),
            next_notebook_handle: 1,
            task_providers: HashMap::new(),
            next_task_handle: 1,
            debug_adapters: HashMap::new(),
            next_debug_handle: 1,
            lang_config_handles: HashMap::new(),
            next_lang_config_handle: 1,
        }
    }
}

impl wit_bindings::sidex::extension::host_api::Host for WasmHostState {
    fn log_info(&mut self, message: String) {
        log::info!("[wasm-ext] {message}");
        self.log_buffer.push(format!("[info] {message}"));
    }

    fn log_warn(&mut self, message: String) {
        log::warn!("[wasm-ext] {message}");
        self.log_buffer.push(format!("[warn] {message}"));
    }

    fn log_error(&mut self, message: String) {
        log::error!("[wasm-ext] {message}");
        self.log_buffer.push(format!("[error] {message}"));
    }

    fn show_info_message(&mut self, message: String) {
        log::info!("[wasm-ext][notification] {message}");
    }

    fn show_warn_message(&mut self, message: String) {
        log::warn!("[wasm-ext][notification] {message}");
    }

    fn show_error_message(&mut self, message: String) {
        log::error!("[wasm-ext][notification] {message}");
    }

    fn output_channel_append(&mut self, channel: String, text: String) {
        log::info!("[wasm-ext][{channel}] {text}");
    }

    fn publish_diagnostics(&mut self, uri: String, diagnostics: Vec<wit_types::Diagnostic>) {
        self.diagnostics.insert(uri, diagnostics);
    }

    fn clear_diagnostics(&mut self, uri: String) {
        self.diagnostics.remove(&uri);
    }

    fn get_workspace_folders(&mut self) -> Vec<String> {
        self.workspace_folders.clone()
    }

    fn get_configuration(&mut self, section: String, key: String) -> Option<String> {
        self.configuration
            .get(&section)
            .and_then(|s| s.get(&key))
            .cloned()
    }

    fn find_files(&mut self, pattern: String, max_results: u32) -> Vec<String> {
        let mut results = Vec::new();
        // Extract file extension from glob pattern like "**/*.css"
        let ext_match = if let Some(star_dot) = pattern.rfind("*.") {
            Some(pattern[star_dot + 1..].to_string())
        } else {
            None
        };

        for folder in &self.workspace_folders {
            let walker = walkdir::WalkDir::new(folder)
                .max_depth(10)
                .into_iter()
                .flatten();
            for entry in walker {
                if results.len() >= max_results as usize {
                    break;
                }
                let path = entry.path();
                if path.is_file() {
                    let name = path.to_string_lossy();
                    let matched = if pattern == "**/*" {
                        true
                    } else if let Some(ref ext) = ext_match {
                        name.ends_with(ext)
                    } else {
                        name.contains(&pattern)
                    };
                    if matched {
                        results.push(name.to_string());
                    }
                }
            }
        }
        results
    }

    fn read_file(&mut self, uri: String) -> Result<String, String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        std::fs::read_to_string(path).map_err(|e| {
            log::warn!("[wasm-host] read_file failed for {path}: {e}");
            e.to_string()
        })
    }

    fn read_file_bytes(&mut self, uri: String) -> Result<Vec<u8>, String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        std::fs::read(path).map_err(|e| e.to_string())
    }

    fn write_file(&mut self, uri: String, content: String) -> Result<(), String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        std::fs::write(path, content).map_err(|e| e.to_string())
    }

    fn stat_file(&mut self, uri: String) -> Result<wit_types::FileStat, String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        use std::time::UNIX_EPOCH;
        let ctime = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let file_type = if meta.is_dir() {
            2
        } else if meta.is_symlink() {
            64
        } else {
            1
        };
        Ok(wit_types::FileStat {
            file_type,
            size: meta.len(),
            ctime,
            mtime,
        })
    }

    fn list_dir(&mut self, uri: String) -> Result<Vec<String>, String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
        Ok(entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect())
    }

    fn get_document_text(&mut self, uri: String) -> Option<String> {
        self.documents.get(&uri).map(|d| d.text.clone())
    }

    fn get_document_language(&mut self, uri: String) -> Option<String> {
        self.documents.get(&uri).map(|d| d.language_id.clone())
    }

    fn register_command(&mut self, _id: String) {}

    fn execute_command(&mut self, id: String, args: String) -> Result<String, String> {
        if id == "__sidex.tsserver" {
            return self.execute_tsserver_command(&args);
        }
        if id == "__sidex.lsp" {
            return self.execute_lsp_command(&args);
        }
        Err(format!("command not implemented: {id}"))
    }

    fn apply_workspace_edit(&mut self, _edit: wit_types::WorkspaceEdit) -> Result<(), String> {
        Ok(())
    }

    fn show_text_document(&mut self, _uri: String) {}

    fn set_status_bar_item(&mut self, item: wit_types::StatusBarItem) {
        self.status_bar_items.insert(item.id.clone(), item);
    }

    fn remove_status_bar_item(&mut self, id: String) {
        self.status_bar_items.remove(&id);
    }

    fn watch_files(&mut self, _pattern: String) -> Result<u64, String> {
        Ok(0)
    }

    fn unwatch_files(&mut self, _watch_id: u64) {}

    // ── Logging ──────────────────────────────────────────────────────────────

    fn show_info_message_with_actions(&mut self, message: String, actions: Vec<wit_types::NotificationAction>) -> Option<String> {
        log::info!("[wasm-ext][notification] {message}");
        actions.first().map(|a| a.title.clone())
    }
    fn show_warn_message_with_actions(&mut self, message: String, actions: Vec<wit_types::NotificationAction>) -> Option<String> {
        log::warn!("[wasm-ext][notification] {message}");
        actions.first().map(|a| a.title.clone())
    }
    fn show_error_message_with_actions(&mut self, message: String, actions: Vec<wit_types::NotificationAction>) -> Option<String> {
        log::error!("[wasm-ext][notification] {message}");
        actions.first().map(|a| a.title.clone())
    }
    fn output_channel_append_line(&mut self, channel: String, text: String) {
        log::info!("[wasm-ext][{channel}] {text}");
        self.output_channels.entry(channel).or_default().push(text);
    }
    fn output_channel_clear(&mut self, channel: String) {
        self.output_channels.remove(&channel);
    }
    fn output_channel_show(&mut self, channel: String, _preserve_focus: bool) {
        log::info!("[wasm-ext] show output channel: {channel}");
    }

    // ── Diagnostics ──────────────────────────────────────────────────────────

    fn clear_all_diagnostics(&mut self) {
        self.diagnostics.clear();
    }

    // ── Workspace ────────────────────────────────────────────────────────────

    fn get_workspace_name(&mut self) -> Option<String> { self.workspace_name.clone() }
    fn get_configuration_section(&mut self, section: String) -> Vec<(String, String)> {
        self.configuration.get(&section).map(|m| m.iter().map(|(k,v)|(k.clone(),v.clone())).collect()).unwrap_or_default()
    }
    fn update_configuration(&mut self, section: String, key: String, value: String, _global: bool) -> Result<(), String> {
        self.configuration.entry(section).or_default().insert(key, value);
        Ok(())
    }
    fn find_files_with_exclude(&mut self, include_pattern: String, _exclude_pattern: String, max_results: u32) -> Vec<String> {
        self.find_files(include_pattern, max_results)
    }
    fn open_text_document(&mut self, uri: String) -> Result<String, String> {
        self.read_file(uri.clone())?;
        Ok(uri)
    }
    fn open_text_document_with_content(&mut self, content: String, language_id: String) -> Result<String, String> {
        let uri = format!("untitled:///{}", uuid::Uuid::new_v4());
        self.documents.insert(uri.clone(), DocumentData { text: content, language_id });
        Ok(uri)
    }
    fn save_text_document(&mut self, uri: String) -> Result<bool, String> {
        if let Some(doc) = self.documents.get(&uri) {
            let path = uri.strip_prefix("file://").unwrap_or(&uri);
            std::fs::write(path, &doc.text).map_err(|e| e.to_string())?;
            return Ok(true);
        }
        Ok(false)
    }
    fn save_all_text_documents(&mut self) -> Result<bool, String> {
        let uris: Vec<String> = self.documents.keys().cloned().collect();
        for uri in uris { self.save_text_document(uri)?; }
        Ok(true)
    }
    fn apply_workspace_edit_entries(&mut self, entries: Vec<wit_types::WorkspaceEditEntry>) -> Result<bool, String> {
        for entry in &entries {
            let path = entry.uri.strip_prefix("file://").unwrap_or(&entry.uri);
            if entry.kind == wit_types::WorkspaceEditKind::CreateFile {
                if let Some(ref opts) = entry.create_options {
                    if !opts.overwrite && std::path::Path::new(path).exists() { continue; }
                }
                std::fs::write(path, "").map_err(|e| e.to_string())?;
            } else if entry.kind == wit_types::WorkspaceEditKind::DeleteFile {
                if let Some(ref opts) = entry.delete_options {
                    if opts.recursive { let _ = std::fs::remove_dir_all(path); }
                    else { let _ = std::fs::remove_file(path); }
                } else { let _ = std::fs::remove_file(path); }
            } else if entry.kind == wit_types::WorkspaceEditKind::RenameFile {
                if let Some(ref new_uri) = entry.new_uri {
                    let new_path = new_uri.strip_prefix("file://").unwrap_or(new_uri);
                    std::fs::rename(path, new_path).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(true)
    }
    fn create_file_system_watcher(&mut self, _glob_pattern: String) -> Result<u64, String> { Ok(0) }
    fn on_did_create_files(&mut self, uris: Vec<String>) { log::info!("[wasm-ext] files created: {:?}", uris); }
    fn on_did_rename_files(&mut self, old_uris: Vec<String>, new_uris: Vec<String>) { log::info!("[wasm-ext] files renamed: {:?} -> {:?}", old_uris, new_uris); }
    fn on_did_delete_files(&mut self, uris: Vec<String>) { log::info!("[wasm-ext] files deleted: {:?}", uris); }
    fn get_workspace_state(&mut self, key: String) -> Option<String> { self.workspace_state.get(&key).cloned() }
    fn set_workspace_state(&mut self, key: String, value: String) -> Result<(), String> { self.workspace_state.insert(key, value); Ok(()) }
    fn get_global_state(&mut self, key: String) -> Option<String> { self.global_storage.get(&key).cloned() }
    fn set_global_state(&mut self, key: String, value: String) -> Result<(), String> { self.global_storage.insert(key, value); Ok(()) }

    // ── File system ──────────────────────────────────────────────────────────

    fn write_file_bytes(&mut self, uri: String, content: Vec<u8>) -> Result<(), String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        std::fs::write(path, content).map_err(|e| e.to_string())
    }
    fn delete_file(&mut self, uri: String, recursive: bool) -> Result<(), String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        let p = std::path::Path::new(path);
        if p.is_dir() && recursive { std::fs::remove_dir_all(path).map_err(|e| e.to_string()) }
        else if p.is_dir() { std::fs::remove_dir(path).map_err(|e| e.to_string()) }
        else { std::fs::remove_file(path).map_err(|e| e.to_string()) }
    }
    fn rename_file(&mut self, old_uri: String, new_uri: String, _overwrite: bool) -> Result<(), String> {
        let old = old_uri.strip_prefix("file://").unwrap_or(&old_uri);
        let new = new_uri.strip_prefix("file://").unwrap_or(&new_uri);
        std::fs::rename(old, new).map_err(|e| e.to_string())
    }
    fn copy_file(&mut self, source: String, dest: String, _overwrite: bool) -> Result<(), String> {
        let s = source.strip_prefix("file://").unwrap_or(&source);
        let d = dest.strip_prefix("file://").unwrap_or(&dest);
        std::fs::copy(s, d).map(|_| ()).map_err(|e| e.to_string())
    }
    fn create_directory(&mut self, uri: String) -> Result<(), String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        std::fs::create_dir_all(path).map_err(|e| e.to_string())
    }
    fn list_dir_with_types(&mut self, uri: String) -> Result<Vec<(String, u32)>, String> {
        let path = uri.strip_prefix("file://").unwrap_or(&uri);
        let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
        Ok(entries.flatten().map(|e| {
            let ft = if e.path().is_dir() { 2u32 } else if e.path().is_symlink() { 64u32 } else { 1u32 };
            (e.file_name().to_string_lossy().to_string(), ft)
        }).collect())
    }

    // ── Document access ──────────────────────────────────────────────────────

    fn get_document_version(&mut self, uri: String) -> Option<u32> {
        self.documents.get(&uri).map(|_| 1)
    }
    fn get_document_line_count(&mut self, uri: String) -> Option<u32> {
        self.documents.get(&uri).map(|d| d.text.lines().count() as u32)
    }
    fn get_document_is_dirty(&mut self, _uri: String) -> bool { false }
    fn get_document_is_untitled(&mut self, uri: String) -> bool {
        uri.starts_with("untitled://")
    }
    fn get_all_open_document_uris(&mut self) -> Vec<String> {
        self.documents.keys().cloned().collect()
    }

    // ── Window / editor ──────────────────────────────────────────────────────

    fn get_active_text_editor_uri(&mut self) -> Option<String> { self.active_editor_uri.clone() }
    fn get_active_text_editor_selection(&mut self) -> Option<wit_types::Range> { None }
    fn get_active_text_editor_selections(&mut self) -> Vec<wit_types::Range> { vec![] }
    fn get_active_text_editor_visible_ranges(&mut self) -> Vec<wit_types::Range> { vec![] }
    fn get_active_text_editor_language_id(&mut self) -> Option<String> { self.active_editor_language_id.clone() }
    fn get_active_text_editor_view_column(&mut self) -> Option<u32> { Some(1) }
    fn get_visible_text_editors(&mut self) -> Vec<String> {
        self.active_editor_uri.iter().cloned().collect()
    }
    fn set_text_editor_selection(&mut self, _uri: String, _selection: wit_types::Range) -> Result<(), String> { Ok(()) }
    fn set_text_editor_selections(&mut self, _uri: String, _selections: Vec<wit_types::Range>) -> Result<(), String> { Ok(()) }
    fn reveal_range(&mut self, _uri: String, _r: wit_types::Range, _reveal_type: u32) -> Result<(), String> { Ok(()) }
    fn insert_snippet(&mut self, uri: String, snippet: String, _range: Option<wit_types::Range>) -> Result<(), String> {
        log::info!("[wasm-ext] insert_snippet in {uri}: {snippet}");
        Ok(())
    }

    // ── Window UI ────────────────────────────────────────────────────────────

    fn show_input_box(&mut self, options: wit_types::InputBoxOptions) -> Option<String> {
        log::info!("[wasm-ext] show_input_box: {:?}", options.prompt);
        options.value.clone()
    }
    fn show_quick_pick(&mut self, items: Vec<wit_types::QuickPickItem>, _options: wit_types::QuickPickOptions) -> Vec<wit_types::QuickPickItem> {
        items.into_iter().filter(|i| i.picked).collect()
    }
    fn show_open_dialog(&mut self, _options: wit_types::OpenDialogOptions) -> Vec<String> { vec![] }
    fn show_save_dialog(&mut self, _options: wit_types::SaveDialogOptions) -> Option<String> { None }
    fn set_status_bar_message(&mut self, text: String, _timeout_ms: Option<u32>) -> u64 {
        let h = self.next_status_bar_handle;
        self.next_status_bar_handle += 1;
        self.status_bar_messages.insert(h, text);
        h
    }
    fn clear_status_bar_message(&mut self, handle: u64) { self.status_bar_messages.remove(&handle); }
    fn with_progress(&mut self, _options: wit_types::ProgressOptions, task_id: String) {
        self.progress_tasks.insert(task_id, ProgressTask { message: None, increment: 0.0, cancelled: false });
    }
    fn report_progress(&mut self, task_id: String, increment: Option<f64>, message: Option<String>) {
        if let Some(t) = self.progress_tasks.get_mut(&task_id) {
            if let Some(inc) = increment { t.increment += inc; }
            if message.is_some() { t.message = message; }
        }
    }
    fn complete_progress(&mut self, task_id: String) { self.progress_tasks.remove(&task_id); }
    fn get_window_state(&mut self) -> wit_types::WindowState { wit_types::WindowState { focused: true } }
    fn open_external_uri(&mut self, uri: String) -> Result<bool, String> {
        log::info!("[wasm-ext] open_external_uri: {uri}");
        Ok(true)
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    fn register_text_editor_command(&mut self, _id: String) {}
    fn unregister_command(&mut self, _id: String) {}
    fn execute_built_in_command(&mut self, id: String, args: String) -> Result<String, String> {
        log::info!("[wasm-ext] execute_built_in_command: {id} args={args}");
        Ok("{}".to_string())
    }
    fn get_all_commands(&mut self, _filter_internal: bool) -> Vec<String> { vec![] }

    // ── Editor actions ───────────────────────────────────────────────────────

    fn show_text_document_at(&mut self, uri: String, _range: wit_types::Range, _preview: bool) -> Result<(), String> {
        log::info!("[wasm-ext] show_text_document_at: {uri}");
        Ok(())
    }
    fn diff_editor_open(&mut self, original: String, modified: String, title: String) -> Result<(), String> {
        log::info!("[wasm-ext] diff_editor_open: {original} vs {modified} ({title})");
        Ok(())
    }
    fn close_active_editor(&mut self) -> Result<(), String> { Ok(()) }

    // ── Decorations ──────────────────────────────────────────────────────────

    fn create_decoration_type(&mut self, options: wit_types::DecorationRenderOptions) -> u64 {
        let h = self.next_decoration_handle;
        self.next_decoration_handle += 1;
        self.decoration_types.insert(h, options);
        h
    }
    fn set_decorations(&mut self, _editor_uri: String, _type_id: u64, _decorations: Vec<wit_types::DecorationInstance>) -> Result<(), String> { Ok(()) }
    fn delete_decoration_type(&mut self, type_id: u64) { self.decoration_types.remove(&type_id); }

    // ── Languages ────────────────────────────────────────────────────────────

    fn register_language_configuration(&mut self, config: wit_types::LanguageConfiguration) -> Result<u64, String> {
        let h = self.next_lang_config_handle;
        self.next_lang_config_handle += 1;
        self.lang_config_handles.insert(h, config);
        Ok(h)
    }
    fn unregister_language_configuration(&mut self, handle: u64) { self.lang_config_handles.remove(&handle); }
    fn get_languages(&mut self) -> Vec<String> {
        vec!["plaintext".to_string(),"typescript".to_string(),"javascript".to_string(),"rust".to_string(),"python".to_string(),"go".to_string(),"css".to_string(),"html".to_string(),"json".to_string()]
    }
    fn change_document_language(&mut self, uri: String, language_id: String) -> Result<(), String> {
        if let Some(doc) = self.documents.get_mut(&uri) { doc.language_id = language_id; }
        Ok(())
    }

    // ── SCM ──────────────────────────────────────────────────────────────────

    fn scm_create_source_control(&mut self, id: String, label: String, root_uri: Option<String>) -> Result<u64, String> {
        let h = self.next_scm_handle;
        self.next_scm_handle += 1;
        self.scm_handles.insert(h, ScmSourceControl { id, label, root_uri, input_box_value: String::new(), count: 0 });
        Ok(h)
    }
    fn scm_dispose(&mut self, handle: u64) { self.scm_handles.remove(&handle); }
    fn scm_set_count(&mut self, handle: u64, count: u32) {
        if let Some(s) = self.scm_handles.get_mut(&handle) { s.count = count; }
    }
    fn scm_set_commit_template(&mut self, _handle: u64, _template: String) {}
    fn scm_get_input_box_value(&mut self, handle: u64) -> String {
        self.scm_handles.get(&handle).map(|s| s.input_box_value.clone()).unwrap_or_default()
    }
    fn scm_set_input_box_value(&mut self, handle: u64, value: String) {
        if let Some(s) = self.scm_handles.get_mut(&handle) { s.input_box_value = value; }
    }
    fn scm_set_resource_groups(&mut self, _handle: u64, _groups: Vec<(String, Vec<wit_types::ScmResource>)>) -> Result<(), String> { Ok(()) }
    fn scm_create_resource_group(&mut self, _handle: u64, _id: String, _label: String) -> Result<u64, String> {
        let h = self.next_scm_handle;
        self.next_scm_handle += 1;
        Ok(h)
    }
    fn scm_dispose_resource_group(&mut self, _group_handle: u64) {}

    // ── Tasks ────────────────────────────────────────────────────────────────

    fn register_task_provider(&mut self, task_type: String) -> Result<u64, String> {
        let h = self.next_task_handle;
        self.next_task_handle += 1;
        self.task_providers.insert(h, task_type);
        Ok(h)
    }
    fn unregister_task_provider(&mut self, handle: u64) { self.task_providers.remove(&handle); }
    fn execute_task(&mut self, task: wit_types::TaskExecution) -> Result<u64, String> {
        log::info!("[wasm-ext] execute_task: {}", task.name);
        Ok(0)
    }
    fn terminate_task_execution(&mut self, _execution_id: u64) -> Result<(), String> { Ok(()) }
    fn fetch_tasks(&mut self, _filter_type: Option<String>) -> Vec<wit_types::TaskExecution> { vec![] }

    // ── Debug ────────────────────────────────────────────────────────────────

    fn register_debug_adapter_descriptor(&mut self, debug_type: String, executable: String, args: Vec<String>) -> Result<u64, String> {
        let h = self.next_debug_handle;
        self.next_debug_handle += 1;
        self.debug_adapters.insert(h, format!("{debug_type}:{executable}:{}", args.join(",")));
        Ok(h)
    }
    fn unregister_debug_adapter_descriptor(&mut self, handle: u64) { self.debug_adapters.remove(&handle); }
    fn start_debug_session(&mut self, options: wit_types::DebugSessionOptions) -> Result<u64, String> {
        log::info!("[wasm-ext] start_debug_session: {}", options.name);
        Ok(0)
    }
    fn stop_debug_session(&mut self, _session_id: u64) -> Result<(), String> { Ok(()) }
    fn add_breakpoints(&mut self, breakpoints: Vec<wit_types::SourceBreakpoint>) -> Result<(), String> {
        log::info!("[wasm-ext] add_breakpoints: {} bps", breakpoints.len());
        Ok(())
    }
    fn remove_breakpoints(&mut self, _ids: Vec<String>) -> Result<(), String> { Ok(()) }
    fn get_breakpoints(&mut self) -> Vec<wit_types::SourceBreakpoint> { vec![] }

    // ── Environment ──────────────────────────────────────────────────────────

    fn env_app_name(&mut self) -> String { "SideX".to_string() }
    fn env_app_root(&mut self) -> String {
        std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_string_lossy().to_string())).unwrap_or_default()
    }
    fn env_language(&mut self) -> String { "en".to_string() }
    fn env_machine_id(&mut self) -> String {
        hostname::get().ok().map(|h| h.to_string_lossy().to_string()).unwrap_or_else(|| "unknown".to_string())
    }
    fn env_session_id(&mut self) -> String { uuid::Uuid::new_v4().to_string() }
    fn env_clipboard_read_text(&mut self) -> Result<String, String> { Ok(String::new()) }
    fn env_clipboard_write_text(&mut self, text: String) -> Result<(), String> {
        log::info!("[wasm-ext] clipboard write: {} chars", text.len());
        Ok(())
    }
    fn env_shell(&mut self) -> Option<String> {
        std::env::var("SHELL").ok()
    }
    fn env_remote_name(&mut self) -> Option<String> { None }
    fn env_is_new_app_install(&mut self) -> bool { false }

    // ── Extensions ───────────────────────────────────────────────────────────

    fn get_extension_id(&mut self) -> String { self.extension_id.clone() }
    fn get_extension_path(&mut self) -> String { self.extension_path.clone() }
    fn get_extension_version(&mut self) -> String { self.extension_version.clone() }
    fn get_extension_global_storage_path(&mut self) -> String {
        dirs::data_local_dir().map(|d| d.join("sidex").join("global-storage").join(&self.extension_id).to_string_lossy().to_string()).unwrap_or_default()
    }
    fn get_extension_workspace_storage_path(&mut self) -> String {
        dirs::data_local_dir().map(|d| d.join("sidex").join("workspace-storage").join(&self.extension_id).to_string_lossy().to_string()).unwrap_or_default()
    }
    fn get_extension_log_path(&mut self) -> String {
        dirs::data_local_dir().map(|d| d.join("sidex").join("logs").join(&self.extension_id).to_string_lossy().to_string()).unwrap_or_default()
    }
    fn is_extension_active(&mut self, _extension_id: String) -> bool { false }
    fn get_extension_exports(&mut self, _extension_id: String) -> Option<String> { None }
    fn extension_storage_get(&mut self, key: String) -> Option<String> { self.storage.get(&key).cloned() }
    fn extension_storage_set(&mut self, key: String, value: String) -> Result<(), String> { self.storage.insert(key, value); Ok(()) }
    fn extension_storage_delete(&mut self, key: String) -> Result<(), String> { self.storage.remove(&key); Ok(()) }
    fn extension_secrets_get(&mut self, key: String) -> Result<Option<String>, String> { Ok(self.secrets.get(&key).cloned()) }
    fn extension_secrets_store(&mut self, key: String, value: String) -> Result<(), String> { self.secrets.insert(key, value); Ok(()) }
    fn extension_secrets_delete(&mut self, key: String) -> Result<(), String> { self.secrets.remove(&key); Ok(()) }

    // ── Notebooks ────────────────────────────────────────────────────────────

    fn notebook_open_document(&mut self, uri: String) -> Result<u64, String> {
        let h = self.next_notebook_handle;
        self.next_notebook_handle += 1;
        self.notebook_handles.insert(h, uri);
        Ok(h)
    }
    fn notebook_close_document(&mut self, handle: u64) -> Result<(), String> {
        self.notebook_handles.remove(&handle);
        Ok(())
    }
    fn notebook_get_cells(&mut self, _handle: u64) -> Vec<wit_types::NotebookCell> { vec![] }
    fn notebook_execute_cell(&mut self, notebook_uri: u64, cell_index: u32) -> Result<wit_types::NotebookCellOutput, String> {
        log::info!("[wasm-ext] notebook_execute_cell: handle={notebook_uri}[{cell_index}]");
        Ok(wit_types::NotebookCellOutput { items: vec![] })
    }
    fn notebook_apply_edit(&mut self, _handle: u64, _cell_index: u32, _new_value: String) -> Result<(), String> { Ok(()) }
    fn notebook_insert_cell(&mut self, _handle: u64, _index: u32, _kind: u32, _language_id: String, _value: String) -> Result<(), String> { Ok(()) }
    fn notebook_delete_cell(&mut self, _handle: u64, _index: u32) -> Result<(), String> { Ok(()) }

    // ── Testing ──────────────────────────────────────────────────────────────

    fn test_controller_create(&mut self, id: String, label: String) -> Result<u64, String> {
        let h = self.next_test_handle;
        self.next_test_handle += 1;
        self.test_controllers.insert(h, TestController { id, label, items: vec![] });
        Ok(h)
    }
    fn test_controller_dispose(&mut self, handle: u64) { self.test_controllers.remove(&handle); }
    fn test_controller_add_items(&mut self, handle: u64, items: Vec<wit_types::TestItem>) -> Result<(), String> {
        if let Some(c) = self.test_controllers.get_mut(&handle) { c.items.extend(items); }
        Ok(())
    }
    fn test_run_create(&mut self, controller_handle: u64, name: Option<String>) -> Result<u64, String> {
        let h = self.next_run_handle;
        self.next_run_handle += 1;
        self.test_runs.insert(h, TestRun { controller_handle, name, results: vec![] });
        Ok(h)
    }
    fn test_run_started(&mut self, run_handle: u64, item_id: String) {
        if let Some(r) = self.test_runs.get_mut(&run_handle) {
            r.results.push(wit_types::TestResult { id: item_id, state: wit_types::TestResultState::Running, message: None, duration: None });
        }
    }
    fn test_run_passed(&mut self, run_handle: u64, item_id: String, duration: Option<u64>) {
        if let Some(r) = self.test_runs.get_mut(&run_handle) {
            r.results.push(wit_types::TestResult { id: item_id, state: wit_types::TestResultState::Passed, message: None, duration });
        }
    }
    fn test_run_failed(&mut self, run_handle: u64, item_id: String, message: String, duration: Option<u64>) {
        if let Some(r) = self.test_runs.get_mut(&run_handle) {
            r.results.push(wit_types::TestResult { id: item_id, state: wit_types::TestResultState::Failed, message: Some(message), duration });
        }
    }
    fn test_run_errored(&mut self, run_handle: u64, item_id: String, message: String, duration: Option<u64>) {
        if let Some(r) = self.test_runs.get_mut(&run_handle) {
            r.results.push(wit_types::TestResult { id: item_id, state: wit_types::TestResultState::Errored, message: Some(message), duration });
        }
    }
    fn test_run_skipped(&mut self, run_handle: u64, item_id: String) {
        if let Some(r) = self.test_runs.get_mut(&run_handle) {
            r.results.push(wit_types::TestResult { id: item_id, state: wit_types::TestResultState::Skipped, message: None, duration: None });
        }
    }
    fn test_run_end(&mut self, run_handle: u64) {
        if let Some(r) = self.test_runs.get(&run_handle) {
            log::info!("[wasm-ext] test run {} ended: {} results", run_handle, r.results.len());
        }
    }

    // ── Telemetry ────────────────────────────────────────────────────────────

    fn telemetry_send_event(&mut self, event_name: String, data: Vec<(String, String)>) {
        log::debug!("[wasm-ext][telemetry] {event_name}: {:?}", data);
    }

}

impl wit_bindings::sidex::extension::common_types::Host for WasmHostState {}

// ---------------------------------------------------------------------------
// tsserver dispatch — called from execute_command("__sidex.tsserver", ...)
// ---------------------------------------------------------------------------

impl WasmHostState {
    fn tsserver_mut(&mut self) -> Option<&mut TsServerProcess> {
        if self.tsserver.is_none() {
            self.tsserver = TsServerProcess::spawn(&self.workspace_folders);
            if self.tsserver.is_none() {
                log::warn!("[tsserver] failed to spawn — TypeScript features unavailable");
            }
        }
        self.tsserver.as_mut()
    }

    fn ensure_file_open(&mut self, file: &str) {
        if self.tsserver_open_files.contains(file) {
            return;
        }
        let uri = if file.starts_with('/') {
            format!("file://{file}")
        } else {
            file.to_string()
        };
        let (content, script_kind) = if let Some(doc) = self.documents.get(&uri) {
            let kind = if doc.language_id.contains("react") {
                "4"
            } else {
                "3"
            };
            (doc.text.clone(), kind)
        } else {
            let disk_content = std::fs::read_to_string(file).unwrap_or_default();
            let kind = if file.ends_with(".tsx") || file.ends_with(".jsx") {
                "4"
            } else {
                "3"
            };
            (disk_content, kind)
        };

        let escaped = content
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t");

        let open_args = format!(
            r#"{{"file":"{}","fileContent":"{}","scriptKindName":"{}"}}"#,
            file.replace('"', "\\\""),
            escaped,
            script_kind
        );

        if let Some(ts) = self.tsserver_mut() {
            ts.send_notification("open", &open_args);
        }
        self.tsserver_open_files.insert(file.to_string());
    }

    /// Handle __sidex.lsp commands. Payload format:
    /// {"server":"rust-analyzer","cmd":"rust-analyzer","args":[],"method":"textDocument/completion","params":{...}}
    fn execute_lsp_command(&mut self, payload: &str) -> Result<String, String> {
        let server_name = extract_json_string(payload, "server")
            .ok_or_else(|| "lsp: missing server".to_string())?;
        let method = extract_json_string(payload, "method")
            .ok_or_else(|| "lsp: missing method".to_string())?;
        let params = extract_json_object(payload, "params").unwrap_or_else(|| "{}".to_string());

        if !self.lsp_servers.contains_key(&server_name) {
            let cmd = extract_json_string(payload, "cmd").unwrap_or_else(|| server_name.clone());
            let extra_args = extract_json_string_array(payload, "args");
            let root = self
                .workspace_folders
                .first()
                .map(|f| format!("file://{f}"))
                .unwrap_or_else(|| "file:///tmp".to_string());
            let binary = find_binary(
                &cmd,
                &[
                    &format!("/usr/local/bin/{cmd}"),
                    &format!("/opt/homebrew/bin/{cmd}"),
                    &format!("/usr/bin/{cmd}"),
                ],
            )
            .ok_or_else(|| format!("lsp: {cmd} binary not found"))?;

            let cargo_dir = env!("CARGO_MANIFEST_DIR");
            let resolved_args: Vec<String> = extra_args
                .iter()
                .map(|a| {
                    if !a.starts_with('/') {
                        let resolved = format!("{}/{}", cargo_dir, a);
                        if std::path::Path::new(&resolved).exists() {
                            return resolved;
                        }
                    }
                    a.clone()
                })
                .collect();
            let args_refs: Vec<&str> = resolved_args.iter().map(|s| s.as_str()).collect();
            let server = LspServerProcess::spawn(&server_name, &binary, &args_refs, &root)
                .ok_or_else(|| format!("lsp: failed to start {server_name}"))?;

            self.lsp_servers.insert(server_name.clone(), server);
            self.lsp_open_files
                .insert(server_name.clone(), std::collections::HashSet::new());
        }

        if let Some(td) = extract_json_object(&params, "textDocument") {
            if let Some(uri) = extract_json_string(&td, "uri") {
                let files = self
                    .lsp_open_files
                    .get(&server_name)
                    .cloned()
                    .unwrap_or_default();
                if !files.contains(&uri) {
                    let file_path = uri.strip_prefix("file://").unwrap_or(&uri);
                    let lang_id = extract_json_string(&td, "languageId").unwrap_or_else(|| {
                        if file_path.ends_with(".rs") {
                            "rust".to_string()
                        } else if file_path.ends_with(".go") {
                            "go".to_string()
                        } else if file_path.ends_with(".py") {
                            "python".to_string()
                        } else if file_path.ends_with(".c") || file_path.ends_with(".h") {
                            "c".to_string()
                        } else if file_path.ends_with(".cpp") || file_path.ends_with(".cc") {
                            "cpp".to_string()
                        } else if file_path.ends_with(".css") {
                            "css".to_string()
                        } else if file_path.ends_with(".scss") {
                            "scss".to_string()
                        } else if file_path.ends_with(".less") {
                            "less".to_string()
                        } else if file_path.ends_with(".html") || file_path.ends_with(".htm") {
                            "html".to_string()
                        } else if file_path.ends_with(".json") {
                            "json".to_string()
                        } else if file_path.ends_with(".jsonc") {
                            "jsonc".to_string()
                        } else if file_path.ends_with(".ts") || file_path.ends_with(".tsx") {
                            "typescript".to_string()
                        } else if file_path.ends_with(".js") || file_path.ends_with(".jsx") {
                            "javascript".to_string()
                        } else {
                            "plaintext".to_string()
                        }
                    });
                    let content = self
                        .documents
                        .get(&uri)
                        .map(|d| d.text.clone())
                        .or_else(|| std::fs::read_to_string(file_path).ok())
                        .unwrap_or_default();

                    if let Some(server) = self.lsp_servers.get_mut(&server_name) {
                        server.open_file(&uri, &lang_id, &content);
                    }
                    if let Some(files) = self.lsp_open_files.get_mut(&server_name) {
                        files.insert(uri);
                    }
                }
            }
        }

        let server = self
            .lsp_servers
            .get_mut(&server_name)
            .ok_or_else(|| format!("lsp: {server_name} not found"))?;
        let response = server
            .request_sync(&method, &params)
            .ok_or_else(|| format!("lsp: no response for {method}"))?;

        Ok(response)
    }

    fn execute_tsserver_command(&mut self, payload: &str) -> Result<String, String> {
        let command = extract_json_string(payload, "command")
            .ok_or_else(|| "tsserver: missing command field".to_string())?;
        let arguments = extract_json_object(payload, "arguments")
            .ok_or_else(|| "tsserver: missing arguments field".to_string())?;
        let file = extract_json_string(&arguments, "file")
            .ok_or_else(|| "tsserver: missing arguments.file".to_string())?;

        self.ensure_file_open(&file);

        let ts = self
            .tsserver_mut()
            .ok_or_else(|| "tsserver not available".to_string())?;

        let response = ts
            .request_sync(&command, &arguments)
            .ok_or_else(|| format!("tsserver: no response for {command}"))?;

        Ok(response)
    }
}

// Minimal JSON field extractor (no external dependency)
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let search = format!(r#""{key}":"#);
    let start = json.find(&search)? + search.len();
    let rest = json[start..].trim_start();
    if rest.starts_with('"') {
        let inner = &rest[1..];
        let mut result = String::new();
        let mut chars = inner.chars();
        loop {
            match chars.next()? {
                '\\' => match chars.next()? {
                    '"' => result.push('"'),
                    '\\' => result.push('\\'),
                    'n' => result.push('\n'),
                    'r' => result.push('\r'),
                    't' => result.push('\t'),
                    c => {
                        result.push('\\');
                        result.push(c);
                    }
                },
                '"' => break,
                c => result.push(c),
            }
        }
        Some(result)
    } else {
        None
    }
}

fn extract_json_object(json: &str, key: &str) -> Option<String> {
    let search = format!(r#""{key}":"#);
    let start = json.find(&search)? + search.len();
    let rest = json[start..].trim_start();
    if !rest.starts_with('{') {
        return None;
    }
    let mut depth = 0usize;
    let mut end = 0;
    for (i, c) in rest.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    if end > 0 {
        Some(rest[..end].to_string())
    } else {
        None
    }
}

fn extract_json_string_array(json: &str, key: &str) -> Vec<String> {
    let search = format!(r#""{key}":"#);
    let start = match json.find(&search) {
        Some(s) => s + search.len(),
        None => return vec![],
    };
    let rest = json[start..].trim_start();
    if !rest.starts_with('[') {
        return vec![];
    }
    let mut items = Vec::new();
    let mut i = 1; // skip '['
    let bytes = rest.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b']' {
            break;
        }
        if bytes[i] == b'"' {
            let str_start = i + 1;
            let mut str_end = str_start;
            while str_end < bytes.len() && bytes[str_end] != b'"' {
                if bytes[str_end] == b'\\' {
                    str_end += 1;
                }
                str_end += 1;
            }
            items.push(rest[str_start..str_end].to_string());
            i = str_end + 1;
        } else {
            i += 1;
        }
    }
    items
}

// ---------------------------------------------------------------------------
// Loaded WASM extension instance
// ---------------------------------------------------------------------------

struct LoadedWasmExtension {
    #[allow(dead_code)]
    id: String,
    store: Store<WasmHostState>,
    bindings: SidexExtension,
}

// ---------------------------------------------------------------------------
// WASM extension runtime — manages wasmtime engine and all loaded extensions
// ---------------------------------------------------------------------------

pub struct WasmExtensionRuntime {
    inner: Mutex<WasmRuntimeState>,
}

struct WasmRuntimeState {
    engine: Engine,
    linker: Linker<WasmHostState>,
    extensions: HashMap<String, LoadedWasmExtension>,
    shared_documents: HashMap<String, DocumentData>,
    shared_workspace_folders: Vec<String>,
}

impl WasmExtensionRuntime {
    pub fn new() -> Result<Self> {
        let mut config = Config::new();
        config.wasm_component_model(true);

        let engine =
            Engine::new(&config).map_err(|e| anyhow::anyhow!("create wasmtime engine: {e}"))?;
        let mut linker: Linker<WasmHostState> = Linker::new(&engine);

        wasmtime_wasi::p2::add_to_linker_sync(&mut linker)
            .map_err(|e| anyhow::anyhow!("add WASI to linker: {e}"))?;

        SidexExtension::add_to_linker::<_, wasmtime::component::HasSelf<_>>(&mut linker, |x| x)
            .map_err(|e| anyhow::anyhow!("add WIT bindings to linker: {e}"))?;

        Ok(Self {
            inner: Mutex::new(WasmRuntimeState {
                engine,
                linker,
                extensions: HashMap::new(),
                shared_documents: HashMap::new(),
                shared_workspace_folders: Vec::new(),
            }),
        })
    }

    pub fn load_extension(&self, manifest: &ExtensionManifest) -> Result<(), String> {
        let wasm_file = manifest
            .wasm_binary
            .as_ref()
            .ok_or("manifest has no wasm_binary")?;
        let wasm_path = Path::new(&manifest.path).join(wasm_file);

        log::info!(
            "loading WASM extension: {} from {}",
            manifest.id,
            wasm_path.display()
        );

        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;

        let component = Component::from_file(&guard.engine, &wasm_path)
            .map_err(|e| format!("failed to load wasm component {}: {e}", wasm_path.display()))?;

        let mut store = Store::new(&guard.engine, WasmHostState::new());

        {
            let host_state = store.data_mut();
            for (uri, doc) in &guard.shared_documents {
                host_state.documents.insert(
                    uri.clone(),
                    DocumentData {
                        text: doc.text.clone(),
                        language_id: doc.language_id.clone(),
                    },
                );
            }
            host_state.workspace_folders = guard.shared_workspace_folders.clone();
        }

        let bindings = SidexExtension::instantiate(&mut store, &component, &guard.linker)
            .map_err(|e| format!("failed to instantiate {}: {e}", manifest.id))?;

        bindings
            .sidex_extension_extension_api()
            .call_activate(&mut store)
            .map_err(|e| format!("activate failed for {}: {e}", manifest.id))?
            .map_err(|e| format!("extension {} returned error: {e}", manifest.id))?;

        log::info!("loaded WASM extension: {}", manifest.id);

        guard.extensions.insert(
            manifest.id.clone(),
            LoadedWasmExtension {
                id: manifest.id.clone(),
                store,
                bindings,
            },
        );

        Ok(())
    }

    pub fn unload_extension(&self, id: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(mut ext) = guard.extensions.remove(id) {
            let _ = ext
                .bindings
                .sidex_extension_extension_api()
                .call_deactivate(&mut ext.store);
            log::info!("unloaded WASM extension: {id}");
        }
        Ok(())
    }

    pub fn loaded_extension_ids(&self) -> Vec<String> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.extensions.keys().cloned().collect()
    }

    pub fn sync_document(&self, uri: &str, language_id: &str, text: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.shared_documents.insert(
                uri.to_string(),
                DocumentData {
                    text: text.to_string(),
                    language_id: language_id.to_string(),
                },
            );
            for ext in guard.extensions.values_mut() {
                ext.store.data_mut().documents.insert(
                    uri.to_string(),
                    DocumentData {
                        text: text.to_string(),
                        language_id: language_id.to_string(),
                    },
                );
                let state = ext.store.data_mut();
                let file = uri.strip_prefix("file://").unwrap_or(uri);
                if state.tsserver_open_files.contains(file) {
                    state.tsserver_open_files.remove(file);
                    state.ensure_file_open(file);
                }
            }
        }
    }

    pub fn close_document(&self, uri: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.shared_documents.remove(uri);
            for ext in guard.extensions.values_mut() {
                ext.store.data_mut().documents.remove(uri);
            }
        }
    }

    pub fn sync_workspace_folders(&self, folders: &[String]) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.shared_workspace_folders = folders.to_vec();
            for ext in guard.extensions.values_mut() {
                ext.store.data_mut().workspace_folders = folders.to_vec();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Serialized provider result types for Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmCompletionResult {
    pub items: Vec<serde_json::Value>,
    pub is_incomplete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmHoverResult {
    pub contents: Vec<String>,
    pub range: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Provider dispatch helpers
// ---------------------------------------------------------------------------

fn make_doc_ctx(uri: &str, language_id: &str, version: u32) -> wit_types::DocumentContext {
    wit_types::DocumentContext {
        uri: uri.to_string(),
        language_id: language_id.to_string(),
        version,
    }
}

fn make_position(line: u32, character: u32) -> wit_types::Position {
    wit_types::Position { line, character }
}

fn serialize_range(r: &wit_types::Range) -> serde_json::Value {
    serde_json::json!({
        "start": { "line": r.start.line, "character": r.start.character },
        "end": { "line": r.end.line, "character": r.end.character },
    })
}

fn serialize_location(l: &wit_types::Location) -> serde_json::Value {
    serde_json::json!({
        "uri": l.uri,
        "range": serialize_range(&l.range),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands — WASM provider dispatch
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmProviderParams {
    pub extension_id: String,
    pub uri: String,
    pub language_id: String,
    pub version: u32,
    pub line: u32,
    pub character: u32,
}

#[tauri::command]
pub async fn wasm_provide_completion(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmCompletionResult>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_completion(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("completion call failed: {e}"))?;

    Ok(result.map(|cl| WasmCompletionResult {
        items: cl
            .items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "label": item.label,
                    "kind": item.kind,
                    "detail": item.detail,
                    "documentation": item.documentation,
                    "insertText": item.insert_text.as_deref().unwrap_or(&item.label),
                    "sortText": item.sort_text,
                    "filterText": item.filter_text,
                })
            })
            .collect(),
        is_incomplete: cl.is_incomplete,
    }))
}

#[tauri::command]
pub async fn wasm_provide_hover(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmHoverResult>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_hover(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("hover call failed: {e}"))?;

    Ok(result.map(|h| WasmHoverResult {
        contents: h.contents,
        range: h.range.as_ref().map(serialize_range),
    }))
}

#[tauri::command]
pub async fn wasm_provide_definition(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_definition(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("definition call failed: {e}"))?;

    Ok(result.iter().map(serialize_location).collect())
}

#[tauri::command]
pub async fn wasm_provide_references(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_references(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("references call failed: {e}"))?;

    Ok(result.iter().map(serialize_location).collect())
}

#[tauri::command]
pub async fn wasm_provide_document_symbols(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_document_symbols(&mut ext.store, &ctx)
        .map_err(|e| format!("document symbols call failed: {e}"))?;

    Ok(result
        .iter()
        .map(|s| {
            serde_json::json!({
                "name": s.name,
                "detail": s.detail,
                "kind": s.kind,
                "range": serialize_range(&s.range),
                "selectionRange": serialize_range(&s.selection_range),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn wasm_provide_formatting(
    params: WasmProviderParams,
    tab_size: u32,
    insert_spaces: bool,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_formatting(&mut ext.store, &ctx, tab_size, insert_spaces)
        .map_err(|e| format!("formatting call failed: {e}"))?;

    Ok(result
        .iter()
        .map(|e| {
            serde_json::json!({
                "range": serialize_range(&e.range),
                "newText": e.new_text,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn wasm_load_extension(
    extension_id: String,
    wasm_path: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let manifest = ExtensionManifest {
        id: extension_id.clone(),
        publisher: String::new(),
        name: extension_id.clone(),
        display_name: extension_id.clone(),
        version: "0.0.0".to_string(),
        path: std::path::Path::new(&wasm_path)
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .to_string_lossy()
            .to_string(),
        kind: crate::commands::extension_platform::ExtensionKind::Wasm,
        main: None,
        browser: None,
        wasm_binary: Some(
            std::path::Path::new(&wasm_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        ),
        source: "user".to_string(),
        builtin: false,
        activation_events: Vec::new(),
        contributes_keys: Vec::new(),
    };
    state.load_extension(&manifest)
}

#[tauri::command]
pub async fn wasm_unload_extension(
    extension_id: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.unload_extension(&extension_id)
}

#[tauri::command]
pub async fn wasm_list_extensions(
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<String>, String> {
    Ok(state.loaded_extension_ids())
}

#[tauri::command]
pub async fn wasm_sync_document(
    uri: String,
    language_id: String,
    text: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.sync_document(&uri, &language_id, &text);
    Ok(())
}

#[tauri::command]
pub async fn wasm_close_document(
    uri: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.close_document(&uri);
    Ok(())
}

#[tauri::command]
pub async fn wasm_sync_workspace_folders(
    folders: Vec<String>,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.sync_workspace_folders(&folders);
    Ok(())
}

/// Broadcast completion request to all loaded WASM extensions and merge results.
#[tauri::command]
pub async fn wasm_provide_completion_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmCompletionResult>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);

    let mut all_items = Vec::new();
    let mut any_incomplete = false;

    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_completion(&mut ext.store, &ctx, pos)
            {
                Ok(Some(cl)) => {
                    any_incomplete = any_incomplete || cl.is_incomplete;
                    for item in &cl.items {
                        all_items.push(serde_json::json!({
                            "label": item.label,
                            "kind": item.kind,
                            "detail": item.detail,
                            "documentation": item.documentation,
                            "insertText": item.insert_text.as_deref().unwrap_or(&item.label),
                            // "0" prefix so WASM extension results sort before other sources
                            "sortText": item.sort_text.as_deref().map(|s| format!("0{s}")).unwrap_or_else(|| format!("0{}", item.label)),
                            "filterText": item.filter_text,
                        }));
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    log::warn!("WASM completion error from {ext_id}: {e}");
                }
            }
        }
    }

    if all_items.is_empty() {
        Ok(None)
    } else {
        Ok(Some(WasmCompletionResult {
            items: all_items,
            is_incomplete: any_incomplete,
        }))
    }
}

/// Broadcast hover request to all loaded WASM extensions and return first non-empty result.
#[tauri::command]
pub async fn wasm_provide_hover_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmHoverResult>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);

    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_hover(&mut ext.store, &ctx, pos)
            {
                Ok(Some(h)) if !h.contents.is_empty() => {
                    return Ok(Some(WasmHoverResult {
                        contents: h.contents,
                        range: h.range.as_ref().map(serialize_range),
                    }));
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("WASM hover error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(None)
}

/// Broadcast definition request to all loaded WASM extensions.
#[tauri::command]
pub async fn wasm_provide_definition_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);

    let mut all_locs = Vec::new();
    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_definition(&mut ext.store, &ctx, pos)
            {
                Ok(locs) => {
                    for l in &locs {
                        all_locs.push(serialize_location(l));
                    }
                }
                Err(e) => {
                    log::warn!("WASM definition error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(all_locs)
}

/// Broadcast document symbols request to all loaded WASM extensions.
#[tauri::command]
pub async fn wasm_provide_document_symbols_all(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);

    let mut all_symbols = Vec::new();
    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_document_symbols(&mut ext.store, &ctx)
            {
                Ok(symbols) => {
                    for s in &symbols {
                        all_symbols.push(serde_json::json!({
                            "name": s.name,
                            "detail": s.detail,
                            "kind": s.kind,
                            "range": serialize_range(&s.range),
                            "selectionRange": serialize_range(&s.selection_range),
                        }));
                    }
                }
                Err(e) => {
                    log::warn!("WASM document symbols error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(all_symbols)
}

/// Broadcast formatting request to all loaded WASM extensions.
#[tauri::command]
pub async fn wasm_provide_formatting_all(
    uri: String,
    language_id: String,
    version: u32,
    tab_size: u32,
    insert_spaces: bool,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);

    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_formatting(&mut ext.store, &ctx, tab_size, insert_spaces)
            {
                Ok(edits) if !edits.is_empty() => {
                    return Ok(edits
                        .iter()
                        .map(|e| {
                            serde_json::json!({
                                "range": serialize_range(&e.range),
                                "newText": e.new_text,
                            })
                        })
                        .collect());
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("WASM formatting error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// Document event broadcast helpers
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn wasm_on_document_opened(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext.bindings.sidex_extension_extension_api().call_on_document_opened(&mut ext.store, &ctx);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_document_closed(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext.bindings.sidex_extension_extension_api().call_on_document_closed(&mut ext.store, &ctx);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_document_saved(
    uri: String,
    language_id: String,
    version: u32,
    reason: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext.bindings.sidex_extension_extension_api().call_on_document_saved(&mut ext.store, &ctx, reason);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_document_changed(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext.bindings.sidex_extension_extension_api().call_on_document_changed(&mut ext.store, &ctx, &[]);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_configuration_changed(
    section: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    for ext in guard.extensions.values_mut() {
        let _ = ext.bindings.sidex_extension_extension_api().call_on_configuration_changed(&mut ext.store, &section);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_active_editor_changed(
    uri: Option<String>,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    if let Ok(mut guard) = state.inner.lock() {
        for ext in guard.extensions.values_mut() {
            ext.store.data_mut().active_editor_uri = uri.clone();
            let _ = ext.bindings.sidex_extension_extension_api().call_on_active_editor_changed(&mut ext.store, uri.as_deref());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Extended provider broadcast commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn wasm_provide_type_definition_all(
    uri: String, language_id: String, version: u32, line: u32, character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(locs) = ext.bindings.sidex_extension_extension_api().call_provide_type_definition(&mut ext.store, &ctx, pos) {
                for l in &locs { all.push(serialize_location(l)); }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_implementation_all(
    uri: String, language_id: String, version: u32, line: u32, character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(locs) = ext.bindings.sidex_extension_extension_api().call_provide_implementation(&mut ext.store, &ctx, pos) {
                for l in &locs { all.push(serialize_location(l)); }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_declaration_all(
    uri: String, language_id: String, version: u32, line: u32, character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(locs) = ext.bindings.sidex_extension_extension_api().call_provide_declaration(&mut ext.store, &ctx, pos) {
                for l in &locs { all.push(serialize_location(l)); }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_code_actions_all(
    uri: String, language_id: String, version: u32,
    start_line: u32, start_character: u32, end_line: u32, end_character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let range = wit_types::Range {
        start: make_position(start_line, start_character),
        end: make_position(end_line, end_character),
    };
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(actions) = ext.bindings.sidex_extension_extension_api().call_provide_code_actions(&mut ext.store, &ctx, range, &[]) {
                for a in &actions {
                    all.push(serde_json::json!({
                        "title": a.title,
                        "kind": a.kind,
                        "isPreferred": a.is_preferred,
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_code_lenses_all(
    uri: String, language_id: String, version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(lenses) = ext.bindings.sidex_extension_extension_api().call_provide_code_lenses(&mut ext.store, &ctx) {
                for l in &lenses {
                    all.push(serde_json::json!({
                        "range": serialize_range(&l.range),
                        "command": { "id": l.command_id, "title": l.command_title },
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_signature_help_all(
    uri: String, language_id: String, version: u32, line: u32, character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(Some(sh)) = ext.bindings.sidex_extension_extension_api().call_provide_signature_help(&mut ext.store, &ctx, pos) {
                return Ok(Some(serde_json::json!({
                    "signatures": sh.signatures.iter().map(|s| serde_json::json!({
                        "label": s.label,
                        "documentation": s.documentation,
                        "parameters": s.parameters.iter().map(|p| serde_json::json!({"label": p.label})).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                    "activeSignature": sh.active_signature,
                    "activeParameter": sh.active_parameter,
                })));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn wasm_provide_document_highlights_all(
    uri: String, language_id: String, version: u32, line: u32, character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(highlights) = ext.bindings.sidex_extension_extension_api().call_provide_document_highlights(&mut ext.store, &ctx, pos) {
                for h in &highlights {
                    all.push(serde_json::json!({ "range": serialize_range(&h.range), "kind": h.kind }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_rename_all(
    uri: String, language_id: String, version: u32, line: u32, character: u32, new_name: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(Some(r)) = ext.bindings.sidex_extension_extension_api().call_provide_rename(&mut ext.store, &ctx, pos, &new_name) {
                return Ok(Some(serde_json::json!({
                    "edits": r.edits.iter().map(|e| serde_json::json!({
                        "uri": e.uri,
                        "edits": e.edits.iter().map(|te| serde_json::json!({"range": serialize_range(&te.range), "newText": te.new_text})).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                })));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn wasm_provide_folding_ranges_all(
    uri: String, language_id: String, version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(ranges) = ext.bindings.sidex_extension_extension_api().call_provide_folding_ranges(&mut ext.store, &ctx) {
                for r in &ranges {
                    all.push(serde_json::json!({ "startLine": r.start_line, "endLine": r.end_line, "kind": r.kind }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_inlay_hints_all(
    uri: String, language_id: String, version: u32,
    start_line: u32, start_character: u32, end_line: u32, end_character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let range = wit_types::Range {
        start: make_position(start_line, start_character),
        end: make_position(end_line, end_character),
    };
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(hints) = ext.bindings.sidex_extension_extension_api().call_provide_inlay_hints(&mut ext.store, &ctx, range) {
                for h in &hints {
                    all.push(serde_json::json!({
                        "position": { "line": h.position.line, "character": h.position.character },
                        "label": h.label,
                        "kind": h.kind,
                        "paddingLeft": h.padding_left,
                        "paddingRight": h.padding_right,
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_document_links_all(
    uri: String, language_id: String, version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(links) = ext.bindings.sidex_extension_extension_api().call_provide_document_links(&mut ext.store, &ctx) {
                for l in &links {
                    all.push(serde_json::json!({ "range": serialize_range(&l.range), "target": l.target }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_selection_ranges_all(
    uri: String, language_id: String, version: u32,
    positions: Vec<(u32, u32)>,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let wit_positions: Vec<wit_types::Position> = positions.iter().map(|(l, c)| make_position(*l, *c)).collect();
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(ranges) = ext.bindings.sidex_extension_extension_api().call_provide_selection_ranges(&mut ext.store, &ctx, &wit_positions) {
                for r in &ranges {
                    all.push(serde_json::json!({ "range": serialize_range(&r.range) }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_semantic_tokens_all(
    uri: String, language_id: String, version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(Some(tokens)) = ext.bindings.sidex_extension_extension_api().call_provide_semantic_tokens(&mut ext.store, &ctx) {
                return Ok(Some(serde_json::json!({ "data": tokens.data, "resultId": tokens.result_id })));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn wasm_provide_document_colors_all(
    uri: String, language_id: String, version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(colors) = ext.bindings.sidex_extension_extension_api().call_provide_document_colors(&mut ext.store, &ctx) {
                for c in &colors {
                    all.push(serde_json::json!({
                        "range": serialize_range(&c.range),
                        "color": { "red": c.red, "green": c.green, "blue": c.blue, "alpha": c.alpha },
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_workspace_symbols_all(
    query: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(symbols) = ext.bindings.sidex_extension_extension_api().call_provide_workspace_symbols(&mut ext.store, &query) {
                for s in &symbols {
                    all.push(serde_json::json!({
                        "name": s.name,
                        "detail": s.detail,
                        "kind": s.kind,
                        "range": serialize_range(&s.range),
                        "selectionRange": serialize_range(&s.selection_range),
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_range_formatting_all(
    uri: String, language_id: String, version: u32,
    start_line: u32, start_character: u32, end_line: u32, end_character: u32,
    tab_size: u32, insert_spaces: bool,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let range = wit_types::Range {
        start: make_position(start_line, start_character),
        end: make_position(end_line, end_character),
    };
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(edits) = ext.bindings.sidex_extension_extension_api().call_provide_range_formatting(&mut ext.store, &ctx, range, tab_size, insert_spaces) {
                if !edits.is_empty() {
                    return Ok(edits.iter().map(|e| serde_json::json!({
                        "range": serialize_range(&e.range),
                        "newText": e.new_text,
                    })).collect());
                }
            }
        }
    }
    Ok(vec![])
}

#[tauri::command]
pub async fn wasm_execute_command_all(
    command_id: String,
    args: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            match ext.bindings.sidex_extension_extension_api().call_execute_command(&mut ext.store, &command_id, &args) {
                Ok(Ok(result)) => results.push(serde_json::json!({ "extensionId": id, "result": result })),
                Ok(Err(e)) => log::warn!("[wasm] execute_command error from {id}: {e}"),
                Err(e) => log::warn!("[wasm] execute_command trap from {id}: {e}"),
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn wasm_get_extension_metadata(
    extension_id: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ext = guard.extensions.get_mut(&extension_id)
        .ok_or_else(|| format!("extension not loaded: {extension_id}"))?;
    let api = ext.bindings.sidex_extension_extension_api();
    let name = api.call_get_name(&mut ext.store).unwrap_or_default();
    let display_name = api.call_get_display_name(&mut ext.store).unwrap_or_default();
    let version = api.call_get_version(&mut ext.store).unwrap_or_default();
    let publisher = api.call_get_publisher(&mut ext.store).unwrap_or_default();
    let activation_events = api.call_get_activation_events(&mut ext.store).unwrap_or_default();
    let commands = api.call_get_commands(&mut ext.store).unwrap_or_default();
    let languages = api.call_get_languages(&mut ext.store).unwrap_or_default();
    let legend = api.call_get_semantic_tokens_legend(&mut ext.store).unwrap_or(None);
    Ok(serde_json::json!({
        "id": extension_id,
        "name": name,
        "displayName": display_name,
        "version": version,
        "publisher": publisher,
        "activationEvents": activation_events,
        "commands": commands.iter().map(|c| serde_json::json!({"id": c.id, "title": c.title})).collect::<Vec<_>>(),
        "languages": languages,
        "semanticTokensLegend": legend.map(|l| serde_json::json!({
            "tokenTypes": l.token_types,
            "tokenModifiers": l.token_modifiers,
        })),
    }))
}
