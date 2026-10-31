//! Quick Open (⌘P) and the command palette (⇧⌘P, or `>` in Quick Open).
//!
//! UI is gpui-kit's `Command` palette with its local filtering off; file
//! search is `sidex_workspace::FileIndex` (gitignore-aware walk + fuzzy
//! scoring with a recently-opened boost).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gpui_kit::component::command::{Command, CommandItem, CommandState};
use gpui_kit::*;
use sidex_workspace::fuzzy_file_finder::FileIndex;
use sidex_workspace::FileEvent;

use crate::icons::Codicon;
use crate::theme;
use crate::vscode::{self, z};

pub enum QuickOpenEvent {
    Open(PathBuf),
    Dismiss,
}

/// A palette command: label, keybinding hint, and the action it dispatches.
pub struct PaletteCommand {
    pub label: &'static str,
    pub keys: &'static str,
    pub action: fn() -> Box<dyn Action>,
}

pub struct QuickOpen {
    root: PathBuf,
    state: Entity<CommandState>,
    index: Arc<Mutex<Option<FileIndex>>>,
    query: String,
    files: Vec<PathBuf>,
    commands: &'static [PaletteCommand],
    _index_task: Task<()>,
}

const MAX_RESULTS: usize = 50;

impl QuickOpen {
    pub fn new(
        root: PathBuf,
        commands: &'static [PaletteCommand],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let index: Arc<Mutex<Option<FileIndex>>> = Arc::default();
        let build_root = root.clone();
        let slot = Arc::clone(&index);
        let index_task = cx.background_executor().spawn(async move {
            let built = FileIndex::build(&build_root);
            log::info!("quick open: indexed {} files", built.file_count());
            if let Ok(mut s) = slot.lock() {
                *s = Some(built);
            }
        });
        Self {
            root,
            state: cx.new(|cx| CommandState::new(window, cx)),
            index,
            query: String::new(),
            files: Vec::new(),
            commands,
            _index_task: index_task,
        }
    }

    /// Reset and focus. `prefix` is `">"` for the command palette.
    pub fn show(&mut self, prefix: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.state = cx.new(|cx| CommandState::new(window, cx));
        self.state.update(cx, |s, cx| {
            s.set_query(prefix.to_owned(), window, cx);
        });
        self.set_query(prefix.to_owned(), cx);
        // The palette pushes its options (including "searchable") into the
        // state when it first renders, so focus after the next frame.
        let state = self.state.clone();
        window.on_next_frame(move |window, cx| {
            state.update(cx, |s, cx| s.focus(window, cx));
        });
    }

    pub fn mark_recent(&self, path: &Path) {
        if let Ok(mut idx) = self.index.lock() {
            if let Some(idx) = idx.as_mut() {
                idx.mark_recent(path);
            }
        }
    }

    pub fn apply_fs_events(&self, events: &[FileEvent]) {
        if let Ok(mut idx) = self.index.lock() {
            if let Some(idx) = idx.as_mut() {
                idx.update(events);
            }
        }
    }

    fn set_query(&mut self, query: String, cx: &mut Context<Self>) {
        self.files = if query.starts_with('>') {
            Vec::new()
        } else {
            self.index
                .lock()
                .ok()
                .and_then(|idx| idx.as_ref().map(|i| i.query(query.trim(), MAX_RESULTS)))
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.path)
                .collect()
        };
        self.query = query;
        cx.notify();
    }

    fn command_mode(&self) -> bool {
        self.query.starts_with('>')
    }

    fn matching_commands(&self) -> Vec<&'static PaletteCommand> {
        let q = self.query.trim_start_matches('>').trim().to_lowercase();
        self.commands
            .iter()
            .filter(|c| q.is_empty() || c.label.to_lowercase().contains(&q))
            .collect()
    }

    fn file_item(&self, path: &Path) -> CommandItem {
        let setup = vscode::get();
        let c = theme::colors();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let dir = path
            .parent()
            .and_then(|p| p.strip_prefix(&self.root).ok())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let icon = setup
            .icons
            .as_ref()
            .and_then(|i| i.file(&name, setup.language_for(&name)));
        let label = name.clone();
        CommandItem::new().label(label).child(move |_, _| {
            div()
                .flex()
                .items_center()
                .gap(z(6.))
                .min_w_0()
                .child(match icon.clone() {
                    Some(p) => img(p).size(z(16.)).flex_none().into_any_element(),
                    None => Codicon::FILE.render(16., c.icon).into_any_element(),
                })
                .child(div().flex_none().child(name.clone()))
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(z(12.))
                        .text_color(c.description)
                        .child(dir.clone()),
                )
        })
    }

    fn command_item(cmd: &'static PaletteCommand) -> CommandItem {
        let c = theme::colors();
        CommandItem::new()
            .label(cmd.label)
            .action((cmd.action)())
            .child(move |_, _| {
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .child(div().flex_1().child(cmd.label))
                    .child(
                        div()
                            .text_size(z(12.))
                            .text_color(c.description)
                            .child(cmd.keys),
                    )
            })
    }
}

impl EventEmitter<QuickOpenEvent> for QuickOpen {}

impl Render for QuickOpen {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let this = cx.weak_entity();
        let command_mode = self.command_mode();
        let items: Vec<CommandItem> = if command_mode {
            self.matching_commands()
                .into_iter()
                .map(Self::command_item)
                .collect()
        } else {
            self.files.iter().map(|p| self.file_item(p)).collect()
        };
        let files = self.files.clone();
        let indexing = self.index.lock().map(|i| i.is_none()).unwrap_or(false);

        let on_query = {
            let this = this.clone();
            move |q: &str, _: &mut Window, cx: &mut App| {
                let q = q.to_owned();
                let _ = this.update(cx, |this, cx| this.set_query(q, cx));
            }
        };
        let on_confirm = {
            let this = this.clone();
            move |ix: gpui_kit::component::IndexPath, _: &mut Window, cx: &mut App| {
                let _ = this.update(cx, |_, cx| {
                    let event = if command_mode {
                        QuickOpenEvent::Dismiss
                    } else {
                        match files.get(ix.row) {
                            Some(p) => QuickOpenEvent::Open(p.clone()),
                            None => QuickOpenEvent::Dismiss,
                        }
                    };
                    cx.emit(event);
                });
            }
        };
        let on_cancel = move |_: &mut Window, cx: &mut App| {
            let _ = this.update(cx, |_, cx| cx.emit(QuickOpenEvent::Dismiss));
        };

        let empty_text = if indexing {
            "Indexing files…"
        } else if command_mode {
            "No matching commands"
        } else if self.query.is_empty() {
            "Type to search files, or > for commands"
        } else {
            "No matching results"
        };

        div()
            .w(z(600.))
            .rounded(z(8.))
            .border_1()
            .border_color(c.widget_border)
            .bg(c.quick_input)
            .text_color(c.quick_input_fg)
            .shadow_lg()
            .overflow_hidden()
            .child(
                Command::new(&self.state)
                    .filterable(false)
                    .bordered(false)
                    .placeholder("Search files by name (append : to go to line or > for commands)")
                    .items(items)
                    .max_h(z(420.))
                    .empty(move |_, _, _| {
                        div().p(z(8.)).text_color(c.description).child(empty_text)
                    })
                    .on_query(on_query)
                    .on_confirm(on_confirm)
                    .on_cancel(on_cancel),
            )
    }
}
