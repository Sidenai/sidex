/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ISocket, SocketCloseEvent, SocketDiagnosticsEventType } from '../../../base/parts/ipc/common/ipc.net.js';

export interface RemoteSocketHalf {
	onData: Emitter<VSBuffer>;
	onClose: Emitter<SocketCloseEvent>;
	onEnd: Emitter<void>;
}

export async function connectManagedSocket<T extends ManagedSocket>(
	socket: T,
	_path: string,
	_query: string,
	_debugLabel: string,
	_half: RemoteSocketHalf
): Promise<T> {
	return socket;
}

export abstract class ManagedSocket extends Disposable implements ISocket {
	public onData: Event<VSBuffer> = Event.None;
	public onClose: Event<SocketCloseEvent> = Event.None;
	public onEnd: Event<void> = Event.None;
	public onDidDispose: Event<void> = Event.None;

	protected constructor(_debugLabel: string, _half: RemoteSocketHalf) {
		super();
	}

	public pauseData(): void {}
	public drain(): Promise<void> {
		return Promise.resolve();
	}
	public end(): void {}
	public abstract write(buffer: VSBuffer): void;
	protected abstract closeRemote(): void;
	traceSocketEvent(_type: SocketDiagnosticsEventType, _data?: unknown): void {}
}
