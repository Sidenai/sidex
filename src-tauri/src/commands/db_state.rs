use std::sync::{Arc, Mutex};

use serde::Serialize;
use sidex_db::Database;
use tauri::State;

pub struct SidexDbState {
    db: Mutex<Database>,
}

impl SidexDbState {
    pub fn new(db: Database) -> Self {
        Self { db: Mutex::new(db) }
    }

    /// Borrow the database directly. Used by chat-session storage,
    /// which needs a guard rather than a single-shot query helper.
    pub fn lock_db(
        &self,
    ) -> Result<
        std::sync::MutexGuard<'_, Database>,
        std::sync::PoisonError<std::sync::MutexGuard<'_, Database>>,
    > {
        self.db.lock()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RecentFileEntry {
    pub path: String,
    pub last_opened: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecentWorkspaceEntry {
    pub path: String,
    pub last_opened: String,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn db_get_recent_files(
    state: State<'_, Arc<SidexDbState>>,
    limit: u32,
) -> Result<Vec<RecentFileEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    sidex_db::recent_files(&db, limit as usize)
        .map(|v| {
            v.into_iter()
                .map(|e| RecentFileEntry {
                    path: e.path,
                    last_opened: e.last_opened,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn db_get_recent_workspaces(
    state: State<'_, Arc<SidexDbState>>,
    limit: u32,
) -> Result<Vec<RecentWorkspaceEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    sidex_db::recent_workspaces(&db, limit as usize)
        .map(|v| {
            v.into_iter()
                .map(|e| RecentWorkspaceEntry {
                    path: e.path,
                    last_opened: e.last_opened,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn db_save_workspace_state(
    state: State<'_, Arc<SidexDbState>>,
    workspace: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let json_val = serde_json::Value::String(value);
    sidex_db::set_workspace_state(&db, &workspace, &key, &json_val).map_err(|e| e.to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn db_get_workspace_state(
    state: State<'_, Arc<SidexDbState>>,
    workspace: String,
    key: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    sidex_db::get_workspace_state(&db, &workspace, &key)
        .map(|opt| opt.map(|v| v.to_string()))
        .map_err(|e| e.to_string())
}
