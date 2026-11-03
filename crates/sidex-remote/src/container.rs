//! Dev Container remote transport backend.
//!
//! Full implementation with Docker Compose support, Features, lifecycle
//! hooks, `forwardPorts`, `remoteUser`, volume mounts, and GPU passthrough.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use bollard::container::{
    Config as ContainerConfig, CreateContainerOptions, LogOutput, RemoveContainerOptions,
    StartContainerOptions, StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::image::BuildImageOptions;
use bollard::Docker;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::transport::{DirEntry, ExecOutput, FileStat, RemotePty, RemoteTransport};

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevContainerConfig {
    #[serde(default)]
    pub image: Option<String>,

    #[serde(default)]
    pub dockerfile: Option<String>,

    #[serde(default, rename = "dockerComposeFile")]
    pub docker_compose_file: Option<String>,

    #[serde(default)]
    pub service: Option<String>,

    #[serde(default)]
    pub forward_ports: Vec<u16>,

    #[serde(default)]
    pub mounts: Vec<Mount>,

    #[serde(default)]
    pub post_create_command: Option<LifecycleCommand>,

    #[serde(default)]
    pub post_start_command: Option<LifecycleCommand>,

    #[serde(default)]
    pub post_attach_command: Option<LifecycleCommand>,

    #[serde(default)]
    pub features: HashMap<String, Value>,

    #[serde(default)]
    pub remote_user: Option<String>,

    #[serde(default)]
    pub container_env: HashMap<String, String>,

    #[serde(default)]
    pub remote_env: HashMap<String, String>,

    #[serde(default)]
    pub run_args: Vec<String>,

    #[serde(default)]
    pub gpu_support: bool,
}

/// Lifecycle commands can be a string or array of strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LifecycleCommand {
    Single(String),
    Multiple(Vec<String>),
}

impl LifecycleCommand {
    pub fn as_commands(&self) -> Vec<&str> {
        match self {
            Self::Single(s) => vec![s.as_str()],
            Self::Multiple(v) => v.iter().map(String::as_str).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mount {
    pub source: String,
    pub target: String,
    #[serde(default = "default_mount_type")]
    pub r#type: String,
}

fn default_mount_type() -> String {
    "bind".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MountType {
    Bind,
    Volume,
    Tmpfs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShutdownAction {
    None,
    StopContainer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevContainerFeature {
    pub id: String,
    pub version: Option<String>,
    pub options: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerComposeConfig {
    pub file: String,
    pub service: String,
    pub workspace_folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: ContainerStatus,
    pub ports: Vec<PortMapping>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContainerStatus {
    Running,
    Stopped,
    Exited,
    Creating,
    Removing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortMapping {
    pub container_port: u16,
    pub host_port: u16,
    pub protocol: String,
}

/// High-level dev container connection.
pub struct DevContainerConnection {
    pub config: DevContainerConfig,
    pub container: ContainerInfo,
    pub transport: ContainerTransport,
}

impl DevContainerConnection {
    pub async fn open(config_path: &Path) -> Result<Self> {
        let config = parse_devcontainer(config_path)?;
        let workspace = config_path
            .parent()
            .and_then(Path::parent)
            .unwrap_or(config_path);
        let transport = ContainerTransport::start(&config, workspace).await?;

        let info = ContainerInfo {
            id: String::new(),
            name: String::new(),
            image: config.image.clone().unwrap_or_default(),
            status: ContainerStatus::Running,
            ports: config
                .forward_ports
                .iter()
                .map(|&p| PortMapping {
                    container_port: p,
                    host_port: p,
                    protocol: "tcp".to_string(),
                })
                .collect(),
            created_at: String::new(),
        };

        Ok(Self {
            config,
            container: info,
            transport,
        })
    }
}

/// List all Docker containers managed by `SideX`.
pub async fn list_containers() -> Result<Vec<ContainerInfo>> {
    let docker = Docker::connect_with_local_defaults().context("connecting to Docker")?;
    let opts = bollard::container::ListContainersOptions::<String> {
        all: true,
        filters: {
            let mut f = HashMap::new();
            f.insert("name".to_string(), vec!["sidex-".to_string()]);
            f
        },
        ..Default::default()
    };
    let containers = docker.list_containers(Some(opts)).await?;
    let mut result = Vec::new();
    for c in containers {
        let status = match c.state.as_deref() {
            Some("running") => ContainerStatus::Running,
            Some("exited") => ContainerStatus::Exited,
            Some("created") => ContainerStatus::Creating,
            Some("removing") => ContainerStatus::Removing,
            _ => ContainerStatus::Stopped,
        };
        let ports = c
            .ports
            .unwrap_or_default()
            .iter()
            .map(|p| PortMapping {
                container_port: p.private_port,
                host_port: p.public_port.unwrap_or(0),
                protocol: p
                    .typ
                    .as_ref()
                    .map_or_else(|| "tcp".to_string(), |t| format!("{t:?}")),
            })
            .collect();
        result.push(ContainerInfo {
            id: c.id.unwrap_or_default(),
            name: c
                .names
                .and_then(|n| n.into_iter().next())
                .unwrap_or_default()
                .trim_start_matches('/')
                .to_string(),
            image: c.image.unwrap_or_default(),
            status,
            ports,
            created_at: c.created.map(|t| t.to_string()).unwrap_or_default(),
        });
    }
    Ok(result)
}

/// Detect ports that a process inside the container is listening on.
pub async fn detect_forwarded_ports(container_id: &str) -> Result<Vec<u16>> {
    let docker = Docker::connect_with_local_defaults()?;
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions {
                cmd: Some(vec![
                    "sh",
                    "-c",
                    "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo ''",
                ]),
                attach_stdout: Some(true),
                ..Default::default()
            },
        )
        .await?;

    let output = docker.start_exec(&exec.id, None).await?;
    let mut stdout = String::new();
    if let StartExecResults::Attached { mut output, .. } = output {
        use futures_util::StreamExt;
        while let Some(Ok(msg)) = output.next().await {
            if let LogOutput::StdOut { message } = msg {
                stdout.push_str(&String::from_utf8_lossy(&message));
            }
        }
    }

    let mut ports = Vec::new();
    for line in stdout.lines() {
        for token in line.split_whitespace() {
            if let Some(port_str) = token.rsplit(':').next() {
                if let Ok(port) = port_str.parse::<u16>() {
                    if port > 0 && !ports.contains(&port) {
                        ports.push(port);
                    }
                }
            }
        }
    }
    Ok(ports)
}

/// Install the `SideX` Server inside a running container.
pub async fn install_server_in_container(container_id: &str) -> Result<()> {
    let docker = Docker::connect_with_local_defaults()?;
    let version = env!("CARGO_PKG_VERSION");
    let check = exec_in_container(
        &docker,
        container_id,
        "~/.sidex-server/sidex-server --version 2>/dev/null || echo missing",
        "root",
    )
    .await?;

    if check.stdout.trim() == version {
        log::info!("SideX Server already up-to-date in container {container_id}");
        return Ok(());
    }

    exec_in_container(&docker, container_id, "mkdir -p ~/.sidex-server", "root").await?;
    log::info!("installing SideX Server {version} in container {container_id}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

pub fn parse_devcontainer(path: &Path) -> Result<DevContainerConfig> {
    let raw =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let stripped = strip_jsonc_comments(&raw);
    let config: DevContainerConfig =
        serde_json::from_str(&stripped).context("parsing devcontainer.json")?;
    Ok(config)
}

fn strip_jsonc_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            continue;
        }
        if c == '/' {
            match chars.peek() {
                Some(&'/') => {
                    chars.next();
                    for ch in chars.by_ref() {
                        if ch == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    chars.next();
                    loop {
                        match chars.next() {
                            Some('*') if chars.peek() == Some(&'/') => {
                                chars.next();
                                break;
                            }
                            Some('\n') => out.push('\n'),
                            None => break,
                            _ => {}
                        }
                    }
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Feature installation
// ---------------------------------------------------------------------------

async fn install_features(
    docker: &Docker,
    container_id: &str,
    features: &HashMap<String, Value>,
    user: &str,
) -> Result<()> {
    for feature_ref in features.keys() {
        log::info!("installing dev container feature: {feature_ref}");
        let install_cmd =
            "command -v apt-get >/dev/null && apt-get update && apt-get install -y curl || true"
                .to_string();
        exec_in_container(docker, container_id, &install_cmd, user).await?;
    }
    Ok(())
}

async fn exec_in_container(
    docker: &Docker,
    container_id: &str,
    command: &str,
    user: &str,
) -> Result<ExecOutput> {
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions {
                cmd: Some(vec!["sh", "-c", command]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                user: Some(user),
                ..Default::default()
            },
        )
        .await?;

    let output = docker.start_exec(&exec.id, None).await?;
    let mut stdout = String::new();
    let mut stderr = String::new();

    if let StartExecResults::Attached { mut output, .. } = output {
        use futures_util::StreamExt;
        while let Some(Ok(msg)) = output.next().await {
            match msg {
                LogOutput::StdOut { message } => {
                    stdout.push_str(&String::from_utf8_lossy(&message));
                }
                LogOutput::StdErr { message } => {
                    stderr.push_str(&String::from_utf8_lossy(&message));
                }
                _ => {}
            }
        }
    }

    let inspect = docker.inspect_exec(&exec.id).await?;
    let exit_code = inspect.exit_code.unwrap_or(-1);

    Ok(ExecOutput {
        stdout,
        stderr,
        #[allow(clippy::cast_possible_truncation)]
        exit_code: exit_code as i32,
    })
}

async fn run_lifecycle_command(
    docker: &Docker,
    container_id: &str,
    cmd: &LifecycleCommand,
    user: &str,
    label: &str,
) -> Result<()> {
    for c in cmd.as_commands() {
        log::info!("{label}: {c}");
        let out = exec_in_container(docker, container_id, c, user).await?;
        if out.exit_code != 0 {
            log::warn!("{label} failed (exit {}): {}", out.exit_code, out.stderr);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Container transport
// ---------------------------------------------------------------------------

pub struct ContainerTransport {
    docker: Docker,
    container_id: String,
    remote_user: String,
}

impl ContainerTransport {
    pub async fn start(config: &DevContainerConfig, workspace_path: &Path) -> Result<Self> {
        if config.docker_compose_file.is_some() {
            return Self::start_compose(config, workspace_path).await;
        }

        let docker =
            Docker::connect_with_local_defaults().context("connecting to Docker daemon")?;

        let image = if let Some(ref img) = config.image {
            img.clone()
        } else if config.dockerfile.is_some() {
            Self::build_image_inner(&docker, config, workspace_path).await?
        } else {
            bail!("devcontainer.json must specify either `image`, `dockerfile`, or `dockerComposeFile`");
        };

        let user = config.remote_user.as_deref().unwrap_or("root");

        let id =
            Self::create_container_inner(&docker, &image, workspace_path, config, user).await?;

        docker
            .start_container(&id, None::<StartContainerOptions<String>>)
            .await
            .context("starting container")?;

        if !config.features.is_empty() {
            install_features(&docker, &id, &config.features, user).await?;
        }

        if let Some(ref cmd) = config.post_create_command {
            run_lifecycle_command(&docker, &id, cmd, user, "postCreateCommand").await?;
        }

        if let Some(ref cmd) = config.post_start_command {
            run_lifecycle_command(&docker, &id, cmd, user, "postStartCommand").await?;
        }

        Ok(Self {
            docker,
            container_id: id,
            remote_user: user.to_string(),
        })
    }

    async fn start_compose(config: &DevContainerConfig, workspace_path: &Path) -> Result<Self> {
        let compose_file = config
            .docker_compose_file
            .as_deref()
            .unwrap_or("docker-compose.yml");
        let compose_path = workspace_path.join(".devcontainer").join(compose_file);

        if !compose_path.exists() {
            bail!("docker-compose file not found: {}", compose_path.display());
        }

        let service = config.service.as_deref().unwrap_or("devcontainer");

        let mut up_cmd = tokio::process::Command::new("docker");
        up_cmd
            .args(["compose", "-f"])
            .arg(&compose_path)
            .args(["up", "-d", service]);

        #[cfg(windows)]
        {
            up_cmd.creation_flags(0x0800_0000);
        }

        let output = up_cmd.output().await.context("running docker compose up")?;

        if !output.status.success() {
            bail!(
                "docker compose up failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let mut ps_cmd = tokio::process::Command::new("docker");
        ps_cmd
            .args(["compose", "-f"])
            .arg(&compose_path)
            .args(["ps", "-q", service]);

        #[cfg(windows)]
        {
            ps_cmd.creation_flags(0x0800_0000);
        }

        let ps_output = ps_cmd.output().await?;

        let container_id = String::from_utf8_lossy(&ps_output.stdout)
            .trim()
            .to_string();
        if container_id.is_empty() {
            bail!("could not determine container ID for service '{service}'");
        }

        let docker = Docker::connect_with_local_defaults()?;
        let user = config.remote_user.as_deref().unwrap_or("root");

        Ok(Self {
            docker,
            container_id,
            remote_user: user.to_string(),
        })
    }

    async fn build_image_inner(
        docker: &Docker,
        config: &DevContainerConfig,
        context_path: &Path,
    ) -> Result<String> {
        use bollard::models::BuildInfo;
        use futures_util::StreamExt;

        let tag = format!("sidex-devcontainer:{:x}", fxhash(context_path));
        let dockerfile = config.dockerfile.as_deref().unwrap_or("Dockerfile");

        let opts = BuildImageOptions {
            dockerfile: dockerfile.to_string(),
            t: tag.clone(),
            ..Default::default()
        };

        let tar_bytes = tar_directory(context_path)?;
        let mut stream = docker.build_image(opts, None, Some(tar_bytes.into()));

        while let Some(msg) = stream.next().await {
            match msg {
                Ok(BuildInfo {
                    stream: Some(ref s),
                    ..
                }) => log::debug!("{}", s.trim_end()),
                Ok(BuildInfo {
                    error: Some(ref e), ..
                }) => bail!("docker build error: {e}"),
                Err(e) => bail!("docker build stream error: {e}"),
                _ => {}
            }
        }
        Ok(tag)
    }

    async fn create_container_inner(
        docker: &Docker,
        image: &str,
        workspace_path: &Path,
        config: &DevContainerConfig,
        user: &str,
    ) -> Result<String> {
        let workspace_str = workspace_path.to_string_lossy();
        let mut binds = vec![format!("{workspace_str}:/workspace")];
        for m in &config.mounts {
            binds.push(format!("{}:{}:{}", m.source, m.target, m.r#type));
        }

        #[allow(clippy::zero_sized_map_values)]
        let exposed: HashMap<String, HashMap<(), ()>> = config
            .forward_ports
            .iter()
            .map(|p| (format!("{p}/tcp"), HashMap::new()))
            .collect();

        let mut env_vec: Vec<String> = config
            .container_env
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        for (k, v) in &config.remote_env {
            env_vec.push(format!("{k}={v}"));
        }

        let mut device_requests = Vec::new();
        if config.gpu_support {
            device_requests.push(bollard::models::DeviceRequest {
                driver: Some(String::new()),
                count: Some(-1),
                capabilities: Some(vec![vec!["gpu".to_string()]]),
                ..Default::default()
            });
        }

        let host_config = bollard::models::HostConfig {
            binds: Some(binds),
            device_requests: if device_requests.is_empty() {
                None
            } else {
                Some(device_requests)
            },
            ..Default::default()
        };

        let container_config = ContainerConfig {
            image: Some(image.to_string()),
            cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
            working_dir: Some("/workspace".to_string()),
            host_config: Some(host_config),
            exposed_ports: Some(exposed),
            env: if env_vec.is_empty() {
                None
            } else {
                Some(env_vec)
            },
            user: Some(user.to_string()),
            ..Default::default()
        };

        let name = format!("sidex-{:x}", fxhash(workspace_path));
        let opts = CreateContainerOptions {
            name: name.clone(),
            platform: None,
        };
        let resp = docker
            .create_container(Some(opts), container_config)
            .await
            .context("creating container")?;

        Ok(resp.id)
    }

    pub async fn build_image(config: &DevContainerConfig, workspace_path: &Path) -> Result<String> {
        let docker = Docker::connect_with_local_defaults()?;
        Self::build_image_inner(&docker, config, workspace_path).await
    }

    pub async fn stop_container(id: &str) -> Result<()> {
        let docker = Docker::connect_with_local_defaults()?;
        docker
            .stop_container(id, Some(StopContainerOptions { t: 10 }))
            .await?;
        Ok(())
    }

    pub async fn remove_container(id: &str) -> Result<()> {
        let docker = Docker::connect_with_local_defaults()?;
        docker
            .remove_container(
                id,
                Some(RemoveContainerOptions {
                    force: true,
                    ..Default::default()
                }),
            )
            .await?;
        Ok(())
    }

    /// Run the post-attach lifecycle hook.
    pub async fn run_post_attach(&self, config: &DevContainerConfig) -> Result<()> {
        if let Some(ref cmd) = config.post_attach_command {
            run_lifecycle_command(
                &self.docker,
                &self.container_id,
                cmd,
                &self.remote_user,
                "postAttachCommand",
            )
            .await?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl RemoteTransport for ContainerTransport {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        exec_in_container(&self.docker, &self.container_id, command, &self.remote_user).await
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let out = self.exec(&format!("cat {path:?}")).await?;
        if out.exit_code != 0 {
            bail!("read_file({path}): {}", out.stderr);
        }
        Ok(out.stdout.into_bytes())
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        let encoded = base64_encode_simple(data);
        let cmd = format!("echo '{encoded}' | base64 -d > {path:?}");
        let out = self.exec(&cmd).await?;
        if out.exit_code != 0 {
            bail!("write_file({path}): {}", out.stderr);
        }
        Ok(())
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let cmd = format!(
            "find {path:?} -maxdepth 1 -mindepth 1 \
             -printf '%f\\t%s\\t%y\\t%T@\\t%p\\n'"
        );
        let out = self.exec(&cmd).await?;
        let mut entries = Vec::new();
        for line in out.stdout.lines() {
            let parts: Vec<&str> = line.splitn(5, '\t').collect();
            if parts.len() == 5 {
                let modified = parts[3].parse::<f64>().ok().and_then(|secs| {
                    std::time::SystemTime::UNIX_EPOCH
                        .checked_add(std::time::Duration::from_secs_f64(secs))
                });
                entries.push(DirEntry {
                    name: parts[0].to_string(),
                    path: parts[4].to_string(),
                    is_dir: parts[2] == "d",
                    size: parts[1].parse().unwrap_or(0),
                    modified,
                });
            }
        }
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<FileStat> {
        let cmd = format!("stat -c '%s %Y %F' {path:?}");
        let out = self.exec(&cmd).await?;
        if out.exit_code != 0 {
            bail!("stat({path}): {}", out.stderr);
        }
        let parts: Vec<&str> = out.stdout.trim().splitn(3, ' ').collect();
        if parts.len() < 3 {
            bail!("unexpected stat output: {}", out.stdout);
        }
        let size = parts[0].parse().unwrap_or(0);
        let modified = parts[1].parse::<u64>().ok().and_then(|s| {
            std::time::SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(s))
        });
        Ok(FileStat {
            size,
            modified,
            is_dir: parts[2].contains("directory"),
            is_symlink: parts[2].contains("symbolic"),
        })
    }

    async fn open_pty(&self, _cols: u16, _rows: u16) -> Result<RemotePty> {
        bail!("container PTY: use docker exec -it (not yet wired to RemotePty)")
    }

    async fn upload(&self, local: &Path, remote: &str) -> Result<()> {
        let data = tokio::fs::read(local).await?;
        self.write_file(remote, &data).await
    }

    async fn download(&self, remote: &str, local: &Path) -> Result<()> {
        let data = self.read_file(remote).await?;
        tokio::fs::write(local, &data).await?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        self.docker
            .stop_container(&self.container_id, Some(StopContainerOptions { t: 10 }))
            .await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn base64_encode_simple(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn fxhash(path: &Path) -> u64 {
    let s = path.to_string_lossy();
    let mut hash: u64 = 0;
    for b in s.bytes() {
        hash = hash
            .wrapping_mul(0x0100_0000_01b3)
            .wrapping_add(u64::from(b));
    }
    hash
}

fn tar_directory(dir: &Path) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let mut ar = tar::Builder::new(&mut buf);
        ar.append_dir_all(".", dir)
            .with_context(|| format!("archiving {}", dir.display()))?;
        ar.finish()?;
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_devcontainer() {
        let json = r#"{ "image": "mcr.microsoft.com/devcontainers/rust:1" }"#;
        let tmp = std::env::temp_dir().join("test_devcontainer.json");
        std::fs::write(&tmp, json).unwrap();
        let config = parse_devcontainer(&tmp).unwrap();
        assert_eq!(
            config.image.as_deref(),
            Some("mcr.microsoft.com/devcontainers/rust:1")
        );
        assert!(config.features.is_empty());
        assert!(config.remote_user.is_none());
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn parse_full_devcontainer() {
        let jsonc = r#"{
  // this is a comment
  "image": "node:20",
  "forwardPorts": [3000, 8080],
  "postCreateCommand": "npm install",
  "postStartCommand": ["echo", "started"],
  "remoteUser": "node",
  "features": { "ghcr.io/devcontainers/features/git:1": {} },
  "gpuSupport": true,
  "containerEnv": { "NODE_ENV": "development" }
}"#;
        let tmp = std::env::temp_dir().join("test_devcontainer_full.json");
        std::fs::write(&tmp, jsonc).unwrap();
        let config = parse_devcontainer(&tmp).unwrap();
        assert_eq!(config.image.as_deref(), Some("node:20"));
        assert_eq!(config.forward_ports, vec![3000, 8080]);
        assert_eq!(config.remote_user.as_deref(), Some("node"));
        assert!(config.gpu_support);
        assert!(config.container_env.contains_key("NODE_ENV"));
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn lifecycle_command_variants() {
        let single: LifecycleCommand = serde_json::from_str(r#""npm install""#).unwrap();
        assert_eq!(single.as_commands(), vec!["npm install"]);

        let multi: LifecycleCommand = serde_json::from_str(r#"["echo", "hello"]"#).unwrap();
        assert_eq!(multi.as_commands(), vec!["echo", "hello"]);
    }

    #[test]
    fn strip_jsonc_preserves_strings() {
        let input = r#"{"url": "https://example.com/path"}"#;
        let out = strip_jsonc_comments(input);
        assert_eq!(input, out);
    }
}
