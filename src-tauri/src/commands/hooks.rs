use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use globset::{Glob, GlobSetBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const GLOBAL_HOOKS_FILE: &str = "hooks.json";

fn global_sidex_config_dir() -> PathBuf {
    crate::app_dirs::app_data_dir()
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookConfig {
    pub hooks: Vec<Hook>,
}

impl Default for HookConfig {
    fn default() -> Self {
        Self { hooks: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hook {
    pub name: String,
    pub event: HookEvent,
    pub matchers: Option<HookMatchers>,
    pub action: HookAction,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookEvent {
    AfterFileEdit,
    BeforeFileEdit,
    AfterShell,
    AfterAgentTurn,
    OnError,
    BeforeCommit,
    OnSessionStart,
    OnSessionEnd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookMatchers {
    pub file_patterns: Option<Vec<String>>,
    pub tool_names: Option<Vec<String>>,
    pub content_match: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HookAction {
    #[serde(rename = "command")]
    Command {
        command: String,
        args: Option<Vec<String>>,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
    },
    #[serde(rename = "script")]
    Script {
        path: String,
        timeout_ms: Option<u64>,
    },
    #[serde(rename = "inject_message")]
    InjectMessage {
        content: String,
        role: Option<String>,
    },
    #[serde(rename = "reject")]
    Reject { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookResult {
    pub hook_name: String,
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
    pub action_taken: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookTriggerRequest {
    pub event: HookEvent,
    pub context: HookContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookContext {
    pub file_path: Option<String>,
    pub tool_name: Option<String>,
    pub tool_output: Option<String>,
    pub cwd: String,
}

// ─── State ───────────────────────────────────────────────────────────────────

pub struct HooksState {
    config: Mutex<HookConfig>,
    config_paths: Vec<PathBuf>,
}

impl HooksState {
    pub fn default_global() -> Self {
        let global_path = global_sidex_config_dir().join(GLOBAL_HOOKS_FILE);
        let config_paths = vec![global_path];
        let config = load_merged_config(&config_paths);

        Self {
            config: Mutex::new(config),
            config_paths,
        }
    }
}

// ─── Config Loading ──────────────────────────────────────────────────────────

fn load_config_from_path(path: &Path) -> Option<HookConfig> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn load_merged_config(paths: &[PathBuf]) -> HookConfig {
    let mut merged = HookConfig::default();

    for path in paths {
        if let Some(cfg) = load_config_from_path(path) {
            for hook in cfg.hooks {
                if let Some(pos) = merged.hooks.iter().position(|h| h.name == hook.name) {
                    merged.hooks[pos] = hook;
                } else {
                    merged.hooks.push(hook);
                }
            }
        }
    }

    merged
}

// ─── Matching ────────────────────────────────────────────────────────────────

fn matches_hook(hook: &Hook, event: &HookEvent, ctx: &HookContext) -> bool {
    if hook.event != *event || !hook.enabled {
        return false;
    }

    let Some(matchers) = &hook.matchers else {
        return true;
    };

    if let Some(patterns) = &matchers.file_patterns {
        let file_path = match &ctx.file_path {
            Some(p) => p.as_str(),
            None => return false,
        };
        if !matches_any_glob(patterns, file_path) {
            return false;
        }
    }

    if let Some(tool_names) = &matchers.tool_names {
        let tool = match &ctx.tool_name {
            Some(t) => t.as_str(),
            None => return false,
        };
        if !tool_names.iter().any(|name| name == tool) {
            return false;
        }
    }

    if let Some(pattern) = &matchers.content_match {
        let content = ctx.tool_output.as_deref().unwrap_or("");
        match Regex::new(pattern) {
            Ok(re) => {
                if !re.is_match(content) {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }

    true
}

fn matches_any_glob(patterns: &[String], path: &str) -> bool {
    let mut builder = GlobSetBuilder::new();
    for pat in patterns {
        if let Ok(g) = Glob::new(pat) {
            builder.add(g);
        }
    }
    match builder.build() {
        Ok(set) => !set.matches(path).is_empty(),
        Err(_) => false,
    }
}

// ─── Execution ───────────────────────────────────────────────────────────────

async fn execute_hook(hook: &Hook, ctx: &HookContext) -> HookResult {
    match &hook.action {
        HookAction::Command {
            command,
            args,
            cwd,
            timeout_ms,
        } => {
            execute_command(
                hook,
                command,
                args.as_deref(),
                cwd.as_deref(),
                ctx,
                *timeout_ms,
            )
            .await
        }

        HookAction::Script { path, timeout_ms } => {
            execute_script(hook, path, ctx, *timeout_ms).await
        }

        HookAction::InjectMessage { content, role } => HookResult {
            hook_name: hook.name.clone(),
            success: true,
            output: Some(
                serde_json::json!({
                    "content": content,
                    "role": role.as_deref().unwrap_or("system"),
                })
                .to_string(),
            ),
            error: None,
            action_taken: "injected message".into(),
        },

        HookAction::Reject { reason } => HookResult {
            hook_name: hook.name.clone(),
            success: true,
            output: Some(reason.clone()),
            error: None,
            action_taken: "rejected".into(),
        },
    }
}

async fn execute_command(
    hook: &Hook,
    command: &str,
    args: Option<&[String]>,
    cwd: Option<&str>,
    ctx: &HookContext,
    timeout_ms: Option<u64>,
) -> HookResult {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    let mut cmd = Command::new(command);
    if let Some(a) = args {
        cmd.args(a);
    }
    cmd.current_dir(cwd.unwrap_or(&ctx.cwd));
    inject_env_vars(&mut cmd, ctx);

    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let success = output.status.success();

            HookResult {
                hook_name: hook.name.clone(),
                success,
                output: if stdout.is_empty() {
                    None
                } else {
                    Some(stdout)
                },
                error: if stderr.is_empty() {
                    None
                } else {
                    Some(stderr)
                },
                action_taken: "ran command".into(),
            }
        }
        Ok(Err(e)) => HookResult {
            hook_name: hook.name.clone(),
            success: false,
            output: None,
            error: Some(format!("Failed to spawn command: {e}")),
            action_taken: "ran command".into(),
        },
        Err(_) => HookResult {
            hook_name: hook.name.clone(),
            success: false,
            output: None,
            error: Some(format!("Command timed out after {timeout_ms:?}ms")),
            action_taken: "ran command".into(),
        },
    }
}

async fn execute_script(
    hook: &Hook,
    path: &str,
    ctx: &HookContext,
    timeout_ms: Option<u64>,
) -> HookResult {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let script_path = Path::new(path);

    if !script_path.exists() {
        return HookResult {
            hook_name: hook.name.clone(),
            success: false,
            output: None,
            error: Some(format!("Script not found: {path}")),
            action_taken: "ran script".into(),
        };
    }

    let interpreter = detect_interpreter(path);
    let mut cmd = Command::new(&interpreter);
    cmd.arg(path);
    cmd.current_dir(&ctx.cwd);
    inject_env_vars(&mut cmd, ctx);

    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let success = output.status.success();

            HookResult {
                hook_name: hook.name.clone(),
                success,
                output: if stdout.is_empty() {
                    None
                } else {
                    Some(stdout)
                },
                error: if stderr.is_empty() {
                    None
                } else {
                    Some(stderr)
                },
                action_taken: "ran script".into(),
            }
        }
        Ok(Err(e)) => HookResult {
            hook_name: hook.name.clone(),
            success: false,
            output: None,
            error: Some(format!("Failed to run script: {e}")),
            action_taken: "ran script".into(),
        },
        Err(_) => HookResult {
            hook_name: hook.name.clone(),
            success: false,
            output: None,
            error: Some(format!("Script timed out after {timeout_ms:?}ms")),
            action_taken: "ran script".into(),
        },
    }
}

fn inject_env_vars(cmd: &mut Command, ctx: &HookContext) {
    cmd.env("SIDEX_CWD", &ctx.cwd);
    cmd.env("SIDEX_EVENT", format!("{:?}", ctx.file_path));
    if let Some(f) = &ctx.file_path {
        cmd.env("SIDEX_FILE", f);
    }
    if let Some(t) = &ctx.tool_name {
        cmd.env("SIDEX_TOOL", t);
    }
}

fn detect_interpreter(path: &str) -> String {
    match Path::new(path).extension().and_then(|e| e.to_str()) {
        Some("py") => "python3".into(),
        Some("rb") => "ruby".into(),
        Some("js") => "node".into(),
        Some("ts") => "npx".into(),
        Some("sh") | Some("bash") => "bash".into(),
        Some("zsh") => "zsh".into(),
        _ => "sh".into(),
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn hooks_list(state: State<'_, HooksState>) -> Result<Vec<Hook>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.hooks.clone())
}

#[tauri::command]
pub async fn hooks_trigger(
    state: State<'_, HooksState>,
    request: HookTriggerRequest,
) -> Result<Vec<HookResult>, String> {
    let hooks: Vec<Hook> = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config
            .hooks
            .iter()
            .filter(|h| matches_hook(h, &request.event, &request.context))
            .cloned()
            .collect()
    };

    let mut results = Vec::with_capacity(hooks.len());
    for hook in &hooks {
        let result = execute_hook(hook, &request.context).await;

        if matches!(hook.action, HookAction::Reject { .. }) && result.success {
            results.push(result);
            break;
        }

        results.push(result);
    }

    Ok(results)
}

#[tauri::command]
pub fn hooks_reload(state: State<'_, HooksState>) -> Result<(), String> {
    let new_config = load_merged_config(&state.config_paths);
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    *config = new_config;
    Ok(())
}

#[tauri::command]
pub fn hooks_add(state: State<'_, HooksState>, hook: Hook) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;

    if config.hooks.iter().any(|h| h.name == hook.name) {
        return Err(format!("Hook '{}' already exists", hook.name));
    }

    config.hooks.push(hook);
    persist_project_config(&config, &state.config_paths)?;
    Ok(())
}

#[tauri::command]
pub fn hooks_remove(state: State<'_, HooksState>, name: String) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let before = config.hooks.len();
    config.hooks.retain(|h| h.name != name);

    if config.hooks.len() == before {
        return Err(format!("Hook '{name}' not found"));
    }

    persist_project_config(&config, &state.config_paths)?;
    Ok(())
}

#[tauri::command]
pub fn hooks_toggle(
    state: State<'_, HooksState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let hook = config
        .hooks
        .iter_mut()
        .find(|h| h.name == name)
        .ok_or_else(|| format!("Hook '{name}' not found"))?;

    hook.enabled = enabled;
    persist_project_config(&config, &state.config_paths)?;
    Ok(())
}

#[tauri::command]
pub async fn hooks_test(
    state: State<'_, HooksState>,
    name: String,
    context: HookContext,
) -> Result<HookResult, String> {
    let hook = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config
            .hooks
            .iter()
            .find(|h| h.name == name)
            .cloned()
            .ok_or_else(|| format!("Hook '{name}' not found"))?
    };

    Ok(execute_hook(&hook, &context).await)
}

// ─── Persistence ─────────────────────────────────────────────────────────────

fn persist_project_config(config: &HookConfig, config_paths: &[PathBuf]) -> Result<(), String> {
    let project_path = config_paths
        .last()
        .ok_or_else(|| "No project config path configured".to_string())?;

    if let Some(parent) = project_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create config dir: {e}"))?;
    }

    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;

    std::fs::write(project_path, json)
        .map_err(|e| format!("Failed to write config to {}: {e}", project_path.display()))?;

    Ok(())
}
