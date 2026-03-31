/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { VSBuffer } from '../../../common/buffer.js';
import { onUnexpectedError } from '../../../common/errors.js';
import { Emitter, Event } from '../../../common/event.js';
import { Disposable, IDisposable } from '../../../common/lifecycle.js';
import { join } from '../../../common/path.js';
import { Platform, platform } from '../../../common/platform.js';
import { generateUuid } from '../../../common/uuid.js';
import { ClientConnectionEvent, IPCServer } from '../common/ipc.js';
import { ChunkStream, Client, ISocket, Protocol, SocketCloseEvent, SocketCloseEventType, SocketDiagnostics, SocketDiagnosticsEventType } from '../common/ipc.net.js';

// TODO: Full Tauri IPC net implementation needed.
// This stub provides the type exports and basic structure.

export function createRandomIPCHandle(): string {
	return join('/tmp', `vscode-ipc-${generateUuid()}.sock`);
}

export function createStaticIPCHandle(directoryPath: string, type: string, version: string): string {
	return join(directoryPath, `${type}-${version}.sock`);
}

export class NodeSocket implements ISocket {
	public readonly debugLabel: string;

	constructor(private _socket: any, debugLabel: string = '') {
		this.debugLabel = debugLabel;
	}

	dispose(): void {
		// TODO: Tauri socket cleanup
	}

	onData(_listener: (e: VSBuffer) => void): IDisposable {
		// TODO: Tauri socket data listener
		return { dispose: () => {} };
	}

	onClose(_listener: (e: SocketCloseEvent) => void): IDisposable {
		return { dispose: () => {} };
	}

	onEnd(_listener: () => void): IDisposable {
		return { dispose: () => {} };
	}

	write(_buffer: VSBuffer): void {
		// TODO: Tauri socket write
	}

	end(): void {
		// TODO: Tauri socket end
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	traceSocketEvent(_type: SocketDiagnosticsEventType, _data?: VSBuffer | Uint8Array | ArrayBuffer | ArrayBufferView | string): void {
		// no-op
	}
}

export class WebSocketNodeSocket extends Disposable implements ISocket {
	public readonly debugLabel: string;
	public readonly permessageDeflate: boolean = false;
	public readonly recordedRecvBytes: VSBuffer[] = [];
	public traceSocketEvent(_type: SocketDiagnosticsEventType, _data?: any): void {}

	constructor(socket: NodeSocket, _debugLabel: string, _enableMessageSplitting?: boolean) {
		super();
		this.debugLabel = _debugLabel;
	}

	dispose(): void { super.dispose(); }
	onData(_listener: (e: VSBuffer) => void): IDisposable { return { dispose: () => {} }; }
	onClose(_listener: (e: SocketCloseEvent) => void): IDisposable { return { dispose: () => {} }; }
	onEnd(_listener: () => void): IDisposable { return { dispose: () => {} }; }
	write(_buffer: VSBuffer): void {}
	end(): void {}
	drain(): Promise<void> { return Promise.resolve(); }
}

export function connect(options: { host: string; port: number }, debugLabel: string): Promise<NodeSocket> {
	// TODO: Implement Tauri-backed socket connection
	return Promise.reject(new Error('Socket connections not available in Tauri webview. Use invoke() instead.'));
}

export function serve(_hook?: any): Promise<any> {
	// TODO: Implement Tauri-backed server
	return Promise.reject(new Error('Socket servers not available in Tauri webview.'));
}

// Re-export for consumers
export function upgradeToISocket(_req: any, _socket: any, _opts: any): any {
	throw new Error('upgradeToISocket not available in Tauri webview.');
}
