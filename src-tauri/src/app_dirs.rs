//! Centralized application directory resolution for SideX.
//!
//! On Linux, follows the XDG Base Directory Specification:
//!   - Config/user data: `$XDG_CONFIG_HOME/SideX` (default `~/.config/SideX`)
//!
//! On macOS:
//!   - `~/Library/Application Support/SideX`
//!
//! On Windows:
//!   - `%APPDATA%/SideX`
//!
//! This matches the convention used by VSCode (`~/.config/Code`),
//! Cursor (`~/.config/Cursor`), and VSCodium (`~/.config/VSCodium`).

use std::path::PathBuf;

const APP_NAME: &str = "SideX";

/// Returns the primary application data directory for SideX.
///
/// This is where settings.json, databases, and other user data live.
/// The path follows platform conventions and respects XDG on Linux.
pub fn app_data_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".config")
            });
        base.join(APP_NAME)
    }

    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("Application Support")
            .join(APP_NAME)
    }

    #[cfg(target_os = "windows")]
    {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(APP_NAME)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(APP_NAME)
    }
}

/// Legacy application data directory path (used before XDG migration).
///
/// On Linux this was `~/.local/share/com.siden.sidex`.
/// On macOS this was `~/Library/Application Support/com.siden.sidex`.
/// On Windows this was `%LOCALAPPDATA%/com.siden.sidex`.
fn legacy_app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".local")
                    .join("share")
            });
        Some(base.join("com.siden.sidex"))
    }

    #[cfg(target_os = "macos")]
    {
        Some(
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Library")
                .join("Application Support")
                .join("com.siden.sidex"),
        )
    }

    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("com.siden.sidex"))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Resolves the app data directory, migrating from legacy locations
/// if they exist and the new location does not.
///
/// Legacy locations checked (in order):
/// 1. Tauri's `app_data_dir()` path: `~/.local/share/com.siden.sidex/` (Linux)
/// 2. Old hard-coded path: `~/.sidex/` (all platforms)
///
/// Migration is atomic: we rename the entire directory. If the rename fails
/// (e.g., cross-device), we copy recursively instead.
pub fn resolve_and_migrate() -> PathBuf {
    let new_dir = app_data_dir();

    if new_dir.exists() {
        migrate_dot_sidex_into(&new_dir);
        return new_dir;
    }

    if let Some(legacy) = legacy_app_data_dir() {
        if legacy.exists() {
            if let Some(parent) = new_dir.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::rename(&legacy, &new_dir) {
                Ok(()) => {
                    log::info!(
                        "Migrated app data from {} to {}",
                        legacy.display(),
                        new_dir.display()
                    );
                    migrate_dot_sidex_into(&new_dir);
                    return new_dir;
                }
                Err(e) => {
                    log::warn!(
                        "Could not migrate app data from {} to {}: {e}. \
                         Attempting copy instead.",
                        legacy.display(),
                        new_dir.display()
                    );
                    if copy_dir_recursive(&legacy, &new_dir).is_ok() {
                        log::info!(
                            "Copied app data from {} to {}",
                            legacy.display(),
                            new_dir.display()
                        );
                        migrate_dot_sidex_into(&new_dir);
                        return new_dir;
                    }
                    log::warn!("Copy also failed; using new directory path anyway.");
                }
            }
        }
    }

    let _ = std::fs::create_dir_all(&new_dir);
    migrate_dot_sidex_into(&new_dir);
    new_dir
}

/// Migrates contents from `~/.sidex/` into the new config directory if
/// the old directory exists and contains files not yet present in the
/// new location.
fn migrate_dot_sidex_into(new_dir: &std::path::Path) {
    let dot_sidex = match dirs::home_dir() {
        Some(h) => h.join(".sidex"),
        None => return,
    };

    if !dot_sidex.exists() || dot_sidex == *new_dir {
        return;
    }

    let dominated_files = ["hooks.json", "mcp.json", "state.db"];
    for file in &dominated_files {
        let src = dot_sidex.join(file);
        let dst = new_dir.join(file);
        if src.exists() && !dst.exists() {
            let _ = std::fs::create_dir_all(new_dir);
            if let Err(e) = std::fs::copy(&src, &dst) {
                log::warn!("Failed to migrate {}: {e}", src.display());
            } else {
                log::info!("Migrated {} to {}", src.display(), dst.display());
            }
        }
    }

    let dominated_dirs = ["extensions", "data"];
    for dir_name in &dominated_dirs {
        let src = dot_sidex.join(dir_name);
        let dst = new_dir.join(dir_name);
        if src.is_dir() && !dst.exists() {
            let _ = std::fs::create_dir_all(new_dir);
            if let Err(e) = copy_dir_recursive(&src, &dst) {
                log::warn!("Failed to migrate {}: {e}", src.display());
            } else {
                log::info!("Migrated {} to {}", src.display(), dst.display());
            }
        }
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}
