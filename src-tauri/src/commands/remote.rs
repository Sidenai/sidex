//! Tauri commands that expose the `sidex-remote` crate to the frontend.
//!
//! A single [`RemoteManagerStore`] is held as Tauri state and wraps the
//! `RemoteManager` in a `tokio::Mutex` so connections can be shared across
//! async command invocations.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

use sidex_remote::{
    codespaces::list_codespace_info,
    ssh::{parse_ssh_config, SshAuth},
    ConnectionId, ConnectionInfo, ConnectionKind, RemoteManager,
};

// ── State ───────────────────────────────────────────────────────────

pub struct RemoteManagerStore {
    inner: Arc<Mutex<RemoteManager>>,
}

impl RemoteManagerStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RemoteManager::new())),
        }
    }
}

impl Default for RemoteManagerStore {
    fn default() -> Self {
        Self::new()
    }
}

// ── Response structs ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SshHostInfo {
    pub host: String,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WslDistroInfo {
    pub name: String,
    pub is_default: bool,
    pub version: u8,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerListEntry {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodespaceEntry {
    pub name: String,
    pub display_name: String,
    pub repository: String,
    pub branch: String,
    pub machine_type: String,
    pub state: String,
    pub created_at: String,
    pub last_used: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteConnectionEntry {
    pub id: u64,
    pub kind: String,
    pub label: String,
    pub connected_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ── Auth payload from the frontend ─────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshAuthPayload {
    Password {
        password: String,
    },
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

impl From<SshAuthPayload> for SshAuth {
    fn from(p: SshAuthPayload) -> Self {
        match p {
            SshAuthPayload::Password { password } => SshAuth::Password(password),
            SshAuthPayload::KeyFile { path, passphrase } => SshAuth::KeyFile {
                path: PathBuf::from(path),
                passphrase,
            },
            SshAuthPayload::Agent => SshAuth::Agent,
        }
    }
}

fn kind_as_str(k: ConnectionKind) -> &'static str {
    match k {
        ConnectionKind::Ssh => "ssh",
        ConnectionKind::Wsl => "wsl",
        ConnectionKind::Container => "container",
        ConnectionKind::Codespace => "codespace",
        ConnectionKind::Tunnel => "tunnel",
    }
}

fn to_entry(info: ConnectionInfo) -> RemoteConnectionEntry {
    RemoteConnectionEntry {
        id: info.id.0,
        kind: kind_as_str(info.kind).to_string(),
        label: info.label,
        connected_secs: info.connected_secs,
    }
}

// ── Commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn remote_list_ssh_hosts() -> Result<Vec<SshHostInfo>, String> {
    let config_path =
        dirs::home_dir().map_or_else(|| PathBuf::from("~/.ssh/config"), |h| h.join(".ssh/config"));

    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let hosts =
        parse_ssh_config(&config_path).map_err(|e| format!("failed to parse SSH config: {e}"))?;

    Ok(hosts
        .into_iter()
        .filter(|h| !h.host_pattern.contains('*'))
        .map(|h| SshHostInfo {
            host: h.host_pattern,
            hostname: h.hostname,
            port: h.port,
            user: h.user,
            identity_file: h.identity_file.map(|p| p.to_string_lossy().into_owned()),
        })
        .collect())
}

#[tauri::command]
pub async fn remote_connect_ssh(
    host: String,
    user: String,
    port: Option<u16>,
    auth: SshAuthPayload,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let port = port.unwrap_or(22);
    let auth: SshAuth = auth.into();

    let mut mgr = store.inner.lock().await;
    let id = mgr
        .connect_ssh_as(&user, &host, port, auth, Some(30))
        .await
        .map_err(|e| format!("SSH connect failed: {e}"))?;

    let info = mgr
        .active_connections()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection disappeared immediately".to_string())?;
    Ok(to_entry(info))
}

#[tauri::command]
pub async fn remote_exec_ssh(
    connection_id: u64,
    command: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteExecResult, String> {
    let mgr = store.inner.lock().await;
    let transport = mgr
        .get(ConnectionId(connection_id))
        .ok_or_else(|| format!("no connection with id {connection_id}"))?;

    let out = transport
        .exec(&command)
        .await
        .map_err(|e| format!("remote exec failed: {e}"))?;

    Ok(RemoteExecResult {
        stdout: out.stdout,
        stderr: out.stderr,
        exit_code: out.exit_code,
    })
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn remote_list_wsl_distros() -> Result<Vec<WslDistroInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let distros =
            sidex_remote::wsl::list_distributions().map_err(|e| format!("WSL list failed: {e}"))?;
        Ok(distros
            .into_iter()
            .map(|d| WslDistroInfo {
                name: d.name,
                is_default: d.is_default,
                version: d.version,
                state: d.state,
            })
            .collect())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn remote_list_containers() -> Result<Vec<ContainerListEntry>, String> {
    let output = tokio::process::Command::new("docker")
        .args([
            "ps",
            "-a",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
        ])
        .output()
        .await
        .map_err(|e| format!("failed to run docker ps: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Cannot connect") || stderr.contains("not found") {
            return Ok(Vec::new());
        }
        return Err(format!("docker ps failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(5, '\t').collect();
            if parts.len() >= 4 {
                Some(ContainerListEntry {
                    id: parts[0].to_string(),
                    name: parts[1].to_string(),
                    image: parts[2].to_string(),
                    status: parts[3].to_string(),
                    ports: parts.get(4).unwrap_or(&"").to_string(),
                })
            } else {
                None
            }
        })
        .collect())
}

#[tauri::command]
pub async fn remote_codespaces_list(github_token: String) -> Result<Vec<CodespaceEntry>, String> {
    let items = list_codespace_info(&github_token)
        .await
        .map_err(|e| format!("listing codespaces failed: {e}"))?;

    Ok(items
        .into_iter()
        .map(|c| CodespaceEntry {
            name: c.name,
            display_name: c.display_name,
            repository: c.repository,
            branch: c.branch,
            machine_type: c.machine_type,
            state: format!("{:?}", c.state),
            created_at: c.created_at,
            last_used: c.last_used,
        })
        .collect())
}

#[tauri::command]
pub async fn remote_connect_wsl(
    distro: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let mut mgr = store.inner.lock().await;
    let id = mgr
        .connect_wsl(&distro)
        .await
        .map_err(|e| format!("WSL connect failed: {e}"))?;
    let info = mgr
        .active_connections()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection disappeared immediately".to_string())?;
    Ok(to_entry(info))
}

#[tauri::command]
pub async fn remote_connect_container(
    config_path: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let path = PathBuf::from(config_path);
    let mut mgr = store.inner.lock().await;
    let id = mgr
        .connect_container(&path)
        .await
        .map_err(|e| format!("container connect failed: {e}"))?;
    let info = mgr
        .active_connections()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection disappeared immediately".to_string())?;
    Ok(to_entry(info))
}

#[tauri::command]
pub async fn remote_connect_codespace(
    name: String,
    github_token: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let mut mgr = store.inner.lock().await;
    let id = mgr
        .connect_codespace(&name, &github_token)
        .await
        .map_err(|e| format!("codespace connect failed: {e}"))?;
    let info = mgr
        .active_connections()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection disappeared immediately".to_string())?;
    Ok(to_entry(info))
}

#[tauri::command]
pub async fn remote_disconnect(
    connection_id: u64,
    store: State<'_, RemoteManagerStore>,
) -> Result<(), String> {
    let mut mgr = store.inner.lock().await;
    mgr.disconnect(ConnectionId(connection_id))
        .await
        .map_err(|e| format!("disconnect failed: {e}"))
}

#[tauri::command]
pub async fn remote_active_connections(
    store: State<'_, RemoteManagerStore>,
) -> Result<Vec<RemoteConnectionEntry>, String> {
    let mgr = store.inner.lock().await;
    Ok(mgr.active_connections().into_iter().map(to_entry).collect())
}

#[tauri::command]
pub async fn remote_internal_set_active_folders(
    _folders: Vec<String>,
) -> Result<(), String> {
    // This is a no-op to satisfy VS Code core's remote agent logic
    // which is triggered by our spoofed identity.
    Ok(())
}
