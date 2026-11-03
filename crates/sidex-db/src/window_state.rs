//! Window position and layout persistence.

use anyhow::{Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Database;

/// Persisted window layout state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_maximized: bool,
    pub sidebar_width: f64,
    pub panel_height: f64,
    pub active_editor: Option<String>,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: 100,
            y: 100,
            width: 1280,
            height: 720,
            is_maximized: false,
            sidebar_width: 260.0,
            panel_height: 200.0,
            active_editor: None,
        }
    }
}

/// Saves the window state, replacing any previous entry.
pub fn save_window_state(db: &Database, state: &WindowState) -> Result<()> {
    db.conn()
        .execute(
            "INSERT INTO window_state
                (id, x, y, width, height, is_maximized, sidebar_width, panel_height, active_editor)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                x = excluded.x,
                y = excluded.y,
                width = excluded.width,
                height = excluded.height,
                is_maximized = excluded.is_maximized,
                sidebar_width = excluded.sidebar_width,
                panel_height = excluded.panel_height,
                active_editor = excluded.active_editor",
            params![
                state.x,
                state.y,
                state.width,
                state.height,
                state.is_maximized,
                state.sidebar_width,
                state.panel_height,
                state.active_editor,
            ],
        )
        .context("save window state")?;
    Ok(())
}

/// Loads the previously saved window state, if any.
pub fn load_window_state(db: &Database) -> Result<Option<WindowState>> {
    let mut stmt = db
        .conn()
        .prepare_cached(
            "SELECT x, y, width, height, is_maximized, sidebar_width, panel_height, active_editor
             FROM window_state WHERE id = 1",
        )
        .context("prepare load window state")?;

    let result = stmt
        .query_row([], |row| {
            Ok(WindowState {
                x: row.get(0)?,
                y: row.get(1)?,
                width: row.get(2)?,
                height: row.get(3)?,
                is_maximized: row.get(4)?,
                sidebar_width: row.get(5)?,
                panel_height: row.get(6)?,
                active_editor: row.get(7)?,
            })
        })
        .optional()
        .context("query window state")?;

    Ok(result)
}

/// Extension trait for optional single-row queries.
trait OptionalExt<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalExt<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let tmp = tempfile::TempDir::new().unwrap();
        Database::open(&tmp.path().join("test.db")).unwrap()
    }

    #[test]
    fn load_missing_returns_none() {
        let db = test_db();
        assert!(load_window_state(&db).unwrap().is_none());
    }

    #[test]
    fn save_and_load_roundtrip() {
        let db = test_db();
        let state = WindowState {
            x: 50,
            y: 75,
            width: 1920,
            height: 1080,
            is_maximized: true,
            sidebar_width: 300.0,
            panel_height: 250.0,
            active_editor: Some("/src/main.rs".to_owned()),
        };
        save_window_state(&db, &state).unwrap();
        let loaded = load_window_state(&db).unwrap().unwrap();
        assert_eq!(loaded.x, 50);
        assert_eq!(loaded.width, 1920);
        assert!(loaded.is_maximized);
        assert_eq!(loaded.active_editor.unwrap(), "/src/main.rs");
    }

    #[test]
    fn save_overwrites_previous() {
        let db = test_db();
        let s1 = WindowState {
            width: 800,
            ..WindowState::default()
        };
        save_window_state(&db, &s1).unwrap();
        let s2 = WindowState {
            width: 1600,
            ..WindowState::default()
        };
        save_window_state(&db, &s2).unwrap();
        let loaded = load_window_state(&db).unwrap().unwrap();
        assert_eq!(loaded.width, 1600);
    }
}
