//! Tauri command bindings for the native update manager.
//!
//! The TypeScript `IUpdateService` on the frontend invokes these commands
//! and listens to the `sidex://update/state-change` event to mirror
//! `onStateChange`.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use sidex_update::{
    DisablementReason, State, UpdateConfig, UpdateManager, UpdateObserver, UpdateResult, UpdateType,
};
use tauri::{AppHandle, Emitter, Manager};

/// Tauri event name carrying the latest [`State`] payload.
pub const STATE_EVENT: &str = "sidex://update/state-change";

/// Runtime opt-in for the update feed. `tauri.conf.json` intentionally ships
/// with no `endpoints` entry under `plugins.updater` — a build from source
/// (or anyone's fork) must never phone home to a server it didn't choose.
/// Whoever runs their own release channel points the app at it by exporting
/// this variable before launch, e.g. in packaging/launch scripts, without
/// having to hardcode a URL into a file that ships in the public repo.
const UPDATE_ENDPOINT_ENV: &str = "SIDEX_UPDATE_ENDPOINT";

/// App-state wrapper so Tauri can hold a single [`UpdateManager`] instance.
pub struct UpdateManagerState {
    manager: OnceLock<UpdateManager>,
    /// Whether an update endpoint was found at startup (env var or a static
    /// `endpoints` array in `tauri.conf.json`). `false` in the common
    /// from-source case, in which every update command below short-circuits
    /// before it can make a network call or surface an error — see
    /// [`initialize`].
    configured: OnceLock<bool>,
}

impl Default for UpdateManagerState {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateManagerState {
    pub const fn new() -> Self {
        Self {
            manager: OnceLock::new(),
            configured: OnceLock::new(),
        }
    }

    pub fn set(&self, manager: UpdateManager) {
        let _ = self.manager.set(manager);
    }

    pub fn get(&self) -> Option<&UpdateManager> {
        self.manager.get()
    }

    fn set_configured(&self, configured: bool) {
        let _ = self.configured.set(configured);
    }

    /// Defaults to `false` (not configured) before [`initialize`] runs, so
    /// a command invoked too early fails the same closed way as "no
    /// endpoint" rather than panicking or erroring.
    fn is_configured(&self) -> bool {
        self.configured.get().copied().unwrap_or(false)
    }
}

struct EventEmitter {
    app: AppHandle,
}

impl UpdateObserver for EventEmitter {
    fn on_state_change(&self, state: &State) {
        if let Err(err) = self.app.emit(STATE_EVENT, state) {
            log::warn!("failed to emit update state event: {err}");
        }
    }
}

/// Initializes the [`UpdateManager`] during Tauri setup.
///
/// Pulls the Minisign public key from the bundled `tauri.conf.json` and the
/// feed endpoint from [`UPDATE_ENDPOINT_ENV`] (falling back to a static
/// `endpoints` array in `tauri.conf.json`, for anyone who wants to bake one
/// into their own build). Neither is present in the upstream config, so a
/// stock build ends up unconfigured and every update command below becomes
/// a no-op — see [`UpdateManagerState::is_configured`].
pub fn initialize(app: &AppHandle) -> UpdateResult<()> {
    let config = read_config(app);
    let configured = !config.endpoints.is_empty();
    let manager = UpdateManager::new(config)?;
    manager.set_observer(Arc::new(EventEmitter { app: app.clone() }));

    let state = app.state::<UpdateManagerState>();
    state.set(manager);
    state.set_configured(configured);
    Ok(())
}

fn read_config(app: &AppHandle) -> UpdateConfig {
    let raw_pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // Runtime opt-in first: whoever runs a release channel exports
    // `SIDEX_UPDATE_ENDPOINT` before launch. Only fall back to a static
    // `endpoints` array in tauri.conf.json (unset upstream) if the env var
    // isn't there, so the two configuration paths compose instead of
    // conflicting.
    let endpoints = std::env::var(UPDATE_ENDPOINT_ENV)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|endpoint| !endpoint.is_empty())
        .map_or_else(
            || {
                app.config()
                    .plugins
                    .0
                    .get("updater")
                    .and_then(|v| v.get("endpoints"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            },
            |endpoint| vec![endpoint],
        );

    UpdateConfig {
        endpoints,
        pubkey: raw_pubkey,
        current_version: app.package_info().version.to_string(),
        cache_dir: cache_dir(app),
        update_type: default_update_type(),
        user_agent: format!(
            "sidex/{} ({})",
            app.package_info().version,
            std::env::consts::OS
        ),
    }
}

fn cache_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("updates")
}

const fn default_update_type() -> UpdateType {
    if cfg!(target_os = "windows") {
        UpdateType::Setup
    } else {
        UpdateType::Archive
    }
}

fn require_manager(state: &UpdateManagerState) -> Result<&UpdateManager, String> {
    state
        .get()
        .ok_or_else(|| "update manager not initialized".to_string())
}

/// The state reported for every update command when no endpoint is
/// configured. Modeled as an ordinary [`State::Disabled`] rather than an
/// error so it flows through the same `Result<State, String>` success path
/// the frontend already handles — nothing needs to distinguish "checked,
/// nothing configured" from any other terminal state.
fn not_configured() -> State {
    State::Disabled {
        reason: DisablementReason::MissingConfiguration,
    }
}

#[tauri::command]
pub async fn update_check(
    state: tauri::State<'_, UpdateManagerState>,
    explicit: bool,
) -> Result<State, String> {
    if !state.is_configured() {
        // No feed configured (the default for a from-source build): resolve
        // immediately without touching the manager or the network. This is
        // what makes both the periodic background poll and an explicit
        // "Check for Updates..." click silent-and-complete rather than
        // erroring — see `sidexUpdate.contribution.ts` and
        // `updateService.ts` for how each `explicit` value is handled.
        return Ok(not_configured());
    }
    let manager = require_manager(&state)?.clone();
    manager
        .check_for_updates(explicit)
        .await
        .map_err(|e| e.to_string())?;
    Ok(manager.state())
}

#[tauri::command]
pub async fn update_download(
    state: tauri::State<'_, UpdateManagerState>,
    explicit: bool,
) -> Result<State, String> {
    if !state.is_configured() {
        // Mirrors `update_check`: without this guard an explicit download
        // call on `Idle` falls back to "check then download" inside the
        // manager, which would attempt the same doomed network request.
        return Ok(not_configured());
    }
    let manager = require_manager(&state)?.clone();
    manager
        .download_update(explicit)
        .await
        .map_err(|e| e.to_string())?;
    Ok(manager.state())
}

#[tauri::command]
pub async fn update_apply(state: tauri::State<'_, UpdateManagerState>) -> Result<State, String> {
    let manager = require_manager(&state)?.clone();
    manager.apply_update().await.map_err(|e| e.to_string())?;
    Ok(manager.state())
}

#[tauri::command]
pub async fn update_cancel(state: tauri::State<'_, UpdateManagerState>) -> Result<(), String> {
    require_manager(&state)?.cancel();
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn update_state(state: tauri::State<'_, UpdateManagerState>) -> Result<State, String> {
    if !state.is_configured() {
        return Ok(not_configured());
    }
    Ok(require_manager(&state)?.state())
}

#[tauri::command]
pub async fn update_cleanup(state: tauri::State<'_, UpdateManagerState>) -> Result<(), String> {
    let manager = require_manager(&state)?.clone();
    manager.cleanup_cache().await.map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn update_quit_and_install(app: AppHandle) -> Result<(), String> {
    let install_root = std::env::current_exe().map_err(|e| e.to_string())?;
    sidex_update::install::relaunch(&install_root).map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
