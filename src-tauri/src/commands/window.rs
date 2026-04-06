use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::storage::StorageDb;

#[derive(Debug, Serialize)]
pub struct MonitorInfo {
    pub name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
}

#[tauri::command]
pub fn create_window(
    app: AppHandle,
    label: String,
    title: String,
    url: Option<String>,
) -> Result<(), String> {
    let webview_url = match url {
        Some(u) => WebviewUrl::External(u.parse().map_err(|e| format!("Invalid URL: {}", e))?),
        None => WebviewUrl::default(),
    };

    WebviewWindowBuilder::new(&app, &label, webview_url)
        .title(&title)
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| format!("Failed to create window '{}': {}", label, e))?;

    Ok(())
}

#[tauri::command]
pub fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window '{}' not found", label))?;

    window
        .close()
        .map_err(|e| format!("Failed to close window '{}': {}", label, e))
}

#[tauri::command]
pub fn set_window_title(app: AppHandle, label: String, title: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window '{}' not found", label))?;

    window
        .set_title(&title)
        .map_err(|e| format!("Failed to set title for '{}': {}", label, e))
}

#[tauri::command]
pub fn get_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?;

    Ok(monitors
        .into_iter()
        .map(|m| {
            let size = m.size();
            let pos = m.position();
            MonitorInfo {
                name: m.name().map(|n| n.to_string()),
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
                scale_factor: m.scale_factor(),
            }
        })
        .collect())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

const WINDOW_STATE_KEY: &str = "sidex.windowState";

#[tauri::command]
pub fn save_window_state(
    app: AppHandle,
    label: String,
    db: tauri::State<'_, Arc<StorageDb>>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let maximized = window.is_maximized().unwrap_or(false);

    let state = WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
    };

    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    db.set(WINDOW_STATE_KEY, &json)?;
    Ok(())
}

#[tauri::command]
pub fn restore_window_state(
    app: AppHandle,
    label: String,
    db: tauri::State<'_, Arc<StorageDb>>,
) -> Result<bool, String> {
    let json = match db.get(WINDOW_STATE_KEY)? {
        Some(j) => j,
        None => return Ok(false),
    };

    let state: WindowState = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
    let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
    if state.maximized {
        let _ = window.maximize();
    }
    Ok(true)
}
