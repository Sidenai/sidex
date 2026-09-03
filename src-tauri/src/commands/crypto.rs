use md5;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;

const HASH_BUF_SIZE: usize = 64 * 1024;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn sha256_hash(data: Vec<u8>) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(format!("{:x}", hasher.finalize()))
}

#[allow(clippy::needless_pass_by_value, clippy::large_stack_arrays)]
#[tauri::command]
pub fn sha256_file(path: String) -> Result<String, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut reader = std::io::BufReader::with_capacity(HASH_BUF_SIZE, file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; HASH_BUF_SIZE];

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn md5_hash(data: Vec<u8>) -> Result<String, String> {
    Ok(format!("{:x}", md5::compute(&data)))
}

#[allow(clippy::needless_pass_by_value, clippy::large_stack_arrays)]
#[tauri::command]
pub fn md5_file(path: String) -> Result<String, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut reader = std::io::BufReader::with_capacity(HASH_BUF_SIZE, file);
    let mut context = md5::Context::new();
    let mut buf = [0u8; HASH_BUF_SIZE];

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file: {e}"))?;
        if n == 0 {
            break;
        }
        context.consume(&buf[..n]);
    }

    Ok(format!("{:x}", context.compute()))
}

#[tauri::command]
pub fn random_bytes(length: usize) -> Result<Vec<u8>, String> {
    use rand::RngCore;
    let mut bytes = vec![0u8; length.min(65536)];
    rand::thread_rng().fill_bytes(&mut bytes);
    Ok(bytes)
}

#[tauri::command]
pub fn uuid_v4() -> Result<String, String> {
    Ok(uuid::Uuid::new_v4().to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn base64_encode(data: Vec<u8>) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(STANDARD.encode(&data))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn base64_decode(text: String) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD
        .decode(&text)
        .map_err(|e| format!("Base64 decode error: {e}"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn base64_encode_urlsafe(data: Vec<u8>) -> Result<String, String> {
    use base64::{engine::general_purpose::URL_SAFE, Engine as _};
    Ok(URL_SAFE.encode(&data))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn base64_decode_urlsafe(text: String) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::URL_SAFE, Engine as _};
    URL_SAFE
        .decode(&text)
        .map_err(|e| format!("Base64 decode error: {e}"))
}

#[derive(Debug, Serialize)]
pub struct FileHashInfo {
    pub path: String,
    pub sha256: String,
    pub md5: String,
    pub size: u64,
}

#[allow(clippy::needless_pass_by_value, clippy::large_stack_arrays)]
#[tauri::command]
pub fn file_hashes(path: String) -> Result<FileHashInfo, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let file_size = file
        .metadata()
        .map_err(|e| format!("Failed to get metadata: {e}"))?
        .len();

    let mut reader = std::io::BufReader::with_capacity(HASH_BUF_SIZE, file);
    let mut sha256_hasher = Sha256::new();
    let mut md5_context = md5::Context::new();
    let mut buf = [0u8; HASH_BUF_SIZE];

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file: {e}"))?;
        if n == 0 {
            break;
        }
        sha256_hasher.update(&buf[..n]);
        md5_context.consume(&buf[..n]);
    }

    Ok(FileHashInfo {
        path,
        sha256: format!("{:x}", sha256_hasher.finalize()),
        md5: format!("{:x}", md5_context.compute()),
        size: file_size,
    })
}
