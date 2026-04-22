//! Data structures and utilities for the keyboard shortcut editor UI.
//!
//! Provides types for listing, recording, formatting, and parsing keybindings
//! in the keyboard shortcuts editor panel.

use std::collections::HashMap;

use crate::keybinding::{
    Key, KeyBinding, KeyChord, KeyCombo, KeybindingSource, Modifiers, ResolvedKeybinding,
    UnknownKey,
};

// ── Keybinding entry (for UI display) ───────────────────────────────────────

/// A single row in the keyboard shortcuts editor table.
#[derive(Clone, Debug)]
pub struct KeybindingEntry {
    pub command_id: String,
    pub command_title: String,
    pub keybinding: Option<String>,
    pub when: Option<String>,
    pub source: KeybindingSource,
    pub is_user_modified: bool,
}

/// Metadata about a registered command.
#[derive(Clone, Debug)]
pub struct CommandInfo {
    pub id: String,
    pub title: String,
    pub category: Option<String>,
}

/// Build the list of entries shown in the keyboard shortcuts editor.
///
/// Merges default bindings with user overrides and command metadata.
pub fn get_all_keybinding_entries<S: ::std::hash::BuildHasher>(
    defaults: &[ResolvedKeybinding],
    user: &[ResolvedKeybinding],
    commands: &HashMap<String, CommandInfo, S>,
) -> Vec<KeybindingEntry> {
    let mut entries: Vec<KeybindingEntry> = Vec::new();
    let mut user_commands: HashMap<String, &ResolvedKeybinding> = HashMap::new();

    for ub in user {
        user_commands.insert(ub.command.clone(), ub);
    }

    for resolved in defaults {
        if resolved.is_removal() {
            continue;
        }
        let is_overridden = user_commands.contains_key(&resolved.command);
        let effective = if is_overridden {
            user_commands[&resolved.command]
        } else {
            resolved
        };

        let title = commands.get(&resolved.command).map_or_else(
            || resolved.command.clone(),
            |c| {
                if let Some(cat) = &c.category {
                    format!("{cat}: {}", c.title)
                } else {
                    c.title.clone()
                }
            },
        );

        entries.push(KeybindingEntry {
            command_id: resolved.command.clone(),
            command_title: title,
            keybinding: Some(format_keybinding(&effective.keys)),
            when: effective.when.clone(),
            source: effective.source.clone(),
            is_user_modified: is_overridden,
        });
    }

    for ub in user {
        if ub.is_removal() {
            continue;
        }
        if defaults.iter().any(|d| d.command == ub.command) {
            continue;
        }
        let title = commands
            .get(&ub.command)
            .map_or_else(|| ub.command.clone(), |c| c.title.clone());

        entries.push(KeybindingEntry {
            command_id: ub.command.clone(),
            command_title: title,
            keybinding: Some(format_keybinding(&ub.keys)),
            when: ub.when.clone(),
            source: ub.source.clone(),
            is_user_modified: true,
        });
    }

    for (id, info) in commands {
        let already = entries.iter().any(|e| e.command_id == *id);
        if !already {
            let title = if let Some(cat) = &info.category {
                format!("{cat}: {}", info.title)
            } else {
                info.title.clone()
            };
            entries.push(KeybindingEntry {
                command_id: id.clone(),
                command_title: title,
                keybinding: None,
                when: None,
                source: KeybindingSource::Default,
                is_user_modified: false,
            });
        }
    }

    entries.sort_by_key(|a| a.command_title.clone());
    entries
}

// ── Keybinding recorder ─────────────────────────────────────────────────────

/// Records key presses from the user when defining a new keybinding.
#[derive(Clone, Debug, Default)]
pub struct KeybindingRecorder {
    pub recorded_keys: Vec<KeyCombo>,
    pub is_recording: bool,
}

impl KeybindingRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start_recording(&mut self) {
        self.recorded_keys.clear();
        self.is_recording = true;
    }

    pub fn record_key(&mut self, combo: KeyCombo) {
        if self.is_recording && self.recorded_keys.len() < 2 {
            self.recorded_keys.push(combo);
        }
    }

    pub fn stop_recording(&mut self) {
        self.is_recording = false;
    }

    pub fn clear(&mut self) {
        self.recorded_keys.clear();
        self.is_recording = false;
    }

    pub fn as_chord(&self) -> Option<KeyChord> {
        if self.recorded_keys.is_empty() {
            return None;
        }
        Some(KeyChord {
            parts: self.recorded_keys.clone(),
        })
    }

    pub fn display_string(&self) -> String {
        format_keybinding(&self.recorded_keys)
    }
}

// ── Format / parse keybinding strings ───────────────────────────────────────

/// Format a sequence of key combos into a human-readable string like
/// `"Ctrl+K Ctrl+C"`.
pub fn format_keybinding(combos: &[KeyCombo]) -> String {
    combos
        .iter()
        .map(format_combo)
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_combo(combo: &KeyCombo) -> String {
    let mut parts = Vec::new();
    if combo.modifiers.contains(Modifiers::CTRL) {
        parts.push("Ctrl");
    }
    if combo.modifiers.contains(Modifiers::SHIFT) {
        parts.push("Shift");
    }
    if combo.modifiers.contains(Modifiers::ALT) {
        parts.push("Alt");
    }
    if combo.modifiers.contains(Modifiers::META) {
        if cfg!(target_os = "macos") {
            parts.push("Cmd");
        } else {
            parts.push("Win");
        }
    }
    parts.push(key_display_name(combo.key));
    parts.join("+")
}

fn key_display_name(key: Key) -> &'static str {
    match key {
        Key::A => "A",
        Key::B => "B",
        Key::C => "C",
        Key::D => "D",
        Key::E => "E",
        Key::F => "F",
        Key::G => "G",
        Key::H => "H",
        Key::I => "I",
        Key::J => "J",
        Key::K => "K",
        Key::L => "L",
        Key::M => "M",
        Key::N => "N",
        Key::O => "O",
        Key::P => "P",
        Key::Q => "Q",
        Key::R => "R",
        Key::S => "S",
        Key::T => "T",
        Key::U => "U",
        Key::V => "V",
        Key::W => "W",
        Key::X => "X",
        Key::Y => "Y",
        Key::Z => "Z",
        Key::Digit0 => "0",
        Key::Digit1 => "1",
        Key::Digit2 => "2",
        Key::Digit3 => "3",
        Key::Digit4 => "4",
        Key::Digit5 => "5",
        Key::Digit6 => "6",
        Key::Digit7 => "7",
        Key::Digit8 => "8",
        Key::Digit9 => "9",
        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",
        Key::Enter => "Enter",
        Key::Escape => "Escape",
        Key::Tab => "Tab",
        Key::Space => "Space",
        Key::Backspace => "Backspace",
        Key::Delete => "Delete",
        Key::ArrowUp => "Up",
        Key::ArrowDown => "Down",
        Key::ArrowLeft => "Left",
        Key::ArrowRight => "Right",
        Key::Home => "Home",
        Key::End => "End",
        Key::PageUp => "PageUp",
        Key::PageDown => "PageDown",
        Key::Insert => "Insert",
        Key::Pause => "Pause",
        Key::CapsLock => "CapsLock",
        Key::NumLock => "NumLock",
        Key::ScrollLock => "ScrollLock",
        Key::Minus => "-",
        Key::Equal => "=",
        Key::BracketLeft => "[",
        Key::BracketRight => "]",
        Key::Backslash => "\\",
        Key::Semicolon => ";",
        Key::Quote => "'",
        Key::Backquote => "`",
        Key::Comma => ",",
        Key::Period => ".",
        Key::Slash => "/",
        Key::ContextMenu => "ContextMenu",
        Key::PrintScreen => "PrintScreen",
    }
}

/// Parse a keybinding string like `"Ctrl+K Ctrl+C"` into key combos.
pub fn parse_keybinding_string(s: &str) -> Result<Vec<KeyCombo>, UnknownKey> {
    let chord = KeyChord::parse(s)?;
    Ok(chord.parts)
}

/// Convert a `KeyBinding` to a JSON-compatible structure for writing to
/// `keybindings.json`.
pub fn keybinding_to_json(binding: &KeyBinding) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "key".into(),
        serde_json::Value::String(binding.key.to_string()),
    );
    obj.insert(
        "command".into(),
        serde_json::Value::String(binding.command.clone()),
    );
    if let Some(when) = &binding.when {
        obj.insert("when".into(), serde_json::Value::String(when.clone()));
    }
    if let Some(args) = &binding.args {
        obj.insert("args".into(), args.clone());
    }
    serde_json::Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_single_combo() {
        let combos = vec![KeyCombo::new(Key::S, Modifiers::CTRL)];
        assert_eq!(format_keybinding(&combos), "Ctrl+S");
    }

    #[test]
    fn format_chord() {
        let combos = vec![
            KeyCombo::new(Key::K, Modifiers::CTRL),
            KeyCombo::new(Key::C, Modifiers::CTRL),
        ];
        assert_eq!(format_keybinding(&combos), "Ctrl+K Ctrl+C");
    }

    #[test]
    fn format_multi_modifier() {
        let combos = vec![KeyCombo::new(Key::P, Modifiers::CTRL | Modifiers::SHIFT)];
        assert_eq!(format_keybinding(&combos), "Ctrl+Shift+P");
    }

    #[test]
    fn parse_roundtrip() {
        let combos = parse_keybinding_string("Ctrl+K Ctrl+C").unwrap();
        assert_eq!(combos.len(), 2);
        assert_eq!(combos[0].key, Key::K);
        assert_eq!(combos[1].key, Key::C);
    }

    #[test]
    fn recorder_basic() {
        let mut recorder = KeybindingRecorder::new();
        recorder.start_recording();
        assert!(recorder.is_recording);
        recorder.record_key(KeyCombo::new(Key::K, Modifiers::CTRL));
        recorder.record_key(KeyCombo::new(Key::C, Modifiers::CTRL));
        recorder.stop_recording();
        assert!(!recorder.is_recording);
        assert_eq!(recorder.recorded_keys.len(), 2);
        let chord = recorder.as_chord().unwrap();
        assert!(chord.is_chord());
    }

    #[test]
    fn recorder_max_two_keys() {
        let mut recorder = KeybindingRecorder::new();
        recorder.start_recording();
        recorder.record_key(KeyCombo::new(Key::K, Modifiers::CTRL));
        recorder.record_key(KeyCombo::new(Key::C, Modifiers::CTRL));
        recorder.record_key(KeyCombo::new(Key::V, Modifiers::CTRL));
        assert_eq!(recorder.recorded_keys.len(), 2);
    }

    #[test]
    fn get_all_entries_merges() {
        let defaults = vec![ResolvedKeybinding {
            keys: vec![KeyCombo::new(Key::S, Modifiers::CTRL)],
            command: "workbench.action.files.save".into(),
            args: None,
            when: None,
            source: KeybindingSource::Default,
            is_default: true,
        }];
        let user = vec![];
        let mut commands = HashMap::new();
        commands.insert(
            "workbench.action.files.save".into(),
            CommandInfo {
                id: "workbench.action.files.save".into(),
                title: "Save".into(),
                category: Some("File".into()),
            },
        );
        let entries = get_all_keybinding_entries(&defaults, &user, &commands);
        assert!(!entries.is_empty());
        let save = entries
            .iter()
            .find(|e| e.command_id == "workbench.action.files.save")
            .unwrap();
        assert_eq!(save.command_title, "File: Save");
        assert!(!save.is_user_modified);
    }

    #[test]
    fn keybinding_to_json_output() {
        let binding = KeyBinding::new(
            KeyChord::single(KeyCombo::new(Key::S, Modifiers::CTRL)),
            "workbench.action.files.save",
        )
        .with_when("editorTextFocus");
        let json = keybinding_to_json(&binding);
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("key"));
        assert!(obj.contains_key("command"));
        assert!(obj.contains_key("when"));
    }
}
