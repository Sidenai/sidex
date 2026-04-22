//! Auto-detect npm scripts from `package.json` and turn them into [`Task`]s.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};

use crate::task::{Task, TaskGroup, TaskPresentation, TaskSource, TaskType};

/// Detects npm scripts in the given workspace and returns them as tasks.
///
/// Looks for `package.json` in `workspace_root` and reads its `"scripts"`
/// section.
pub fn detect_npm_tasks(workspace_root: &Path) -> Result<Vec<Task>> {
    let pkg_path = workspace_root.join("package.json");
    if !pkg_path.exists() {
        return Ok(Vec::new());
    }

    let text = std::fs::read_to_string(&pkg_path)
        .with_context(|| format!("failed to read {}", pkg_path.display()))?;
    parse_package_json(&text)
}

/// Parses a `package.json` string and extracts scripts as tasks.
pub fn parse_package_json(json: &str) -> Result<Vec<Task>> {
    let value: serde_json::Value =
        serde_json::from_str(json).context("failed to parse package.json")?;

    let Some(scripts) = value.get("scripts").and_then(|s| s.as_object()) else {
        return Ok(Vec::new());
    };

    let mut tasks = Vec::with_capacity(scripts.len());
    for (name, cmd) in scripts {
        let _command = cmd.as_str().unwrap_or_default().to_string();
        let group = infer_group(name);

        tasks.push(Task {
            name: format!("npm: {name}"),
            task_type: TaskType::Npm,
            command: format!("npm run {name}"),
            args: Vec::new(),
            cwd: None,
            env: HashMap::default(),
            group,
            presentation: TaskPresentation::default(),
            problem_matcher: Vec::new(),
            source: TaskSource::Npm,
            depends_on: Vec::new(),
            depends_order: crate::task::DependsOrder::Parallel,
            is_background: false,
            prompt_on_close: false,
            is_default_build: false,
            is_default_test: false,
        });
    }

    tasks.sort_by_key(|a| a.name.clone());
    Ok(tasks)
}

fn infer_group(script_name: &str) -> TaskGroup {
    match script_name {
        "build" | "compile" | "watch" => TaskGroup::Build,
        "test" | "test:unit" | "test:e2e" | "test:integration" => TaskGroup::Test,
        _ => TaskGroup::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_package_json() {
        let json = r#"{
            "name": "my-app",
            "scripts": {
                "build": "tsc",
                "test": "jest",
                "start": "node dist/main.js"
            }
        }"#;
        let tasks = parse_package_json(json).unwrap();
        assert_eq!(tasks.len(), 3);

        let build = tasks.iter().find(|t| t.name == "npm: build").unwrap();
        assert_eq!(build.task_type, TaskType::Npm);
        assert_eq!(build.command, "npm run build");
        assert_eq!(build.group, TaskGroup::Build);
        assert_eq!(build.source, TaskSource::Npm);

        let test = tasks.iter().find(|t| t.name == "npm: test").unwrap();
        assert_eq!(test.group, TaskGroup::Test);

        let start = tasks.iter().find(|t| t.name == "npm: start").unwrap();
        assert_eq!(start.group, TaskGroup::None);
    }

    #[test]
    fn parse_no_scripts() {
        let json = r#"{ "name": "bare" }"#;
        let tasks = parse_package_json(json).unwrap();
        assert!(tasks.is_empty());
    }

    #[test]
    fn parse_empty_scripts() {
        let json = r#"{ "name": "bare", "scripts": {} }"#;
        let tasks = parse_package_json(json).unwrap();
        assert!(tasks.is_empty());
    }

    #[test]
    fn tasks_are_sorted_by_name() {
        let json = r#"{
            "scripts": {
                "z-last": "echo z",
                "a-first": "echo a"
            }
        }"#;
        let tasks = parse_package_json(json).unwrap();
        assert_eq!(tasks[0].name, "npm: a-first");
        assert_eq!(tasks[1].name, "npm: z-last");
    }

    #[test]
    fn infer_group_build() {
        assert_eq!(infer_group("build"), TaskGroup::Build);
        assert_eq!(infer_group("compile"), TaskGroup::Build);
        assert_eq!(infer_group("watch"), TaskGroup::Build);
    }

    #[test]
    fn infer_group_test() {
        assert_eq!(infer_group("test"), TaskGroup::Test);
        assert_eq!(infer_group("test:unit"), TaskGroup::Test);
    }

    #[test]
    fn infer_group_none() {
        assert_eq!(infer_group("start"), TaskGroup::None);
        assert_eq!(infer_group("lint"), TaskGroup::None);
    }
}
