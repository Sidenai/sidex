use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

fn extensions_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".sidex").join("extensions")
}

#[derive(Debug, Serialize)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub path: String,
}

#[tauri::command]
pub async fn install_extension(vsix_path: String) -> Result<InstalledExtension, String> {
    let vsix = Path::new(&vsix_path);
    if !vsix.exists() {
        return Err(format!("VSIX not found: {}", vsix_path));
    }

    let file = File::open(vsix).map_err(|e| format!("open: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("bad vsix: {e}"))?;

    let manifest = read_vsix_manifest(&mut archive)?;

    let ext_dir = extensions_dir().join(&manifest.id);
    if ext_dir.exists() {
        fs::remove_dir_all(&ext_dir).map_err(|e| format!("cleanup: {e}"))?;
    }
    fs::create_dir_all(&ext_dir).map_err(|e| format!("mkdir: {e}"))?;

    let prefix = "extension/";
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("entry: {e}"))?;
        let raw_name = entry.name().to_string();

        if !raw_name.starts_with(prefix) {
            if raw_name == "[Content_Types].xml" || raw_name.starts_with("extension.vsixmanifest") {
                continue;
            }
            continue;
        }

        let rel = &raw_name[prefix.len()..];
        if rel.is_empty() || rel.contains("..") {
            continue;
        }

        let target = ext_dir.join(rel);

        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("mkdir {rel}: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).ok();
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).map_err(|e| format!("read {rel}: {e}"))?;
            fs::write(&target, &buf).map_err(|e| format!("write {rel}: {e}"))?;
        }
    }

    log::info!("installed extension {} to {}", manifest.id, ext_dir.display());

    Ok(InstalledExtension {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        path: ext_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn uninstall_extension(extension_id: String) -> Result<(), String> {
    let ext_dir = extensions_dir().join(&extension_id);
    if !ext_dir.exists() {
        return Err(format!("not installed: {}", extension_id));
    }
    fs::remove_dir_all(&ext_dir).map_err(|e| format!("remove: {e}"))?;
    log::info!("uninstalled {extension_id}");
    Ok(())
}

#[tauri::command]
pub async fn list_installed_extensions() -> Result<Vec<InstalledExtension>, String> {
    let dir = extensions_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("readdir: {e}"))?;
    for entry in entries.flatten() {
        let pkg = entry.path().join("package.json");
        if !pkg.exists() { continue; }
        if let Ok(raw) = fs::read_to_string(&pkg) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                let publisher = val.get("publisher").and_then(|v| v.as_str()).unwrap_or("unknown");
                let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                out.push(InstalledExtension {
                    id: format!("{publisher}.{name}"),
                    name: val.get("displayName").and_then(|v| v.as_str()).unwrap_or(name).to_string(),
                    version: val.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0").to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                });
            }
        }
    }
    Ok(out)
}

struct VsixManifest {
    id: String,
    name: String,
    version: String,
}

fn read_vsix_manifest(archive: &mut zip::ZipArchive<File>) -> Result<VsixManifest, String> {
    let pkg_path = "extension/package.json";
    let mut entry = archive.by_name(pkg_path).map_err(|_| "VSIX missing extension/package.json".to_string())?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf).map_err(|e| format!("read manifest: {e}"))?;
    let val: serde_json::Value = serde_json::from_str(&buf).map_err(|e| format!("parse manifest: {e}"))?;
    let publisher = val.get("publisher").and_then(|v| v.as_str()).unwrap_or("unknown");
    let name = val.get("name").and_then(|v| v.as_str()).ok_or("manifest missing 'name'")?;
    let version = val.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
    Ok(VsixManifest {
        id: format!("{publisher}.{name}"),
        name: val.get("displayName").and_then(|v| v.as_str()).unwrap_or(name).to_string(),
        version: version.to_string(),
    })
}
