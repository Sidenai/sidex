/*---------------------------------------------------------------------------------------------
 *  Sidex Orchestrator Service — Drives multi-agent task graph via Tauri IPC
 *
 *  The heavy lifting (WebSocket sessions, concurrency, cancellation) lives in
 *  the Rust backend. This service is a thin coordinator that:
 *  1. Calls Tauri commands to create plans, spawn tasks, cancel
 *  2. Listens to `orch-event` Tauri events for real-time streaming
 *  3. Maintains local task graph state for the UI
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import {
	type TaskNode,
	type TaskHandoff,
	type OrchestrationPlan,
	type OrchestratorEvent,
	type OrchestratorConfig,
	DEFAULT_ORCHESTRATOR_CONFIG,
} from './types.js';

export type OrchestratorState = 'idle' | 'planning' | 'running' | 'converging' | 'complete' | 'cancelled';

interface TauriGlobals {
	__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
	__TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

interface TauriEventApi {
	listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
}

function getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	const g = globalThis as unknown as TauriGlobals;
	return g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke ?? null;
}

function getTauriEvent(): TauriEventApi | null {
	const g = globalThis as unknown as { __TAURI_INTERNALS__?: { event: TauriEventApi } };
	return g.__TAURI_INTERNALS__?.event ?? null;
}

export class SidexOrchestrator extends Disposable {
	private _plan: OrchestrationPlan | null = null;
	private _state: OrchestratorState = 'idle';
	private _config: OrchestratorConfig;
	private _startTime = 0;
	private _unlisten: (() => void) | null = null;
	private _loopRunning = false;
	private _cancelled = false;

	private readonly _onEvent = this._register(new Emitter<OrchestratorEvent>());
	readonly onEvent: Event<OrchestratorEvent> = this._onEvent.event;

	private readonly _onStateChange = this._register(new Emitter<OrchestratorState>());
	readonly onStateChange: Event<OrchestratorState> = this._onStateChange.event;

	get plan(): OrchestrationPlan | null { return this._plan; }
	get state(): OrchestratorState { return this._state; }

	constructor(config?: Partial<OrchestratorConfig>) {
		super();
		this._config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
	}

	async orchestrate(goal: string, serverUrl: string, workspace: string): Promise<void> {
		const invoke = getInvoke();
		if (!invoke) {
			this._emit({ type: 'error', error: 'Tauri IPC not available', recoverable: false });
			return;
		}

		this._cancelled = false;
		this._startTime = Date.now();
		this._setState('planning');

		await this._listenToEvents();

		try {
			const plan = await invoke('orch_start', {
				goal,
				workspace,
				config: {
					max_parallel_workers: this._config.maxParallelWorkers,
					max_parallel_verifiers: this._config.maxParallelVerifiers,
					auto_verify: this._config.autoVerify,
					planner_model: this._config.plannerModel,
					worker_model: this._config.workerModel,
					verifier_model: this._config.verifierModel,
					timeout_ms: this._config.timeoutMs,
					max_retries: this._config.maxRetries,
				},
			}) as OrchestrationPlan;

			this._plan = plan;
			this._emit({ type: 'plan', plan });
			this._setState('running');

			// Request the server to decompose the goal into tasks
			await this._requestPlanning(invoke, goal, serverUrl);

			// Drive the task loop
			await this._driveLoop(invoke, serverUrl);

		} catch (err) {
			this._emit({
				type: 'error',
				error: `Orchestration failed: ${err}`,
				recoverable: false,
			});
			this._setState('cancelled');
		}
	}

	async cancel(reason = 'User cancelled'): Promise<void> {
		this._cancelled = true;
		const invoke = getInvoke();
		if (invoke && this._plan) {
			await invoke('orch_cancel', { planId: this._plan.id }).catch(() => { });
		}
		this._setState('cancelled');
		this._emit({ type: 'cancelled', reason });
		this._cleanup();
	}

	private async _requestPlanning(
		invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
		goal: string,
		serverUrl: string,
	): Promise<void> {
		if (!this._plan) { return; }

		// Use the chat server to generate a task decomposition
		const plannerTask: TaskNode = {
			id: `${this._plan.id}-planner`,
			name: 'planner',
			type: 'planner',
			status: 'pending',
			scopedGoal: goal,
			parentId: null,
			pathsAllowed: [],
			pathsForbidden: [],
			dependsOn: [],
			verifies: null,
			acceptance: [],
			agentRunId: null,
			branch: null,
			startedAt: null,
			completedAt: null,
			attempts: 0,
			maxAttempts: 1,
			measurements: [],
		};

		await invoke('orch_add_tasks', {
			planId: this._plan.id,
			tasks: [this._toRustTask(plannerTask)],
		});

		await invoke('orch_spawn_task', {
			planId: this._plan.id,
			taskId: plannerTask.id,
			serverUrl,
		});

		// Wait for the planner to produce tasks
		await this._waitForTaskCompletion(plannerTask.id, 120_000);
	}

	private async _driveLoop(
		invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
		serverUrl: string,
	): Promise<void> {
		if (this._loopRunning) { return; }
		this._loopRunning = true;

		while (!this._cancelled && this._plan) {
			const ready = await invoke('orch_get_ready_tasks', {
				planId: this._plan.id,
			}) as Array<{ id: string; task_type: string }>;

			if (ready.length === 0) {
				const status = await invoke('orch_status', { planId: this._plan.id }) as { status: string; tasks: Array<{ status: string }> };
				const running = status.tasks.filter(t => t.status === 'running').length;
				if (running === 0) { break; }
			}

			// Spawn ready tasks (respecting concurrency limits)
			const workers = ready.filter(t => t.task_type === 'worker' || t.task_type === 'subplanner');
			const verifiers = ready.filter(t => t.task_type === 'verifier');

			for (const task of workers.slice(0, this._config.maxParallelWorkers)) {
				await invoke('orch_spawn_task', {
					planId: this._plan.id,
					taskId: task.id,
					serverUrl,
				}).catch(() => { });
			}

			for (const task of verifiers.slice(0, this._config.maxParallelVerifiers)) {
				await invoke('orch_spawn_task', {
					planId: this._plan.id,
					taskId: task.id,
					serverUrl,
				}).catch(() => { });
			}

			// Wait a bit before polling again
			await new Promise(r => setTimeout(r, 5000));

			// Refresh plan state
			const updated = await invoke('orch_status', { planId: this._plan.id }) as OrchestrationPlan;
			this._plan = updated;
			this._emitProgress();
		}

		this._loopRunning = false;

		if (!this._cancelled) {
			this._finalize();
		}
	}

	private async _listenToEvents(): Promise<void> {
		const eventApi = getTauriEvent();
		if (!eventApi) { return; }

		const unlisten = await eventApi.listen('orch-event', (e) => {
			const payload = e.payload as { event_type: string; plan_id: string; task_id?: string; data: Record<string, unknown> };
			if (this._plan && payload.plan_id !== this._plan.id) { return; }
			this._handleBackendEvent(payload);
		});

		this._unlisten = unlisten;
	}

	private _handleBackendEvent(payload: { event_type: string; task_id?: string; data: Record<string, unknown> }): void {
		switch (payload.event_type) {
			case 'task_text':
				this._emit({
					type: 'task_text',
					taskId: payload.task_id || '',
					text: (payload.data.content as string) || '',
				});
				break;
			case 'task_tool_call':
				this._emit({
					type: 'task_tool_call',
					taskId: payload.task_id || '',
					callId: '',
					toolName: (payload.data.tool_name as string) || '',
					status: (payload.data.status as 'running' | 'completed' | 'error') || 'running',
				});
				break;
			case 'task_spawned':
				this._emit({
					type: 'task_status',
					taskId: payload.task_id || '',
					taskName: payload.task_id || '',
					status: 'running',
				});
				break;
			case 'task_complete':
				this._emit({
					type: 'task_status',
					taskId: payload.task_id || '',
					taskName: payload.task_id || '',
					status: 'completed',
				});
				if (payload.data) {
					this._emit({
						type: 'handoff',
						handoff: payload.data as unknown as TaskHandoff,
					});
				}
				break;
			case 'task_error':
				this._emit({
					type: 'error',
					taskId: payload.task_id,
					error: (payload.data.error as string) || 'Unknown error',
					recoverable: true,
				});
				break;
			case 'cancelled':
				this._cancelled = true;
				this._emit({
					type: 'cancelled',
					reason: (payload.data.reason as string) || 'Cancelled',
				});
				break;
		}
	}

	private _waitForTaskCompletion(taskId: string, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			const disposable = this.onEvent((event) => {
				if (event.type === 'task_status' && 'taskId' in event && event.taskId === taskId) {
					if (event.status === 'completed' || event.status === 'failed') {
						clearTimeout(timer);
						disposable.dispose();
						resolve();
					}
				}
			});
		});
	}

	private _toRustTask(task: TaskNode): Record<string, unknown> {
		return {
			id: task.id,
			name: task.name,
			task_type: task.type,
			scoped_goal: task.scopedGoal,
			status: task.status,
			depends_on: task.dependsOn,
			verifies: task.verifies,
			acceptance: task.acceptance,
			paths_allowed: task.pathsAllowed,
			paths_forbidden: task.pathsForbidden,
			branch: task.branch,
			attempts: task.attempts,
			max_attempts: task.maxAttempts,
		};
	}

	private _finalize(): void {
		if (!this._plan) { return; }
		this._setState('complete');
		this._emit({
			type: 'complete',
			plan: this._plan,
			handoffs: [],
			totalElapsedMs: Date.now() - this._startTime,
		});
		this._cleanup();
	}

	private _emitProgress(): void {
		if (!this._plan) { return; }
		const completed = this._plan.tasks.filter((t: { status: string }) => t.status === 'completed').length;
		const running = this._plan.tasks.filter((t: { status: string }) => t.status === 'running').map((t: { id: string }) => t.id);
		this._emit({
			type: 'progress',
			completedTasks: completed,
			totalTasks: this._plan.tasks.length,
			runningTasks: running,
			elapsedMs: Date.now() - this._startTime,
		});
	}

	private _setState(state: OrchestratorState): void {
		this._state = state;
		this._onStateChange.fire(state);
	}

	private _emit(event: OrchestratorEvent): void {
		this._onEvent.fire(event);
	}

	private _cleanup(): void {
		if (this._unlisten) {
			try { this._unlisten(); } catch { /* ignore tauri unlisten error during hmr */ }
			this._unlisten = null;
		}
	}

	override dispose(): void {
		this._cleanup();
		super.dispose();
	}
}
