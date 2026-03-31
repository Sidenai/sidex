/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listen, emit, type UnlistenFn, type Event as TauriEvent } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/window';
import { validatedIpcMain, type TauriIpcEvent } from './ipcMain.js';
import { Event } from '../../../common/event.js';
import { IDisposable } from '../../../common/lifecycle.js';
import { generateUuid } from '../../../common/uuid.js';
import { Client as MessagePortClient, MessagePort as IMessagePort, MessageEvent as IMessageEvent } from '../common/ipc.mp.js';

/**
 * A Tauri-based MessagePort shim. Instead of using Electron's MessagePortMain,
 * this routes messages through Tauri's event system using a unique channel
 * pair identified by a `portId`.
 */
class TauriMessagePort implements IMessagePort {
	private readonly sendChannel: string;
	private readonly receiveChannel: string;
	private unlistenFn: UnlistenFn | undefined;
	private listener: ((this: IMessagePort, e: IMessageEvent) => unknown) | undefined;
	private started = false;

	constructor(private readonly portId: string, private readonly direction: 'a' | 'b') {
		this.sendChannel = `vscode:mp:${portId}:${direction === 'a' ? 'a2b' : 'b2a'}`;
		this.receiveChannel = `vscode:mp:${portId}:${direction === 'a' ? 'b2a' : 'a2b'}`;
	}

	addEventListener(type: 'message', listener: (this: IMessagePort, e: IMessageEvent) => unknown): void {
		this.listener = listener;
		if (this.started) {
			this.attachListener();
		}
	}

	removeEventListener(_type: 'message', _listener: (this: IMessagePort, e: IMessageEvent) => unknown): void {
		this.listener = undefined;
		this.unlistenFn?.();
		this.unlistenFn = undefined;
	}

	postMessage(message: Uint8Array): void {
		emit(this.sendChannel, { data: Array.from(message) }).catch(() => {
			// system going down
		});
	}

	start(): void {
		this.started = true;
		if (this.listener) {
			this.attachListener();
		}
	}

	close(): void {
		this.started = false;
		this.unlistenFn?.();
		this.unlistenFn = undefined;
		this.listener = undefined;
	}

	private attachListener(): void {
		this.unlistenFn?.();
		const currentListener = this.listener;
		listen<{ data: number[] }>(this.receiveChannel, (event) => {
			if (currentListener) {
				const payload = event.payload;
				const data = payload?.data ? new Uint8Array(payload.data) : new Uint8Array(0);
				currentListener.call(this, { data });
			}
		}).then(unlisten => {
			this.unlistenFn = unlisten;
		});
	}
}

/**
 * Creates a linked pair of TauriMessagePort instances that can
 * communicate bidirectionally through Tauri events.
 */
function createTauriMessagePortPair(portId: string): [TauriMessagePort, TauriMessagePort] {
	return [
		new TauriMessagePort(portId, 'a'),
		new TauriMessagePort(portId, 'b'),
	];
}

/**
 * An implementation of a `IPCClient` on top of Tauri events,
 * replacing Electron's `MessagePortMain`.
 */
export class Client extends MessagePortClient implements IDisposable {

	/**
	 * @param port a TauriMessagePort (or any object matching the MessagePort interface)
	 * @param clientId a way to uniquely identify this client among
	 * other clients. this is important for routing because every
	 * client can also be a server
	 */
	constructor(port: IMessagePort, clientId: string) {
		super({
			addEventListener: (type, listener) => port.addEventListener(type, listener),
			removeEventListener: (type, listener) => port.removeEventListener(type, listener),
			postMessage: message => port.postMessage(message),
			start: () => port.start(),
			close: () => port.close()
		}, clientId);
	}
}

/**
 * Opens a message-channel connection to the target Tauri webview window.
 * The target window needs to use the `Server` from `electron-browser/ipc.mp`.
 *
 * In Electron this used `BrowserWindow.webContents.send()` + `MessagePort`.
 * In Tauri we create a virtual port pair routed through the event system,
 * then notify the window to pick up its end.
 */
export async function connect(window: WebviewWindow): Promise<TauriMessagePort> {
	const nonce = generateUuid();
	const portId = `port-${nonce}`;

	const [portMain, portWindow] = createTauriMessagePortPair(portId);

	await emit('vscode:createMessageChannel', {
		nonce,
		portId,
		direction: 'b',
		target: window.label,
	});

	const resultPromise = new Promise<void>((resolve) => {
		const off = validatedIpcMain.on('vscode:createMessageChannelResult', (event: TauriIpcEvent, payload: any) => {
			if (payload?.nonce === nonce) {
				validatedIpcMain.removeListener('vscode:createMessageChannelResult', off as any);
				resolve();
			}
		});
	});

	await resultPromise;

	return portMain;
}
