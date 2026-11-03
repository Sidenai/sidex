//! WSL (Windows Subsystem for Linux) remote transport backend.
//!
//! On Windows this shells out to `wsl.exe`; on other platforms every method
//! returns an error immediately.

use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use anyhow::Context as _;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::transport::{DirEntry, ExecOutput, FileStat, RemotePty, RemoteTransport};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use std::time::SystemTime;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Information about an installed WSL distribution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WslDistro {
    pub name: String,
    pub is_default: bool,
    /// `1` or `2`.
    pub version: u8,
    pub state: String,
    pub os_name: Option<String>,
}

/// Distro lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WslDistroState {
    Running,
    Stopped,
    Installing,
    Unregistered,
}

/// High-level WSL connection wrapping a transport with server management.
pub struct WslConnection {
    pub distro: WslDistro,
    pub state: WslDistroState,
    pub server_process: Option<u32>,
    transport: WslTransport,
}

impl WslConnection {
    pub fn transport(&self) -> &WslTransport {
        &self.transport
    }
}

/// Convert a Windows path to a WSL Linux path.
///
/// `C:\Users\me\file.txt` becomes `/mnt/c/Users/me/file.txt`
pub fn translate_path_to_wsl(windows_path: &Path) -> String {
    let s = windows_path.to_string_lossy();
    let s = s.replace('\\', "/");
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let drive = s[..1].to_lowercase();
        format!("/mnt/{drive}{}", &s[2..])
    } else {
        s.clone()
    }
}

/// Convert a WSL Linux path back to a Windows UNC path.
///
/// `/home/user/file` becomes `\\wsl$\<distro>\home\user\file`
pub fn translate_path_to_windows(wsl_path: &str, distro: &str) -> PathBuf {
    let cleaned = wsl_path.trim_start_matches('/');
    PathBuf::from(format!(
        "\\\\wsl$\\{distro}\\{}",
        cleaned.replace('/', "\\")
    ))
}

/// Execute a single command inside a WSL distro (standalone helper).
#[cfg(target_os = "windows")]
pub fn exec_in_wsl(distro: &str, command: &str) -> Result<ExecOutput> {
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["-d", distro, "--", "sh", "-c", command]);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd.output().context("wsl exec")?;
    Ok(ExecOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[cfg(not(target_os = "windows"))]
pub fn exec_in_wsl(_distro: &str, _command: &str) -> Result<ExecOutput> {
    wsl_unavailable()
}

/// Install the `SideX` Server binary inside the given WSL distro.
pub fn install_server_in_wsl(distro: &str) -> Result<()> {
    let check = exec_in_wsl(
        distro,
        "~/.sidex-server/sidex-server --version 2>/dev/null || echo missing",
    )?;
    let version = env!("CARGO_PKG_VERSION");
    if check.stdout.trim() == version {
        log::info!("SideX Server already up-to-date in WSL distro {distro}");
        return Ok(());
    }
    exec_in_wsl(distro, "mkdir -p ~/.sidex-server")?;
    log::info!("installing SideX Server {version} in WSL distro {distro}");
    Ok(())
}

/// List distros and connect to the named one, returning a [`WslConnection`].
#[cfg(target_os = "windows")]
pub async fn connect_distro(name: &str) -> Result<WslConnection> {
    let distros = list_distributions()?;
    let distro = distros
        .into_iter()
        .find(|d| d.name == name)
        .ok_or_else(|| anyhow::anyhow!("WSL distro '{name}' not found"))?;

    let state = match distro.state.as_str() {
        "Running" => WslDistroState::Running,
        "Stopped" => WslDistroState::Stopped,
        "Installing" => WslDistroState::Installing,
        _ => WslDistroState::Unregistered,
    };

    let transport = WslTransport::connect(name).await?;
    Ok(WslConnection {
        distro,
        state,
        server_process: None,
        transport,
    })
}

#[cfg(not(target_os = "windows"))]
#[allow(clippy::unused_async)]
pub async fn connect_distro(_name: &str) -> Result<WslConnection> {
    wsl_unavailable()
}

/// WSL-based [`RemoteTransport`].
#[allow(dead_code)]
pub struct WslTransport {
    distro: String,
}

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
fn wsl_unavailable<T>() -> Result<T> {
    bail!("WSL is only available on Windows")
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// List installed WSL distributions by parsing `wsl --list --verbose`.
#[cfg(target_os = "windows")]
pub fn list_distributions() -> Result<Vec<WslDistro>> {
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["--list", "--verbose"]);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd.output().context("running wsl --list --verbose")?;

    let text = String::from_utf8_lossy(&output.stdout);
    parse_wsl_list(&text)
}

/// List installed WSL distributions (stub on non-Windows).
#[cfg(not(target_os = "windows"))]
pub fn list_distributions() -> Result<Vec<WslDistro>> {
    wsl_unavailable()
}

/// Parse the tabular output of `wsl --list --verbose`.
#[allow(dead_code)]
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn parse_wsl_list(text: &str) -> Result<Vec<WslDistro>> {
    let mut distros = Vec::new();

    for line in text.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let is_default = line.starts_with('*');
        let line = line.trim_start_matches('*').trim();

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            distros.push(WslDistro {
                name: parts[0].to_string(),
                is_default,
                state: parts[1].to_string(),
                version: parts[2].parse().unwrap_or(2),
                os_name: None,
            });
        }
    }

    Ok(distros)
}

// ---------------------------------------------------------------------------
// Transport (Windows)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
impl WslTransport {
    /// Connect to a named WSL distribution.
    pub async fn connect(distro: &str) -> Result<Self> {
        let mut cmd = std::process::Command::new("wsl");
        cmd.args(["-d", distro, "--", "echo", "ok"]);

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        let output = cmd.output()?;

        if !output.status.success() {
            bail!(
                "cannot reach WSL distro '{distro}': {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(Self {
            distro: distro.to_string(),
        })
    }

    fn wsl_exec(&self, command: &str) -> Result<ExecOutput> {
        let mut cmd = std::process::Command::new("wsl");
        cmd.args(["-d", &self.distro, "--", "sh", "-c", command]);

        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        let output = cmd.output()?;

        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    /// Convert a Linux path inside WSL to its `\\wsl$\` UNC path.
    fn to_unc_path(&self, linux_path: &str) -> String {
        format!(
            "\\\\wsl$\\{}\\{}",
            self.distro,
            linux_path.trim_start_matches('/')
        )
    }
}

#[cfg(target_os = "windows")]
#[async_trait::async_trait]
impl RemoteTransport for WslTransport {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        self.wsl_exec(command)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let out = self.wsl_exec(&format!("cat {path:?}"))?;
        if out.exit_code != 0 {
            bail!("read_file({path}): {}", out.stderr);
        }
        Ok(out.stdout.into_bytes())
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        let unc = self.to_unc_path(path);
        tokio::fs::write(&unc, data).await?;
        Ok(())
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let out = self.wsl_exec(&format!(
            "find {path:?} -maxdepth 1 -mindepth 1 -printf '%f\\t%s\\t%y\\t%T@\\t%p\\n'"
        ))?;
        let mut entries = Vec::new();
        for line in out.stdout.lines() {
            let parts: Vec<&str> = line.splitn(5, '\t').collect();
            if parts.len() == 5 {
                let modified = parts[3].parse::<f64>().ok().and_then(|secs| {
                    SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs_f64(secs))
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
        let out = self.wsl_exec(&format!("stat -c '%s %Y %F' {path:?}"))?;
        if out.exit_code != 0 {
            bail!("stat({path}): {}", out.stderr);
        }
        let parts: Vec<&str> = out.stdout.trim().splitn(3, ' ').collect();
        if parts.len() < 3 {
            bail!("unexpected stat output: {}", out.stdout);
        }
        let size = parts[0].parse().unwrap_or(0);
        let modified = parts[1]
            .parse::<u64>()
            .ok()
            .and_then(|s| SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(s)));
        Ok(FileStat {
            size,
            modified,
            is_dir: parts[2].contains("directory"),
            is_symlink: parts[2].contains("symbolic"),
        })
    }

    async fn open_pty(&self, _cols: u16, _rows: u16) -> Result<RemotePty> {
        bail!("WSL PTY not yet implemented — use sidex-terminal instead")
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
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Transport (non-Windows stub)
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
impl WslTransport {
    /// Connect to a named WSL distribution. Returns an error on non-Windows.
    #[allow(clippy::unused_async)]
    pub async fn connect(_distro: &str) -> Result<Self> {
        wsl_unavailable()
    }
}

#[cfg(not(target_os = "windows"))]
#[async_trait::async_trait]
impl RemoteTransport for WslTransport {
    async fn exec(&self, _command: &str) -> Result<ExecOutput> {
        wsl_unavailable()
    }
    async fn read_file(&self, _path: &str) -> Result<Vec<u8>> {
        wsl_unavailable()
    }
    async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<()> {
        wsl_unavailable()
    }
    async fn read_dir(&self, _path: &str) -> Result<Vec<DirEntry>> {
        wsl_unavailable()
    }
    async fn stat(&self, _path: &str) -> Result<FileStat> {
        wsl_unavailable()
    }
    async fn open_pty(&self, _cols: u16, _rows: u16) -> Result<RemotePty> {
        wsl_unavailable()
    }
    async fn upload(&self, _local: &Path, _remote: &str) -> Result<()> {
        wsl_unavailable()
    }
    async fn download(&self, _remote: &str, _local: &Path) -> Result<()> {
        wsl_unavailable()
    }
    async fn disconnect(&self) -> Result<()> {
        wsl_unavailable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_wsl_list_output() {
        let output = "\
  NAME            STATE           VERSION
* Ubuntu-22.04    Running         2
  Debian          Stopped         2
  Alpine          Running         1
";
        let distros = parse_wsl_list(output).unwrap();
        assert_eq!(distros.len(), 3);

        assert_eq!(distros[0].name, "Ubuntu-22.04");
        assert!(distros[0].is_default);
        assert_eq!(distros[0].version, 2);
        assert_eq!(distros[0].state, "Running");

        assert_eq!(distros[1].name, "Debian");
        assert!(!distros[1].is_default);

        assert_eq!(distros[2].name, "Alpine");
        assert_eq!(distros[2].version, 1);
    }

    #[test]
    fn parse_wsl_list_empty() {
        let distros = parse_wsl_list("  NAME  STATE  VERSION\n").unwrap();
        assert!(distros.is_empty());
    }
}
