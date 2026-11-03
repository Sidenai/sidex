use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchTask {
    pub id: String,
    pub name: String,
    pub task_type: String,
    pub scoped_goal: String,
    pub status: String,
    pub depends_on: Vec<String>,
    pub verifies: Option<String>,
    pub acceptance: Vec<String>,
    pub paths_allowed: Vec<String>,
    pub paths_forbidden: Vec<String>,
    pub branch: Option<String>,
    pub attempts: u32,
    pub max_attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchPlan {
    pub id: String,
    pub goal: String,
    pub summary: String,
    pub base_branch: String,
    pub model: String,
    pub tasks: Vec<OrchTask>,
    pub status: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchHandoff {
    pub task_id: String,
    pub task_name: String,
    pub status: String,
    pub summary: String,
    pub branch: Option<String>,
    pub files_changed: Vec<String>,
    pub verdict: Option<String>,
    pub verdict_reason: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrchEvent {
    pub event_type: String,
    pub plan_id: String,
    pub task_id: Option<String>,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchConfig {
    pub max_parallel_workers: usize,
    pub max_parallel_verifiers: usize,
    pub auto_verify: bool,
    pub planner_model: String,
    pub worker_model: String,
    pub verifier_model: String,
    pub timeout_ms: u64,
    pub max_retries: u32,
}

impl Default for OrchConfig {
    fn default() -> Self {
        Self {
            max_parallel_workers: 4,
            max_parallel_verifiers: 2,
            auto_verify: true,
            planner_model: "anthropic/claude-sonnet-4.6".into(),
            worker_model: "anthropic/claude-sonnet-4.6".into(),
            verifier_model: "anthropic/claude-sonnet-4.6".into(),
            timeout_ms: 600_000,
            max_retries: 2,
        }
    }
}

struct RunningTask {
    task_id: String,
    cancel_tx: mpsc::Sender<()>,
}

struct OrchRun {
    plan: OrchPlan,
    config: OrchConfig,
    handoffs: HashMap<String, OrchHandoff>,
    running: Vec<RunningTask>,
    cancelled: bool,
}

pub struct OrchestrationStore {
    runs: Mutex<HashMap<String, Arc<Mutex<OrchRun>>>>,
}

impl OrchestrationStore {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn build_system_prompt(task: &OrchTask) -> String {
    match task.task_type.as_str() {
        "worker" => format!(
            "You are a worker agent. Task: \"{}\"\n\
             Allowed paths: {}\n\
             Forbidden paths: {}\n\
             Acceptance: {}\n\
             Work in isolation. Produce a structured handoff when done.",
            task.scoped_goal,
            if task.paths_allowed.is_empty() {
                "any".into()
            } else {
                task.paths_allowed.join(", ")
            },
            if task.paths_forbidden.is_empty() {
                "none".into()
            } else {
                task.paths_forbidden.join(", ")
            },
            task.acceptance.join("; "),
        ),
        "verifier" => format!(
            "You are a verifier. Check task \"{}\" meets criteria:\n{}\n\
             Produce verdict: pass, fail, or partial with reasoning.",
            task.verifies.as_deref().unwrap_or("unknown"),
            task.acceptance
                .iter()
                .enumerate()
                .map(|(i, a)| format!("{}. {}", i + 1, a))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "subplanner" => format!(
            "You are a subplanner for: \"{}\"\n\
             Decompose into concrete sub-tasks. Do not code directly.",
            task.scoped_goal,
        ),
        _ => format!("You are an agent. Goal: \"{}\"", task.scoped_goal),
    }
}

#[tauri::command]
pub async fn orch_start(
    app: AppHandle,
    state: State<'_, Arc<OrchestrationStore>>,
    goal: String,
    _workspace: String,
    config: Option<OrchConfig>,
) -> Result<OrchPlan, String> {
    let cfg = config.unwrap_or_default();
    let plan_id = format!("orch-{}", now_ms());

    let plan = OrchPlan {
        id: plan_id.clone(),
        goal: goal.clone(),
        summary: String::new(),
        base_branch: "main".into(),
        model: cfg.planner_model.clone(),
        tasks: Vec::new(),
        status: "planning".into(),
        created_at: now_ms(),
    };

    let run = OrchRun {
        plan: plan.clone(),
        config: cfg,
        handoffs: HashMap::new(),
        running: Vec::new(),
        cancelled: false,
    };

    let run_arc = Arc::new(Mutex::new(run));
    {
        let mut runs = state.runs.lock().map_err(|e| e.to_string())?;
        runs.insert(plan_id.clone(), run_arc.clone());
    }

    let _ = app.emit(
        "orch-event",
        OrchEvent {
            event_type: "plan_created".into(),
            plan_id: plan_id.clone(),
            task_id: None,
            data: serde_json::to_value(&plan).unwrap_or_default(),
        },
    );

    Ok(plan)
}

#[tauri::command]
pub async fn orch_add_tasks(
    app: AppHandle,
    state: State<'_, Arc<OrchestrationStore>>,
    plan_id: String,
    tasks: Vec<OrchTask>,
) -> Result<(), String> {
    let runs = state.runs.lock().map_err(|e| e.to_string())?;
    let run_arc = runs.get(&plan_id).ok_or("Plan not found")?.clone();
    drop(runs);

    let mut run = run_arc.lock().map_err(|e| e.to_string())?;
    for task in &tasks {
        run.plan.tasks.push(task.clone());
        let _ = app.emit(
            "orch-event",
            OrchEvent {
                event_type: "task_added".into(),
                plan_id: plan_id.clone(),
                task_id: Some(task.id.clone()),
                data: serde_json::to_value(task).unwrap_or_default(),
            },
        );
    }
    run.plan.status = "running".into();

    Ok(())
}

#[tauri::command]
pub async fn orch_spawn_task(
    app: AppHandle,
    state: State<'_, Arc<OrchestrationStore>>,
    plan_id: String,
    task_id: String,
    server_url: String,
) -> Result<String, String> {
    let runs = state.runs.lock().map_err(|e| e.to_string())?;
    let run_arc = runs.get(&plan_id).ok_or("Plan not found")?.clone();
    drop(runs);

    let (task, model, _cwd) = {
        let mut run = run_arc.lock().map_err(|e| e.to_string())?;

        let task_idx = run
            .plan
            .tasks
            .iter()
            .position(|t| t.id == task_id)
            .ok_or("Task not found")?;

        {
            let task = &run.plan.tasks[task_idx];
            if task.status != "pending" && task.status != "queued" {
                return Err(format!(
                    "Task {} is in state {}, cannot spawn",
                    task_id, task.status
                ));
            }
        }

        run.plan.tasks[task_idx].status = "running".into();
        run.plan.tasks[task_idx].attempts += 1;
        run.plan.tasks[task_idx].branch = Some(format!(
            "orch/{}/{}",
            plan_id, run.plan.tasks[task_idx].name
        ));

        let task_type = run.plan.tasks[task_idx].task_type.clone();
        let model = match task_type.as_str() {
            "planner" | "subplanner" => run.config.planner_model.clone(),
            "verifier" => run.config.verifier_model.clone(),
            _ => run.config.worker_model.clone(),
        };

        let task = run.plan.tasks[task_idx].clone();
        let base = run.plan.base_branch.clone();
        (task, model, base)
    };

    let system_prompt = build_system_prompt(&task);
    let run_id = format!("run-{}-{}", task_id, now_ms());

    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);

    {
        let mut run = run_arc.lock().map_err(|e| e.to_string())?;
        run.running.push(RunningTask {
            task_id: task_id.clone(),
            cancel_tx,
        });
    }

    let _ = app.emit(
        "orch-event",
        OrchEvent {
            event_type: "task_spawned".into(),
            plan_id: plan_id.clone(),
            task_id: Some(task_id.clone()),
            data: serde_json::json!({
                "run_id": run_id,
                "model": model,
                "branch": task.branch,
            }),
        },
    );

    // Spawn the agent session in background
    let app_clone = app.clone();
    let plan_id_clone = plan_id.clone();
    let task_id_clone = task_id.clone();
    let run_arc_clone = run_arc.clone();

    tokio::spawn(async move {
        let result = run_agent_session(
            &server_url,
            &system_prompt,
            &task.scoped_goal,
            &model,
            &app_clone,
            &plan_id_clone,
            &task_id_clone,
            &mut cancel_rx,
        )
        .await;

        let mut run = match run_arc_clone.lock() {
            Ok(r) => r,
            Err(_) => return,
        };

        run.running.retain(|r| r.task_id != task_id_clone);

        let task = match run.plan.tasks.iter_mut().find(|t| t.id == task_id_clone) {
            Some(t) => t,
            None => return,
        };

        match result {
            Ok(handoff) => {
                task.status = "completed".into();
                run.handoffs.insert(task_id_clone.clone(), handoff.clone());
                let _ = app_clone.emit(
                    "orch-event",
                    OrchEvent {
                        event_type: "task_complete".into(),
                        plan_id: plan_id_clone.clone(),
                        task_id: Some(task_id_clone.clone()),
                        data: serde_json::to_value(&handoff).unwrap_or_default(),
                    },
                );
            }
            Err(err) => {
                if task.attempts < task.max_attempts {
                    task.status = "pending".into();
                } else {
                    task.status = "failed".into();
                }
                let _ = app_clone.emit(
                    "orch-event",
                    OrchEvent {
                        event_type: "task_error".into(),
                        plan_id: plan_id_clone,
                        task_id: Some(task_id_clone),
                        data: serde_json::json!({ "error": err }),
                    },
                );
            }
        }
    });

    Ok(run_id)
}

async fn run_agent_session(
    server_url: &str,
    system_prompt: &str,
    goal: &str,
    model: &str,
    app: &AppHandle,
    plan_id: &str,
    task_id: &str,
    cancel_rx: &mut mpsc::Receiver<()>,
) -> Result<OrchHandoff, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    let ws_url = format!("{}/v1/stream", server_url.replace("ws://", "ws://"));
    let (ws_stream, _) = connect_async(&ws_url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    let (mut write, mut read) = ws_stream.split();

    let session_id = format!("orch-session-{}-{}", task_id, now_ms());
    let payload = serde_json::json!({
        "session_id": session_id,
        "message": format!("{}\n\nGoal: {}", system_prompt, goal),
        "mode": "agent",
        "model": model,
        "permission_mode": "auto_all",
        "local_exec": false,
        "context": {},
    });

    write
        .send(Message::Text(payload.to_string()))
        .await
        .map_err(|e| format!("Send failed: {e}"))?;

    let mut content = String::new();
    let mut files_changed = Vec::new();

    loop {
        tokio::select! {
            _ = cancel_rx.recv() => {
                let _ = write.close().await;
                return Err("Cancelled".into());
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let chunk: serde_json::Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        let chunk_type = chunk.get("type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");

                        match chunk_type {
                            "text" => {
                                let c = chunk.get("content")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                content.push_str(c);
                                let _ = app.emit("orch-event", OrchEvent {
                                    event_type: "task_text".into(),
                                    plan_id: plan_id.into(),
                                    task_id: Some(task_id.into()),
                                    data: serde_json::json!({ "content": c }),
                                });
                            }
                            "tool_call" => {
                                if let Some(calls) = chunk.get("tool_calls").and_then(|v| v.as_array()) {
                                    for tc in calls {
                                        let name = tc.get("function")
                                            .and_then(|f| f.get("name"))
                                            .and_then(|n| n.as_str())
                                            .unwrap_or("unknown");
                                        let _ = app.emit("orch-event", OrchEvent {
                                            event_type: "task_tool_call".into(),
                                            plan_id: plan_id.into(),
                                            task_id: Some(task_id.into()),
                                            data: serde_json::json!({
                                                "tool_name": name,
                                                "status": "running",
                                            }),
                                        });
                                        if name.contains("edit") || name.contains("write") {
                                            if let Some(args) = tc.get("function")
                                                .and_then(|f| f.get("arguments"))
                                                .and_then(|a| a.as_str())
                                            {
                                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(args) {
                                                    if let Some(path) = parsed.get("path").and_then(|p| p.as_str()) {
                                                        files_changed.push(path.to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            "done" | "error" => {
                                break;
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => continue,
                }
            }
        }
    }

    let _ = write.close().await;

    Ok(OrchHandoff {
        task_id: task_id.into(),
        task_name: task_id.into(),
        status: "success".into(),
        summary: if content.len() > 200 {
            format!("{}...", &content[..200])
        } else {
            content
        },
        branch: None,
        files_changed,
        verdict: None,
        verdict_reason: None,
        timestamp: now_ms(),
    })
}

#[tauri::command]
pub fn orch_cancel(
    app: AppHandle,
    state: State<'_, Arc<OrchestrationStore>>,
    plan_id: String,
) -> Result<(), String> {
    let runs = state.runs.lock().map_err(|e| e.to_string())?;
    let run_arc = runs.get(&plan_id).ok_or("Plan not found")?.clone();
    drop(runs);

    let mut run = run_arc.lock().map_err(|e| e.to_string())?;
    run.cancelled = true;
    run.plan.status = "cancelled".into();

    for rt in run.running.drain(..) {
        let _ = rt.cancel_tx.try_send(());
    }
    drop(run);

    let _ = app.emit(
        "orch-event",
        OrchEvent {
            event_type: "cancelled".into(),
            plan_id,
            task_id: None,
            data: serde_json::json!({ "reason": "User cancelled" }),
        },
    );

    Ok(())
}

#[tauri::command]
pub fn orch_status(
    state: State<'_, Arc<OrchestrationStore>>,
    plan_id: String,
) -> Result<OrchPlan, String> {
    let runs = state.runs.lock().map_err(|e| e.to_string())?;
    let run_arc = runs.get(&plan_id).ok_or("Plan not found")?.clone();
    drop(runs);

    let run = run_arc.lock().map_err(|e| e.to_string())?;
    Ok(run.plan.clone())
}

#[tauri::command]
pub fn orch_get_ready_tasks(
    state: State<'_, Arc<OrchestrationStore>>,
    plan_id: String,
) -> Result<Vec<OrchTask>, String> {
    let runs = state.runs.lock().map_err(|e| e.to_string())?;
    let run_arc = runs.get(&plan_id).ok_or("Plan not found")?.clone();
    drop(runs);

    let run = run_arc.lock().map_err(|e| e.to_string())?;
    let ready: Vec<OrchTask> = run
        .plan
        .tasks
        .iter()
        .filter(|t| {
            t.status == "pending"
                && t.depends_on.iter().all(|dep| {
                    run.plan
                        .tasks
                        .iter()
                        .any(|d| d.id == *dep && d.status == "completed")
                })
        })
        .cloned()
        .collect();

    Ok(ready)
}

#[tauri::command]
pub fn orch_get_handoffs(
    state: State<'_, Arc<OrchestrationStore>>,
    plan_id: String,
) -> Result<Vec<OrchHandoff>, String> {
    let runs = state.runs.lock().map_err(|e| e.to_string())?;
    let run_arc = runs.get(&plan_id).ok_or("Plan not found")?.clone();
    drop(runs);

    let run = run_arc.lock().map_err(|e| e.to_string())?;
    Ok(run.handoffs.values().cloned().collect())
}

#[tauri::command]
pub fn orch_list(state: State<'_, Arc<OrchestrationStore>>) -> Result<Vec<OrchPlan>, String> {
    let runs = state.runs.lock().map_err(|e| e.to_string())?;
    let plans: Vec<OrchPlan> = runs
        .values()
        .filter_map(|r| r.lock().ok().map(|run| run.plan.clone()))
        .collect();
    Ok(plans)
}
