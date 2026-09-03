use serde::Serialize;
use std::env;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize)]
pub struct OsInfo {
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub homedir: String,
    pub tmpdir: String,
}

#[tauri::command]
pub fn get_os_info() -> Result<OsInfo, String> {
    Ok(OsInfo {
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        hostname: hostname::get().map_or_else(
            |_| "unknown".to_string(),
            |h| h.to_string_lossy().to_string(),
        ),
        homedir: dirs::home_dir().map_or_else(
            || "unknown".to_string(),
            |p| p.to_string_lossy().to_string(),
        ),
        tmpdir: env::temp_dir().to_string_lossy().to_string(),
    })
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_env(key: String) -> Result<Option<String>, String> {
    Ok(env::var(&key).ok())
}

const SENSITIVE_ENV_PATTERNS: &[&str] = &[
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "API_KEY",
    "APIKEY",
    "AUTH",
    "AWS_",
    "AZURE_",
    "GCP_",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "DOCKER_PASSWORD",
    "SSH_",
    "GPG_",
];

#[tauri::command]
pub fn get_all_env() -> Result<std::collections::HashMap<String, String>, String> {
    Ok(env::vars()
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            !SENSITIVE_ENV_PATTERNS.iter().any(|p| upper.contains(p))
        })
        .collect())
}

#[tauri::command]
pub fn get_shell() -> Result<String, String> {
    Ok(env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            super::terminal::resolve_windows_shell()
        } else {
            "/bin/sh".to_string()
        }
    }))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn get_user_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let user_dir = resolve_user_data_dir(&app)?;
    std::fs::create_dir_all(&user_dir)
        .map_err(|e| format!("failed to create UserData dir: {e}"))?;
    Ok(user_dir.to_string_lossy().to_string())
}

pub(crate) fn resolve_user_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    if let Some(config_dir) = dirs::config_dir() {
        return Ok(config_dir.join("SideX").join("UserData"));
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(dir.join("UserData"))
}
