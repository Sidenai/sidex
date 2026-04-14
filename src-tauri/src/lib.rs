mod commands;

use commands::debug::DebugAdapterStore;
use commands::ext_host::ExtensionPlatformSupervisor;
use commands::extension_diagnostics::ExtensionDiagnosticsStore;
use commands::extension_wasm::WasmExtensionRuntime;
use commands::index::IndexStore;
use commands::logging::LoggerStore;
use commands::process::ProcessStore;
use commands::storage::StorageDb;
use commands::tasks::TaskProcessStore;
use commands::terminal::TerminalStore;
use commands::watch::WatchStore;
use commands::window::restore_and_show;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let file_menu = SubmenuBuilder::new(app, "File")
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

    let edit_menu = SubmenuBuilder::new(app, "Edit")
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

    let selection_menu = SubmenuBuilder::new(app, "Selection")
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

    let view_menu = SubmenuBuilder::new(app, "View")
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

    let go_menu = SubmenuBuilder::new(app, "Go")
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

    let run_menu = SubmenuBuilder::new(app, "Run")
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

    let terminal_menu = SubmenuBuilder::new(app, "Terminal")
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

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
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

    let sidex_menu = SubmenuBuilder::new(app, "SideX")
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
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(TerminalStore::new()))
        .manage(Arc::new(ProcessStore::new()))
        .manage(Arc::new(DebugAdapterStore::new()))
        .manage(Arc::new(TaskProcessStore::new()))
        .manage(Arc::new(WatchStore::new()))
        .manage(Arc::new(IndexStore::new(true)))
        .manage(Arc::new(LoggerStore::new()))
        .manage(ExtensionPlatformSupervisor::new())
        .manage(ExtensionDiagnosticsStore::new())
        .manage(Arc::new(
            WasmExtensionRuntime::new().expect("failed to initialize WASM runtime"),
        ))
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

            let process_store = app.state::<Arc<ProcessStore>>();
            process_store.set_app_handle(app.handle().clone());

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

            #[cfg(feature = "devtools")]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if let Some(window) = app.get_webview_window("main") {
                let escaped = id.replace('\\', "\\\\").replace('\'', "\\'");
                let _ = window.eval(&format!(
                    "window.dispatchEvent(new CustomEvent('sidex-native-menu', {{ detail: '{}' }}))",
                    escaped
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
            commands::normalize_line_endings,
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
            commands::search_files,
            commands::search_text,
            commands::create_window,
            commands::close_window,
            commands::set_window_title,
            commands::get_monitors,
            commands::save_window_state,
            commands::get_os_info,
            commands::get_env,
            commands::get_all_env,
            commands::get_shell,
            commands::storage_get,
            commands::storage_set,
            commands::storage_delete,
            commands::git_status,
            commands::git_diff,
            commands::git_log,
            commands::git_add,
            commands::git_commit,
            commands::git_checkout,
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
            commands::task_spawn,
            commands::task_kill,
            commands::task_list,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
