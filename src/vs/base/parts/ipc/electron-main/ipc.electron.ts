/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { validatedIpcMain, type TauriIpcEvent } from './ipcMain.js';
import { VSBuffer } from '../../../common/buffer.js';
import { Emitter, Event } from '../../../common/event.js';
import { IDisposable, toDisposable } from '../../../common/lifecycle.js';
import { ClientConnectionEvent, IPCServer } from '../common/ipc.js';
import { Protocol as ElectronProtocol, Sender } from '../common/ipc.electron.js';

interface IIPCEvent {
	event: { sender: TauriIpcEvent['sender'] };
	message: Uint8Array | null;
}

function createScopedOnMessageEvent(senderId: number, eventName: string): Event<VSBuffer | null> {
	const onMessage = Event.fromNodeEventEmitter<IIPCEvent>(validatedIpcMain, eventName, (event: TauriIpcEvent, message: unknown) => ({
		event: { sender: event.sender },
		message: message instanceof Uint8Array ? message : null,
	}));
	const onMessageFromSender = Event.filter(onMessage, ({ event }) => event.sender.id === senderId);

	return Event.map(onMessageFromSender, ({ message }) => message ? VSBuffer.wrap(message) : message);
}

/**
 * A Tauri-compatible `Sender` that uses `emit()` to send messages
 * to the frontend webview, equivalent to Electron's `WebContents.send()`.
 */
class TauriSender implements Sender {
	constructor(private readonly windowLabel: string) { }

	send(channel: string, msg: unknown): void {
		emit(channel, { data: msg, target: this.windowLabel }).catch(() => {
			// system is going down
		});
	}
}

/**
 * An implementation of `IPCServer` on top of Tauri's event system.
 * Replaces the Electron ipcMain-based server.
 */
export class Server extends IPCServer {

	private static readonly Clients = new Map<number, IDisposable>();

	private static getOnDidClientConnect(): Event<ClientConnectionEvent> {
		const onHello = Event.fromNodeEventEmitter<TauriIpcEvent['sender']>(
			validatedIpcMain,
			'vscode:hello',
			(event: TauriIpcEvent) => event.sender,
		);

		return Event.map(onHello, sender => {
			const id = sender.id;
			const client = Server.Clients.get(id);

			client?.dispose();

			const onDidClientReconnect = new Emitter<void>();
			Server.Clients.set(id, toDisposable(() => onDidClientReconnect.fire()));

			const onMessage = createScopedOnMessageEvent(id, 'vscode:message') as Event<VSBuffer>;
			const onDidClientDisconnect = Event.any(
				Event.signal(createScopedOnMessageEvent(id, 'vscode:disconnect')),
				onDidClientReconnect.event,
			);

			const windowLabel = typeof id === 'number' ? String.fromCharCode(id) : 'main';
			const tauriSender = new TauriSender(windowLabel);
			const protocol = new ElectronProtocol(tauriSender, onMessage);

			return { protocol, onDidClientDisconnect };
		});
	}

	constructor() {
		super(Server.getOnDidClientConnect());
	}
}
