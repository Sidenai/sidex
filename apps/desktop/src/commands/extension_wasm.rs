//! Tauri commands over the WASM extension host in `sidex-extension-wasm-host`.

use crate::commands::extension_platform::ExtensionManifest;
use serde::{Deserialize, Serialize};
use sidex_extension_wasm_host::wit_types;
pub use sidex_extension_wasm_host::WasmExtensionRuntime;
use std::sync::Arc;
use tauri::State;

/// Load the WASM binary a scanned manifest points at.
pub fn load_wasm_manifest(
    runtime: &WasmExtensionRuntime,
    manifest: &ExtensionManifest,
) -> Result<(), String> {
    let wasm_file = manifest
        .wasm_binary
        .as_ref()
        .ok_or("manifest has no wasm_binary")?;
    runtime.load_extension(
        &manifest.id,
        &std::path::Path::new(&manifest.path).join(wasm_file),
    )
}

// ---------------------------------------------------------------------------
// Serialized provider result types for Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmCompletionResult {
    pub items: Vec<serde_json::Value>,
    pub is_incomplete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmHoverResult {
    pub contents: Vec<String>,
    pub range: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Provider dispatch helpers
// ---------------------------------------------------------------------------

fn make_doc_ctx(uri: &str, language_id: &str, version: u32) -> wit_types::DocumentContext {
    wit_types::DocumentContext {
        uri: uri.to_string(),
        language_id: language_id.to_string(),
        version,
    }
}

fn make_position(line: u32, character: u32) -> wit_types::Position {
    wit_types::Position { line, character }
}

fn serialize_range(r: &wit_types::Range) -> serde_json::Value {
    serde_json::json!({
        "start": { "line": r.start.line, "character": r.start.character },
        "end": { "line": r.end.line, "character": r.end.character },
    })
}

fn serialize_location(l: &wit_types::Location) -> serde_json::Value {
    serde_json::json!({
        "uri": l.uri,
        "range": serialize_range(&l.range),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands — WASM provider dispatch
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmProviderParams {
    pub extension_id: String,
    pub uri: String,
    pub language_id: String,
    pub version: u32,
    pub line: u32,
    pub character: u32,
}

#[tauri::command]
pub async fn wasm_provide_completion(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmCompletionResult>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_completion(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("completion call failed: {e}"))?;

    Ok(result.map(|cl| WasmCompletionResult {
        items: cl
            .items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "label": item.label,
                    "kind": item.kind,
                    "detail": item.detail,
                    "documentation": item.documentation,
                    "insertText": item.insert_text.as_deref().unwrap_or(&item.label),
                    "sortText": item.sort_text,
                    "filterText": item.filter_text,
                })
            })
            .collect(),
        is_incomplete: cl.is_incomplete,
    }))
}

#[tauri::command]
pub async fn wasm_provide_hover(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmHoverResult>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_hover(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("hover call failed: {e}"))?;

    Ok(result.map(|h| WasmHoverResult {
        contents: h.contents,
        range: h.range.as_ref().map(serialize_range),
    }))
}

#[tauri::command]
pub async fn wasm_provide_definition(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_definition(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("definition call failed: {e}"))?;

    Ok(result.iter().map(serialize_location).collect())
}

#[tauri::command]
pub async fn wasm_provide_references(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);
    let pos = make_position(params.line, params.character);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_references(&mut ext.store, &ctx, pos)
        .map_err(|e| format!("references call failed: {e}"))?;

    Ok(result.iter().map(serialize_location).collect())
}

#[tauri::command]
pub async fn wasm_provide_document_symbols(
    params: WasmProviderParams,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_document_symbols(&mut ext.store, &ctx)
        .map_err(|e| format!("document symbols call failed: {e}"))?;

    Ok(result
        .iter()
        .map(|s| {
            serde_json::json!({
                "name": s.name,
                "detail": s.detail,
                "kind": s.kind,
                "range": serialize_range(&s.range),
                "selectionRange": serialize_range(&s.selection_range),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn wasm_provide_formatting(
    params: WasmProviderParams,
    tab_size: u32,
    insert_spaces: bool,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&params.extension_id)
        .ok_or_else(|| format!("extension not loaded: {}", params.extension_id))?;

    let ctx = make_doc_ctx(&params.uri, &params.language_id, params.version);

    let result = ext
        .bindings
        .sidex_extension_extension_api()
        .call_provide_formatting(&mut ext.store, &ctx, tab_size, insert_spaces)
        .map_err(|e| format!("formatting call failed: {e}"))?;

    Ok(result
        .iter()
        .map(|e| {
            serde_json::json!({
                "range": serialize_range(&e.range),
                "newText": e.new_text,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn wasm_load_extension(
    extension_id: String,
    wasm_path: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.load_extension(&extension_id, std::path::Path::new(&wasm_path))
}

#[tauri::command]
pub async fn wasm_unload_extension(
    extension_id: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.unload_extension(&extension_id)
}

#[tauri::command]
pub async fn wasm_list_extensions(
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<String>, String> {
    Ok(state.loaded_extension_ids())
}

#[tauri::command]
pub async fn wasm_sync_document(
    uri: String,
    language_id: String,
    text: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.sync_document(&uri, &language_id, &text);
    Ok(())
}

#[tauri::command]
pub async fn wasm_close_document(
    uri: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.close_document(&uri);
    Ok(())
}

#[tauri::command]
pub async fn wasm_sync_workspace_folders(
    folders: Vec<String>,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    state.sync_workspace_folders(&folders);
    Ok(())
}

/// Broadcast completion request to all loaded WASM extensions and merge results.
#[tauri::command]
pub async fn wasm_provide_completion_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmCompletionResult>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);

    let mut all_items = Vec::new();
    let mut any_incomplete = false;

    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_completion(&mut ext.store, &ctx, pos)
            {
                Ok(Some(cl)) => {
                    any_incomplete = any_incomplete || cl.is_incomplete;
                    for item in &cl.items {
                        all_items.push(serde_json::json!({
                            "label": item.label,
                            "kind": item.kind,
                            "detail": item.detail,
                            "documentation": item.documentation,
                            "insertText": item.insert_text.as_deref().unwrap_or(&item.label),
                            // "0" prefix so WASM extension results sort before other sources
                            "sortText": item.sort_text.as_deref().map_or_else(|| format!("0{}", item.label), |s| format!("0{s}")),
                            "filterText": item.filter_text,
                        }));
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    log::warn!("WASM completion error from {ext_id}: {e}");
                }
            }
        }
    }

    if all_items.is_empty() {
        Ok(None)
    } else {
        Ok(Some(WasmCompletionResult {
            items: all_items,
            is_incomplete: any_incomplete,
        }))
    }
}

/// Broadcast hover request to all loaded WASM extensions and return first non-empty result.
#[tauri::command]
pub async fn wasm_provide_hover_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<WasmHoverResult>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);

    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_hover(&mut ext.store, &ctx, pos)
            {
                Ok(Some(h)) if !h.contents.is_empty() => {
                    return Ok(Some(WasmHoverResult {
                        contents: h.contents,
                        range: h.range.as_ref().map(serialize_range),
                    }));
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("WASM hover error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(None)
}

/// Broadcast definition request to all loaded WASM extensions.
#[tauri::command]
pub async fn wasm_provide_definition_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);

    let mut all_locs = Vec::new();
    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_definition(&mut ext.store, &ctx, pos)
            {
                Ok(locs) => {
                    for l in &locs {
                        all_locs.push(serialize_location(l));
                    }
                }
                Err(e) => {
                    log::warn!("WASM definition error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(all_locs)
}

/// Broadcast document symbols request to all loaded WASM extensions.
#[tauri::command]
pub async fn wasm_provide_document_symbols_all(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);

    let mut all_symbols = Vec::new();
    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_document_symbols(&mut ext.store, &ctx)
            {
                Ok(symbols) => {
                    for s in &symbols {
                        all_symbols.push(serde_json::json!({
                            "name": s.name,
                            "detail": s.detail,
                            "kind": s.kind,
                            "range": serialize_range(&s.range),
                            "selectionRange": serialize_range(&s.selection_range),
                        }));
                    }
                }
                Err(e) => {
                    log::warn!("WASM document symbols error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(all_symbols)
}

/// Broadcast formatting request to all loaded WASM extensions.
#[tauri::command]
pub async fn wasm_provide_formatting_all(
    uri: String,
    language_id: String,
    version: u32,
    tab_size: u32,
    insert_spaces: bool,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);

    let ext_ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for ext_id in &ext_ids {
        if let Some(ext) = guard.extensions.get_mut(ext_id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_formatting(&mut ext.store, &ctx, tab_size, insert_spaces)
            {
                Ok(edits) if !edits.is_empty() => {
                    return Ok(edits
                        .iter()
                        .map(|e| {
                            serde_json::json!({
                                "range": serialize_range(&e.range),
                                "newText": e.new_text,
                            })
                        })
                        .collect());
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!("WASM formatting error from {ext_id}: {e}");
                }
            }
        }
    }
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// Document event broadcast helpers
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn wasm_on_document_opened(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext
            .bindings
            .sidex_extension_extension_api()
            .call_on_document_opened(&mut ext.store, &ctx);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_document_closed(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext
            .bindings
            .sidex_extension_extension_api()
            .call_on_document_closed(&mut ext.store, &ctx);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_document_saved(
    uri: String,
    language_id: String,
    version: u32,
    reason: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext
            .bindings
            .sidex_extension_extension_api()
            .call_on_document_saved(&mut ext.store, &ctx, reason);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_document_changed(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    for ext in guard.extensions.values_mut() {
        let _ = ext
            .bindings
            .sidex_extension_extension_api()
            .call_on_document_changed(&mut ext.store, &ctx, &[]);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_configuration_changed(
    section: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    for ext in guard.extensions.values_mut() {
        let _ = ext
            .bindings
            .sidex_extension_extension_api()
            .call_on_configuration_changed(&mut ext.store, &section);
    }
    Ok(())
}

#[tauri::command]
pub async fn wasm_on_active_editor_changed(
    uri: Option<String>,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<(), String> {
    if let Ok(mut guard) = state.lock() {
        for ext in guard.extensions.values_mut() {
            ext.store.data_mut().set_active_editor_uri(uri.clone());
            let _ = ext
                .bindings
                .sidex_extension_extension_api()
                .call_on_active_editor_changed(&mut ext.store, uri.as_deref());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Extended provider broadcast commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn wasm_provide_type_definition_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(locs) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_type_definition(&mut ext.store, &ctx, pos)
            {
                for l in &locs {
                    all.push(serialize_location(l));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_implementation_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(locs) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_implementation(&mut ext.store, &ctx, pos)
            {
                for l in &locs {
                    all.push(serialize_location(l));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_declaration_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(locs) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_declaration(&mut ext.store, &ctx, pos)
            {
                for l in &locs {
                    all.push(serialize_location(l));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn wasm_provide_code_actions_all(
    uri: String,
    language_id: String,
    version: u32,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let range = wit_types::Range {
        start: make_position(start_line, start_character),
        end: make_position(end_line, end_character),
    };
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(actions) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_code_actions(&mut ext.store, &ctx, range, &[])
            {
                for a in &actions {
                    all.push(serde_json::json!({
                        "title": a.title,
                        "kind": a.kind,
                        "isPreferred": a.is_preferred,
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_code_lenses_all(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(lenses) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_code_lenses(&mut ext.store, &ctx)
            {
                for l in &lenses {
                    all.push(serde_json::json!({
                        "range": serialize_range(&l.range),
                        "command": { "id": l.command_id, "title": l.command_title },
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_signature_help_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(Some(sh)) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_signature_help(&mut ext.store, &ctx, pos)
            {
                return Ok(Some(serde_json::json!({
                    "signatures": sh.signatures.iter().map(|s| serde_json::json!({
                        "label": s.label,
                        "documentation": s.documentation,
                        "parameters": s.parameters.iter().map(|p| serde_json::json!({"label": p.label})).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                    "activeSignature": sh.active_signature,
                    "activeParameter": sh.active_parameter,
                })));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn wasm_provide_document_highlights_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(highlights) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_document_highlights(&mut ext.store, &ctx, pos)
            {
                for h in &highlights {
                    all.push(
                        serde_json::json!({ "range": serialize_range(&h.range), "kind": h.kind }),
                    );
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_rename_all(
    uri: String,
    language_id: String,
    version: u32,
    line: u32,
    character: u32,
    new_name: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let pos = make_position(line, character);
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(Some(r)) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_rename(&mut ext.store, &ctx, pos, &new_name)
            {
                return Ok(Some(serde_json::json!({
                    "edits": r.edits.iter().map(|e| serde_json::json!({
                        "uri": e.uri,
                        "edits": e.edits.iter().map(|te| serde_json::json!({"range": serialize_range(&te.range), "newText": te.new_text})).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                })));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn wasm_provide_folding_ranges_all(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(ranges) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_folding_ranges(&mut ext.store, &ctx)
            {
                for r in &ranges {
                    all.push(serde_json::json!({ "startLine": r.start_line, "endLine": r.end_line, "kind": r.kind }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn wasm_provide_inlay_hints_all(
    uri: String,
    language_id: String,
    version: u32,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let range = wit_types::Range {
        start: make_position(start_line, start_character),
        end: make_position(end_line, end_character),
    };
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(hints) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_inlay_hints(&mut ext.store, &ctx, range)
            {
                for h in &hints {
                    all.push(serde_json::json!({
                        "position": { "line": h.position.line, "character": h.position.character },
                        "label": h.label,
                        "kind": h.kind,
                        "paddingLeft": h.padding_left,
                        "paddingRight": h.padding_right,
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_document_links_all(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(links) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_document_links(&mut ext.store, &ctx)
            {
                for l in &links {
                    all.push(serde_json::json!({ "range": serialize_range(&l.range), "target": l.target }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_selection_ranges_all(
    uri: String,
    language_id: String,
    version: u32,
    positions: Vec<(u32, u32)>,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let wit_positions: Vec<wit_types::Position> = positions
        .iter()
        .map(|(l, c)| make_position(*l, *c))
        .collect();
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(ranges) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_selection_ranges(&mut ext.store, &ctx, &wit_positions)
            {
                for r in &ranges {
                    all.push(serde_json::json!({ "range": serialize_range(&r.range) }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_semantic_tokens_all(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Option<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(Some(tokens)) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_semantic_tokens(&mut ext.store, &ctx)
            {
                return Ok(Some(
                    serde_json::json!({ "data": tokens.data, "resultId": tokens.result_id }),
                ));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn wasm_provide_document_colors_all(
    uri: String,
    language_id: String,
    version: u32,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(colors) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_document_colors(&mut ext.store, &ctx)
            {
                for c in &colors {
                    all.push(serde_json::json!({
                        "range": serialize_range(&c.range),
                        "color": { "red": c.red, "green": c.green, "blue": c.blue, "alpha": c.alpha },
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
pub async fn wasm_provide_workspace_symbols_all(
    query: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(symbols) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_workspace_symbols(&mut ext.store, &query)
            {
                for s in &symbols {
                    all.push(serde_json::json!({
                        "name": s.name,
                        "detail": s.detail,
                        "kind": s.kind,
                        "range": serialize_range(&s.range),
                        "selectionRange": serialize_range(&s.selection_range),
                    }));
                }
            }
        }
    }
    Ok(all)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn wasm_provide_range_formatting_all(
    uri: String,
    language_id: String,
    version: u32,
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    tab_size: u32,
    insert_spaces: bool,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ctx = make_doc_ctx(&uri, &language_id, version);
    let range = wit_types::Range {
        start: make_position(start_line, start_character),
        end: make_position(end_line, end_character),
    };
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            if let Ok(edits) = ext
                .bindings
                .sidex_extension_extension_api()
                .call_provide_range_formatting(&mut ext.store, &ctx, range, tab_size, insert_spaces)
            {
                if !edits.is_empty() {
                    return Ok(edits
                        .iter()
                        .map(|e| {
                            serde_json::json!({
                                "range": serialize_range(&e.range),
                                "newText": e.new_text,
                            })
                        })
                        .collect());
                }
            }
        }
    }
    Ok(vec![])
}

#[tauri::command]
pub async fn wasm_execute_command_all(
    command_id: String,
    args: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    let ids: Vec<String> = guard.extensions.keys().cloned().collect();
    for id in &ids {
        if let Some(ext) = guard.extensions.get_mut(id) {
            match ext
                .bindings
                .sidex_extension_extension_api()
                .call_execute_command(&mut ext.store, &command_id, &args)
            {
                Ok(Ok(result)) => {
                    results.push(serde_json::json!({ "extensionId": id, "result": result }));
                }
                Ok(Err(e)) => log::warn!("[wasm] execute_command error from {id}: {e}"),
                Err(e) => log::warn!("[wasm] execute_command trap from {id}: {e}"),
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn wasm_get_extension_metadata(
    extension_id: String,
    state: State<'_, Arc<WasmExtensionRuntime>>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let ext = guard
        .extensions
        .get_mut(&extension_id)
        .ok_or_else(|| format!("extension not loaded: {extension_id}"))?;
    let api = ext.bindings.sidex_extension_extension_api();
    let name = api.call_get_name(&mut ext.store).unwrap_or_default();
    let display_name = api
        .call_get_display_name(&mut ext.store)
        .unwrap_or_default();
    let version = api.call_get_version(&mut ext.store).unwrap_or_default();
    let publisher = api.call_get_publisher(&mut ext.store).unwrap_or_default();
    let activation_events = api
        .call_get_activation_events(&mut ext.store)
        .unwrap_or_default();
    let commands = api.call_get_commands(&mut ext.store).unwrap_or_default();
    let languages = api.call_get_languages(&mut ext.store).unwrap_or_default();
    let legend = api
        .call_get_semantic_tokens_legend(&mut ext.store)
        .unwrap_or(None);
    Ok(serde_json::json!({
        "id": extension_id,
        "name": name,
        "displayName": display_name,
        "version": version,
        "publisher": publisher,
        "activationEvents": activation_events,
        "commands": commands.iter().map(|c| serde_json::json!({"id": c.id, "title": c.title})).collect::<Vec<_>>(),
        "languages": languages,
        "semanticTokensLegend": legend.map(|l| serde_json::json!({
            "tokenTypes": l.token_types,
            "tokenModifiers": l.token_modifiers,
        })),
    }))
}
