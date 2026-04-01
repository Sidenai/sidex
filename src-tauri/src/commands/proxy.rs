#[tauri::command]
pub async fn fetch_url(url: String) -> Result<Vec<u8>, String> {
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read failed: {}", e))?;

    Ok(bytes.to_vec())
}

#[tauri::command]
pub async fn fetch_url_text(url: String) -> Result<String, String> {
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;

    response
        .text()
        .await
        .map_err(|e| format!("read failed: {}", e))
}
