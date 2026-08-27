use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

pub struct TerminalStore {
    terminals: Mutex<HashMap<u32, PtyHandle>>,
    next_id: Mutex<u32>,
}

impl TerminalStore {
    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct TerminalDataEvent {
    terminal_id: u32,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalExitEvent {
    terminal_id: u32,
    exit_code: i32,
}

// Environment variables that describe the shell session SideX was launched from.
// They only exist when the app is started from a terminal, so a terminal opened
// after a CLI launch behaves differently from one opened after a menu launch,
// where the app starts from the clean desktop session environment instead.
//
// VTE_VERSION is the one confirmed to break a real setup (issue #112): a
// gnome-terminal launch leaks it into the app, and the spawned login shell then
// runs /etc/profile.d/vte-2.91.sh. That script appends to PROMPT_COMMAND when it
// is an array and overwrites it otherwise, and a prompt framework initialised
// earlier from /etc/profile.d - starship, in the reported setup - leaves it a
// plain string, so the overwrite wins and the prompt stays at the distro default
// while the rest of the shell config still applies. It has no business being
// forwarded regardless - this terminal renders through xterm.js, not VTE, so
// claiming a VTE version also makes bash emit VTE title sequences every prompt.
//
// The rest are the same class of leak rather than reports in their own right.
// Each was checked against an actual shell to confirm it can break prompt setup,
// but none of them is the cause of #112.
const SESSION_SCOPED_ENV_VARS: &[&str] = &[
    "PS0",
    "PS1",
    "PS2",
    "PS3",
    "PS4",
    "PROMPT",
    "PROMPT_COMMAND",
    "RPROMPT",
    "RPS1",
    "STARSHIP_DURATION",
    "STARSHIP_JOBS_COUNT",
    "STARSHIP_PREEXEC_READY",
    "STARSHIP_SESSION_KEY",
    "STARSHIP_SHELL",
    "STARSHIP_START_TIME",
    // Prompt frameworks detect bash-preexec by name. If one of these arrives in
    // the environment without bash-preexec actually being loaded, starship's init
    // takes its bash-preexec branch and registers into precmd_functions instead of
    // PROMPT_COMMAND - arrays nothing ever runs - so the prompt is never drawn
    // while the rest of .bashrc still takes effect. Reproduced by presetting any
    // one of these; not what happens in #112, but the same failure.
    "__bp_imported",
    "bash_preexec_imported",
    "precmd_functions",
    "preexec_functions",
    // Same story for ble.sh detection.
    "BLE_ATTACHED",
    "BLE_VERSION",
    "_ble_version",
    "BASH_ENV",
    "ENV",
    "SHLVL",
    "OLDPWD",
    "_",
    "VTE_VERSION",
    "VSCODE_INJECTION",
    "VSCODE_NONCE",
    "VSCODE_SHELL_ENV_REPORTING",
    "VSCODE_SHELL_INTEGRATION",
    "VSCODE_SHELL_LOGIN",
];

// Exported bash functions travel as BASH_FUNC_<name>%% and bring the previous
// session's prompt hooks along with them.
const SESSION_SCOPED_ENV_PREFIXES: &[&str] = &["BASH_FUNC_"];

fn is_session_scoped_env(key: &str) -> bool {
    SESSION_SCOPED_ENV_VARS.contains(&key)
        || SESSION_SCOPED_ENV_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

// Config the user opted into (STARSHIP_CONFIG, TERM, PATH, ...) is left alone;
// only the per-session leftovers listed above are removed.
fn drop_session_scoped_env(cmd: &mut CommandBuilder) {
    let stale: Vec<String> = cmd
        .iter_full_env_as_str()
        .map(|(key, _)| key.to_string())
        .filter(|key| is_session_scoped_env(key))
        .collect();

    for key in stale {
        cmd.env_remove(key);
    }
}

pub(crate) fn resolve_windows_shell() -> String {
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if let Ok(path) = which::which(candidate) {
            return path.to_string_lossy().to_string();
        }
    }

    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
}

#[cfg(target_os = "windows")]
fn is_git_bash_path(path: &std::path::Path) -> bool {
    let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
}

#[cfg(target_os = "windows")]
fn resolve_git_bash() -> Option<String> {
    let mut candidates = Vec::new();

    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key) {
            let root = std::path::PathBuf::from(root);
            candidates.push(root.join("Git").join("bin").join("bash.exe"));
            candidates.push(root.join("Git").join("usr").join("bin").join("bash.exe"));
            candidates.push(
                root.join("Programs")
                    .join("Git")
                    .join("bin")
                    .join("bash.exe"),
            );
            candidates.push(
                root.join("Programs")
                    .join("Git")
                    .join("usr")
                    .join("bin")
                    .join("bash.exe"),
            );
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("bash.exe"));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists() && is_git_bash_path(path))
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(
    clippy::too_many_lines,
    clippy::needless_pass_by_value,
    clippy::too_many_arguments
)]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, Arc<TerminalStore>>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pty_cols = cols.unwrap_or(80);
    let pty_rows = rows.unwrap_or(24);

    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    #[allow(unused_mut)]
    let mut shell_path = shell.unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            resolve_windows_shell()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        }
    });

    #[cfg(target_os = "windows")]
    if std::path::Path::new(&shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("bash.exe"))
        && !is_git_bash_path(std::path::Path::new(&shell_path))
    {
        if let Some(git_bash) = resolve_git_bash() {
            shell_path = git_bash;
        }
    }

    if !cfg!(target_os = "windows") {
        let path = std::path::Path::new(&shell_path);
        if !path.exists() {
            let fallbacks = ["/bin/zsh", "/bin/bash", "/bin/sh"];
            for fb in &fallbacks {
                if std::path::Path::new(fb).exists() {
                    return terminal_spawn(
                        app,
                        state,
                        Some(fb.to_string()),
                        args,
                        cwd,
                        env,
                        cols,
                        rows,
                    );
                }
            }
            return Err(format!(
                "Shell '{shell_path}' not found, and no fallback shell available"
            ));
        }
    }

    let mut cmd = CommandBuilder::new(&shell_path);

    if let Some(ref shell_args) = args {
        for arg in shell_args {
            cmd.arg(arg);
        }
    } else {
        let shell_basename = std::path::Path::new(&shell_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        match shell_basename {
            "zsh" | "bash" | "sh" | "fish" => {
                cmd.arg("-l");
            }
            _ => {}
        }
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "SideX");

    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }
    if cfg!(target_os = "windows") {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            cmd.env("USERPROFILE", &profile);
            if std::env::var("HOME").is_err() {
                cmd.env("HOME", &profile);
            }
        }
        for key in &[
            "USERNAME",
            "APPDATA",
            "LOCALAPPDATA",
            "HOMEDRIVE",
            "HOMEPATH",
            "COMSPEC",
            "SystemRoot",
        ] {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, &val);
            }
        }
    } else if let Ok(user) = std::env::var("USER") {
        cmd.env("USER", &user);
    }
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", &path);
    }
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", &lang);
    } else if !cfg!(target_os = "windows") {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(ref dir) = cwd {
        if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
            cmd.cwd(dir);
        } else if let Some(home) = home_dir_string() {
            cmd.cwd(&home);
        }
    } else if let Some(home) = home_dir_string() {
        cmd.cwd(&home);
    }

    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    // Runs last so it also covers the env map the frontend sends, which is built
    // from this process' own environment.
    drop_session_scoped_env(&mut cmd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{shell_path}': {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let id = {
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        let id = *next;
        *next += 1;
        id
    };

    {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.insert(
            id,
            PtyHandle {
                writer,
                master: pair.master,
                child,
            },
        );
    }

    let terminal_id = id;
    let state_clone = state.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(
                        "terminal-data",
                        TerminalDataEvent {
                            terminal_id,
                            data: text,
                        },
                    );
                }
                Ok(_) | Err(_) => break,
            }
        }

        let exit_code = {
            let Ok(mut terminals) = state_clone.terminals.lock() else {
                let _ = app.emit(
                    "terminal-exit",
                    TerminalExitEvent {
                        terminal_id,
                        exit_code: -1,
                    },
                );
                return;
            };
            let code = if let Some(handle) = terminals.get_mut(&terminal_id) {
                match handle.child.try_wait() {
                    Ok(Some(status)) => i32::from(!status.success()),
                    _ => 0,
                }
            } else {
                0
            };
            terminals.remove(&terminal_id);
            code
        };

        let _ = app.emit(
            "terminal-exit",
            TerminalExitEvent {
                terminal_id,
                exit_code,
            },
        );
    });

    Ok(id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_write(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
    data: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to terminal {terminal_id}: {e}"))?;

    handle
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_resize(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_kill(state: State<'_, Arc<TerminalStore>>, terminal_id: u32) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let mut handle = terminals
        .remove(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    handle
        .child
        .kill()
        .map_err(|e| format!("Failed to kill terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_get_pid(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
) -> Result<u32, String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    let pid = handle
        .child
        .process_id()
        .ok_or_else(|| "Process ID not available".to_string())?;

    Ok(pid)
}

fn home_dir_string() -> Option<String> {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
    } else {
        std::env::var("HOME").ok()
    }
}

#[tauri::command]
pub fn get_default_shell() -> String {
    if cfg!(target_os = "windows") {
        return resolve_windows_shell();
    }

    // 1. Check $SHELL (same as VS Code: shell.ts getSystemShellUnixLike)
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && shell != "/bin/false" {
            return shell;
        }
    }

    // 2. Read from passwd via libc (same as VS Code: os.userInfo().shell)
    #[cfg(unix)]
    {
        #[allow(unsafe_code)]
        unsafe {
            let uid = libc::getuid();
            let pw = libc::getpwuid(uid);
            if !pw.is_null() {
                let shell_cstr = std::ffi::CStr::from_ptr((*pw).pw_shell);
                if let Ok(s) = shell_cstr.to_str() {
                    if !s.is_empty() && s != "/bin/false" {
                        return s.to_string();
                    }
                }
            }
        }
    }

    // 3. Fallback: zsh first on macOS, then bash
    for fb in &["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(fb).exists() {
            return fb.to_string();
        }
    }
    "/bin/sh".to_string()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn check_shell_exists(path: String) -> bool {
    if cfg!(target_os = "windows") {
        return std::path::Path::new(&path).exists() || which::which(&path).is_ok();
    }

    std::path::Path::new(&path).exists()
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
pub fn get_available_shells() -> Vec<ShellInfo> {
    #[cfg(target_os = "windows")]
    {
        let candidates: &[(&str, &str)] = &[
            ("PowerShell", "powershell.exe"),
            ("PowerShell Core", "pwsh.exe"),
            ("Command Prompt", "cmd.exe"),
            ("WSL", "wsl.exe"),
        ];
        let default_shell = get_default_shell();
        let mut seen = std::collections::HashSet::new();
        let mut shells = Vec::new();

        if let Some(resolved_path) = resolve_git_bash() {
            seen.insert("Git Bash".to_string());
            shells.push(ShellInfo {
                name: "Git Bash".to_string(),
                path: resolved_path.clone(),
                is_default: resolved_path.eq_ignore_ascii_case(&default_shell),
            });
        }

        for (name, path) in candidates {
            if let Ok(resolved_path) = which::which(path) {
                let resolved_path = resolved_path.to_string_lossy().to_string();
                if !seen.insert(name.to_string()) {
                    continue;
                }

                shells.push(ShellInfo {
                    name: name.to_string(),
                    path: resolved_path.clone(),
                    is_default: resolved_path.eq_ignore_ascii_case(&default_shell),
                });
            }
        }
        return shells;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let default_shell = get_default_shell();
        let mut seen_paths = std::collections::HashSet::new();
        let mut shells = Vec::new();

        // Read /etc/shells (same as VS Code: terminalProfiles.ts detectAvailableUnixProfiles)
        if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
            for line in contents.lines() {
                let trimmed = if let Some(idx) = line.find('#') {
                    &line[..idx]
                } else {
                    line
                };
                let trimmed = trimmed.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let path = std::path::Path::new(trimmed);
                if path.exists() && seen_paths.insert(trimmed.to_string()) {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("sh")
                        .to_string();
                    shells.push(ShellInfo {
                        name: name.clone(),
                        path: trimmed.to_string(),
                        is_default: trimmed == default_shell
                            || path.file_name().and_then(|n| n.to_str())
                                == std::path::Path::new(&default_shell)
                                    .file_name()
                                    .and_then(|n| n.to_str()),
                    });
                }
            }
        }

        // Fallback if /etc/shells wasn't readable
        if shells.is_empty() {
            let candidates: &[(&str, &str)] = &[
                ("zsh", "/bin/zsh"),
                ("bash", "/bin/bash"),
                ("fish", "/usr/bin/fish"),
                ("fish", "/usr/local/bin/fish"),
                ("fish", "/opt/homebrew/bin/fish"),
                ("sh", "/bin/sh"),
            ];
            let mut seen_names = std::collections::HashSet::new();
            for (name, shell_path) in candidates {
                if std::path::Path::new(shell_path).exists() && seen_names.insert(name.to_string())
                {
                    shells.push(ShellInfo {
                        name: name.to_string(),
                        path: shell_path.to_string(),
                        is_default: *shell_path == default_shell,
                    });
                }
            }
        }

        shells
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_shell_integration_dir(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let scripts_dir = resource_dir.join("shell-integration");
    Ok(scripts_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_lines, clippy::needless_pass_by_value)]
pub fn setup_zsh_dotdir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let zdotdir = data_dir.join("zsh-integration");
    std::fs::create_dir_all(&zdotdir).map_err(|e| format!("Failed to create zdotdir: {e}"))?;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let scripts_dir = resource_dir.join("shell-integration");

    let zshrc_content = format!(
        r#"# SideX Shell Integration - Auto-generated
VSCODE_SHELL_INTEGRATION=1
VSCODE_INJECTION=1
if [[ -f "{scripts}/shellIntegration-rc.zsh" ]]; then
    USER_ZDOTDIR="${{ZDOTDIR:-$HOME}}"
    . "{scripts}/shellIntegration-rc.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zshrc_path = zdotdir.join(".zshrc");
    std::fs::write(&zshrc_path, zshrc_content)
        .map_err(|e| format!("Failed to write .zshrc: {e}"))?;

    let zshenv_content = format!(
        r#"# SideX Shell Integration - Auto-generated
USER_ZDOTDIR="${{ZDOTDIR:-$HOME}}"
if [[ -f "{scripts}/shellIntegration-env.zsh" ]]; then
    . "{scripts}/shellIntegration-env.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zshenv_path = zdotdir.join(".zshenv");
    std::fs::write(&zshenv_path, zshenv_content)
        .map_err(|e| format!("Failed to write .zshenv: {e}"))?;

    let zprofile_content = format!(
        r#"# SideX Shell Integration - Auto-generated
if [[ -f "{scripts}/shellIntegration-profile.zsh" ]]; then
    . "{scripts}/shellIntegration-profile.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zprofile_path = zdotdir.join(".zprofile");
    std::fs::write(&zprofile_path, zprofile_content)
        .map_err(|e| format!("Failed to write .zprofile: {e}"))?;

    let zlogin_content = format!(
        r#"# SideX Shell Integration - Auto-generated
if [[ -f "{scripts}/shellIntegration-login.zsh" ]]; then
    . "{scripts}/shellIntegration-login.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zlogin_path = zdotdir.join(".zlogin");
    std::fs::write(&zlogin_path, zlogin_content)
        .map_err(|e| format!("Failed to write .zlogin: {e}"))?;

    Ok(zdotdir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_leftover_prompt_state() {
        assert!(is_session_scoped_env("PS1"));
        assert!(is_session_scoped_env("PROMPT_COMMAND"));
        assert!(is_session_scoped_env("STARSHIP_SESSION_KEY"));
        assert!(is_session_scoped_env("STARSHIP_SHELL"));
        assert!(is_session_scoped_env("VTE_VERSION"));
        assert!(is_session_scoped_env("BASH_FUNC_starship_precmd%%"));
        assert!(is_session_scoped_env("__bp_imported"));
        assert!(is_session_scoped_env("precmd_functions"));
        assert!(is_session_scoped_env("preexec_functions"));
        assert!(is_session_scoped_env("BLE_VERSION"));
    }

    #[test]
    fn keeps_user_configuration() {
        assert!(!is_session_scoped_env("STARSHIP_CONFIG"));
        assert!(!is_session_scoped_env("STARSHIP_CACHE"));
        assert!(!is_session_scoped_env("PATH"));
        assert!(!is_session_scoped_env("HOME"));
        assert!(!is_session_scoped_env("SHELL"));
        assert!(!is_session_scoped_env("TERM"));
    }

    #[test]
    fn removes_only_stale_vars_from_the_command() {
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.env("PS1", "leftover");
        cmd.env("PROMPT_COMMAND", "starship_precmd");
        cmd.env("STARSHIP_CONFIG", "/home/user/.config/starship.toml");
        cmd.env("TERM", "xterm-256color");

        drop_session_scoped_env(&mut cmd);

        assert!(cmd.get_env("PS1").is_none());
        assert!(cmd.get_env("PROMPT_COMMAND").is_none());
        assert_eq!(
            cmd.get_env("STARSHIP_CONFIG"),
            Some(std::ffi::OsStr::new("/home/user/.config/starship.toml"))
        );
        assert_eq!(
            cmd.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
    }
}
