use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenPathKind {
    File,
    Folder,
    Workspace,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OpenPath {
    pub path: String,
    pub kind: OpenPathKind,
}

/// Arguments exclude argv[0]. Resolve relative paths in the launching process's cwd.
pub fn parse_paths(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<OpenPath> {
    let mut paths = Vec::new();
    let mut positional = false;
    for arg in args {
        if !positional && arg == "--" {
            positional = true;
            continue;
        }
        if !positional && arg.to_string_lossy().starts_with('-') {
            continue;
        }
        let path = cwd.join(arg);
        let Ok(path) = dunce::canonicalize(path) else {
            continue;
        };
        let kind = if path.is_dir() {
            OpenPathKind::Folder
        } else if path.is_file() {
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("code-workspace"))
            {
                OpenPathKind::Workspace
            } else {
                OpenPathKind::File
            }
        } else {
            continue;
        };
        // The webview uses UTF-8 strings; don't silently corrupt an unrepresentable path.
        let Some(path) = path.to_str() else { continue };
        let request = OpenPath {
            path: path.to_owned(),
            kind,
        };
        if !paths.contains(&request) {
            paths.push(request);
        }
    }
    paths
}

#[derive(Default)]
pub struct PendingOpenPaths(Mutex<VecDeque<Vec<OpenPath>>>);

impl PendingOpenPaths {
    pub fn push(&self, paths: Vec<OpenPath>) {
        if !paths.is_empty() {
            self.0.lock().unwrap().push_back(paths);
        }
    }

    fn take(&self) -> Result<Option<Vec<OpenPath>>, String> {
        self.0
            .lock()
            .map(|mut pending| pending.pop_front())
            .map_err(|_| "Could not access pending launch paths".to_owned())
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn take_pending_open_paths(
    state: tauri::State<'_, PendingOpenPaths>,
) -> Result<Option<Vec<OpenPath>>, String> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_existing_paths_and_ignores_flags_and_missing_paths() {
        let root = std::env::temp_dir().join(format!("sidex-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("folder with spaces")).unwrap();
        for name in [
            "hello 世界.js",
            "test.json",
            "project.code-workspace",
            "-file.js",
        ] {
            std::fs::write(root.join(name), "{}").unwrap();
        }
        let args = [
            "--ignored",
            "missing",
            "hello 世界.js",
            "test.json",
            "folder with spaces",
            "project.code-workspace",
            "hello 世界.js",
            "--",
            "-file.js",
        ];
        let paths = parse_paths(args.map(OsString::from), &root);
        assert_eq!(
            paths.iter().map(|p| p.kind.clone()).collect::<Vec<_>>(),
            vec![
                OpenPathKind::File,
                OpenPathKind::File,
                OpenPathKind::Folder,
                OpenPathKind::Workspace,
                OpenPathKind::File
            ]
        );
        assert_eq!(
            paths[0].path,
            dunce::canonicalize(root.join("hello 世界.js"))
                .unwrap()
                .to_str()
                .unwrap()
        );
        assert_eq!(
            parse_paths([root.join("test.json").into_os_string()], &root)[0],
            paths[1]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queues_launches_until_consumed_once_in_order() {
        let pending = PendingOpenPaths::default();
        let file = OpenPath {
            path: "test.js".into(),
            kind: OpenPathKind::File,
        };
        let folder = OpenPath {
            path: "folder".into(),
            kind: OpenPathKind::Folder,
        };
        pending.push(vec![]);
        pending.push(vec![file.clone()]);
        pending.push(vec![folder.clone()]);
        assert_eq!(pending.take().unwrap(), Some(vec![file]));
        assert_eq!(pending.take().unwrap(), Some(vec![folder]));
        assert_eq!(pending.take().unwrap(), None);
    }
}
