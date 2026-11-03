#[cfg(test)]
mod tests {
    use crate::{execute, ToolContext, ToolRequest};
    use std::fs;

    fn ctx(dir: &std::path::Path) -> ToolContext {
        ToolContext {
            cwd: dir.display().to_string(),
            token: String::new(),
        }
    }

    fn req(name: &str, args: &str) -> ToolRequest {
        ToolRequest {
            tool_call_id: "t1".into(),
            name: name.into(),
            arguments: args.into(),
        }
    }

    #[test]
    fn test_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let resp = execute(&req("cwd", "{}"), &ctx(dir.path()));
        assert!(resp.error.is_empty(), "error: {}", resp.error);
        assert!(resp.output.contains("cwd:"), "output: {}", resp.output);
        assert!(resp.output.contains("exists: true"));
    }

    #[test]
    fn test_read_write_file() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(dir.path());

        let resp = execute(
            &req(
                "write_file",
                r#"{"path":"hello.txt","content":"hello world"}"#,
            ),
            &c,
        );
        assert!(resp.error.is_empty(), "{}", resp.error);

        let resp = execute(&req("read_file", r#"{"path":"hello.txt"}"#), &c);
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("hello world"));
    }

    #[test]
    fn test_edit_file() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(dir.path());
        let path = dir.path().join("test.txt");
        fs::write(&path, "hello world").unwrap();

        let resp = execute(
            &req(
                "edit_file",
                r#"{"path":"test.txt","old_string":"hello","new_string":"goodbye"}"#,
            ),
            &c,
        );
        assert!(resp.error.is_empty(), "{}", resp.error);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "goodbye world");
    }

    #[test]
    fn test_edit_file_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(dir.path());
        fs::write(dir.path().join("f.txt"), "abc").unwrap();

        let resp = execute(
            &req(
                "edit_file",
                r#"{"path":"f.txt","old_string":"xyz","new_string":"q"}"#,
            ),
            &c,
        );
        assert!(!resp.error.is_empty(), "should fail");
        assert!(resp.error.contains("not found"), "error: {}", resp.error);
    }

    #[test]
    fn test_list_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "A").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();

        let resp = execute(&req("list_dir", r#"{"path":"."}"#), &ctx(dir.path()));
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("a.txt"));
        assert!(resp.output.contains("sub"));
    }

    #[test]
    fn test_tree() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a/b")).unwrap();
        fs::write(dir.path().join("a/b/c.txt"), "x").unwrap();

        let resp = execute(&req("tree", r#"{"depth":3}"#), &ctx(dir.path()));
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("c.txt"));
    }

    #[test]
    fn test_shell() {
        let dir = tempfile::tempdir().unwrap();
        let resp = execute(
            &req("shell", r#"{"command":"echo hello-sidex"}"#),
            &ctx(dir.path()),
        );
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("hello-sidex"));
    }

    #[test]
    fn test_shell_bad_dir() {
        let resp = execute(
            &req(
                "shell",
                r#"{"command":"echo hi","working_directory":"/nope/fake"}"#,
            ),
            &ToolContext {
                cwd: "/tmp".into(),
                token: String::new(),
            },
        );
        assert!(!resp.error.is_empty());
        assert!(resp.error.contains("does not exist"), "{}", resp.error);
    }

    #[test]
    fn test_file_info() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), "hello").unwrap();
        let resp = execute(&req("file_info", r#"{"path":"f.txt"}"#), &ctx(dir.path()));
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("size: 5"));
    }

    #[test]
    fn test_multi_edit() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(dir.path());
        let path = dir.path().join("m.txt");
        fs::write(&path, "alpha beta gamma").unwrap();

        let resp = execute(
            &req(
                "multi_edit",
                r#"{"path":"m.txt","edits":[{"old":"alpha","new":"one"},{"old":"beta","new":"two"}]}"#,
            ),
            &c,
        );
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert_eq!(fs::read_to_string(&path).unwrap(), "one two gamma");
    }

    #[test]
    fn test_glob() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.rs"), "").unwrap();
        fs::write(dir.path().join("b.txt"), "").unwrap();

        let resp = execute(&req("glob", r#"{"pattern":"*.rs"}"#), &ctx(dir.path()));
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("a.rs"));
        assert!(!resp.output.contains("b.txt"));
    }

    #[test]
    fn test_batch_read() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("x.txt"), "hello").unwrap();
        fs::write(dir.path().join("y.txt"), "world").unwrap();

        let resp = execute(
            &req("batch_read", r#"{"paths":["x.txt","y.txt"]}"#),
            &ctx(dir.path()),
        );
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("hello"));
        assert!(resp.output.contains("world"));
    }

    #[test]
    fn test_empty_args() {
        let dir = tempfile::tempdir().unwrap();
        let resp = execute(&req("cwd", ""), &ctx(dir.path()));
        assert!(
            resp.error.is_empty(),
            "empty args should be OK: {}",
            resp.error
        );
    }

    #[test]
    fn test_unknown_tool() {
        let resp = execute(
            &req("not_real", "{}"),
            &ToolContext {
                cwd: "/tmp".into(),
                token: String::new(),
            },
        );
        assert!(!resp.error.is_empty());
        assert!(resp.error.contains("not implemented"));
    }

    #[test]
    fn test_read_file_with_offset_limit() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("lines.txt"), "a\nb\nc\nd\ne").unwrap();

        let resp = execute(
            &req("read_file", r#"{"path":"lines.txt","offset":2,"limit":2}"#),
            &ctx(dir.path()),
        );
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("|b"));
        assert!(resp.output.contains("|c"));
        assert!(!resp.output.contains("|a"));
        assert!(!resp.output.contains("|d"));
    }

    #[test]
    fn test_image_read() {
        let dir = tempfile::tempdir().unwrap();
        #[rustfmt::skip]
        let png_data: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
            0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
            0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF,
            0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
            0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82,
        ];
        fs::write(dir.path().join("test.png"), &png_data).unwrap();

        let resp = execute(
            &req("image_read", r#"{"path":"test.png"}"#),
            &ctx(dir.path()),
        );
        assert!(resp.error.is_empty(), "{}", resp.error);
        assert!(resp.output.contains("image/png"));
        assert!(resp.output.contains("base64_data"));
    }
}
