use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct LoggerStore {
    loggers: Mutex<HashMap<String, LoggerState>>,
    counter: Mutex<u32>,
}

struct LoggerState {
    filepath: PathBuf,
    level: u32,
}

impl LoggerStore {
    pub fn new() -> Self {
        Self {
            loggers: Mutex::new(HashMap::new()),
            counter: Mutex::new(0),
        }
    }
}

impl Default for LoggerStore {
    fn default() -> Self { Self::new() }
}

#[tauri::command]
pub fn log_create_logger(
    state: tauri::State<'_, std::sync::Arc<LoggerStore>>,
    name: String,
    filepath: String,
    _rotating: bool,
    _donot_use_formatters: bool,
    level: u32,
) -> Result<String, String> {
    let path = PathBuf::from(&filepath);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }

    let mut counter = state.counter.lock().map_err(|e| e.to_string())?;
    *counter += 1;
    let id = format!("log-{}-{}", name, counter);

    let mut loggers = state.loggers.lock().map_err(|e| e.to_string())?;
    loggers.insert(id.clone(), LoggerState { filepath: path, level });

    Ok(id)
}

#[tauri::command]
pub fn log_write(
    state: tauri::State<'_, std::sync::Arc<LoggerStore>>,
    logger_id: String,
    level: u32,
    message: String,
) -> Result<(), String> {
    let loggers = state.loggers.lock().map_err(|e| e.to_string())?;
    let logger = loggers.get(&logger_id).ok_or("logger not found")?;
    if level < logger.level {
        return Ok(());
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&logger.filepath)
        .map_err(|e| format!("open log: {e}"))?;

    writeln!(file, "{}", message).map_err(|e| format!("write log: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn log_set_level(
    state: tauri::State<'_, std::sync::Arc<LoggerStore>>,
    logger_id: String,
    level: u32,
) -> Result<(), String> {
    let mut loggers = state.loggers.lock().map_err(|e| e.to_string())?;
    let logger = loggers.get_mut(&logger_id).ok_or("logger not found")?;
    logger.level = level;
    Ok(())
}

#[tauri::command]
pub fn log_flush(
    state: tauri::State<'_, std::sync::Arc<LoggerStore>>,
    logger_id: String,
) -> Result<(), String> {
    let loggers = state.loggers.lock().map_err(|e| e.to_string())?;
    let _logger = loggers.get(&logger_id).ok_or("logger not found")?;
    Ok(())
}

#[tauri::command]
pub fn log_drop(
    state: tauri::State<'_, std::sync::Arc<LoggerStore>>,
    logger_id: String,
) -> Result<(), String> {
    let mut loggers = state.loggers.lock().map_err(|e| e.to_string())?;
    loggers.remove(&logger_id);
    Ok(())
}
