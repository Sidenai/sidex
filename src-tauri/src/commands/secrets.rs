//! Secret storage commands — thin wrapper around `SecretStorage`.
//!
//! Values live in `state.vscdb` → `ItemTable`, the same `SQLite` database the
//! VS Code platform uses for all user state. There's no fixed key namespace
//! here; callers pick their own keys (see `commands::providers` for the
//! provider API key, base-URL and CLI-auth-opt-in keys actually written).

use std::sync::Arc;

use sidex_auth::SecretStorage;
use tauri::{AppHandle, Manager};

pub struct SecretsStore {
    pub(crate) inner: SecretStorage,
}

impl SecretsStore {
    fn new(storage: SecretStorage) -> Self {
        Self { inner: storage }
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let data_dir = crate::app_dirs::app_data_dir();
    // state.vscdb -> ItemTable, matching how the VS Code platform (and
    // Cursor, which this layout is modeled on) persist user-scoped state.
    let db_path = data_dir
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    let storage = SecretStorage::open(db_path).map_err(|e| e.to_string())?;
    app.manage(Arc::new(SecretsStore::new(storage)));
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn secret_get(
    store: tauri::State<'_, Arc<SecretsStore>>,
    key: String,
) -> Result<Option<String>, String> {
    store.inner.get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn secret_set(
    store: tauri::State<'_, Arc<SecretsStore>>,
    key: String,
    value: String,
) -> Result<(), String> {
    store.inner.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn secret_delete(
    store: tauri::State<'_, Arc<SecretsStore>>,
    key: String,
) -> Result<(), String> {
    store.inner.delete(&key).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn secret_keys(store: tauri::State<'_, Arc<SecretsStore>>) -> Result<Vec<String>, String> {
    store.inner.keys().map_err(|e| e.to_string())
}
