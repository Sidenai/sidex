//! Standard filesystem paths for `SideX` extension storage.
//!
//! On Linux, follows the XDG Base Directory Specification:
//!   - Config: `$XDG_CONFIG_HOME/SideX` (default `~/.config/SideX`)
//!   - Data: `$XDG_DATA_HOME/SideX` (default `~/.local/share/SideX`)
//!
//! On macOS: `~/Library/Application Support/SideX`
//! On Windows: `%APPDATA%/SideX`

use std::path::PathBuf;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const APP_NAME: &str = "SideX";

/// Root `SideX` config directory following platform conventions.
///
/// - Linux: `$XDG_CONFIG_HOME/SideX` (default `~/.config/SideX`)
/// - macOS: `~/Library/Application Support/SideX`
/// - Windows: `%APPDATA%/SideX`
pub fn sidex_config_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".config")
            });
        base.join(APP_NAME)
    }

    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("Application Support")
            .join(APP_NAME)
    }

    #[cfg(target_os = "windows")]
    {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(APP_NAME)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(APP_NAME)
    }
}

/// Root `SideX` data directory (backward-compatible alias).
///
/// Previously this was hard-coded to `~/.sidex`. Now it returns the
/// platform-appropriate config directory.
pub fn sidex_data_dir() -> PathBuf {
    sidex_config_dir()
}

/// User-installed extensions directory.
///
/// - Linux: `$XDG_DATA_HOME/SideX/extensions` (default `~/.local/share/SideX/extensions`)
/// - macOS: `~/Library/Application Support/SideX/extensions`
/// - Windows: `%APPDATA%/SideX/extensions`
pub fn user_extensions_dir() -> PathBuf {
    let dir = extensions_base_dir().join("extensions");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Global extension storage directory.
pub fn global_storage_dir() -> PathBuf {
    let dir = sidex_config_dir()
        .join("data")
        .join("User")
        .join("globalStorage");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// User data directory.
pub fn user_data_dir() -> PathBuf {
    sidex_config_dir().join("data")
}

/// Base directory for extensions on Linux uses XDG_DATA_HOME to keep large
/// extension binaries separate from config. On other platforms, uses the
/// same directory as config.
fn extensions_base_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".local")
                    .join("share")
            });
        base.join(APP_NAME)
    }

    #[cfg(not(target_os = "linux"))]
    {
        sidex_config_dir()
    }
}

/// Node.js runtime resolution (system-only, no bundled/Tauri paths).
pub fn resolve_node_runtime() -> Result<NodeRuntime, String> {
    if let Ok(path) = std::env::var("SIDEX_NODE_BINARY") {
        if is_usable_node(&path) {
            return Ok(NodeRuntime {
                path: path.clone(),
                version: read_node_version(&path),
                source: "env",
                bundled: false,
            });
        }
    }

    let candidates = if cfg!(target_os = "windows") {
        vec!["node.exe", "node"]
    } else {
        vec![
            "node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/opt/homebrew/bin/node",
        ]
    };

    for candidate in candidates {
        if is_usable_node(candidate) {
            return Ok(NodeRuntime {
                path: candidate.to_string(),
                version: read_node_version(candidate),
                source: "system",
                bundled: false,
            });
        }
    }

    Err("Node runtime not found. Install Node.js (>=18) or set SIDEX_NODE_BINARY.".into())
}

/// Information about a resolved Node.js runtime.
#[derive(Debug, Clone)]
pub struct NodeRuntime {
    pub path: String,
    pub version: Option<String>,
    pub source: &'static str,
    pub bundled: bool,
}

fn read_node_version(binary: &str) -> Option<String> {
    let mut cmd = std::process::Command::new(binary);
    cmd.arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    cmd.output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn is_usable_node(binary: &str) -> bool {
    let mut cmd = std::process::Command::new(binary);
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    cmd.status().is_ok_and(|s| s.success())
}
