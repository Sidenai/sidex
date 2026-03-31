/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listen, emit, type UnlistenFn, type Event as TauriEvent } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { onUnexpectedError } from '../../../common/errors.js';
import { Event } from '../../../common/event.js';

/**
 * Tauri-side equivalent of Electron's IpcMainEvent. Carries
 * the Tauri event payload and a synthetic `sender` that can
 * reply via Tauri's emit().
 */
export interface TauriIpcEvent {
	sender: {
		id: number;
		send: (channel: string, ...args: unknown[]) => void;
	};
	senderFrame?: { url?: string; parent: unknown | null };
}

type ipcMainListener = (event: TauriIpcEvent, ...args: any[]) => void;

function buildTauriIpcEvent(tauriEvent: TauriEvent<unknown>): TauriIpcEvent {
	const windowLabel = (tauriEvent as any).windowLabel ?? 'main';
	const senderId = typeof windowLabel === 'string' ? windowLabel.charCodeAt(0) : 0;

	return {
		sender: {
			id: senderId,
			send: (channel: string, ...args: unknown[]) => {
				emit(channel, { args, target: windowLabel }).catch(err =>
					onUnexpectedError(`Failed to emit reply on channel '${channel}': ${err}`)
				);
			},
		},
		senderFrame: { url: undefined, parent: null },
	};
}

class ValidatedIpcMain implements Event.NodeEventEmitter {

	private readonly mapListenerToUnlisten = new WeakMap<ipcMainListener, UnlistenFn>();
	private readonly handlerUnlistenMap = new Map<string, UnlistenFn>();

	on(channel: string, listener: ipcMainListener): this {
		if (!this.validateChannel(channel)) {
			return this;
		}

		listen<unknown[]>(channel, (tauriEvent) => {
			const ipcEvent = buildTauriIpcEvent(tauriEvent);
			const args = Array.isArray(tauriEvent.payload) ? tauriEvent.payload : [tauriEvent.payload];
			listener(ipcEvent, ...args);
		}).then(unlisten => {
			this.mapListenerToUnlisten.set(listener, unlisten);
		}).catch(err => onUnexpectedError(`Failed to listen on channel '${channel}': ${err}`));

		return this;
	}

	once(channel: string, listener: ipcMainListener): this {
		if (!this.validateChannel(channel)) {
			return this;
		}

		let unlistenFn: UnlistenFn | undefined;
		listen<unknown[]>(channel, (tauriEvent) => {
			const ipcEvent = buildTauriIpcEvent(tauriEvent);
			const args = Array.isArray(tauriEvent.payload) ? tauriEvent.payload : [tauriEvent.payload];
			listener(ipcEvent, ...args);
			unlistenFn?.();
		}).then(unlisten => {
			unlistenFn = unlisten;
		}).catch(err => onUnexpectedError(`Failed to listen (once) on channel '${channel}': ${err}`));

		return this;
	}

	/**
	 * Registers a handler for an invokable IPC channel. In Tauri the frontend
	 * calls `invoke(channel, args)` which routes to a Rust command. This shim
	 * listens for a `${channel}:request` event, calls the handler, and emits
	 * the result back on `${channel}:response`.
	 */
	handle(channel: string, listener: (event: TauriIpcEvent, ...args: any[]) => Promise<unknown>): this {
		if (!this.validateChannel(channel)) {
			return this;
		}

		const requestChannel = `${channel}:request`;
		const responseChannel = `${channel}:response`;

		listen<{ requestId: string; args: unknown[] }>(requestChannel, async (tauriEvent) => {
			const ipcEvent = buildTauriIpcEvent(tauriEvent);
			const payload = tauriEvent.payload;
			const requestId = payload?.requestId ?? '';
			const args = Array.isArray(payload?.args) ? payload.args : [];

			try {
				const result = await listener(ipcEvent, ...args);
				await emit(responseChannel, { requestId, result });
			} catch (err) {
				await emit(responseChannel, { requestId, error: String(err) });
			}
		}).then(unlisten => {
			this.handlerUnlistenMap.set(channel, unlisten);
		}).catch(err => onUnexpectedError(`Failed to register handle for channel '${channel}': ${err}`));

		return this;
	}

	removeHandler(channel: string): this {
		const unlisten = this.handlerUnlistenMap.get(channel);
		if (unlisten) {
			unlisten();
			this.handlerUnlistenMap.delete(channel);
		}

		return this;
	}

	removeListener(channel: string, listener: ipcMainListener): this {
		const unlisten = this.mapListenerToUnlisten.get(listener);
		if (unlisten) {
			unlisten();
			this.mapListenerToUnlisten.delete(listener);
		}

		return this;
	}

	private validateChannel(channel: string): boolean {
		if (!channel?.startsWith('vscode:')) {
			onUnexpectedError(`Refused to handle ipcMain event for channel '${channel}' because the channel is unknown.`);
			return false;
		}
		return true;
	}
}

/**
 * A drop-in replacement of `ipcMain` that validates the sender of a message.
 * In the Tauri port this uses Tauri's event system (`listen` / `emit`)
 * instead of Electron's ipcMain.
 *
 * @deprecated direct use of Tauri IPC events is not encouraged. We have utilities
 * in place to create services on top of IPC, see `ProxyChannel` for more information.
 */
export const validatedIpcMain = new ValidatedIpcMain();
