mod commands;

use commands::ext_host::ExtHostProcess;
use commands::storage::StorageDb;
use commands::terminal::TerminalStore;
use std::sync::Arc;
use tauri::Manager;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
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

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new_file", "New File").accelerator("CmdOrCtrl+N").build(app)?)
        .item(&MenuItemBuilder::with_id("new_window", "New Window").accelerator("CmdOrCtrl+Shift+N").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("open_file", "Open File...").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&MenuItemBuilder::with_id("open_folder", "Open Folder...").build(app)?)
        .item(&MenuItemBuilder::with_id("open_recent", "Open Recent").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(app)?)
        .item(&MenuItemBuilder::with_id("save_as", "Save As...").accelerator("CmdOrCtrl+Shift+S").build(app)?)
        .item(&MenuItemBuilder::with_id("save_all", "Save All").accelerator("CmdOrCtrl+Alt+S").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("close_editor", "Close Editor").accelerator("CmdOrCtrl+W").build(app)?)
        .item(&MenuItemBuilder::with_id("close_window", "Close Window").accelerator("CmdOrCtrl+Shift+W").build(app)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("find", "Find").accelerator("CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("replace", "Replace").accelerator("CmdOrCtrl+H").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("find_in_files", "Find in Files").accelerator("CmdOrCtrl+Shift+F").build(app)?)
        .item(&MenuItemBuilder::with_id("replace_in_files", "Replace in Files").accelerator("CmdOrCtrl+Shift+H").build(app)?)
        .build()?;

    let selection_menu = SubmenuBuilder::new(app, "Selection")
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .item(&MenuItemBuilder::with_id("expand_selection", "Expand Selection").accelerator("CmdOrCtrl+Shift+Right").build(app)?)
        .item(&MenuItemBuilder::with_id("shrink_selection", "Shrink Selection").accelerator("CmdOrCtrl+Shift+Left").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("copy_line_up", "Copy Line Up").accelerator("Alt+Shift+Up").build(app)?)
        .item(&MenuItemBuilder::with_id("copy_line_down", "Copy Line Down").accelerator("Alt+Shift+Down").build(app)?)
        .item(&MenuItemBuilder::with_id("move_line_up", "Move Line Up").accelerator("Alt+Up").build(app)?)
        .item(&MenuItemBuilder::with_id("move_line_down", "Move Line Down").accelerator("Alt+Down").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("add_cursor_above", "Add Cursor Above").accelerator("CmdOrCtrl+Alt+Up").build(app)?)
        .item(&MenuItemBuilder::with_id("add_cursor_below", "Add Cursor Below").accelerator("CmdOrCtrl+Alt+Down").build(app)?)
        .item(&MenuItemBuilder::with_id("select_all_occurrences", "Select All Occurrences").accelerator("CmdOrCtrl+Shift+L").build(app)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("command_palette", "Command Palette...").accelerator("CmdOrCtrl+Shift+P").build(app)?)
        .item(&MenuItemBuilder::with_id("open_view", "Open View...").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("explorer", "Explorer").accelerator("CmdOrCtrl+Shift+E").build(app)?)
        .item(&MenuItemBuilder::with_id("search", "Search").accelerator("CmdOrCtrl+Shift+F").build(app)?)
        .item(&MenuItemBuilder::with_id("source_control", "Source Control").accelerator("CmdOrCtrl+Shift+G").build(app)?)
        .item(&MenuItemBuilder::with_id("debug", "Run and Debug").accelerator("CmdOrCtrl+Shift+D").build(app)?)
        .item(&MenuItemBuilder::with_id("extensions", "Extensions").accelerator("CmdOrCtrl+Shift+X").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("problems", "Problems").accelerator("CmdOrCtrl+Shift+M").build(app)?)
        .item(&MenuItemBuilder::with_id("output", "Output").accelerator("CmdOrCtrl+Shift+U").build(app)?)
        .item(&MenuItemBuilder::with_id("terminal", "Terminal").accelerator("CmdOrCtrl+`").build(app)?)
        .item(&MenuItemBuilder::with_id("debug_console", "Debug Console").accelerator("CmdOrCtrl+Shift+Y").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggle_fullscreen", "Toggle Full Screen").accelerator("Ctrl+CmdOrCtrl+F").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom_in", "Zoom In").accelerator("CmdOrCtrl+=").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom_out", "Zoom Out").accelerator("CmdOrCtrl+-").build(app)?)
        .item(&MenuItemBuilder::with_id("reset_zoom", "Reset Zoom").accelerator("CmdOrCtrl+0").build(app)?)
        .build()?;

    let go_menu = SubmenuBuilder::new(app, "Go")
        .item(&MenuItemBuilder::with_id("back", "Back").accelerator("CmdOrCtrl+Alt+Left").build(app)?)
        .item(&MenuItemBuilder::with_id("forward", "Forward").accelerator("CmdOrCtrl+Alt+Right").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("go_to_file", "Go to File...").accelerator("CmdOrCtrl+P").build(app)?)
        .item(&MenuItemBuilder::with_id("go_to_symbol", "Go to Symbol in Workspace...").accelerator("CmdOrCtrl+T").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("go_to_line", "Go to Line/Column...").accelerator("CmdOrCtrl+G").build(app)?)
        .item(&MenuItemBuilder::with_id("go_to_definition", "Go to Definition").accelerator("F12").build(app)?)
        .item(&MenuItemBuilder::with_id("go_to_references", "Go to References").accelerator("Shift+F12").build(app)?)
        .build()?;

    let run_menu = SubmenuBuilder::new(app, "Run")
        .item(&MenuItemBuilder::with_id("start_debugging", "Start Debugging").accelerator("F5").build(app)?)
        .item(&MenuItemBuilder::with_id("run_without_debugging", "Run Without Debugging").accelerator("CmdOrCtrl+F5").build(app)?)
        .item(&MenuItemBuilder::with_id("stop_debugging", "Stop Debugging").accelerator("Shift+F5").build(app)?)
        .item(&MenuItemBuilder::with_id("restart_debugging", "Restart Debugging").accelerator("CmdOrCtrl+Shift+F5").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggle_breakpoint", "Toggle Breakpoint").accelerator("F9").build(app)?)
        .build()?;

    let terminal_menu = SubmenuBuilder::new(app, "Terminal")
        .item(&MenuItemBuilder::with_id("new_terminal", "New Terminal").accelerator("CmdOrCtrl+Shift+`").build(app)?)
        .item(&MenuItemBuilder::with_id("split_terminal", "Split Terminal").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("run_task", "Run Task...").build(app)?)
        .item(&MenuItemBuilder::with_id("run_build_task", "Run Build Task...").accelerator("CmdOrCtrl+Shift+B").build(app)?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("welcome", "Welcome").build(app)?)
        .item(&MenuItemBuilder::with_id("documentation", "Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id("release_notes", "Release Notes").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("keyboard_shortcuts", "Keyboard Shortcuts Reference").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("report_issue", "Report Issue").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggle_dev_tools", "Toggle Developer Tools").accelerator("CmdOrCtrl+Alt+I").build(app)?)
        .build()?;

    Menu::with_items(app, &[
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
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(TerminalStore::new()))
        .manage(ExtHostProcess::new())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data).ok();
            let db_path = app_data.join("sidex_storage.db");
            let db = StorageDb::new(db_path.to_str().unwrap())
                .expect("failed to initialize storage database");
            app.manage(Arc::new(db));

            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            // Forward menu action to the webview
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&format!(
                    "window.__sidex_menu_action && window.__sidex_menu_action('{}')",
                    id
                ));
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::terminal_spawn,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::search_files,
            commands::search_text,
            commands::create_window,
            commands::close_window,
            commands::set_window_title,
            commands::get_monitors,
            commands::get_os_info,
            commands::get_env,
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
            commands::start_extension_host,
            commands::stop_extension_host,
            commands::extension_host_port,
            commands::fetch_url,
            commands::fetch_url_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
