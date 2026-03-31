/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri auxiliary window preload bridge.
 *
 * Provides a minimal `window.vscode` with `ipcRenderer.send/invoke` and
 * `webFrame.setZoomLevel` for auxiliary (non-main) windows.
 */

(function () {

	const { invoke } = (window as any).__TAURI_INTERNALS__ ?? {};
	const tauriInvoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> =
		invoke ?? (async (cmd: string, _args?: Record<string, unknown>) => { throw new Error(`Tauri invoke not available for command: ${cmd}`); });

	function validateIPC(channel: string): true | never {
		if (!channel?.startsWith('vscode:')) {
			throw new Error(`Unsupported event IPC channel '${channel}'`);
		}

		return true;
	}

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
			}
		},

		webFrame: {

			setZoomLevel(level: number): void {
				if (typeof level === 'number') {
					(document.documentElement.style as any).zoom = String(Math.pow(1.2, level));
				}
			}
		}
	};

	try {
		(window as any).vscode = globals;
	} catch (error) {
		console.error(error);
	}
}());
