/*---------------------------------------------------------------------------------------------
 *  SideX DAP Service
 *  Thin wrapper around the Rust `sidex-dap` crate via Tauri IPC. Exposes the
 *  high-level debug client (launch/request/stop) and adapter registry
 *  metadata. For the low-level DAP wire-protocol adapter used by the VS Code
 *  debug infrastructure see `contrib/debug/tauri/tauriDebugAdapter.ts`.
 *
 *  Registration note: VS Code's IDebugService is a rich debug session manager
 *  that is not replaced here. This bridge is exposed via its own decorator
 *  for use by adapter factories and debug UI extensions.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

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
			/* no-op */
		});
	}
	return listen<T>(event, e => handler(e.payload));
}

export interface DebugAdapterInfo {
	typeName: string;
	command: string;
	args: string[];
	runtime: string | null;
	commandLine: string;
}

export interface DapLaunchConfig {
	name: string;
	debugType: string;
	request: string;
	program?: string | null;
	args: string[];
	cwd?: string | null;
	env: Record<string, string>;
	console?: string | null;
	preLaunchTask?: string | null;
	postDebugTask?: string | null;
	extra: Record<string, unknown>;
}

export interface DapCompoundLaunchConfig {
	name: string;
	configurations: string[];
	stopAll: boolean;
	preLaunchTask?: string | null;
}

export interface DapLaunchConfigResponse {
	configs: DapLaunchConfig[];
	compounds: DapCompoundLaunchConfig[];
}

export interface DapStartResult {
	adapterId: number;
	capabilities: Record<string, unknown>;
}

export interface DapEventPayload {
	adapterId: number;
	event: unknown;
}

export const ISideXDapService = createDecorator<ISideXDapService>('sidexDapService');

export interface ISideXDapService extends SideXDapService {
	readonly _serviceBrand: undefined;
}

export class SideXDapService {
	declare readonly _serviceBrand: undefined;
	async getAdapterRegistry(): Promise<DebugAdapterInfo[]> {
		try {
			return (await invoke<DebugAdapterInfo[]>('dap_get_adapter_registry')) ?? [];
		} catch {
			return [];
		}
	}

	async getLaunchConfigs(workspace: string): Promise<DapLaunchConfigResponse> {
		try {
			return (
				(await invoke<DapLaunchConfigResponse>('dap_get_launch_configs', { workspace })) ?? {
					configs: [],
					compounds: []
				}
			);
		} catch {
			return { configs: [], compounds: [] };
		}
	}

	async startAdapter(typeName: string, config: DapLaunchConfig): Promise<DapStartResult> {
		return await invoke<DapStartResult>('dap_start_adapter', { typeName, config });
	}

	async sendRequest(adapterId: number, command: string, args?: unknown): Promise<unknown> {
		return await invoke<unknown>('dap_send_request', {
			adapterId,
			command,
			arguments: args ?? null
		});
	}

	async stopAdapter(adapterId: number): Promise<void> {
		await invoke('dap_stop_adapter', { adapterId });
	}

	onEvent(handler: (event: DapEventPayload) => void): Promise<() => void> {
		return tauriListen<DapEventPayload>('dap-event', handler);
	}
}

registerSingleton(ISideXDapService, SideXDapService, InstantiationType.Delayed);
