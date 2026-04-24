mod commands;

use commands::cache::FileMetadataCache;
use commands::db_state::SidexDbState;
use commands::debug::{DapClientStore, DebugAdapterStore};
use commands::ext_host::ExtensionPlatformSupervisor;
use commands::extension_diagnostics::ExtensionDiagnosticsStore;
use commands::extension_wasm::WasmExtensionRuntime;
use commands::index::IndexStore;
use commands::logging::LoggerStore;
use commands::lsp::LspState;
use commands::process::ProcessStore;
use commands::remote::RemoteManagerStore;
use commands::settings::SettingsStore;
use commands::storage::StorageDb;
use commands::tasks::TaskProcessStore;
use commands::terminal::TerminalStore;
use commands::updater::UpdateManagerState;
use commands::watch::WatchStore;
use commands::window::restore_and_show;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_lines)]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let file_menu = SubmenuBuilder::with_id(app, "file_menu", "File")
        .item(
            &MenuItemBuilder::with_id("new_file", "New File")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("new_window", "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("open_file", "Open File...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("open_folder", "Open Folder...").build(app)?)
        .item(&MenuItemBuilder::with_id("open_recent", "Open Recent").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_as", "Save As...")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("save_all", "Save All")
                .accelerator("CmdOrCtrl+Alt+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close_editor", "Close Editor")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("close_window", "Close Window")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::with_id(app, "edit_menu", "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", "Find")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("replace", "Replace")
                .accelerator("CmdOrCtrl+H")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("find_in_files", "Find in Files")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("replace_in_files", "Replace in Files")
                .accelerator("CmdOrCtrl+Shift+H")
                .build(app)?,
        )
        .build()?;

    let selection_menu = SubmenuBuilder::with_id(app, "selection_menu", "Selection")
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .item(
            &MenuItemBuilder::with_id("expand_selection", "Expand Selection")
                .accelerator("CmdOrCtrl+Shift+Right")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("shrink_selection", "Shrink Selection")
                .accelerator("CmdOrCtrl+Shift+Left")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("copy_line_up", "Copy Line Up")
                .accelerator("Alt+Shift+Up")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("copy_line_down", "Copy Line Down")
                .accelerator("Alt+Shift+Down")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("move_line_up", "Move Line Up")
                .accelerator("Alt+Up")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("move_line_down", "Move Line Down")
                .accelerator("Alt+Down")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("add_cursor_above", "Add Cursor Above")
                .accelerator("CmdOrCtrl+Alt+Up")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("add_cursor_below", "Add Cursor Below")
                .accelerator("CmdOrCtrl+Alt+Down")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("select_all_occurrences", "Select All Occurrences")
                .accelerator("CmdOrCtrl+Shift+L")
                .build(app)?,
        )
        .build()?;

    let view_menu = SubmenuBuilder::with_id(app, "view_menu", "View")
        .item(
            &MenuItemBuilder::with_id("command_palette", "Command Palette...")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("open_view", "Open View...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("explorer", "Explorer")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("search", "Search")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("source_control", "Source Control")
                .accelerator("CmdOrCtrl+Shift+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("debug", "Run and Debug")
                .accelerator("CmdOrCtrl+Shift+D")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("extensions", "Extensions")
                .accelerator("CmdOrCtrl+Shift+X")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("problems", "Problems")
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("output", "Output")
                .accelerator("CmdOrCtrl+Shift+U")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("terminal", "Terminal")
                .accelerator("CmdOrCtrl+`")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("debug_console", "Debug Console")
                .accelerator("CmdOrCtrl+Shift+Y")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle_fullscreen", "Toggle Full Screen")
                .accelerator("F11")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("reset_zoom", "Reset Zoom")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .build()?;

    let go_menu = SubmenuBuilder::with_id(app, "go_menu", "Go")
        .item(
            &MenuItemBuilder::with_id("back", "Back")
                .accelerator("CmdOrCtrl+Alt+Left")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("forward", "Forward")
                .accelerator("CmdOrCtrl+Alt+Right")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("go_to_file", "Go to File...")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("go_to_symbol", "Go to Symbol in Workspace...")
                .accelerator("CmdOrCtrl+T")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("go_to_line", "Go to Line/Column...")
                .accelerator("CmdOrCtrl+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("go_to_definition", "Go to Definition")
                .accelerator("F12")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("go_to_references", "Go to References")
                .accelerator("Shift+F12")
                .build(app)?,
        )
        .build()?;

    let run_menu = SubmenuBuilder::with_id(app, "run_menu", "Run")
        .item(
            &MenuItemBuilder::with_id("start_debugging", "Start Debugging")
                .accelerator("F5")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("run_without_debugging", "Run Without Debugging")
                .accelerator("CmdOrCtrl+F5")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("stop_debugging", "Stop Debugging")
                .accelerator("Shift+F5")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("restart_debugging", "Restart Debugging")
                .accelerator("CmdOrCtrl+Shift+F5")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle_breakpoint", "Toggle Breakpoint")
                .accelerator("F9")
                .build(app)?,
        )
        .build()?;

    let terminal_menu = SubmenuBuilder::with_id(app, "terminal_menu", "Terminal")
        .item(
            &MenuItemBuilder::with_id("new_terminal", "New Terminal")
                .accelerator("CmdOrCtrl+Shift+`")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("split_terminal", "Split Terminal").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("run_task", "Run Task...").build(app)?)
        .item(
            &MenuItemBuilder::with_id("run_build_task", "Run Build Task...")
                .accelerator("CmdOrCtrl+Shift+B")
                .build(app)?,
        )
        .build()?;

    let window_menu = SubmenuBuilder::with_id(app, "window_menu", "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    let help_menu = SubmenuBuilder::with_id(app, "help_menu", "Help")
        .item(&MenuItemBuilder::with_id("welcome", "Welcome").build(app)?)
        .item(&MenuItemBuilder::with_id("documentation", "Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id("release_notes", "Release Notes").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("keyboard_shortcuts", "Keyboard Shortcuts Reference")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("report_issue", "Report Issue").build(app)?)
        .separator()
        .build()?;

    let sidex_menu = SubmenuBuilder::with_id(app, "sidex_menu", "SideX")
        .item(&PredefinedMenuItem::about(app, Some("About SideX"), None)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let menu = Menu::with_items(
        app,
        &[
            &sidex_menu,
            &file_menu,
            &edit_menu,
            &selection_menu,
            &view_menu,
            &go_menu,
            &run_menu,
            &terminal_menu,
            &window_menu,
            &help_menu,
        ],
    )?;

    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::too_many_lines)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(UpdateManagerState::new())
        .manage(Arc::new(commands::textmate::TextMateStore::new()))
        .manage(Arc::new(commands::extensions::MarketplaceClientState::new()))
        .manage(Arc::new(TerminalStore::new()))
        .manage(Arc::new(ProcessStore::new()))
        .manage(Arc::new(DebugAdapterStore::new()))
        .manage(Arc::new(DapClientStore::new()))
        .manage(Arc::new(LspState::new()))
        .manage(Arc::new(TaskProcessStore::new()))
        .manage(Arc::new(WatchStore::new()))
        .manage(Arc::new(IndexStore::new(true)))
        .manage(Arc::new(LoggerStore::new()))
        .manage(ExtensionPlatformSupervisor::new())
        .manage(ExtensionDiagnosticsStore::new())
        .manage(Arc::new(SettingsStore::new()))
        .manage(Arc::new(sidex_extension_api::CommandRegistry::new()))
        .manage(Arc::new(RemoteManagerStore::new()))
        .manage(Arc::new(
            WasmExtensionRuntime::new().expect("failed to initialize WASM runtime"),
        ))
        .register_asynchronous_uri_scheme_protocol("sidex-asset", |_ctx, request, responder| {
            std::thread::spawn(move || {
                let raw_path = request.uri().path();
                let decoded = urlencoding::decode(raw_path.strip_prefix('/').unwrap_or(raw_path))
                    .unwrap_or_default();

                let Ok(data) = std::fs::read(decoded.as_ref()) else {
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(404)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(Vec::new())
                            .unwrap(),
                    );
                    return;
                };

                let mime = match std::path::Path::new(decoded.as_ref())
                    .extension()
                    .and_then(|e| e.to_str())
                {
                    Some("png") => "image/png",
                    Some("jpg" | "jpeg") => "image/jpeg",
                    Some("gif") => "image/gif",
                    Some("svg") => "image/svg+xml",
                    Some("webp") => "image/webp",
                    Some("ico") => "image/x-icon",
                    Some("woff") => "font/woff",
                    Some("woff2") => "font/woff2",
                    Some("ttf") => "font/ttf",
                    Some("css") => "text/css",
                    Some("js") => "text/javascript",
                    Some("json") => "application/json",
                    Some("wasm") => "application/wasm",
                    _ => "application/octet-stream",
                };

                responder.respond(
                    tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(data)
                        .unwrap(),
                );
            });
        })
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data).ok();
            let db_path = app_data.join("sidex_storage.db");
            let db = StorageDb::new(db_path.to_str().unwrap())
                .expect("failed to initialize storage database");

            restore_and_show(app, &db);

            app.manage(Arc::new(db));

            {
                let settings_store = app.state::<Arc<SettingsStore>>();
                let user_settings_path = app_data.join("UserData").join("User").join("settings.json");
                if user_settings_path.exists() {
                    if let Err(e) = settings_store.load_user(&user_settings_path) {
                        log::warn!("failed to pre-load user settings: {e}");
                    }
                }
            }

            let sidex_db_path = app_data.join("sidex_state.db");
            let sidex_db = sidex_db::Database::open(&sidex_db_path)
                .expect("failed to initialize sidex-db state database");
            app.manage(Arc::new(SidexDbState::new(sidex_db)));

            let process_store = app.state::<Arc<ProcessStore>>();
            process_store.set_app_handle(app.handle().clone());

            // Initialize LRU cache for file metadata
            app.manage(Arc::new(FileMetadataCache::new(10_000)));

            if let Err(err) = commands::updater::initialize(app.handle()) {
                log::warn!("update manager disabled: {err}");
            }
            if let Err(err) = commands::profiles::initialize(app.handle()) {
                log::warn!("profile storage disabled: {err}");
            }
            if let Err(err) = commands::secrets::initialize(app.handle()) {
                log::warn!("secret storage disabled: {err}");
            }

            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle())?;
                app.set_menu(menu)?;
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[allow(unexpected_cfgs)]
            {
                #[cfg(feature = "devtools")]
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if let Some(window) = app.get_webview_window("main") {
                let escaped = id.replace('\\', "\\\\").replace('\'', "\\'");
                let _ = window.eval(format!(
                    "window.dispatchEvent(new CustomEvent('sidex-native-menu', {{ detail: '{escaped}' }}))"
                ));
            }
        })
        .invoke_handler(tauri::generate_handler![
            // File system
            commands::read_file,
            commands::read_file_bytes,
            commands::write_file,
            commands::write_file_bytes,
            commands::read_dir,
            commands::stat,
            commands::mkdir,
            commands::remove,
            commands::rename,
            commands::exists,
            // Path operations
            commands::parse_path,
            commands::join_paths,
            commands::relative_path,
            commands::glob_match,
            commands::ext_category,
            commands::is_binary_file,
            commands::common_parent,
            // Text processing
            commands::count_lines,
            commands::file_summary,
            commands::normalize_line_endings_cmd,
            commands::to_crlf,
            commands::trim_trailing_whitespace,
            commands::ensure_final_newline,
            commands::get_word_boundaries,
            commands::simple_diff,
            commands::file_hash,
            commands::files_equal,
            // Compression
            commands::gzip_compress,
            commands::gzip_decompress,
            commands::gzip_compress_text,
            commands::gzip_decompress_text,
            commands::zip_list,
            commands::zip_extract_file,
            commands::zip_create,
            // Crypto
            commands::sha256_hash,
            commands::sha256_file,
            commands::md5_hash,
            commands::md5_file,
            commands::random_bytes,
            commands::uuid_v4,
            commands::base64_encode,
            commands::base64_decode,
            commands::base64_encode_urlsafe,
            commands::base64_decode_urlsafe,
            commands::file_hashes,
            commands::terminal_spawn,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::terminal_get_pid,
            // High-performance process management
            commands::term_spawn,
            commands::term_write,
            commands::term_resize,
            commands::term_read,
            commands::term_kill,
            commands::term_info,
            commands::term_list,
            commands::term_is_alive,
            commands::term_clear_buffer,
            commands::term_signal,
            commands::term_set_cwd,
            commands::term_get_shells,
            commands::exec,
            commands::get_default_shell,
            commands::check_shell_exists,
            commands::get_available_shells,
            commands::get_shell_integration_dir,
            commands::setup_zsh_dotdir,
            // sidex-terminal crate features
            commands::terminal_detect_shell,
            commands::terminal_get_profiles,
            commands::terminal_find_in_buffer,
            commands::search_files,
            commands::search_text,
            commands::search_workspace,
            commands::search_workspace_grouped,
            commands::search_workspace_replace_preview,
            commands::search_workspace_replace_apply,
            commands::create_window,
            commands::close_window,
            commands::set_window_title,
            commands::get_monitors,
            commands::save_window_state,
            commands::update_check,
            commands::update_download,
            commands::update_apply,
            commands::update_cancel,
            commands::update_state,
            commands::update_cleanup,
            commands::update_quit_and_install,
            commands::profiles_load,
            commands::profiles_save,
            commands::profiles_load_associations,
            commands::profiles_save_associations,
            commands::secret_get,
            commands::secret_set,
            commands::secret_delete,
            commands::secret_keys,
            commands::textmate_load_grammar,
            commands::textmate_update_theme,
            commands::textmate_tokenize_line,
		commands::textmate_tokenize_line_binary,
            commands::textmate_tokenize_document,
            commands::textmate_release_stack,
            commands::get_os_info,
            commands::get_env,
            commands::get_all_env,
            commands::get_shell,
            commands::get_user_data_dir,
            commands::storage_get,
            commands::storage_set,
            commands::storage_delete,
            // sidex-db state persistence
            commands::db_get_recent_files,
            commands::db_get_recent_workspaces,
            commands::db_save_workspace_state,
            commands::db_get_workspace_state,
            // Layered settings
            commands::settings_get,
            commands::settings_update,
            commands::settings_load,
            commands::settings_parse_jsonc,
            commands::settings_modify_jsonc,
            commands::git_status,
            commands::git_diff,
            commands::git_log,
            commands::git_add,
            commands::git_commit,
            commands::git_checkout,
            commands::git_restore,
            commands::git_clean,
            commands::git_checkout_file,
            commands::git_branches,
            commands::git_init,
            commands::git_is_repo,
            commands::git_push,
            commands::git_pull,
            commands::git_fetch,
            commands::git_stash,
            commands::git_create_branch,
            commands::git_delete_branch,
            commands::git_remote_list,
            commands::git_clone,
            commands::git_reset,
            commands::git_show,
            commands::git_run,
            commands::git_log_graph,
            commands::git_blame,
            commands::git_cherry_pick,
            commands::git_delete_branch_force,
            commands::git_fetch_all,
            commands::git_get_config,
            commands::git_get_remotes,
            commands::git_list_branches,
            commands::git_list_submodules,
            commands::git_list_tags,
            commands::git_merge,
            commands::git_pull_detailed,
            commands::git_push_detailed,
            commands::git_rebase,
            commands::git_rename_branch,
            commands::git_set_config,
            commands::git_stash_apply,
            commands::git_stash_drop_index,
            commands::git_stash_list_parsed,
            commands::git_submodule_init,
            commands::git_submodule_update,
            commands::git_tag,
            commands::extension_platform_bootstrap,
            commands::extension_platform_status,
            commands::extension_platform_restart,
            commands::extension_platform_stop,
            commands::extension_platform_init_data,
            commands::fetch_url,
            commands::fetch_url_text,
            commands::proxy_request,
            commands::proxy_request_full,
            commands::clipboard_read_text,
            commands::clipboard_write_text,
            commands::open_external_url,
            commands::env_shell,
            commands::env_app_host,
            commands::debug_spawn_adapter,
            commands::debug_send,
            commands::debug_kill,
            commands::debug_list_adapters,
            commands::dap_get_launch_configs,
            commands::dap_get_adapter_registry,
            commands::dap_start_adapter,
            commands::dap_send_request,
            commands::dap_stop_adapter,
            commands::task_spawn,
            commands::task_kill,
            commands::task_list,
            commands::tasks_detect,
            commands::tasks_parse_config,
            // File watching
            commands::watch_start,
            commands::watch_stop,
            commands::watch_update_patterns,
            commands::watch_list,
            commands::watch_is_active,
            // Extensions
            commands::install_extension,
            commands::install_extension_from_url,
            commands::uninstall_extension,
            commands::list_installed_extensions,
            commands::list_available_extensions,
            // Marketplace & contributions (sidex-extensions)
            commands::extension_search_marketplace,
            commands::extension_get_contributions,
            // WASM extensions
            commands::wasm_load_extension,
            commands::wasm_unload_extension,
            commands::wasm_list_extensions,
            commands::wasm_sync_document,
            commands::wasm_close_document,
            commands::wasm_sync_workspace_folders,
            commands::wasm_provide_completion,
            commands::wasm_provide_hover,
            commands::wasm_provide_definition,
            commands::wasm_provide_references,
            commands::wasm_provide_document_symbols,
            commands::wasm_provide_formatting,
            commands::wasm_provide_completion_all,
            commands::wasm_provide_hover_all,
            commands::wasm_provide_definition_all,
            commands::wasm_provide_document_symbols_all,
            commands::wasm_provide_formatting_all,
            commands::wasm_provide_type_definition_all,
            commands::wasm_provide_implementation_all,
            commands::wasm_provide_declaration_all,
            commands::wasm_provide_code_actions_all,
            commands::wasm_provide_code_lenses_all,
            commands::wasm_provide_signature_help_all,
            commands::wasm_provide_document_highlights_all,
            commands::wasm_provide_rename_all,
            commands::wasm_provide_folding_ranges_all,
            commands::wasm_provide_inlay_hints_all,
            commands::wasm_provide_document_links_all,
            commands::wasm_provide_selection_ranges_all,
            commands::wasm_provide_semantic_tokens_all,
            commands::wasm_provide_document_colors_all,
            commands::wasm_provide_workspace_symbols_all,
            commands::wasm_provide_range_formatting_all,
            commands::wasm_execute_command_all,
            commands::wasm_get_extension_metadata,
            commands::wasm_on_document_opened,
            commands::wasm_on_document_closed,
            commands::wasm_on_document_saved,
            commands::wasm_on_document_changed,
            commands::wasm_on_configuration_changed,
            commands::wasm_on_active_editor_changed,
            // Extension diagnostics
            commands::extension_report_activated,
            commands::extension_report_provider_call,
            commands::extension_report_deactivated,
            commands::extension_report_error,
            commands::extension_mark_startup_complete,
            commands::extension_register_session,
            commands::extension_runtime_status,
            commands::extension_runtime_profile,
            commands::extension_slow_extensions,
            commands::extension_startup_summary,
            // Extension bisect
            commands::extension_bisect_start,
            commands::extension_bisect_good,
            commands::extension_bisect_bad,
            commands::extension_bisect_reset,
            commands::extension_bisect_state,
            // Logging
            commands::log_create_logger,
            commands::log_write,
            commands::log_set_level,
            commands::log_flush,
            commands::log_drop,
            // Index search
            commands::index_build,
            commands::index_search,
            commands::index_update,
            commands::index_stats,
            commands::index_clear,
            // LSP management
            commands::lsp_get_server_registry,
            commands::lsp_get_supported_languages,
            commands::lsp_start_server,
            commands::lsp_send_request,
            commands::lsp_stop_server,
            commands::lsp_list_servers,
            // Syntax / language info
            commands::syntax_get_languages,
            commands::syntax_detect_language,
            commands::syntax_detect_from_content,
            commands::syntax_get_language_config,
            commands::syntax_tokenize,
            commands::textmate_tokenize_lines,
            // Theme management
            commands::theme_list,
            commands::theme_get,
            commands::theme_get_default_dark,
            commands::theme_get_default_light,
            // Keymap
            commands::keymap_get_defaults,
            commands::keymap_resolve,
            commands::keymap_resolve_chord,
            commands::keymap_get_all,
            // Editor intelligence
            commands::editor_detect_colors,
            commands::editor_compute_bracket_pairs,
            commands::editor_compute_folding_ranges,
            // Remote development
		commands::remote_list_ssh_hosts,
            commands::remote_list_wsl_distros,
            commands::remote_list_containers,
            commands::remote_connect_ssh,
            commands::remote_connect_wsl,
            commands::remote_connect_container,
            commands::remote_connect_codespace,
            commands::remote_exec_ssh,
            commands::remote_codespaces_list,
            commands::remote_disconnect,
            commands::remote_active_connections,
            // Extension API introspection
            commands::ext_api_get_namespaces,
            commands::ext_api_get_commands,
            // Menu i18n
            commands::update_menu_labels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
