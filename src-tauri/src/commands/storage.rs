use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct StorageDb {
    conn: Mutex<Connection>,
}

impl StorageDb {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open database: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv_store (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .map_err(|e| format!("Failed to create table: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT value FROM kv_store WHERE key = ?1")
            .map_err(|e| e.to_string())?;
        Ok(stmt.query_row([key], |row| row.get::<_, String>(0)).ok())
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?1, ?2)",
            [key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub fn storage_get(
    state: State<'_, Arc<StorageDb>>,
    key: String,
) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT value FROM kv_store WHERE key = ?1")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let result = stmt
        .query_row([&key], |row| row.get::<_, String>(0))
        .ok();

    Ok(result)
}

#[tauri::command]
pub fn storage_set(
    state: State<'_, Arc<StorageDb>>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?1, ?2)",
        [&key, &value],
    )
    .map_err(|e| format!("Failed to set key '{}': {}", key, e))?;
    Ok(())
}

#[tauri::command]
pub fn storage_delete(state: State<'_, Arc<StorageDb>>, key: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM kv_store WHERE key = ?1", [&key])
        .map_err(|e| format!("Failed to delete key '{}': {}", key, e))?;
    Ok(())
}
