/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { SocketDiagnosticsEventType } from '../../../base/parts/ipc/common/ipc.net.js';
import { ISocketFactory } from '../common/remoteSocketFactoryService.js';
import { RemoteConnectionType, WebSocketRemoteConnection } from '../common/remoteAuthorityResolver.js';

export interface IWebSocketFactory {
	create(url: string, debugLabel: string): IWebSocket;
}

export interface IWebSocket {
	readonly onData: Event<ArrayBuffer>;
	readonly onOpen: Event<void>;
	readonly onClose: Event<void>;
	readonly onError: Event<unknown>;
	traceSocketEvent?(
		type: SocketDiagnosticsEventType,
		data?: VSBuffer | Uint8Array | ArrayBuffer | ArrayBufferView | unknown
	): void;
	send(data: ArrayBuffer | ArrayBufferView): void;
	close(): void;
}

export class BrowserSocketFactory implements ISocketFactory<RemoteConnectionType.WebSocket> {
	constructor(_webSocketFactory: IWebSocketFactory | null | undefined) {}

	supports(_connectTo: WebSocketRemoteConnection): boolean {
		return true;
	}

	connect(_connectTo: WebSocketRemoteConnection, _path: string, _query: string, _debugLabel: string): Promise<never> {
		throw new Error('Browser socket connections are handled by Rust runtime');
	}
}
