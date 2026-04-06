use serde::Deserialize;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub struct ExtHostProcess {
    inner: Mutex<Option<ExtHostState>>,
}

struct ExtHostState {
    child: Child,
    port: u16,
}

impl ExtHostProcess {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

#[derive(Deserialize)]
struct PortMessage {
    port: u16,
}

fn find_node() -> Result<String, String> {
    let candidates = if cfg!(target_os = "windows") {
        vec![
            "node.exe",
            "node",
        ]
    } else {
        vec![
            "node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/opt/homebrew/bin/node",
        ]
    };

    for c in &candidates {
        if Command::new(c)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return Ok(c.to_string());
        }
    }

    Err("Node.js not found. Install Node.js (>=18) to use extensions.".into())
}

fn resolve_server_script(app: &AppHandle) -> std::path::PathBuf {
    let resource_path = app
        .path()
        .resolve("extension-host/server.cjs", tauri::path::BaseDirectory::Resource)
        .ok();

    if let Some(ref p) = resource_path {
        if p.exists() {
            return p.clone();
        }
    }
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("extension-host/server.cjs")
}

fn ensure_extensions_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let ext_dir = home.join(".sidex").join("extensions");
    let _ = std::fs::create_dir_all(&ext_dir);
    ext_dir
}

#[tauri::command]
pub async fn start_extension_host(
    app: AppHandle,
    state: State<'_, ExtHostProcess>,
) -> Result<u16, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;

    if let Some(ref s) = *guard {
        return Ok(s.port);
    }

    let node = find_node()?;
    let server_js = resolve_server_script(&app);

    if !server_js.exists() {
        return Err(format!(
            "extension host script not found at {}",
            server_js.display()
        ));
    }

    let extensions_dir = ensure_extensions_dir();
    log::info!("extensions directory: {}", extensions_dir.display());

    let mut child_cmd = Command::new(&node);
    child_cmd
        .arg("--max-old-space-size=3072")
        .arg(&server_js)
        .env("SIDEX_EXTENSIONS_DIR", &extensions_dir)
        .env("NODE_ENV", "production")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        child_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = child_cmd
        .spawn()
        .map_err(|e| format!("failed to spawn extension host: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture extension host stdout")?;

    let port = {
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("failed to read extension host port: {e}"))?;
        let msg: PortMessage =
            serde_json::from_str(line.trim()).map_err(|e| format!("bad port message: {e}"))?;
        msg.port
    };

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log::info!("{}", line);
            }
        });
    }

    log::info!("extension host started on port {port}");
    *guard = Some(ExtHostState { child, port });
    Ok(port)
}

#[tauri::command]
pub async fn stop_extension_host(state: State<'_, ExtHostProcess>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = guard.take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
        log::info!("extension host stopped");
    }
    Ok(())
}

#[tauri::command]
pub async fn extension_host_port(state: State<'_, ExtHostProcess>) -> Result<Option<u16>, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(|s| s.port))
}
