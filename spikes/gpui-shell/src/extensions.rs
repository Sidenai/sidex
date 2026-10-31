//! Native extensions: WASM components run by `sidex-extension-wasm-host`,
//! the same host the Tauri app uses. The runtime lives on its own thread,
//! since extension calls block; what extensions show (status-bar items,
//! notifications, palette commands) comes back as state here.
//!
//! Spike-only discovery: every `extensions/*/sidex.toml` next to this crate.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use futures::channel::mpsc::{unbounded, UnboundedSender};
use futures::StreamExt;
use gpui_kit::*;
use ropey::Rope;
use sidex_extension_wasm_host::wit_types::StatusBarItem;
use sidex_extension_wasm_host::{HostEvent, NotificationLevel, WasmExtensionRuntime};

pub struct ExtensionCommand {
    pub extension: String,
    pub id: String,
    pub title: String,
}

pub struct StatusItem {
    pub extension: String,
    pub item: StatusBarItem,
}

pub struct Toast {
    pub id: u64,
    pub level: NotificationLevel,
    pub message: String,
    pub source: String,
}

/// A document as extensions see it.
pub struct Document {
    pub path: PathBuf,
    pub language: String,
    pub text: Rope,
}

impl Document {
    fn uri(&self) -> String {
        format!("file://{}", self.path.display())
    }
}

type Job = Box<dyn FnOnce(&WasmExtensionRuntime) + Send>;

enum Msg {
    Loaded(Vec<ExtensionCommand>),
    Host(String, HostEvent),
    Error(String),
}

pub struct Extensions {
    jobs: mpsc::Sender<Job>,
    msgs: UnboundedSender<Msg>,
    pub commands: Vec<ExtensionCommand>,
    pub status_items: Vec<StatusItem>,
    pub toasts: Vec<Toast>,
    next_toast: u64,
    version: u32,
    pending_change: Option<Task<()>>,
    _events: Task<()>,
}

/// How long a notification stays up, as in VSCode for ones without actions.
const TOAST_TIMEOUT: Duration = Duration::from_secs(10);
/// Typing settles for this long before extensions hear about the change.
const CHANGE_DEBOUNCE: Duration = Duration::from_millis(150);

pub fn extensions_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("extensions")
}

/// `(id, wasm path)` for each extension under `dir`.
pub fn discover(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<_> = entries
        .flatten()
        .filter_map(|e| {
            let ext_dir = e.path();
            let text = std::fs::read_to_string(ext_dir.join("sidex.toml")).ok()?;
            let manifest: toml::Value = toml::from_str(&text).ok()?;
            let ext = manifest.get("extension")?;
            let id = ext.get("id")?.as_str()?.to_owned();
            let wasm = ext.get("wasm")?.as_str()?;
            Some((id, ext_dir.join(wasm)))
        })
        .collect();
    found.sort();
    found
}

impl Extensions {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let (msg_tx, mut msg_rx) = unbounded::<Msg>();
        let (job_tx, job_rx) = mpsc::channel::<Job>();

        let tx = msg_tx.clone();
        std::thread::Builder::new()
            .name("extension host".into())
            .spawn(move || {
                let runtime = match WasmExtensionRuntime::new() {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = tx.unbounded_send(Msg::Error(format!("extension host: {e}")));
                        return;
                    }
                };
                let sink_tx = tx.clone();
                runtime.set_event_sink(Arc::new(move |id: &str, event| {
                    let _ = sink_tx.unbounded_send(Msg::Host(id.to_owned(), event));
                }));
                for (id, wasm) in discover(&extensions_dir()) {
                    let result = if wasm.exists() {
                        runtime.load_extension(&id, &wasm)
                    } else {
                        Err(format!(
                            "{id} isn't built. Run `cargo build --release --target \
                             wasm32-wasip2` in {}",
                            wasm.ancestors().nth(4).unwrap_or(&wasm).display()
                        ))
                    };
                    if let Err(e) = result {
                        log::warn!("[extensions] {e}");
                        let _ = tx.unbounded_send(Msg::Error(e));
                    }
                }
                let commands = runtime
                    .contributed_commands()
                    .into_iter()
                    .map(|(extension, c)| ExtensionCommand {
                        extension,
                        id: c.id,
                        title: c.title,
                    })
                    .collect();
                log::info!("[extensions] loaded {:?}", runtime.loaded_extension_ids());
                let _ = tx.unbounded_send(Msg::Loaded(commands));
                // Jobs queued before loading finished run now, in order.
                for job in job_rx {
                    job(&runtime);
                }
            })
            .expect("spawn extension host thread");

        let events = cx.spawn(async move |this, cx| {
            while let Some(msg) = msg_rx.next().await {
                let mut batch = vec![msg];
                while let Ok(m) = msg_rx.try_recv() {
                    batch.push(m);
                }
                let alive = this.update(cx, |this, cx| {
                    for m in batch {
                        this.handle(m, cx);
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        });

        Self {
            jobs: job_tx,
            msgs: msg_tx,
            commands: Vec::new(),
            status_items: Vec::new(),
            toasts: Vec::new(),
            next_toast: 1,
            version: 0,
            pending_change: None,
            _events: events,
        }
    }

    fn handle(&mut self, msg: Msg, cx: &mut Context<Self>) {
        match msg {
            Msg::Loaded(commands) => self.commands = commands,
            Msg::Error(e) => self.toast(NotificationLevel::Error, e, "Extensions".into(), cx),
            Msg::Host(extension, event) => match event {
                HostEvent::Notification { level, message } => {
                    self.toast(level, message, extension, cx);
                }
                HostEvent::StatusBarItemSet(item) => {
                    match self
                        .status_items
                        .iter_mut()
                        .find(|s| s.extension == extension && s.item.id == item.id)
                    {
                        Some(s) => s.item = item,
                        None => self.status_items.push(StatusItem { extension, item }),
                    }
                    self.status_items.sort_by_key(|s| -s.item.priority);
                }
                HostEvent::StatusBarItemRemoved(id) => self
                    .status_items
                    .retain(|s| !(s.extension == extension && s.item.id == id)),
                HostEvent::CommandRegistered(_) | HostEvent::OutputLine { .. } => {}
            },
        }
    }

    fn toast(
        &mut self,
        level: NotificationLevel,
        message: String,
        source: String,
        cx: &mut Context<Self>,
    ) {
        let id = self.next_toast;
        self.next_toast += 1;
        self.toasts.push(Toast {
            id,
            level,
            message,
            source,
        });
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOAST_TIMEOUT).await;
            let _ = this.update(cx, |this, cx| this.dismiss(id, cx));
        })
        .detach();
    }

    pub fn dismiss(&mut self, id: u64, cx: &mut Context<Self>) {
        self.toasts.retain(|t| t.id != id);
        cx.notify();
    }

    fn run(&self, job: impl FnOnce(&WasmExtensionRuntime) + Send + 'static) {
        let _ = self.jobs.send(Box::new(job));
    }

    /// The active editor now shows `doc` (or nothing).
    pub fn set_active(&mut self, doc: Option<Document>) {
        self.pending_change = None;
        self.run(move |rt| match doc {
            Some(doc) => {
                let uri = doc.uri();
                rt.sync_document(&uri, &doc.language, &doc.text.to_string());
                rt.set_active_editor(Some(&uri));
            }
            None => rt.set_active_editor(None),
        });
    }

    /// `doc`'s text changed; extensions hear about it once typing settles.
    pub fn changed(&mut self, doc: Document, cx: &mut Context<Self>) {
        self.version += 1;
        let version = self.version;
        self.pending_change = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CHANGE_DEBOUNCE).await;
            let _ = this.update(cx, |this, _| {
                this.run(move |rt| {
                    let uri = doc.uri();
                    rt.sync_document(&uri, &doc.language, &doc.text.to_string());
                    rt.document_changed(&uri, &doc.language, version);
                });
            });
        }));
    }

    pub fn execute(&self, extension: String, command: String) {
        let msgs = self.msgs.clone();
        self.run(move |rt| {
            if let Err(e) = rt.execute_command(&extension, &command, "") {
                let _ = msgs.unbounded_send(Msg::Error(e));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Loads the real word-count component through the shared host and
    /// checks what it puts in the status bar and shows as a notification.
    #[::core::prelude::v1::test]
    fn word_count_extension_round_trip() {
        let (id, wasm) = discover(&extensions_dir())
            .into_iter()
            .find(|(id, _)| id == "sidex.word-count")
            .expect("word-count manifest");
        assert!(
            wasm.exists(),
            "build it first: cargo build --release --target wasm32-wasip2 \
             in extensions/word-count"
        );

        let events: Arc<Mutex<Vec<HostEvent>>> = Arc::default();
        let rt = WasmExtensionRuntime::new().unwrap();
        let sink = Arc::clone(&events);
        rt.set_event_sink(Arc::new(move |_, e| sink.lock().unwrap().push(e)));
        rt.load_extension(&id, &wasm).unwrap();

        let commands = rt.contributed_commands();
        assert_eq!(commands[0].1.id, "wordCount.show");

        rt.sync_document("file:///tmp/a.txt", "plaintext", "one two\nthree\n");
        rt.set_active_editor(Some("file:///tmp/a.txt"));
        rt.execute_command(&id, "wordCount.show", "").unwrap();

        let events = events.lock().unwrap();
        let status = events.iter().rev().find_map(|e| match e {
            HostEvent::StatusBarItemSet(item) => Some(item.text.clone()),
            _ => None,
        });
        assert_eq!(status.as_deref(), Some("3 words"));
        let note = events.iter().find_map(|e| match e {
            HostEvent::Notification { message, .. } => Some(message.clone()),
            _ => None,
        });
        assert_eq!(
            note.as_deref(),
            Some("a.txt: 3 words, 2 lines, 14 characters")
        );
    }
}
