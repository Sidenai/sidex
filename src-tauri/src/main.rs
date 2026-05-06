// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
fn fix_path_env() {
    if let Ok(output) = std::process::Command::new("/bin/zsh")
        .arg("-ilc")
        .arg("echo -n \"_MY_PATH_IS_=$PATH\"")
        .output()
    {
        if let Ok(path_str) = String::from_utf8(output.stdout) {
            if let Some(path) = path_str.split("_MY_PATH_IS_=").last() {
                if !path.trim().is_empty() {
                    std::env::set_var("PATH", path.trim());
                }
            }
        }
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    fix_path_env();

    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    sidex_lib::run();
}
