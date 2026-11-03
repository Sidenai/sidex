//! Profile registry Tauri commands.
//!
//! These commands are thin wrappers around `sidex-profiles` that persist
//! the profile list and workspace/profile associations under
//! `<app-data>/UserData`. The TypeScript side mirrors writes here and
//! hydrates from here on boot.

use std::sync::Arc;

use serde_json::Value;
use sidex_profiles::{ProfileStorage, StoredProfileAssociations, StoredUserDataProfile};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

pub const PROFILES_CHANGED_EVENT: &str = "sidex://profiles/changed";

pub struct ProfilesStore {
    storage: Mutex<ProfileStorage>,
}

impl ProfilesStore {
    pub fn new(root: std::path::PathBuf) -> Self {
        Self {
            storage: Mutex::new(ProfileStorage::new(root)),
        }
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let data_dir = crate::app_dirs::app_data_dir();
    let profile_root = data_dir.join("UserData");
    std::fs::create_dir_all(&profile_root).map_err(|e| format!("create UserData: {e}"))?;
    app.manage(Arc::new(ProfilesStore::new(profile_root)));
    Ok(())
}

#[tauri::command]
pub async fn profiles_load(
    store: tauri::State<'_, Arc<ProfilesStore>>,
) -> Result<Vec<StoredUserDataProfile>, String> {
    let storage = store.storage.lock().await;
    storage.load_profiles().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn profiles_save(
    store: tauri::State<'_, Arc<ProfilesStore>>,
    app: AppHandle,
    profiles: Vec<StoredUserDataProfile>,
) -> Result<(), String> {
    let storage = store.storage.lock().await;
    storage
        .save_profiles(&profiles)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(PROFILES_CHANGED_EVENT, Value::Null);
    Ok(())
}

#[tauri::command]
pub async fn profiles_load_associations(
    store: tauri::State<'_, Arc<ProfilesStore>>,
) -> Result<StoredProfileAssociations, String> {
    let storage = store.storage.lock().await;
    storage.load_associations().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn profiles_save_associations(
    store: tauri::State<'_, Arc<ProfilesStore>>,
    value: StoredProfileAssociations,
) -> Result<(), String> {
    let storage = store.storage.lock().await;
    storage
        .save_associations(&value)
        .await
        .map_err(|e| e.to_string())
}
