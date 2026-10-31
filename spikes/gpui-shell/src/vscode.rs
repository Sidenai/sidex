//! Reads the user's real VSCode setup: settings.json, the active colour theme
//! (following `include` chains), the active file-icon theme, and the
//! extension -> language-id table contributed by every installed extension.
//!
//! Spike-only: in a real SideX these come from SideX's own settings and
//! extension registry, but reading VSCode's makes the look comparable.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{Map, Value};
use sidex_theme::TokenColorRule;

use crate::file_icons::IconTheme;

pub struct Setup {
    /// VSCode `window.zoomLevel` as a scale factor (1.2 ^ level).
    pub zoom: f32,
    pub editor_font: String,
    pub editor_font_size: f32,
    pub editor_line_height: f32,
    pub terminal_font: String,
    pub terminal_font_size: f32,
    pub theme_name: String,
    pub is_dark: bool,
    pub colors: Map<String, Value>,
    pub token_rules: Vec<TokenColorRule>,
    pub icons: Option<IconTheme>,
    pub lang_by_ext: HashMap<String, String>,
    pub lang_by_filename: HashMap<String, String>,
}

static SETUP: OnceLock<Setup> = OnceLock::new();

pub fn get() -> &'static Setup {
    SETUP.get_or_init(load)
}

/// Scale a design-pixel value by the user's zoom level.
pub fn z(v: f32) -> gpui_kit::Pixels {
    gpui_kit::px(v * get().zoom)
}

fn read_jsonc(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    sidex_settings::parse_jsonc(&text).ok()
}

fn first_family(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().trim_matches(['\'', '"']).to_owned())
        .filter(|s| !s.is_empty() && s != "monospace")
        .unwrap_or_else(|| fallback.to_owned())
}

struct Contribution {
    dir: PathBuf,
    manifest: Value,
}

fn extension_dirs() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(
        "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
    )];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".vscode/extensions"));
    }
    roots
}

fn contributions() -> Vec<Contribution> {
    let mut out = Vec::new();
    for root in extension_dirs() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if let Some(manifest) = read_jsonc(&dir.join("package.json")) {
                out.push(Contribution { dir, manifest });
            }
        }
    }
    out
}

fn contributes<'a>(c: &'a Contribution, key: &str) -> impl Iterator<Item = &'a Value> {
    c.manifest
        .get("contributes")
        .and_then(|v| v.get(key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// Find a contributed theme/icon theme whose `id` or `label` equals `name`.
fn find_contribution(all: &[Contribution], key: &str, name: &str) -> Option<PathBuf> {
    for c in all {
        for t in contributes(c, key) {
            let matches = ["id", "label"]
                .iter()
                .any(|k| t.get(*k).and_then(Value::as_str) == Some(name));
            if matches {
                if let Some(p) = t.get("path").and_then(Value::as_str) {
                    return Some(c.dir.join(p));
                }
            }
        }
    }
    None
}

/// Load a colour theme file, merging its `include` chain base-first.
fn load_theme(
    path: &Path,
    depth: usize,
) -> Option<(Map<String, Value>, Vec<Value>, Option<String>)> {
    let v = read_jsonc(path)?;
    let (mut colors, mut tokens, mut kind) = match v.get("include").and_then(Value::as_str) {
        Some(inc) if depth < 8 => {
            load_theme(&path.parent()?.join(inc), depth + 1).unwrap_or_default()
        }
        _ => Default::default(),
    };
    if let Some(Value::Object(c)) = v.get("colors") {
        for (k, v) in c {
            colors.insert(k.clone(), v.clone());
        }
    }
    if let Some(Value::Array(t)) = v.get("tokenColors") {
        tokens.extend(t.iter().cloned());
    }
    if let Some(t) = v.get("type").and_then(Value::as_str) {
        kind = Some(t.to_owned());
    }
    Some((colors, tokens, kind))
}

fn load() -> Setup {
    let settings = dirs::home_dir()
        .map(|h| h.join("Library/Application Support/Code/User/settings.json"))
        .and_then(|p| read_jsonc(&p))
        .unwrap_or(Value::Null);
    let s = |k: &str| settings.get(k);

    let zoom = 1.2f32.powf(s("window.zoomLevel").and_then(Value::as_f64).unwrap_or(0.) as f32);
    let editor_font = first_family(s("editor.fontFamily"), "Menlo");
    let editor_font_size = s("editor.fontSize").and_then(Value::as_f64).unwrap_or(12.) as f32;
    let editor_line_height = match s("editor.lineHeight").and_then(Value::as_f64) {
        Some(h) if h >= 8. => h as f32,
        Some(h) if h > 0. => (h as f32 * editor_font_size).round(),
        // VSCode on macOS: golden ratio 1.5, rounded.
        _ => (editor_font_size * 1.5).round(),
    };
    let terminal_font = first_family(s("terminal.integrated.fontFamily"), &editor_font);
    let terminal_font_size = s("terminal.integrated.fontSize")
        .and_then(Value::as_f64)
        .unwrap_or(12.) as f32;

    let all = contributions();

    let theme_name = s("workbench.colorTheme")
        .and_then(Value::as_str)
        .unwrap_or("Default Dark Modern")
        .to_owned();
    let theme = find_contribution(&all, "themes", &theme_name)
        .and_then(|p| load_theme(&p, 0))
        .or_else(|| {
            find_contribution(&all, "themes", "Default Dark Modern").and_then(|p| load_theme(&p, 0))
        });
    let (colors, tokens, kind) = theme.unwrap_or_default();
    let token_rules = sidex_theme::Theme::from_value(&serde_json::json!({
        "tokenColors": tokens,
    }))
    .map(|t| t.token_colors)
    .unwrap_or_default();
    let is_dark = !matches!(kind.as_deref(), Some("light" | "hcLight"));

    let icon_name = s("workbench.iconTheme")
        .and_then(Value::as_str)
        .unwrap_or("vs-seti");
    let icons = find_contribution(&all, "iconThemes", icon_name).and_then(|p| IconTheme::load(&p));

    let mut lang_by_ext = HashMap::new();
    let mut lang_by_filename = HashMap::new();
    for c in &all {
        for lang in contributes(c, "languages") {
            let Some(id) = lang.get("id").and_then(Value::as_str) else {
                continue;
            };
            for ext in lang
                .get("extensions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(e) = ext.as_str() {
                    lang_by_ext
                        .entry(e.trim_start_matches('.').to_lowercase())
                        .or_insert_with(|| id.to_owned());
                }
            }
            for f in lang
                .get("filenames")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(f) = f.as_str() {
                    lang_by_filename
                        .entry(f.to_lowercase())
                        .or_insert_with(|| id.to_owned());
                }
            }
        }
    }

    log::info!(
        "vscode setup: theme={theme_name} ({} colors, {} token rules), icons={icon_name}, zoom={zoom}",
        colors.len(),
        token_rules.len()
    );

    Setup {
        zoom,
        editor_font,
        editor_font_size,
        editor_line_height,
        terminal_font,
        terminal_font_size,
        theme_name,
        is_dark,
        colors,
        token_rules,
        icons,
        lang_by_ext,
        lang_by_filename,
    }
}

impl Setup {
    /// VSCode language id for a file name, the way the editor resolves it.
    pub fn language_for(&self, file_name: &str) -> Option<&str> {
        let lower = file_name.to_lowercase();
        if let Some(id) = self.lang_by_filename.get(&lower) {
            return Some(id);
        }
        // Longest dotted suffix first: `d.ts` before `ts`.
        let mut rest = lower.as_str();
        while let Some(ix) = rest.find('.') {
            rest = &rest[ix + 1..];
            if let Some(id) = self.lang_by_ext.get(rest) {
                return Some(id);
            }
        }
        None
    }
}
