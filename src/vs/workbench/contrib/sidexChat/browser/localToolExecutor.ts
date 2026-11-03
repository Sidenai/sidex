/*---------------------------------------------------------------------------------------------
 *  Local tool executor — delegates tool execution to the Rust sidex-agent crate
 *  via Tauri IPC invoke(). The entire tool implementation (file I/O, search,
 *  shell, git) runs natively in Rust. This TS file is just the bridge.
 *--------------------------------------------------------------------------------------------*/

export interface ILocalToolRequest {
	type: 'tool_request';
	tool_call_id: string;
	name: string;
	arguments: string;
}

export interface ILocalToolResponse {
	type: 'tool_response';
	tool_call_id: string;
	output: string;
	error: string;
}

export interface ILocalToolContext {
	cwd: string;
	token?: string;
	onProgress?: (event: { name: string; status: 'running' | 'done' | 'error'; detail?: string }) => void;
}

// Tauri invoke is available globally in the webview via @tauri-apps/api
 
declare function __TAURI_INVOKE__(cmd: string, args?: Record<string, unknown>): Promise<any>;

interface RustToolResponse {
	tool_call_id: string;
	output: string;
	error: string;
}

// Check if Tauri invoke is available (we're in the desktop app, not a browser)
function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
	const g = globalThis as unknown as {
		__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
		__TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
	};
	if (typeof g.__TAURI_INVOKE__ === 'function') {
		return g.__TAURI_INVOKE__;
	}
	if (g.__TAURI_INTERNALS__?.invoke) {
		return g.__TAURI_INTERNALS__.invoke;
	}
	return null;
}

/** True when the Rust agent crate is reachable via Tauri IPC. */
export function LOCAL_TOOLS_SUPPORTED(): boolean {
	return getTauriInvoke() !== null;
}

export class LocalToolExecutor {
	constructor(private readonly getContext: () => ILocalToolContext) {}

	async execute(req: ILocalToolRequest): Promise<ILocalToolResponse> {
		const invoke = getTauriInvoke();
		if (!invoke) {
			return {
				type: 'tool_response',
				tool_call_id: req.tool_call_id,
				output: '',
				error: 'local tool execution unavailable (Tauri IPC not reachable)',
			};
		}

		const ctx = this.getContext();
		ctx.onProgress?.({ name: req.name, status: 'running' });

		try {
			const result = await invoke('agent_execute_tool', {
				request: {
					tool_call_id: req.tool_call_id,
					name: req.name,
					arguments: req.arguments || '{}',
					cwd: ctx.cwd,
					token: ctx.token || "",
				},
			}) as RustToolResponse;

			const status = result.error ? 'error' : 'done';
			ctx.onProgress?.({ name: req.name, status, detail: result.error || undefined });

			return {
				type: 'tool_response',
				tool_call_id: result.tool_call_id,
				output: result.output,
				error: result.error,
			};
		} catch (e) {
			const msg = (e as Error).message || String(e);
			ctx.onProgress?.({ name: req.name, status: 'error', detail: msg });
			return {
				type: 'tool_response',
				tool_call_id: req.tool_call_id,
				output: '',
				error: msg,
			};
		}
	}
}
