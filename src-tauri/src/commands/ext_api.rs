use serde::Serialize;
use sidex_extension_api::CommandRegistry;
use sidex_extension_api::ExtensionApiHandler;
use std::env;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
pub struct ExtCommandInfo {
    pub id: String,
}

#[tauri::command]
pub fn ext_api_get_namespaces() -> Vec<String> {
    [
        "window",
        "workspace",
        "commands",
        "languages",
        "debug",
        "tasks",
        "scm",
        "tests",
        "env",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn ext_api_get_commands(registry: State<'_, Arc<CommandRegistry>>) -> Vec<ExtCommandInfo> {
    registry
        .get_commands()
        .into_iter()
        .map(|id| ExtCommandInfo { id })
        .collect()
}

/// Dispatch an extension-API call ("namespace/action") to the appropriate
/// subsystem handler. This is the command the workbench-side
/// SidexExtensionApiService invokes — without it the entire extension API
/// surface was unreachable.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn ext_api_call(
    handler: State<'_, Arc<ExtensionApiHandler>>,
    namespace: String,
    action: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let method = format!("{namespace}/{action}");
    let params = params.unwrap_or(serde_json::Value::Null);
    handler
        .dispatch(&method, &params)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    clipboard
        .get_text()
        .map_err(|e| format!("clipboard read failed: {e}"))
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("clipboard write failed: {e}"))
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let parsed: url::Url = url.parse().map_err(|_| "invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => {}
        s => return Err(format!("blocked scheme: {s}")),
    }
    open::that(parsed.as_str()).map_err(|e| format!("failed to open URL: {e}"))
}

#[tauri::command]
pub fn env_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
        } else {
            "/bin/sh".to_string()
        }
    })
}

#[derive(Serialize)]
pub struct AppHostInfo {
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn env_app_host() -> AppHostInfo {
    AppHostInfo {
        os: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
    }
}
