/*---------------------------------------------------------------------------------------------
 *  Tauri Debug Adapter — replaces Node.js ExecutableDebugAdapter for SideX.
 *  Spawns debug adapter processes via Tauri IPC and communicates over the
 *  DAP wire protocol (Content-Length header framing over stdin/stdout).
 *--------------------------------------------------------------------------------------------*/

import { AbstractDebugAdapter } from '../common/abstractDebugAdapter.js';
import { IDebugAdapterExecutable } from '../common/debug.js';

declare function __TAURI_INVOKE__(cmd: string, args?: Record<string, unknown>): Promise<unknown>;

interface TauriWindow {
	__TAURI__?: {
		core?: {
			invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
		};
		event?: {
			listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
		};
	};
}

function getTauriInvoke(): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
	const w = globalThis as unknown as TauriWindow;
	if (w.__TAURI__?.core?.invoke) {
		return w.__TAURI__.core.invoke;
	}
	if (typeof __TAURI_INVOKE__ === 'function') {
		return __TAURI_INVOKE__;
	}
	throw new Error('Tauri IPC not available');
}

function getTauriListen(): (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> {
	const w = globalThis as unknown as TauriWindow;
	if (w.__TAURI__?.event?.listen) {
		return w.__TAURI__.event.listen;
	}
	throw new Error('Tauri event listener not available');
}

const TWO_CRLF = '\r\n\r\n';
const HEADER_LINE_SEP = /\r?\n/;
const HEADER_FIELD_SEP = /: */;

/**
 * A debug adapter that spawns the debug adapter process through Tauri's Rust
 * backend and communicates via the DAP wire protocol over stdin/stdout piping.
 */
export class TauriExecutableDebugAdapter extends AbstractDebugAdapter {
	private adapterId: number | undefined;
	private rawData = '';
	private contentLength = -1;
	private unlistenOutput: (() => void) | undefined;
	private unlistenError: (() => void) | undefined;
	private unlistenExit: (() => void) | undefined;

	constructor(
		private readonly adapterExecutable: IDebugAdapterExecutable,
		private readonly debugType: string
	) {
		super();
	}

	async startSession(): Promise<void> {
		const invoke = getTauriInvoke();
		const listen = getTauriListen();

		const { command, args, options } = this.adapterExecutable;

		const adapterId = (await invoke('debug_spawn_adapter', {
			executable: command,
			args: args ?? [],
			cwd: options?.cwd ?? null,
			env: options?.env ?? null
		})) as number;

		this.adapterId = adapterId;

		this.unlistenOutput = await listen('debug-output', event => {
			const payload = event.payload as { adapter_id: number; data: string };
			if (payload.adapter_id === adapterId) {
				this.handleData(payload.data);
			}
		});

		this.unlistenError = await listen('debug-error', event => {
			const payload = event.payload as { adapter_id: number; data: string };
			if (payload.adapter_id === adapterId) {
				this._onError.fire(new Error(payload.data));
			}
		});

		this.unlistenExit = await listen('debug-exit', event => {
			const payload = event.payload as { adapter_id: number; exit_code: number | null };
			if (payload.adapter_id === adapterId) {
				this._onExit.fire(payload.exit_code);
			}
		});
	}

	sendMessage(message: DebugProtocol.ProtocolMessage): void {
		if (this.adapterId === undefined) {
			return;
		}

		const json = JSON.stringify(message);
		const byteLength = new TextEncoder().encode(json).length;
		const wire = `Content-Length: ${byteLength}${TWO_CRLF}${json}`;

		const invoke = getTauriInvoke();
		invoke('debug_send', {
			adapterId: this.adapterId,
			data: wire
		}).catch((err: unknown) => {
			this._onError.fire(new Error(String(err)));
		});
	}

	async stopSession(): Promise<void> {
		await this.cancelPendingRequests();

		if (this.unlistenOutput) {
			this.unlistenOutput();
			this.unlistenOutput = undefined;
		}
		if (this.unlistenError) {
			this.unlistenError();
			this.unlistenError = undefined;
		}
		if (this.unlistenExit) {
			this.unlistenExit();
			this.unlistenExit = undefined;
		}

		if (this.adapterId !== undefined) {
			const invoke = getTauriInvoke();
			try {
				await invoke('debug_kill', { adapterId: this.adapterId });
			} catch {
				// adapter may have already exited
			}
			this.adapterId = undefined;
		}
	}

	private handleData(data: string): void {
		this.rawData += data;

		while (true) {
			if (this.contentLength >= 0) {
				if (this.rawData.length >= this.contentLength) {
					const message = this.rawData.substring(0, this.contentLength);
					this.rawData = this.rawData.substring(this.contentLength);
					this.contentLength = -1;
					if (message.length > 0) {
						try {
							this.acceptMessage(JSON.parse(message) as DebugProtocol.ProtocolMessage);
						} catch (e: unknown) {
							this._onError.fire(new Error(((e as Error).message || e) + '\n' + message));
						}
					}
					continue;
				}
			} else {
				const idx = this.rawData.indexOf(TWO_CRLF);
				if (idx !== -1) {
					const header = this.rawData.substring(0, idx);
					const lines = header.split(HEADER_LINE_SEP);
					for (const h of lines) {
						const kvPair = h.split(HEADER_FIELD_SEP);
						if (kvPair[0] === 'Content-Length') {
							this.contentLength = Number(kvPair[1]);
						}
					}
					this.rawData = this.rawData.substring(idx + TWO_CRLF.length);
					continue;
				}
			}
			break;
		}
	}

	override dispose(): void {
		this.stopSession().catch(() => {
			/* ignore */
		});
		super.dispose();
	}
}

/**
 * A debug adapter that connects to an already-running debug adapter server
 * via WebSocket. Used for IDebugAdapterServer descriptors in Tauri where
 * raw TCP sockets are not available from the browser context.
 */
export class TauriSocketDebugAdapter extends AbstractDebugAdapter {
	private ws: WebSocket | undefined;
	private rawData = '';
	private contentLength = -1;

	constructor(
		private readonly port: number,
		private readonly host: string = '127.0.0.1'
	) {
		super();
	}

	async startSession(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = `ws://${this.host}:${this.port}`;
			this.ws = new WebSocket(url);

			this.ws.onopen = () => {
				resolve();
			};

			this.ws.onmessage = event => {
				if (typeof event.data === 'string') {
					this.handleData(event.data);
				}
			};

			this.ws.onerror = _event => {
				const err = new Error(`WebSocket error connecting to debug adapter at ${url}`);
				this._onError.fire(err);
				reject(err);
			};

			this.ws.onclose = () => {
				this._onExit.fire(0);
			};
		});
	}

	sendMessage(message: DebugProtocol.ProtocolMessage): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}
		const json = JSON.stringify(message);
		const byteLength = new TextEncoder().encode(json).length;
		this.ws.send(`Content-Length: ${byteLength}${TWO_CRLF}${json}`);
	}

	async stopSession(): Promise<void> {
		await this.cancelPendingRequests();
		if (this.ws) {
			this.ws.close();
			this.ws = undefined;
		}
	}

	private handleData(data: string): void {
		this.rawData += data;

		while (true) {
			if (this.contentLength >= 0) {
				if (this.rawData.length >= this.contentLength) {
					const message = this.rawData.substring(0, this.contentLength);
					this.rawData = this.rawData.substring(this.contentLength);
					this.contentLength = -1;
					if (message.length > 0) {
						try {
							this.acceptMessage(JSON.parse(message) as DebugProtocol.ProtocolMessage);
						} catch (e: unknown) {
							this._onError.fire(new Error(((e as Error).message || e) + '\n' + message));
						}
					}
					continue;
				}
			} else {
				const idx = this.rawData.indexOf(TWO_CRLF);
				if (idx !== -1) {
					const header = this.rawData.substring(0, idx);
					const lines = header.split(HEADER_LINE_SEP);
					for (const h of lines) {
						const kvPair = h.split(HEADER_FIELD_SEP);
						if (kvPair[0] === 'Content-Length') {
							this.contentLength = Number(kvPair[1]);
						}
					}
					this.rawData = this.rawData.substring(idx + TWO_CRLF.length);
					continue;
				}
			}
			break;
		}
	}
}
