use md5;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Calculate SHA-256 hash of data
#[tauri::command]
pub fn sha256_hash(data: Vec<u8>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(&data);
    format!("{:x}", hasher.finalize())
}

/// Calculate SHA-256 hash of file
#[tauri::command]
pub fn sha256_file(path: String) -> Result<String, String> {
    use std::fs::File;
    use std::io::Read;

    let mut file = File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Calculate MD5 hash of data
#[tauri::command]
pub fn md5_hash(data: Vec<u8>) -> String {
    format!("{:x}", md5::compute(&data))
}

/// Calculate MD5 hash of file
#[tauri::command]
pub fn md5_file(path: String) -> Result<String, String> {
    use std::fs::File;
    use std::io::Read;

    let mut file = File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;

    let mut context = md5::Context::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        context.consume(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", context.compute()))
}

/// Generate random bytes
#[tauri::command]
pub fn random_bytes(length: usize) -> Vec<u8> {
    use rand::RngCore;

    let mut bytes = vec![0u8; length.min(65536)]; // Max 64KB
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
}

/// Generate UUID v4
#[tauri::command]
pub fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Simple base64 encoding
#[tauri::command]
pub fn base64_encode(data: Vec<u8>) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(&data)
}

/// Simple base64 decoding
#[tauri::command]
pub fn base64_decode(text: String) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD
        .decode(&text)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

/// URL-safe base64 encoding
#[tauri::command]
pub fn base64_encode_urlsafe(data: Vec<u8>) -> String {
    use base64::{engine::general_purpose::URL_SAFE, Engine as _};
    URL_SAFE.encode(&data)
}

/// URL-safe base64 decoding
#[tauri::command]
pub fn base64_decode_urlsafe(text: String) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::URL_SAFE, Engine as _};
    URL_SAFE
        .decode(&text)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

#[derive(Debug, Serialize)]
pub struct FileHashInfo {
    pub path: String,
    pub sha256: String,
    pub md5: String,
    pub size: u64,
}

/// Calculate multiple hashes for a file at once
#[tauri::command]
pub fn file_hashes(path: String) -> Result<FileHashInfo, String> {
    use std::fs::File;
    use std::io::Read;

    let mut file = File::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;

    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to get metadata: {}", e))?;

    let mut sha256_hasher = Sha256::new();
    let mut md5_context = md5::Context::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        sha256_hasher.update(&buffer[..bytes_read]);
        md5_context.consume(&buffer[..bytes_read]);
    }

    Ok(FileHashInfo {
        path,
        sha256: format!("{:x}", sha256_hasher.finalize()),
        md5: format!("{:x}", md5_context.compute()),
        size: metadata.len(),
    })
}
