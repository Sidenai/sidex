//! Explorer view backed by `sidex_workspace::file_ops::read_dir`, drawn like
//! VSCode's: title row, root header, rows with twisties, file-icon-theme
//! icons, indent guides, and gitignored entries dimmed.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use sidex_workspace::{file_ops, FileEvent, FileWatcher};

use crate::icons::Codicon;
use crate::theme;
use crate::vscode::{self, z};

/// VSCode's default `files.exclude`.
const EXCLUDE: &[&str] = &[".git", ".DS_Store", ".svn", ".hg", "CVS", "Thumbs.db"];
const ROW_H: f32 = 22.;
/// `workbench.tree.indent` default.
const INDENT: f32 = 8.;
const TWISTIE: f32 = 16.;
const ROW_PAD: f32 = 8.;

pub enum FilesEvent {
    OpenFile(PathBuf),
    /// Debounced file-system changes, forwarded to the Quick Open index.
    FsChanged(Vec<FileEvent>),
}

#[derive(Clone)]
struct Row {
    path: PathBuf,
    name: String,
    is_dir: bool,
    depth: usize,
    ignored: bool,
}

pub struct FilesPanel {
    focus_handle: FocusHandle,
    root: PathBuf,
    expanded: BTreeSet<PathBuf>,
    selected: Option<PathBuf>,
    rows: Vec<Row>,
    ignored: HashSet<PathBuf>,
    scroll: ScrollHandle,
    _watcher: Option<FileWatcher>,
    _watch_task: Task<()>,
}

/// Paths git ignores, as VSCode greys them out. One `git` call at startup.
fn git_ignored(root: &Path) -> HashSet<PathBuf> {
    let out = std::process::Command::new("git")
        .args([
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ])
        .current_dir(root)
        .output();
    let Ok(out) = out else {
        return HashSet::new();
    };
    out.stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| root.join(String::from_utf8_lossy(s).trim_end_matches('/')))
        .collect()
}

impl FilesPanel {
    pub fn new(root: PathBuf, cx: &mut Context<Self>) -> Self {
        // sidex-workspace's watcher (notify + debounce) calls back on its
        // own thread; hand batches to the UI thread through a channel.
        let (tx, rx) = mpsc::channel::<Vec<FileEvent>>();
        let watcher = FileWatcher::on_change(&root, move |events| {
            let _ = tx.send(events);
        })
        .map_err(|e| log::warn!("file watcher: {e}"))
        .ok();
        let watch_task = cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(100))
                .await;
            let mut batch = Vec::new();
            while let Ok(events) = rx.try_recv() {
                batch.extend(events);
            }
            if batch.is_empty() {
                continue;
            }
            log::info!("explorer: {} file-system events", batch.len());
            let alive = this.update(cx, |this, cx| {
                this.ignored = git_ignored(&this.root);
                this.rebuild();
                cx.emit(FilesEvent::FsChanged(batch));
                cx.notify();
            });
            if alive.is_err() {
                break;
            }
        });

        let mut this = Self {
            focus_handle: cx.focus_handle(),
            ignored: git_ignored(&root),
            root,
            expanded: BTreeSet::new(),
            selected: None,
            rows: Vec::new(),
            scroll: ScrollHandle::new(),
            _watcher: watcher,
            _watch_task: watch_task,
        };
        this.rebuild();
        this
    }

    fn rebuild(&mut self) {
        self.rows.clear();
        let root = self.root.clone();
        self.push_dir(&root, 0, false);
    }

    fn push_dir(&mut self, dir: &Path, depth: usize, parent_ignored: bool) {
        let Ok(mut entries) = file_ops::read_dir(dir) else {
            return;
        };
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        for e in entries {
            if EXCLUDE.contains(&e.name.as_str()) {
                continue;
            }
            let path = PathBuf::from(&e.path);
            let ignored = parent_ignored || self.ignored.contains(&path);
            self.rows.push(Row {
                path: path.clone(),
                name: e.name,
                is_dir: e.is_dir,
                depth,
                ignored,
            });
            if e.is_dir && self.expanded.contains(&path) {
                self.push_dir(&path, depth + 1, ignored);
            }
        }
    }

    fn on_row_click(&mut self, row: Row, cx: &mut Context<Self>) {
        self.selected = Some(row.path.clone());
        if row.is_dir {
            if !self.expanded.remove(&row.path) {
                self.expanded.insert(row.path.clone());
            }
            self.rebuild();
        } else {
            cx.emit(FilesEvent::OpenFile(row.path));
        }
        cx.notify();
    }

    fn render_row(&self, row: &Row, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let setup = vscode::get();
        let selected = self.selected.as_deref() == Some(row.path.as_path());
        let expanded = self.expanded.contains(&row.path);
        let fg = if selected {
            c.list_active_selection_fg
        } else if row.ignored {
            c.ignored_fg
        } else {
            c.side_bar_fg
        };
        let hides_arrows = setup
            .icons
            .as_ref()
            .is_some_and(|i| i.hides_explorer_arrows);

        let twistie: AnyElement = if row.is_dir && !hides_arrows {
            if expanded {
                Codicon::CHEVRON_DOWN
            } else {
                Codicon::CHEVRON_RIGHT
            }
            .render(TWISTIE, c.icon)
            .into_any_element()
        } else {
            div().w(z(TWISTIE)).flex_none().into_any_element()
        };

        let icon_path = setup.icons.as_ref().and_then(|icons| {
            if row.is_dir {
                icons.folder(&row.name, expanded)
            } else {
                icons.file(&row.name, setup.language_for(&row.name))
            }
        });
        let icon: AnyElement = match icon_path {
            Some(p) => img(p)
                .size(z(16.))
                .flex_none()
                .when(row.ignored, |i| i.opacity(0.5))
                .into_any_element(),
            None => if row.is_dir {
                Codicon::FOLDER
            } else {
                Codicon::FILE
            }
            .render(16., c.icon)
            .into_any_element(),
        };

        // Indent guides: one hairline per ancestor level, centred under the
        // parent's twistie.
        let guides = (0..row.depth).map(|level| {
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(z(ROW_PAD + level as f32 * INDENT + TWISTIE / 2.))
                .w(px(1.))
                .bg(c.indent_guide)
        });

        let click_row = row.clone();
        div()
            .id(SharedString::from(row.path.to_string_lossy().to_string()))
            .relative()
            .h(z(ROW_H))
            .w_full()
            .flex()
            .items_center()
            .gap(z(6.))
            .pl(z(ROW_PAD + INDENT * row.depth as f32))
            .pr(z(8.))
            .text_color(fg)
            .when(selected, |d| d.bg(c.list_active_selection))
            .when(!selected, |d| d.hover(|s| s.bg(c.list_hover)))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.on_row_click(click_row.clone(), cx);
            }))
            .children(guides)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(z(4.))
                    .child(twistie)
                    .child(icon),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(row.name.clone()),
            )
    }

    fn collapsed_section(title: &'static str) -> impl IntoElement {
        let c = theme::colors();
        div()
            .h(z(22.))
            .flex_none()
            .flex()
            .items_center()
            .gap(z(2.))
            .pl(z(4.))
            .border_t_1()
            .border_color(c.section_header_border)
            .bg(c.section_header)
            .text_size(z(11.))
            .font_weight(FontWeight::BOLD)
            .text_color(c.section_header_fg)
            .child(Codicon::CHEVRON_RIGHT.render(16., c.icon))
            .child(title)
    }
}

impl EventEmitter<FilesEvent> for FilesPanel {}

impl Focusable for FilesPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for FilesPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = theme::colors();
        let root_name = self
            .root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let rows: Vec<AnyElement> = self
            .rows
            .clone()
            .iter()
            .map(|r| self.render_row(r, cx).into_any_element())
            .collect();

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(c.side_bar)
            .text_color(c.side_bar_fg)
            .text_size(z(13.))
            // Title row.
            .child(
                div()
                    .h(z(35.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .pl(z(12.))
                    .pr(z(8.))
                    .text_size(z(11.))
                    .text_color(c.side_bar_title_fg)
                    .child(div().flex_1().child("EXPLORER"))
                    .child(Codicon::ELLIPSIS.render(16., c.icon)),
            )
            // Root folder header.
            .child(
                div()
                    .h(z(22.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(z(2.))
                    .pl(z(4.))
                    .pr(z(8.))
                    .bg(c.section_header)
                    .text_size(z(11.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(c.section_header_fg)
                    .child(Codicon::CHEVRON_DOWN.render(16., c.icon))
                    .child(div().flex_1().child(root_name.to_uppercase())),
            )
            .child(
                div()
                    .id("explorer-rows")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .children(rows),
            )
            .child(Self::collapsed_section("OUTLINE"))
            .child(Self::collapsed_section("TIMELINE"))
    }
}
