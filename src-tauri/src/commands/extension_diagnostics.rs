use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tauri::State;

// ---------------------------------------------------------------------------
// Extension runtime record — tracks each extension's lifecycle state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRuntimeRecord {
    pub id: String,
    pub status: ExtensionStatus,
    pub activation_time_ms: Option<u64>,
    pub activated_at: Option<String>,
    pub deactivated_at: Option<String>,
    pub error: Option<String>,
    pub error_count: u32,
    pub is_slow: bool,
    pub disabled_by_bisect: bool,
    pub provider_count: u32,
    pub command_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionStatus {
    Discovered,
    Loading,
    Activated,
    Failed,
    Deactivated,
    Disabled,
}

// ---------------------------------------------------------------------------
// Extension profiling record
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionProfileRecord {
    pub id: String,
    pub activation_time_ms: u64,
    pub is_slow: bool,
    pub total_provider_calls: u64,
    pub total_provider_time_ms: u64,
    pub avg_provider_time_ms: f64,
    pub peak_provider_time_ms: u64,
    pub error_count: u32,
}

// ---------------------------------------------------------------------------
// Bisect state — binary search for problematic extensions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectState {
    pub active: bool,
    pub round: u32,
    pub total_rounds: u32,
    pub all_extension_ids: Vec<String>,
    pub enabled_ids: Vec<String>,
    pub disabled_ids: Vec<String>,
    pub confirmed_bad: Vec<String>,
    pub confirmed_good: Vec<String>,
}

// ---------------------------------------------------------------------------
// Slow extension detection config
// ---------------------------------------------------------------------------

const SLOW_ACTIVATION_THRESHOLD_MS: u64 = 2000;
const SLOW_PROVIDER_AVG_THRESHOLD_MS: f64 = 500.0;

// ---------------------------------------------------------------------------
// Internal state for a single extension
// ---------------------------------------------------------------------------

struct ExtRuntimeState {
    id: String,
    status: ExtensionStatus,
    activation_time_ms: Option<u64>,
    activated_at: Option<String>,
    deactivated_at: Option<String>,
    error: Option<String>,
    error_count: u32,
    disabled_by_bisect: bool,
    provider_count: u32,
    command_count: u32,
    total_provider_calls: u64,
    total_provider_time_ms: u64,
    peak_provider_time_ms: u64,
}

impl ExtRuntimeState {
    fn new(id: String) -> Self {
        Self {
            id,
            status: ExtensionStatus::Discovered,
            activation_time_ms: None,
            activated_at: None,
            deactivated_at: None,
            error: None,
            error_count: 0,
            disabled_by_bisect: false,
            provider_count: 0,
            command_count: 0,
            total_provider_calls: 0,
            total_provider_time_ms: 0,
            peak_provider_time_ms: 0,
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn is_slow(&self) -> bool {
        if let Some(ms) = self.activation_time_ms {
            if ms >= SLOW_ACTIVATION_THRESHOLD_MS {
                return true;
            }
        }
        if self.total_provider_calls > 0 {
            let avg = self.total_provider_time_ms as f64 / self.total_provider_calls as f64;
            if avg >= SLOW_PROVIDER_AVG_THRESHOLD_MS {
                return true;
            }
        }
        false
    }

    fn to_record(&self) -> ExtensionRuntimeRecord {
        ExtensionRuntimeRecord {
            id: self.id.clone(),
            status: self.status.clone(),
            activation_time_ms: self.activation_time_ms,
            activated_at: self.activated_at.clone(),
            deactivated_at: self.deactivated_at.clone(),
            error: self.error.clone(),
            error_count: self.error_count,
            is_slow: self.is_slow(),
            disabled_by_bisect: self.disabled_by_bisect,
            provider_count: self.provider_count,
            command_count: self.command_count,
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn to_profile(&self) -> ExtensionProfileRecord {
        let avg = if self.total_provider_calls > 0 {
            self.total_provider_time_ms as f64 / self.total_provider_calls as f64
        } else {
            0.0
        };
        ExtensionProfileRecord {
            id: self.id.clone(),
            activation_time_ms: self.activation_time_ms.unwrap_or(0),
            is_slow: self.is_slow(),
            total_provider_calls: self.total_provider_calls,
            total_provider_time_ms: self.total_provider_time_ms,
            avg_provider_time_ms: avg,
            peak_provider_time_ms: self.peak_provider_time_ms,
            error_count: self.error_count,
        }
    }
}

// ---------------------------------------------------------------------------
// Bisect engine
// ---------------------------------------------------------------------------

struct BisectEngine {
    active: bool,
    round: u32,
    all_ids: Vec<String>,
    candidates: Vec<String>,
    confirmed_bad: Vec<String>,
    confirmed_good: Vec<String>,
}

impl BisectEngine {
    fn new() -> Self {
        Self {
            active: false,
            round: 0,
            all_ids: Vec::new(),
            candidates: Vec::new(),
            confirmed_bad: Vec::new(),
            confirmed_good: Vec::new(),
        }
    }

    fn start(&mut self, extension_ids: Vec<String>) {
        self.active = true;
        self.round = 0;
        self.all_ids = extension_ids.clone();
        self.candidates = extension_ids;
        self.confirmed_bad.clear();
        self.confirmed_good.clear();
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    fn total_rounds(&self) -> u32 {
        if self.candidates.is_empty() {
            return 0;
        }
        (self.candidates.len() as f64).log2().ceil() as u32 + 1
    }

    fn current_enabled_set(&self) -> Vec<String> {
        if !self.active || self.candidates.is_empty() {
            return self.all_ids.clone();
        }
        let half = self.candidates.len() / 2;
        if half == 0 {
            return self.candidates.clone();
        }
        self.candidates[..half].to_vec()
    }

    fn current_disabled_set(&self) -> Vec<String> {
        if !self.active || self.candidates.is_empty() {
            return Vec::new();
        }
        let half = self.candidates.len() / 2;
        if half == 0 {
            return Vec::new();
        }
        self.candidates[half..].to_vec()
    }

    fn report_good(&mut self) {
        if !self.active {
            return;
        }
        let half = self.candidates.len() / 2;
        if half == 0 {
            self.finish();
            return;
        }
        let good_half: Vec<String> = self.candidates[..half].to_vec();
        self.confirmed_good.extend(good_half);
        self.candidates = self.candidates[half..].to_vec();
        self.round += 1;
        if self.candidates.len() <= 1 {
            self.finish();
        }
    }

    fn report_bad(&mut self) {
        if !self.active {
            return;
        }
        let half = self.candidates.len() / 2;
        if half == 0 {
            if self.candidates.len() == 1 {
                self.confirmed_bad.push(self.candidates[0].clone());
            }
            self.finish();
            return;
        }
        let bad_half: Vec<String> = self.candidates[half..].to_vec();
        self.confirmed_good.extend(bad_half);
        self.candidates = self.candidates[..half].to_vec();
        self.round += 1;
        if self.candidates.len() <= 1 {
            if self.candidates.len() == 1 {
                self.confirmed_bad.push(self.candidates[0].clone());
            }
            self.finish();
        }
    }

    fn finish(&mut self) {
        self.active = false;
    }

    fn to_state(&self) -> BisectState {
        BisectState {
            active: self.active,
            round: self.round,
            total_rounds: self.total_rounds(),
            all_extension_ids: self.all_ids.clone(),
            enabled_ids: self.current_enabled_set(),
            disabled_ids: self.current_disabled_set(),
            confirmed_bad: self.confirmed_bad.clone(),
            confirmed_good: self.confirmed_good.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// The diagnostics store — managed state in Tauri
// ---------------------------------------------------------------------------

pub struct ExtensionDiagnosticsStore {
    inner: Mutex<DiagnosticsState>,
}

struct DiagnosticsState {
    extensions: HashMap<String, ExtRuntimeState>,
    bisect: BisectEngine,
    session_start: Option<Instant>,
    startup_complete: bool,
    startup_time_ms: Option<u64>,
}

impl ExtensionDiagnosticsStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(DiagnosticsState {
                extensions: HashMap::new(),
                bisect: BisectEngine::new(),
                session_start: None,
                startup_complete: false,
                startup_time_ms: None,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — runtime diagnostics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionActivationReport {
    pub extension_id: String,
    pub activation_time_ms: u64,
    pub error: Option<String>,
    pub provider_count: Option<u32>,
    pub command_count: Option<u32>,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn extension_report_activated(
    report: ExtensionActivationReport,
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let entry = guard
        .extensions
        .entry(report.extension_id.clone())
        .or_insert_with(|| ExtRuntimeState::new(report.extension_id.clone()));

    if let Some(ref err) = report.error {
        entry.status = ExtensionStatus::Failed;
        entry.error = Some(err.clone());
        entry.error_count += 1;
    } else {
        entry.status = ExtensionStatus::Activated;
        entry.activation_time_ms = Some(report.activation_time_ms);
        entry.activated_at = Some(chrono::Utc::now().to_rfc3339());
        if let Some(pc) = report.provider_count {
            entry.provider_count = pc;
        }
        if let Some(cc) = report.command_count {
            entry.command_count = cc;
        }
    }
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn extension_report_provider_call(
    extension_id: String,
    duration_ms: u64,
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let entry = guard
        .extensions
        .entry(extension_id.clone())
        .or_insert_with(|| ExtRuntimeState::new(extension_id));

    entry.total_provider_calls += 1;
    entry.total_provider_time_ms += duration_ms;
    if duration_ms > entry.peak_provider_time_ms {
        entry.peak_provider_time_ms = duration_ms;
    }
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn extension_report_deactivated(
    extension_id: String,
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = guard.extensions.get_mut(&extension_id) {
        entry.status = ExtensionStatus::Deactivated;
        entry.deactivated_at = Some(chrono::Utc::now().to_rfc3339());
    }
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn extension_report_error(
    extension_id: String,
    error: String,
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let entry = guard
        .extensions
        .entry(extension_id.clone())
        .or_insert_with(|| ExtRuntimeState::new(extension_id));

    entry.error = Some(error);
    entry.error_count += 1;
    Ok(())
}

#[allow(clippy::cast_possible_truncation)]
#[tauri::command]
pub async fn extension_mark_startup_complete(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<u64, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.startup_complete = true;
    let ms = guard
        .session_start
        .map_or(0, |s| s.elapsed().as_millis() as u64);
    guard.startup_time_ms = Some(ms);
    Ok(ms)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub async fn extension_register_session(
    extension_ids: Vec<String>,
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.extensions.clear();
    guard.session_start = Some(Instant::now());
    guard.startup_complete = false;
    guard.startup_time_ms = None;
    for id in extension_ids {
        guard
            .extensions
            .insert(id.clone(), ExtRuntimeState::new(id));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — runtime queries
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn extension_runtime_status(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<Vec<ExtensionRuntimeRecord>, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut records: Vec<_> = guard
        .extensions
        .values()
        .map(ExtRuntimeState::to_record)
        .collect();
    records.sort_by_key(|a| a.id.clone());
    Ok(records)
}

#[tauri::command]
pub async fn extension_runtime_profile(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<Vec<ExtensionProfileRecord>, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut records: Vec<_> = guard
        .extensions
        .values()
        .map(ExtRuntimeState::to_profile)
        .collect();
    records.sort_by(|a, b| {
        b.activation_time_ms
            .cmp(&a.activation_time_ms)
            .then_with(|| b.total_provider_time_ms.cmp(&a.total_provider_time_ms))
    });
    Ok(records)
}

#[tauri::command]
pub async fn extension_slow_extensions(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<Vec<ExtensionProfileRecord>, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut records: Vec<_> = guard
        .extensions
        .values()
        .filter(|e| e.is_slow())
        .map(ExtRuntimeState::to_profile)
        .collect();
    records.sort_by_key(|a| std::cmp::Reverse(a.activation_time_ms));
    Ok(records)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStartupSummary {
    pub startup_complete: bool,
    pub startup_time_ms: Option<u64>,
    pub total_extensions: usize,
    pub activated_count: usize,
    pub failed_count: usize,
    pub slow_count: usize,
    pub total_activation_time_ms: u64,
    pub slowest_extension: Option<String>,
    pub slowest_activation_ms: u64,
}

#[tauri::command]
pub async fn extension_startup_summary(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<ExtensionStartupSummary, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let total = guard.extensions.len();
    let activated = guard
        .extensions
        .values()
        .filter(|e| e.status == ExtensionStatus::Activated)
        .count();
    let failed = guard
        .extensions
        .values()
        .filter(|e| e.status == ExtensionStatus::Failed)
        .count();
    let slow = guard.extensions.values().filter(|e| e.is_slow()).count();
    let total_act_ms: u64 = guard
        .extensions
        .values()
        .filter_map(|e| e.activation_time_ms)
        .sum();

    let (slowest_id, slowest_ms) = guard
        .extensions
        .values()
        .filter_map(|e| e.activation_time_ms.map(|ms| (e.id.clone(), ms)))
        .max_by_key(|(_, ms)| *ms)
        .unwrap_or_default();

    Ok(ExtensionStartupSummary {
        startup_complete: guard.startup_complete,
        startup_time_ms: guard.startup_time_ms,
        total_extensions: total,
        activated_count: activated,
        failed_count: failed,
        slow_count: slow,
        total_activation_time_ms: total_act_ms,
        slowest_extension: if slowest_id.is_empty() {
            None
        } else {
            Some(slowest_id)
        },
        slowest_activation_ms: slowest_ms,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands — bisect
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn extension_bisect_start(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<BisectState, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let ids: Vec<String> = guard
        .extensions
        .values()
        .filter(|e| e.status == ExtensionStatus::Activated)
        .map(|e| e.id.clone())
        .collect();
    if ids.is_empty() {
        return Err("no activated extensions to bisect".to_string());
    }
    guard.bisect.start(ids);
    for ext in guard.extensions.values_mut() {
        ext.disabled_by_bisect = false;
    }
    for id in guard.bisect.current_disabled_set() {
        if let Some(ext) = guard.extensions.get_mut(&id) {
            ext.disabled_by_bisect = true;
        }
    }
    Ok(guard.bisect.to_state())
}

#[tauri::command]
pub async fn extension_bisect_good(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<BisectState, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.bisect.report_good();
    for ext in guard.extensions.values_mut() {
        ext.disabled_by_bisect = false;
    }
    for id in guard.bisect.current_disabled_set() {
        if let Some(ext) = guard.extensions.get_mut(&id) {
            ext.disabled_by_bisect = true;
        }
    }
    Ok(guard.bisect.to_state())
}

#[tauri::command]
pub async fn extension_bisect_bad(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<BisectState, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.bisect.report_bad();
    for ext in guard.extensions.values_mut() {
        ext.disabled_by_bisect = false;
    }
    for id in guard.bisect.current_disabled_set() {
        if let Some(ext) = guard.extensions.get_mut(&id) {
            ext.disabled_by_bisect = true;
        }
    }
    Ok(guard.bisect.to_state())
}

#[tauri::command]
pub async fn extension_bisect_reset(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard.bisect = BisectEngine::new();
    for ext in guard.extensions.values_mut() {
        ext.disabled_by_bisect = false;
    }
    Ok(())
}

#[tauri::command]
pub async fn extension_bisect_state(
    state: State<'_, ExtensionDiagnosticsStore>,
) -> Result<BisectState, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(guard.bisect.to_state())
}
