/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri preload bridge.
 *
 * In Electron this ran as a preload script in a sandboxed renderer process,
 * using `contextBridge.exposeInMainWorld('vscode', globals)`.
 *
 * In Tauri the webview can call Rust commands directly via `invoke()` and
 * `listen()`, so we build the same `window.vscode` global object but route
 * everything through the Tauri API.
 */

/* eslint-disable no-restricted-globals */

(function () {

	const { invoke } = (window as any).__TAURI_INTERNALS__ ?? {};
	const tauriInvoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> =
		invoke ?? (async (cmd: string, _args?: Record<string, unknown>) => { throw new Error(`Tauri invoke not available for command: ${cmd}`); });

	type ISandboxConfiguration = import('../common/sandboxTypes.js').ISandboxConfiguration;

	//#region Utilities

	function validateIPC(channel: string): true | never {
		if (!channel?.startsWith('vscode:')) {
			throw new Error(`Unsupported event IPC channel '${channel}'`);
		}

		return true;
	}

	//#endregion

	//#region Event emitter for Tauri → renderer messages

	type ListenerFn = (event: any, ...args: unknown[]) => void;
	const channelListeners = new Map<string, Set<ListenerFn>>();
	let tauriUnlistenPromises: Promise<() => void>[] = [];

	function ensureTauriListener(channel: string): void {
		if (channelListeners.has(channel)) {
			return;
		}
		channelListeners.set(channel, new Set());

		try {
			const { listen } = (window as any).__TAURI_INTERNALS__ ?? {};
			if (listen) {
				const unlistenPromise = listen(channel, (event: { payload: unknown[] }) => {
					const fakeEvent = { sender: globals.ipcRenderer };
					const listeners = channelListeners.get(channel);
					if (listeners) {
						for (const fn of listeners) {
							fn(fakeEvent, ...(Array.isArray(event.payload) ? event.payload : [event.payload]));
						}
					}
				});
				tauriUnlistenPromises.push(unlistenPromise);
			}
		} catch {
			// Tauri listen not available
		}
	}

	//#endregion

	//#region Resolve Configuration

	let configuration: ISandboxConfiguration | undefined = undefined;

	const resolveConfiguration: Promise<ISandboxConfiguration> = (async () => {
		try {
			const resolvedConfiguration: ISandboxConfiguration = configuration = await tauriInvoke('get_window_config') as ISandboxConfiguration;

			const zoomLevel = resolvedConfiguration.zoomLevel ?? 0;
			(document.documentElement.style as any).zoom = String(Math.pow(1.2, zoomLevel));

			return resolvedConfiguration;
		} catch (error) {
			throw new Error(`Preload: unable to fetch window config via Tauri invoke: ${error}`);
		}
	})();

	//#endregion

	//#region Resolve Shell Environment

	const resolveShellEnv: Promise<Record<string, string>> = (async () => {
		const [userEnv, shellEnv] = await Promise.all([
			(async () => (await resolveConfiguration).userEnv)(),
			tauriInvoke('get_shell_env') as Promise<Record<string, string>>
		]);

		return { ...shellEnv, ...userEnv };
	})();

	//#endregion

	//#region Globals Definition

	const globals = {

		ipcRenderer: {

			send(channel: string, ...args: unknown[]): void {
				if (validateIPC(channel)) {
					tauriInvoke('ipc_send', { channel, args }).catch(err =>
						console.error(`[Tauri IPC send] ${channel}:`, err)
					);
				}
			},

			invoke(channel: string, ...args: unknown[]): Promise<unknown> {
				validateIPC(channel);

				return tauriInvoke('ipc_invoke', { channel, args });
			},

			on(channel: string, listener: (event: any, ...args: unknown[]) => void) {
				validateIPC(channel);

				ensureTauriListener(channel);
				channelListeners.get(channel)!.add(listener);

				return this;
			},

			once(channel: string, listener: (event: any, ...args: unknown[]) => void) {
				validateIPC(channel);

				const wrapped = (event: any, ...args: unknown[]) => {
					channelListeners.get(channel)?.delete(wrapped);
					listener(event, ...args);
				};

				ensureTauriListener(channel);
				channelListeners.get(channel)!.add(wrapped);

				return this;
			},

			removeListener(channel: string, listener: (event: any, ...args: unknown[]) => void) {
				validateIPC(channel);

				channelListeners.get(channel)?.delete(listener);

				return this;
			}
		},

		ipcMessagePort: {

			acquire(responseChannel: string, nonce: string) {
				if (validateIPC(responseChannel)) {
					const mc = new MessageChannel();
					window.postMessage(nonce, '*', [mc.port2]);

					tauriInvoke('ipc_acquire_port', { responseChannel, nonce }).catch(err =>
						console.error(`[Tauri IPC acquirePort] ${responseChannel}:`, err)
					);
				}
			}
		},

		webFrame: {

			setZoomLevel(level: number): void {
				if (typeof level === 'number') {
					(document.documentElement.style as any).zoom = String(Math.pow(1.2, level));
				}
			}
		},

		webUtils: {

			getPathForFile(file: File): string {
				return (file as any).path ?? file.name;
			}
		},

		process: {
			get platform() {
				const ua = navigator.userAgent.toLowerCase();
				if (ua.includes('win')) { return 'win32'; }
				if (ua.includes('mac')) { return 'darwin'; }
				return 'linux';
			},
			get arch() {
				return (navigator as any).userAgentData?.architecture ?? 'x64';
			},
			get env() { return {} as Record<string, string | undefined>; },
			get versions() {
				return {
					'tauri': '2.x',
					'chrome': navigator.userAgent.match(/Chrome\/(\S+)/)?.[1] ?? 'unknown',
					'node': 'n/a',
					'v8': 'n/a',
					'electron': 'n/a (Tauri)',
					'microsoft-build': 'n/a',
				} as Record<string, string | undefined>;
			},
			get type() { return 'renderer'; },
			get execPath() { return ''; },

			cwd(): string {
				return '/';
			},

			shellEnv(): Promise<Record<string, string>> {
				return resolveShellEnv;
			},

			getProcessMemoryInfo(): Promise<{ private: number; residentSet: number; shared: number }> {
				if ((performance as any).memory) {
					const mem = (performance as any).memory;
					return Promise.resolve({
						private: Math.round(mem.usedJSHeapSize / 1024),
						residentSet: Math.round(mem.totalJSHeapSize / 1024),
						shared: 0
					});
				}
				return Promise.resolve({ private: 0, residentSet: 0, shared: 0 });
			},

			on(type: string, callback: (...args: unknown[]) => void): void {
				if (type === 'uncaughtException') {
					window.addEventListener('error', (e) => callback(e.error));
				} else if (type === 'unhandledRejection') {
					window.addEventListener('unhandledrejection', (e) => callback(e.reason));
				}
			}
		},

		context: {
			configuration(): ISandboxConfiguration | undefined {
				return configuration;
			},

			async resolveConfiguration(): Promise<ISandboxConfiguration> {
				return resolveConfiguration;
			}
		}
	};

	// Expose on window.vscode — no contextBridge needed in Tauri
	try {
		(window as any).vscode = globals;
	} catch (error) {
		console.error(error);
	}
}());
