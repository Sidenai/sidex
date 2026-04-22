/*---------------------------------------------------------------------------------------------
 *  SideX Task Service
 *  Bridges VS Code's task runner to the Rust `sidex-tasks` crate via Tauri IPC.
 *
 *  Tauri commands exposed:
 *    task_spawn        – spawn a process, returns task_id; streams via task-output / task-exit events
 *    task_kill         – kill a running task by task_id
 *    task_list         – list active task IDs
 *    tasks_detect      – auto-detect npm/cargo/make tasks in a workspace directory
 *    tasks_parse_config – parse .vscode/tasks.json from a workspace directory
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

// ── Tauri event listener shim ──────────────────────────────────────────────────

interface TauriEventWindow {
	__TAURI__?: {
		event?: {
			listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
		};
	};
}

function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
	const w = globalThis as unknown as TauriEventWindow;
	const listen = w.__TAURI__?.event?.listen;
	if (!listen) {
		return Promise.resolve(() => {
			/* no-op outside Tauri */
		});
	}
	return listen<T>(event, e => handler(e.payload));
}

// ── Wire types – mirror the Rust structs in tasks.rs ──────────────────────────

/** Auto-detected task surfaced by `tasks_detect`. */
export interface DetectedTask {
	/** Human-readable label (e.g. `"test"`, `"build"`, `"run --release"`). */
	label: string;
	/** Stringified task type: `"Npm"`, `"Cargo"`, `"Make"`, etc. */
	taskType: string;
	/** Full shell-ready command string. */
	command: string;
	/** Stringified source: `"PackageJson"`, `"Makefile"`, `"CargoToml"`, etc. */
	source: string;
}

/** Task definition parsed from `.vscode/tasks.json` via `tasks_parse_config`. */
export interface TaskDefinition {
	/** Human-readable label. */
	label: string;
	/** Stringified task type. */
	taskType: string;
	/** Base command (without args). */
	command: string;
	/** Argument list. */
	args: string[];
	/** Optional group: `"build"`, `"test"`, `"none"`, etc. */
	group: string | null;
}

/** Parameters accepted by `task_spawn`. */
export interface TaskSpawnOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	/** When `true` (default), the command runs inside the user's shell. */
	shell?: boolean;
}

/** Payload emitted on the `task-output` Tauri event. */
export interface TaskOutputEvent {
	taskId: number;
	data: string;
	/** `"stdout"` or `"stderr"` */
	stream: 'stdout' | 'stderr';
}

/** Payload emitted on the `task-exit` Tauri event. */
export interface TaskExitEvent {
	taskId: number;
	exitCode: number | null;
}

// ── Service decorator ──────────────────────────────────────────────────────────

export const ISideXTaskService = createDecorator<ISideXTaskService>('sidexTaskService');

export interface ISideXTaskService extends SideXTaskService {
	readonly _serviceBrand: undefined;
}

// ── Service implementation ─────────────────────────────────────────────────────

export class SideXTaskService {
	declare readonly _serviceBrand: undefined;

	// ── Process management ───────────────────────────────────────────────────

	/**
	 * Spawn a task process. Returns the opaque `taskId` assigned by the Rust
	 * backend. stdout/stderr are delivered via `onOutput`; process exit via
	 * `onExit`. The caller is responsible for removing its listeners.
	 */
	async spawn(options: TaskSpawnOptions): Promise<number> {
		return invoke<number>('task_spawn', {
			command: options.command,
			args: options.args ?? null,
			cwd: options.cwd ?? null,
			env: options.env ?? null,
			shell: options.shell ?? null
		});
	}

	/**
	 * Kill a running task by its `taskId`. Resolves when the process has been
	 * signalled; the `task-exit` event will still fire shortly after.
	 */
	async kill(taskId: number): Promise<void> {
		await invoke('task_kill', { taskId });
	}

	/**
	 * Return the IDs of all currently running task processes.
	 */
	async list(): Promise<number[]> {
		try {
			return (await invoke<number[]>('task_list')) ?? [];
		} catch {
			return [];
		}
	}

	// ── Discovery ────────────────────────────────────────────────────────────

	/**
	 * Auto-detect npm scripts, Cargo targets, and Makefile targets present in
	 * `workspace`. Returns an empty array when nothing is found or the call
	 * fails (detection errors are logged on the Rust side).
	 */
	async detect(workspace: string): Promise<DetectedTask[]> {
		try {
			return (await invoke<DetectedTask[]>('tasks_detect', { workspace })) ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * Parse `.vscode/tasks.json` from `workspace`. Returns an empty array when
	 * the file does not exist or cannot be parsed.
	 */
	async parseConfig(workspace: string): Promise<TaskDefinition[]> {
		try {
			return (await invoke<TaskDefinition[]>('tasks_parse_config', { workspace })) ?? [];
		} catch {
			return [];
		}
	}

	// ── Event streams ────────────────────────────────────────────────────────

	/**
	 * Subscribe to stdout/stderr output from all running tasks.
	 * Returns an unlisten function; call it to stop receiving events.
	 *
	 * @example
	 * const unlisten = await taskService.onOutput(evt => {
	 *   if (evt.taskId === myId) terminal.write(evt.data);
	 * });
	 * // later: unlisten();
	 */
	onOutput(handler: (event: TaskOutputEvent) => void): Promise<() => void> {
		return tauriListen<TaskOutputEvent>('task-output', handler);
	}

	/**
	 * Subscribe to process-exit notifications for all running tasks.
	 * Returns an unlisten function.
	 */
	onExit(handler: (event: TaskExitEvent) => void): Promise<() => void> {
		return tauriListen<TaskExitEvent>('task-exit', handler);
	}

	// ── Convenience helpers ──────────────────────────────────────────────────

	/**
	 * Spawn a task and collect its complete output. Resolves with the combined
	 * output string and exit code once the process terminates.
	 *
	 * Use only for short-lived tasks where buffering the full output in memory
	 * is acceptable. For long-running processes prefer `spawn` + `onOutput`.
	 */
	async run(options: TaskSpawnOptions): Promise<{ output: string; exitCode: number | null }> {
		const taskId = await this.spawn(options);
		const chunks: string[] = [];

		return new Promise(async resolve => {
			const unlistenOutput = await this.onOutput(evt => {
				if (evt.taskId === taskId) {
					chunks.push(evt.data);
				}
			});

			const unlistenExit = await this.onExit(evt => {
				if (evt.taskId === taskId) {
					unlistenOutput();
					unlistenExit();
					resolve({ output: chunks.join(''), exitCode: evt.exitCode });
				}
			});
		});
	}
}

registerSingleton(ISideXTaskService, SideXTaskService, InstantiationType.Delayed);
