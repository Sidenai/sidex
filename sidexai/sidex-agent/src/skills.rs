//! Skill loader for .sidex/skills/*.md files.
//! Skills are markdown files with YAML frontmatter that define reusable
//! prompts the AI can invoke.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub user_invocable: bool,
    pub path: PathBuf,
}

/// Load all skills from `.sidex/skills/` in the given project directory.
/// Each skill is either a directory containing a `SKILL.md` file, or a
/// standalone `.md` file directly inside the skills folder.
pub fn load_skills(project_dir: &Path) -> Vec<Skill> {
    let skills_dir = project_dir.join(".sidex").join("skills");
    if !skills_dir.is_dir() {
        return Vec::new();
    }
    let mut skills = Vec::new();

    let entries = match fs::read_dir(&skills_dir) {
        Ok(e) => e,
        Err(_) => return skills,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let skill_file = path.join("SKILL.md");
            if skill_file.exists() {
                if let Some(skill) = parse_skill_file(&skill_file) {
                    skills.push(skill);
                }
            }
        } else if path.extension().map_or(false, |e| e == "md") {
            if let Some(skill) = parse_skill_file(&path) {
                skills.push(skill);
            }
        }
    }
    skills
}

/// Look up a single skill by name from the loaded set.
pub fn find_skill<'a>(skills: &'a [Skill], name: &str) -> Option<&'a Skill> {
    skills.iter().find(|s| s.name == name)
}

fn parse_skill_file(path: &Path) -> Option<Skill> {
    let content = fs::read_to_string(path).ok()?;
    let (frontmatter, body) = split_frontmatter(&content)?;

    let default_name = path
        .file_stem()
        .unwrap_or_default()
        .to_str()
        .unwrap_or("")
        .to_string();

    let name = frontmatter
        .get("name")
        .cloned()
        .unwrap_or(default_name);

    let description = frontmatter
        .get("description")
        .cloned()
        .unwrap_or_default();

    let user_invocable = frontmatter
        .get("user-invocable")
        .map(|v| v == "true")
        .unwrap_or(false);

    let allowed_tools = frontmatter
        .get("allowed-tools")
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    Some(Skill {
        name,
        description,
        body: body.to_string(),
        allowed_tools,
        user_invocable,
        path: path.to_path_buf(),
    })
}

fn split_frontmatter(content: &str) -> Option<(HashMap<String, String>, &str)> {
    let content = content.trim_start();
    if !content.starts_with("---") {
        return Some((HashMap::new(), content));
    }
    let after_first = &content[3..];
    let end = after_first.find("\n---")?;
    let fm_text = &after_first[..end];
    let body_start = end + 4; // skip "\n---"
    let body = after_first.get(body_start..)?.trim_start();

    let mut map = HashMap::new();
    for line in fm_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            map.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    Some((map, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_split_frontmatter_with_yaml() {
        let input = "---\nname: commit\ndescription: Generate commit message\n---\nBody text here";
        let (fm, body) = split_frontmatter(input).unwrap();
        assert_eq!(fm.get("name").unwrap(), "commit");
        assert_eq!(fm.get("description").unwrap(), "Generate commit message");
        assert_eq!(body, "Body text here");
    }

    #[test]
    fn test_split_frontmatter_without_yaml() {
        let input = "Just plain markdown content";
        let (fm, body) = split_frontmatter(input).unwrap();
        assert!(fm.is_empty());
        assert_eq!(body, "Just plain markdown content");
    }

    #[test]
    fn test_load_skills_missing_dir() {
        let dir = std::env::temp_dir().join("sidex_test_no_skills");
        let skills = load_skills(&dir);
        assert!(skills.is_empty());
    }

    #[test]
    fn test_load_skills_from_dir() {
        let dir = tempfile::tempdir().unwrap();
        let skills_dir = dir.path().join(".sidex").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();

        fs::write(
            skills_dir.join("review.md"),
            "---\nname: review\ndescription: Code review\nuser-invocable: true\n---\nReview the code.",
        )
        .unwrap();

        let sub = skills_dir.join("commit");
        fs::create_dir_all(&sub).unwrap();
        fs::write(
            sub.join("SKILL.md"),
            "---\nname: commit\ndescription: Commit helper\n---\nGenerate a commit message.",
        )
        .unwrap();

        let skills = load_skills(dir.path());
        assert_eq!(skills.len(), 2);

        let review = find_skill(&skills, "review").unwrap();
        assert!(review.user_invocable);
        assert_eq!(review.body, "Review the code.");

        let commit = find_skill(&skills, "commit").unwrap();
        assert_eq!(commit.description, "Commit helper");
    }
}
