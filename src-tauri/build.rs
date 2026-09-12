use std::fs;
use std::path::Path;

fn main() {
    let scripts_src = Path::new("../src/vs/workbench/contrib/terminal/common/scripts");
    let scripts_dst = Path::new("shell-integration");

    if scripts_src.exists() {
        fs::create_dir_all(scripts_dst).expect("Failed to create shell-integration dir");

        let shell_files = [
            "shellIntegration-rc.zsh",
            "shellIntegration-env.zsh",
            "shellIntegration-profile.zsh",
            "shellIntegration-login.zsh",
            "shellIntegration-bash.sh",
            "shellIntegration.fish",
            "shellIntegration.ps1",
        ];

        for file in &shell_files {
            let src = scripts_src.join(file);
            let dst = scripts_dst.join(file);
            if src.exists() {
                let src_bytes =
                    fs::read(&src).unwrap_or_else(|e| panic!("Failed to read {file}: {e}"));
                let needs_copy = fs::read(&dst).map_or(true, |dst_bytes| dst_bytes != src_bytes);
                if needs_copy {
                    fs::write(&dst, &src_bytes)
                        .unwrap_or_else(|e| panic!("Failed to copy {file}: {e}"));
                }
                println!("cargo:rerun-if-changed={}", src.display());
            }
        }
    }

    let ext_host_src = Path::new("extension-host");
    let ext_host_targets = [
        Path::new("target/debug/extension-host"),
        Path::new("target/release/extension-host"),
    ];
    if ext_host_src.exists() {
        for ext_host_dst in &ext_host_targets {
            fs::create_dir_all(ext_host_dst).ok();
            for file in &["server.cjs", "host.cjs"] {
                let src = ext_host_src.join(file);
                let dst = ext_host_dst.join(file);
                if src.exists() {
                    let src_bytes = fs::read(&src).unwrap_or_default();
                    let needs_copy =
                        fs::read(&dst).map_or(true, |dst_bytes| dst_bytes != src_bytes);
                    if needs_copy {
                        let _ = fs::write(&dst, &src_bytes);
                    }
                }
            }
        }
        for file in &["server.cjs", "host.cjs"] {
            let src = ext_host_src.join(file);
            if src.exists() {
                println!("cargo:rerun-if-changed={}", src.display());
            }
        }
    }

    // --- No-op UBSan runtime ---------------------------------------------
    // zig cc (the C compiler used on Windows here) instruments C code with
    // UndefinedBehaviourSanitizer in Debug mode. The C objects pulled in by
    // tree-sitter / sqlite3 / zstd / lzma / ring / aws-lc therefore reference
    // __ubsan_handle_* hooks, and rust-lld -- our linker -- does not provide
    // that runtime, so the link fails with "undefined symbol".
    //
    // Linking a no-op stub keeps a dev build working. Point SIDEX_UBSAN_LIB at
    // the directory holding libubsan_runtime.a, or drop the archive at
    // `<workspace-root>/.tools/lib/` and it is picked up automatically. The
    // directory is optional: without it the build just does not add the stub,
    // which is correct for toolchains that ship a real UBSan runtime.
    let ubsan_dir = std::env::var("SIDEX_UBSAN_LIB").unwrap_or_else(|_| {
        // CARGO_MANIFEST_DIR is `<workspace-root>/src-tauri`.
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .map_or_else(String::new, |root| {
                root.join(".tools").join("lib").to_string_lossy().into_owned()
            })
    });
    if Path::new(&ubsan_dir).join("libubsan_runtime.a").exists() {
        println!("cargo:rustc-link-search=native={ubsan_dir}");
        println!("cargo:rustc-link-lib=static=ubsan_runtime");
    }

    tauri_build::build();

    // --- Force the Windows resource object into the executable -------------
    // tauri-build compiles resource.rc (icon + version info + application
    // manifest) with windres and packs the resulting object into
    // libresource.a, linked as `-lstatic=resource`.
    //
    // Archive members are only pulled in when they resolve an undefined
    // symbol, and a resource-only object resolves nothing -- so rust-lld
    // drops it entirely and the executable ends up without a .rsrc section.
    // With no embedded manifest Windows loads comctl32 v5, which does not
    // export TaskDialogIndirect, and the process dies during startup with
    //
    //     STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)
    //
    // Passing the object file to the linker directly makes it an
    // unconditional input, so the manifest actually lands in the image.
    let out_dir = std::env::var("OUT_DIR").unwrap_or_default();
    for entry in fs::read_dir(&out_dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("obj") {
            println!("cargo:rustc-link-arg={}", path.display());
        }
    }
}
