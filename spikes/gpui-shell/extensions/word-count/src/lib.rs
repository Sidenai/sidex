//! Word count of the active editor, in the status bar. Clicking it (or
//! running "Word Count: Show Details") shows a notification with the counts.

use sidex_extension_sdk::prelude::*;

include!("unsupported.rs");

const ITEM: &str = "wordCount.status";
const SHOW: &str = "wordCount.show";

struct WordCount;

struct Counts {
    words: usize,
    lines: usize,
    chars: usize,
}

fn count(text: &str) -> Counts {
    Counts {
        words: text.split_whitespace().count(),
        lines: text.lines().count(),
        chars: text.chars().count(),
    }
}

fn active_counts() -> Option<(String, Counts)> {
    let uri = host::get_active_text_editor_uri()?;
    let text = host::get_document_text(&uri)?;
    let name = uri.rsplit('/').next().unwrap_or(&uri).to_owned();
    Some((name, count(&text)))
}

fn refresh() {
    match active_counts() {
        Some((_, c)) => host::set_status_bar_item(&StatusBarItem {
            id: ITEM.into(),
            text: format!("{} words", c.words),
            tooltip: Some("Word Count (WASM extension)".into()),
            command: Some(SHOW.into()),
            alignment: 2,
            priority: 100,
        }),
        None => host::remove_status_bar_item(ITEM),
    }
}

impl SidexExtension for WordCount {
    fn activate() -> Result<(), String> {
        host::register_command(SHOW);
        host::log_info("word count activated");
        refresh();
        Ok(())
    }

    fn deactivate() {
        host::remove_status_bar_item(ITEM);
    }

    fn get_name() -> String {
        "word-count".into()
    }
    fn get_display_name() -> String {
        "Word Count".into()
    }
    fn get_version() -> String {
        env!("CARGO_PKG_VERSION").into()
    }
    fn get_publisher() -> String {
        "sidex".into()
    }
    fn get_activation_events() -> Vec<String> {
        vec!["*".into()]
    }
    fn get_commands() -> Vec<CommandDefinition> {
        vec![CommandDefinition {
            id: SHOW.into(),
            title: "Word Count: Show Details".into(),
        }]
    }

    fn execute_command(command_id: String, _args: String) -> Result<String, String> {
        if command_id != SHOW {
            return Err(format!("unknown command: {command_id}"));
        }
        match active_counts() {
            Some((name, c)) => host::show_info_message(&format!(
                "{name}: {} words, {} lines, {} characters",
                c.words, c.lines, c.chars
            )),
            None => host::show_warn_message("Word Count: no file is open"),
        }
        Ok(String::new())
    }

    fn on_active_editor_changed(_uri: Option<String>) {
        refresh();
    }

    fn on_document_changed(_ctx: DocumentContext, _changes: Vec<TextEdit>) {
        refresh();
    }

    unsupported!();
}

sidex_extension_sdk::export_extension!(WordCount);
