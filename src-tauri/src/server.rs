//! Local agent server supervisor.
//!
//! SideX's agent loop, tools, MCP and memory all live in `sidex-server`. With
//! no account there is no hosted instance to talk to, so the app runs its own
//! copy: a child process bound to loopback, started on launch and stopped when
//! the app exits.
//!
//! The server is given provider credentials through its environment (see
//! `providers::server_env`), so keys never reach the webview and never land in
//! a config file.
//!
//! Spawning happens off the calling thread and is retried a bounded number of
//! times (`MAX_SPAWN_ATTEMPTS`) if the health check never passes — the port
//! reserved by `free_port` can be taken before the child binds it. Once the
//! server is up, a lightweight watchdog notices if it dies later and tries to
//! bring it back, also bounded (`MAX_CRASH_RESTARTS`), so a server that is
//! crash-looping on its own doesn't spin the watchdog forever.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::providers;
use crate::commands::secrets::SecretsStore;

/// How long to wait for the server to answer `/v1/health` before giving up.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

/// Bounded retries for the initial spawn. A failure here is usually the
/// reserved port having been taken by something else between `free_port`
/// releasing it and the child binding it, not a broken binary, so it's worth
/// trying again with a fresh port before surfacing an error.
const MAX_SPAWN_ATTEMPTS: u32 = 3;

/// Bounded automatic restarts if the server dies later, during normal
/// operation. Past this the watchdog stands down and leaves the failure for
/// the user to retry (e.g. by resaving a provider key, which calls
/// `server_restart`), rather than spinning forever on a server that keeps
/// crashing on its own.
const MAX_CRASH_RESTARTS: u32 = 3;

/// How often the crash watchdog polls the child once it's up.
const WATCHDOG_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Name of the server executable, as bundled and as built in development.
#[cfg(windows)]
const SERVER_BIN: &str = "sidex-server.exe";
#[cfg(not(windows))]
const SERVER_BIN: &str = "sidex-server";

/// The running child, or `None` when the server could not be started.
struct ServerProc {
    child: Option<Child>,
    port: u16,
    /// Why the server isn't up, for the UI to show verbatim: a missing
    /// binary, a spawn failure, a health check that never passed, or an
    /// exit the watchdog couldn't recover from. Cleared as soon as a spawn
    /// attempt succeeds.
    error: Option<String>,
    /// Bumped by every `start()` and `shutdown()`. Lets a retry or
    /// crash-watchdog thread left over from an earlier attempt recognize it
    /// has been superseded — a manual restart, or app shutdown — and stand
    /// down instead of racing the new attempt for the child slot.
    generation: u64,
}

pub struct LocalServer {
    inner: Mutex<ServerProc>,
}

impl LocalServer {
    fn new() -> Self {
        Self {
            inner: Mutex::new(ServerProc {
                child: None,
                port: 0,
                error: None,
                generation: 0,
            }),
        }
    }

    fn with_proc<T>(&self, f: impl FnOnce(&mut ServerProc) -> T) -> T {
        // A poisoned lock only means a previous holder panicked; the process
        // handle is still valid, so recover rather than propagate.
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    pub fn port(&self) -> u16 {
        self.with_proc(|p| p.port)
    }

    /// True while we hold a child and the OS confirms it's still alive,
    /// checked via `try_wait` rather than "we once spawned something" — a
    /// server that crashed between polls is caught the moment anyone asks,
    /// here or in `server_endpoint`.
    pub fn is_running(&self) -> bool {
        self.with_proc(Self::child_alive)
    }

    /// WebSocket origin the workbench should connect to.
    pub fn ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port())
    }

    pub fn http_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port())
    }

    fn endpoint(&self) -> ServerEndpoint {
        self.with_proc(|p| {
            let running = Self::child_alive(p);
            ServerEndpoint {
                ws_url: format!("ws://127.0.0.1:{}", p.port),
                http_url: format!("http://127.0.0.1:{}", p.port),
                port: p.port,
                running,
                error: p.error.clone(),
            }
        })
    }

    /// Checks (and if the process has exited, reaps and records) the child's
    /// real liveness. Centralized here so `is_running`, `server_endpoint` and
    /// the crash watchdog all agree on what "running" means instead of each
    /// re-deriving it from `try_wait`.
    fn child_alive(p: &mut ServerProc) -> bool {
        let Some(child) = p.child.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                log::warn!("[sidex-server] exited unexpectedly ({status})");
                p.error = Some(format!("server exited unexpectedly ({status})"));
                p.child = None;
                false
            }
            Err(e) => {
                // Can't reason about this handle any more; treat it as gone
                // rather than claim a liveness we can't verify.
                log::warn!("[sidex-server] could not check child status: {e}");
                p.child = None;
                false
            }
        }
    }

    /// Claim a new generation for a fresh attempt. A retry or watchdog
    /// thread from a previous attempt compares against this and steps aside
    /// once it no longer matches.
    fn bump_generation(&self) -> u64 {
        self.with_proc(|p| {
            p.generation = p.generation.wrapping_add(1);
            p.generation
        })
    }

    /// Stop the child. Safe to call more than once.
    pub fn shutdown(&self) {
        self.with_proc(|p| {
            // Bump first so any retry/watchdog thread still running for the
            // outgoing attempt sees it has been superseded and doesn't
            // "helpfully" restart the server we were just told to stop.
            p.generation = p.generation.wrapping_add(1);
            if let Some(mut child) = p.child.take() {
                let _ = child.kill();
                let _ = child.wait();
                log::info!("[sidex-server] stopped");
            }
        });
    }
}

impl Drop for LocalServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEndpoint {
    pub ws_url: String,
    pub http_url: String,
    pub port: u16,
    pub running: bool,
    /// Set when the server is not running and we know why. `None` while
    /// healthy, or before the first spawn attempt has reported back.
    pub error: Option<String>,
}

/// Where the workbench should point. Called early by the chat service.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn server_endpoint(server: tauri::State<'_, Arc<LocalServer>>) -> ServerEndpoint {
    server.endpoint()
}

/// Ask the OS for a free loopback port, then release it for the child to bind.
///
/// There is a small race between releasing and the child binding; `start`
/// retries with a fresh port (bounded by `MAX_SPAWN_ATTEMPTS`) if that race
/// is lost. Using a fixed port instead would collide with a developer
/// already running a server.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

/// Locate the server binary.
///
/// Order matters: a bundled sidecar is what ships to users, `SIDEX_SERVER_BIN`
/// and `PATH` let people run their own build, and the repo-relative paths keep
/// `tauri dev` working without an install step.
fn find_server_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(SERVER_BIN);
        if bundled.is_file() {
            return Some(bundled);
        }
    }

    if let Ok(explicit) = std::env::var("SIDEX_SERVER_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(found) = which::which(SERVER_BIN) {
        return Some(found);
    }

    // Development: repo checkout, server built in place. `CARGO_MANIFEST_DIR`
    // is src-tauri regardless of the process cwd (`tauri dev` often starts
    // there, but a launched .app does not).
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let cwd = std::env::current_dir().unwrap_or_default();
    for candidate in [
        manifest_dir.join("../sidexai/sidex-server").join(SERVER_BIN),
        cwd.join("sidexai/sidex-server").join(SERVER_BIN),
        cwd.join("../sidexai/sidex-server").join(SERVER_BIN),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

/// Block until the server answers its health endpoint, or the timeout expires.
fn wait_until_healthy(port: u16) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/v1/health");
    let deadline = Instant::now() + STARTUP_TIMEOUT;

    while Instant::now() < deadline {
        if client
            .get(&url)
            .send()
            .is_ok_and(|r| r.status().is_success())
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "server did not become healthy within {STARTUP_TIMEOUT:?}"
    ))
}

/// Forward the child's stderr into the app log, so a crash is diagnosable.
///
/// The Go server logs everything through `log.Printf` at one unstructured
/// severity — there's no `level=` prefix to parse. Left alone, its routine
/// startup/access chatter would sit at the same level as a real failure and
/// bury it, so lines that look like a problem are promoted to WARN and
/// everything else is knocked down to DEBUG (still available with
/// `RUST_LOG=debug`, invisible at the app's default level).
fn pipe_logs(child: &mut Child) {
    let Some(stderr) = child.stderr.take() else {
        return;
    };
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if looks_like_a_problem(&line) {
                log::warn!("[sidex-server] {line}");
            } else {
                log::debug!("[sidex-server] {line}");
            }
        }
    });
}

/// Heuristic, since the child has no structured log levels: matches the
/// vocabulary its own error paths actually use (`failed`, `error`, `panic`,
/// `fatal`, `warning` — see `sidex-server/internal/**/*.go`). Occasionally
/// promotes a benign line that happens to contain one of these words; that's
/// the safer failure mode than burying a real one.
fn looks_like_a_problem(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    ["error", "fail", "panic", "fatal", "warning", "locked"]
        .iter()
        .any(|kw| lower.contains(kw))
}

/// A previous `tauri dev` / crash can leave `sidex-server` running with
/// `~/.sidex/state.db` locked. The next spawn then sits on that lock until
/// the health timeout, never binds, and the UI talks to an empty port.
fn kill_orphan_servers(bin: &Path) {
    let bin_s = bin.to_string_lossy();
    let Ok(out) = Command::new("pgrep").arg("-f").arg(bin_s.as_ref()).output() else {
        return;
    };
    if !out.status.success() {
        return;
    }
    for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        log::warn!("[sidex-server] stopping leftover process {pid} ({bin_s})");
        let _ = Command::new("kill").arg("-TERM").arg(pid).status();
    }
    std::thread::sleep(Duration::from_millis(300));
}

/// Spawn one child on `port` and block until it answers its health check
/// (the caller runs this off the main thread). On success the child is left
/// running and recorded on `server`. On failure — or if superseded before it
/// could even be registered — it is killed and reaped immediately: leaving a
/// dead-end child running would both leak the process and, if it did
/// somehow bind, hold a port we may be about to hand to the next attempt.
fn spawn_and_confirm(
    bin: &Path,
    port: u16,
    provider_env: &BTreeMap<String, String>,
    server: &Arc<LocalServer>,
    generation: u64,
) -> Result<(), String> {
    let mut cmd = Command::new(bin);
    cmd.env("SIDEX_PORT", port.to_string())
        // No account, no tokens: the server only listens on loopback and
        // serves the single local user who launched it.
        .env("SIDEX_NO_AUTH", "1")
        .env("SIDEX_BIND_ADDR", "127.0.0.1")
        .envs(provider_env)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", bin.display()))?;
    pipe_logs(&mut child);

    // Do not advertise this child as running until it answers /v1/health.
    // Registering earlier made the workbench open a WebSocket to a port that
    // was reserved but not serving (e.g. the process was blocked on a stale
    // state.db lock).
    if let Err(e) = wait_until_healthy(port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }

    let mut orphan = Some(child);
    server.with_proc(|p| {
        if p.generation == generation {
            p.child = orphan.take();
        }
    });
    if let Some(mut leftover) = orphan {
        let _ = leftover.kill();
        let _ = leftover.wait();
        return Err("superseded before startup finished".to_string());
    }
    Ok(())
}

/// Poll the child once it's expected to be up. If it dies on its own —
/// `shutdown` bumps `generation` before touching the child, so a death with
/// `generation` unchanged means a crash, not a deliberate stop — try to
/// bring it back on a fresh port, bounded by `MAX_CRASH_RESTARTS`. Returns
/// (stops polling) once superseded by a newer `start()`/`shutdown()`, or once
/// the restart budget is spent.
fn watch_for_crash(
    server: &Arc<LocalServer>,
    bin: &Path,
    provider_env: &BTreeMap<String, String>,
    generation: u64,
) {
    let mut restarts_left = MAX_CRASH_RESTARTS;
    loop {
        std::thread::sleep(WATCHDOG_POLL_INTERVAL);

        let (alive, current_generation) =
            server.with_proc(|p| (LocalServer::child_alive(p), p.generation));
        if current_generation != generation {
            return;
        }
        if alive {
            continue;
        }

        if restarts_left == 0 {
            log::error!("[sidex-server] crashed repeatedly; giving up automatic restarts");
            server.with_proc(|p| {
                if p.generation == generation {
                    p.error = Some("server crashed repeatedly and was not restarted".to_string());
                }
            });
            return;
        }
        restarts_left -= 1;
        log::warn!(
            "[sidex-server] process exited unexpectedly; attempting restart ({restarts_left} left)"
        );

        let port = match free_port() {
            Ok(p) => p,
            Err(e) => {
                log::error!("[sidex-server] could not reserve a port for restart: {e}");
                return;
            }
        };
        server.with_proc(|p| {
            if p.generation == generation {
                p.port = port;
            }
        });

        match spawn_and_confirm(bin, port, provider_env, server, generation) {
            Ok(()) => {
                log::info!("[sidex-server] recovered on 127.0.0.1:{port}");
                server.with_proc(|p| {
                    if p.generation == generation {
                        p.error = None;
                    }
                });
            }
            Err(e) => log::error!("[sidex-server] restart failed: {e}"),
        }
    }
}

/// Own the full lifecycle of one `start()` call, off the calling thread:
/// spawn the child, retrying with a fresh port a bounded number of times if
/// it never becomes healthy, then hand off to the crash watchdog once it is.
/// Exits quietly the moment `generation` is superseded by a newer `start()`
/// or by `shutdown`.
fn run_supervised(
    server: &Arc<LocalServer>,
    bin: &Path,
    provider_env: &BTreeMap<String, String>,
    mut port: u16,
    generation: u64,
) {
    for attempt in 1..=MAX_SPAWN_ATTEMPTS {
        if server.with_proc(|p| p.generation) != generation {
            return;
        }

        match spawn_and_confirm(bin, port, provider_env, server, generation) {
            Ok(()) => {
                log::info!("[sidex-server] ready on 127.0.0.1:{port}");
                server.with_proc(|p| {
                    if p.generation == generation {
                        p.error = None;
                    }
                });
                watch_for_crash(server, bin, provider_env, generation);
                return;
            }
            Err(e) => {
                log::error!("[sidex-server] attempt {attempt}/{MAX_SPAWN_ATTEMPTS}: {e}");
                let superseded = server.with_proc(|p| p.generation) != generation;
                if attempt == MAX_SPAWN_ATTEMPTS || superseded {
                    server.with_proc(|p| {
                        if p.generation == generation {
                            p.error = Some(e);
                            // Whatever port we tried is evidently unusable;
                            // clear it so a later manual restart reserves a
                            // fresh one instead of retrying a bad one.
                            p.port = 0;
                        }
                    });
                    return;
                }
                port = match free_port() {
                    Ok(p) => p,
                    Err(e) => {
                        server.with_proc(|p| {
                            if p.generation == generation {
                                p.error = Some(e);
                            }
                        });
                        return;
                    }
                };
                server.with_proc(|p| {
                    if p.generation == generation {
                        p.port = port;
                    }
                });
            }
        }
    }
}

/// Spawn the server process and record it on `server`.
///
/// A failure here is not fatal: the editor is fully usable without the agent,
/// so the error is recorded on `ServerProc::error` (surfaced to the UI via
/// `server_endpoint`) and logged, rather than blocking startup.
fn start(app: &AppHandle, server: &Arc<LocalServer>) {
    server.with_proc(|p| p.error = None);

    let Some(bin) = find_server_binary(app) else {
        let msg = "sidex-server binary not found. Build it with `cd sidexai/sidex-server && \
                    go build -tags fts5 -o sidex-server ./cmd/server`, or set SIDEX_SERVER_BIN \
                    to point at an existing build."
            .to_string();
        log::warn!("[sidex-server] {msg}");
        server.with_proc(|p| p.error = Some(msg));
        return;
    };

    kill_orphan_servers(&bin);

    // Reuse the port across restarts. Credentials are read at spawn, so
    // changing one restarts the server; moving it to a new port as well would
    // drop the workbench's socket onto a dead address every time.
    let existing = server.with_proc(|p| p.port);
    let port = if existing != 0 {
        existing
    } else {
        match free_port() {
            Ok(p) => p,
            Err(e) => {
                log::error!("[sidex-server] could not reserve a port: {e}");
                server.with_proc(|p| p.error = Some(format!("could not reserve a port: {e}")));
                return;
            }
        }
    };
    server.with_proc(|p| p.port = port);

    let provider_env = {
        let store = app.state::<Arc<SecretsStore>>();
        providers::server_env(&store)
    };

    let generation = server.bump_generation();
    let server = Arc::clone(server);
    // Off-thread so the window still paints while we spawn, retry and wait
    // out the health check (up to `STARTUP_TIMEOUT` per attempt).
    std::thread::spawn(move || run_supervised(&server, &bin, &provider_env, port, generation));
}

/// Register the supervisor and start the server. Called once during setup.
pub fn initialize(app: &AppHandle) {
    let server = Arc::new(LocalServer::new());
    app.manage(Arc::clone(&server));
    start(app, &server);
}

/// Restart the server so newly-saved provider credentials take effect.
#[tauri::command]
pub fn server_restart(app: AppHandle) -> Result<ServerEndpoint, String> {
    let server = app
        .try_state::<Arc<LocalServer>>()
        .ok_or("local server is not initialized")?
        .inner()
        .clone();
    server.shutdown();
    start(&app, &server);
    Ok(server.endpoint())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn spawn_short_lived() -> Child {
        Command::new("true").spawn().expect("spawn `true`")
    }
    #[cfg(windows)]
    fn spawn_short_lived() -> Child {
        Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .expect("spawn `cmd /C exit 0`")
    }

    #[cfg(unix)]
    fn spawn_long_lived() -> Child {
        Command::new("sleep")
            .arg("5")
            .spawn()
            .expect("spawn `sleep`")
    }
    #[cfg(windows)]
    fn spawn_long_lived() -> Child {
        Command::new("ping")
            .args(["-n", "6", "127.0.0.1"])
            .spawn()
            .expect("spawn `ping`")
    }

    /// Restarting must not move the server.
    ///
    /// Credentials are read at spawn, so changing one restarts the process. If
    /// the port changed too, the workbench's WebSocket would reconnect to a
    /// dead address every time the user saved a key.
    #[test]
    fn shutdown_preserves_the_port_for_the_next_start() {
        let server = LocalServer::new();
        assert_eq!(server.port(), 0, "a fresh supervisor has no port yet");

        server.with_proc(|p| p.port = 51234);
        server.shutdown();

        assert_eq!(
            server.port(),
            51234,
            "the port must survive shutdown so the restart can rebind it"
        );
    }

    /// A supervisor with no child reports as not running, and its endpoint
    /// still describes where the server will be — the UI renders that before
    /// the process is up.
    #[test]
    fn endpoint_reflects_port_even_while_stopped() {
        let server = LocalServer::new();
        server.with_proc(|p| p.port = 4242);

        let ep = server.endpoint();
        assert!(!ep.running);
        assert_eq!(ep.port, 4242);
        assert_eq!(ep.ws_url, "ws://127.0.0.1:4242");
        assert_eq!(ep.http_url, "http://127.0.0.1:4242");
    }

    #[test]
    fn free_port_returns_a_usable_loopback_port() {
        let port = free_port().expect("should be able to reserve a loopback port");
        assert!(port > 0);
    }

    /// The UI needs the reason, not just a boolean, to tell "binary missing"
    /// apart from "crashed" apart from "hasn't started yet".
    #[test]
    fn endpoint_surfaces_the_recorded_error() {
        let server = LocalServer::new();
        server.with_proc(|p| p.error = Some("binary not found".to_string()));

        assert_eq!(server.endpoint().error.as_deref(), Some("binary not found"));
    }

    /// `is_running` must not trust a stale `Some(Child)` — it has to ask the
    /// OS. Uses a real (trivial, portless) process so the reaping path
    /// through `try_wait` is actually exercised, not just simulated.
    #[test]
    fn is_running_reaps_a_child_that_already_exited() {
        let server = LocalServer::new();
        let child = spawn_short_lived();
        // Give the trivial process time to actually exit; try_wait (unlike
        // wait) does not block, so without this the check could race it.
        std::thread::sleep(Duration::from_millis(300));
        server.with_proc(|p| p.child = Some(child));

        assert!(
            !server.is_running(),
            "a process that already exited must not be reported as running"
        );
        assert!(
            server.with_proc(|p| p.child.is_none()),
            "is_running must reap the dead handle, not just report on it"
        );
        assert!(
            server.endpoint().error.is_some(),
            "the exit must be recorded for the UI"
        );
    }

    /// The flip side: a process that is genuinely still alive must not be
    /// mistaken for dead.
    #[test]
    fn is_running_reflects_a_live_child() {
        let server = LocalServer::new();
        let child = spawn_long_lived();
        server.with_proc(|p| p.child = Some(child));

        assert!(server.is_running());
        server.shutdown(); // reap it so the test doesn't leak a process
    }

    /// A binary that can't even spawn (bad path) must exhaust its retries and
    /// record why, without leaving a child registered. Runs `run_supervised`
    /// directly on the test thread — with a nonexistent path each attempt
    /// fails at `Command::spawn`, before any health check, so this completes
    /// immediately rather than waiting out `STARTUP_TIMEOUT`.
    #[test]
    fn run_supervised_gives_up_after_bounded_attempts_when_the_binary_cannot_spawn() {
        let server = Arc::new(LocalServer::new());
        let generation = server.bump_generation();
        let bin = PathBuf::from("/definitely/does/not/exist/sidex-server-test-binary");
        let port = free_port().expect("reserve a port for the test");

        run_supervised(&server, &bin, &BTreeMap::new(), port, generation);

        server.with_proc(|p| {
            assert!(
                p.child.is_none(),
                "a binary that can't spawn must not register a child"
            );
            assert!(
                p.error.is_some(),
                "the failure must be recorded for the UI to show"
            );
            assert_eq!(
                p.port, 0,
                "the unusable port must be cleared so a retry picks a new one"
            );
        });
        assert!(!server.is_running());
    }

    /// A stale attempt (superseded by a manual restart or shutdown before it
    /// got to run) must not clobber state that a newer attempt now owns.
    #[test]
    fn run_supervised_steps_aside_once_superseded() {
        let server = Arc::new(LocalServer::new());
        let stale_generation = server.bump_generation();
        server.bump_generation(); // simulates a newer start()/shutdown()

        run_supervised(
            &server,
            &PathBuf::from("irrelevant — must never be spawned"),
            &BTreeMap::new(),
            0,
            stale_generation,
        );

        server.with_proc(|p| {
            assert!(
                p.error.is_none(),
                "a superseded attempt must not report its own failure"
            )
        });
    }

    /// The Go server has no structured log levels, so `pipe_logs` classifies
    /// lines by keyword. These are drawn from its actual call sites (see
    /// `sidex-server/internal/**/*.go`) so the heuristic is checked against
    /// real output, not an idealized example.
    #[test]
    fn log_classification_promotes_failures_and_demotes_routine_lines() {
        assert!(looks_like_a_problem(
            "warning: failed to initialize usage service: boom (continuing without usage tracking)"
        ));
        assert!(looks_like_a_problem("agent loop panic: index out of range"));
        assert!(looks_like_a_problem(
            "mcp: failed to start server \"foo\": exit status 1 (skipping)"
        ));
        assert!(looks_like_a_problem(
            "state store is locked by another instance; waiting for it to exit"
        ));

        assert!(!looks_like_a_problem(
            "Sidex server listening on 127.0.0.1:7433"
        ));
        assert!(!looks_like_a_problem(
            "mcp: connected to \"foo\" (stdio) — 3 tools registered"
        ));
        assert!(!looks_like_a_problem("cleaned up session abc123"));
    }
}
