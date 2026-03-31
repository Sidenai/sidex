/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { createCancelablePromise, Delayer } from '../../../common/async.js';
import { VSBuffer } from '../../../common/buffer.js';
import { CancellationToken } from '../../../common/cancellation.js';
import { isRemoteConsoleLog, log } from '../../../common/console.js';
import * as errors from '../../../common/errors.js';
import { Emitter, Event } from '../../../common/event.js';
import { dispose, IDisposable, toDisposable } from '../../../common/lifecycle.js';
import { deepClone } from '../../../common/objects.js';
import { createQueuedSender } from '../../../node/processes.js';
import { removeDangerousEnvVariables } from '../../../common/processes.js';
import { ChannelClient as IPCClient, ChannelServer as IPCServer, IChannel, IChannelClient } from '../common/ipc.js';

/**
 * In Tauri, child process forking is not available from the webview.
 * IPC communication goes through Tauri's invoke() mechanism instead.
 */

export class Server<TContext extends string> extends IPCServer<TContext> {
	constructor(ctx: TContext) {
		super({
			send: _r => {
				// TODO: Tauri IPC send
			},
			onMessage: Event.fromNodeEventEmitter<VSBuffer>(
				{ on: () => {}, removeListener: () => {} } as any,
				'message',
				(msg: any) => VSBuffer.wrap(typeof msg === 'string' ? new TextEncoder().encode(msg) : new Uint8Array(0))
			)
		}, ctx);
	}
}

export interface IIPCOptions {
	serverName: string;
	args?: string[];
	env?: any;
}

export class Client implements IChannelClient, IDisposable {

	private _client: IPCClient | undefined;
	private readonly _onDidProcessExit = new Emitter<{ code: number; signal: string }>();
	readonly onDidProcessExit = this._onDidProcessExit.event;

	constructor(
		private readonly _modulePath: string,
		private readonly _options: IIPCOptions
	) {
		// TODO: In Tauri, we'd use invoke to start a sidecar or background process
		console.warn(`IPC Client: child process forking not available in Tauri. Module: ${_modulePath}`);
	}

	getChannel(channelName: string): IChannel {
		// TODO: Return a Tauri-backed channel
		return {
			call: async (_command: string, _arg?: any, _cancellationToken?: CancellationToken) => {
				throw new Error(`IPC channel '${channelName}' not available in Tauri webview.`);
			},
			listen: (_event: string, _arg?: any) => {
				return Event.None;
			}
		};
	}

	dispose(): void {
		this._client?.dispose();
	}
}
