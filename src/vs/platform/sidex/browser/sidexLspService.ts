/*---------------------------------------------------------------------------------------------
 *  SideX LSP Service
 *  Thin wrapper around the Rust `sidex-lsp` crate via Tauri IPC. Spawns
 *  language servers, forwards JSON-RPC requests, and relays server-sent
 *  notifications as browser events.
 *
 *  Registration note: VS Code does not ship a single "LSP client" service —
 *  language features flow through ILanguageFeaturesService / extension
 *  contributions. This bridge exposes LSP process management as its own
 *  decorator; adapters atop it feed ILanguageFeaturesService providers.
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

export interface LspServerInfo {
	name: string;
	languages: string[];
	command: string;
	args: string[];
}

export interface LspStartArgs {
	languageId?: string;
	command?: string;
	args?: string[];
	rootUri: string;
}

export interface LspStartResult {
	serverId: number;
	capabilities: unknown;
}

export interface LspNotification {
	serverId: number;
	method: string;
	params: unknown;
}

export const ISideXLspService = createDecorator<ISideXLspService>('sidexLspService');

export interface ISideXLspService extends SideXLspService {
	readonly _serviceBrand: undefined;
}

export class SideXLspService {
	declare readonly _serviceBrand: undefined;
	async getServerRegistry(): Promise<LspServerInfo[]> {
		try {
			return (await invoke<LspServerInfo[]>('lsp_get_server_registry')) ?? [];
		} catch {
			return [];
		}
	}

	async getSupportedLanguages(): Promise<string[]> {
		try {
			return (await invoke<string[]>('lsp_get_supported_languages')) ?? [];
		} catch {
			return [];
		}
	}

	async startServer(args: LspStartArgs): Promise<LspStartResult> {
		return await invoke<LspStartResult>('lsp_start_server', { args });
	}

	async sendRequest(serverId: number, method: string, params?: unknown): Promise<unknown> {
		return await invoke<unknown>('lsp_send_request', { serverId, method, params: params ?? null });
	}

	async stopServer(serverId: number): Promise<void> {
		await invoke('lsp_stop_server', { serverId });
	}

	async listServers(): Promise<number[]> {
		try {
			return (await invoke<number[]>('lsp_list_servers')) ?? [];
		} catch {
			return [];
		}
	}

	onNotification(handler: (notification: LspNotification) => void): Promise<() => void> {
		return tauriListen<LspNotification>('lsp-notification', handler);
	}
}

registerSingleton(ISideXLspService, SideXLspService, InstantiationType.Delayed);
