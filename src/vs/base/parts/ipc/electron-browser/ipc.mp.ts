/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../browser/window.js';
import { Event } from '../../../common/event.js';
import { generateUuid } from '../../../common/uuid.js';
import { ipcMessagePort, ipcRenderer } from '../../sandbox/electron-browser/globals.js';

interface IMessageChannelResult {
	nonce: string;
	port: MessagePort;
	source: unknown;
}

/**
 * Acquire a `MessagePort` by requesting the Tauri backend to create one.
 *
 * The flow mirrors Electron's: we tell the preload bridge to listen for
 * a response on `responseChannel`, send a request on `requestChannel`,
 * then wait for the port to arrive via `window.postMessage`.
 */
export async function acquirePort(requestChannel: string | undefined, responseChannel: string, nonce = generateUuid()): Promise<MessagePort> {

	ipcMessagePort.acquire(responseChannel, nonce);

	if (typeof requestChannel === 'string') {
		ipcRenderer.send(requestChannel, nonce);
	}

	const onMessageChannelResult = Event.fromDOMEventEmitter<IMessageChannelResult>(mainWindow, 'message', (e: MessageEvent) => ({ nonce: e.data, port: e.ports[0], source: e.source }));
	const { port } = await Event.toPromise(Event.once(Event.filter(onMessageChannelResult, e => e.nonce === nonce && e.source === mainWindow)));

	return port;
}
