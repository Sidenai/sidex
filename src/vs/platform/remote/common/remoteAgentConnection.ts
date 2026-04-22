/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancelablePromise } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IIPCLogger } from '../../../base/parts/ipc/common/ipc.js';
import { Client, PersistentProtocol } from '../../../base/parts/ipc/common/ipc.net.js';
import { ILogService } from '../../log/common/log.js';
import { RemoteAgentConnectionContext } from './remoteAgentEnvironment.js';
import { RemoteConnection } from './remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService } from './remoteSocketFactoryService.js';
import { ISignService } from '../../sign/common/sign.js';

export const enum ConnectionType {
	Management = 1,
	ExtensionHost = 2,
	Tunnel = 3
}

export interface IRemoteExtensionHostStartParams {
	language: string;
	debugId?: string;
	break?: boolean;
	port?: number | null;
	env?: { [key: string]: string | null };
}

export interface ITunnelConnectionStartParams {
	host: string;
	port: number;
}

export interface IConnectionOptions<T extends RemoteConnection = RemoteConnection> {
	commit: string | undefined;
	quality: string | undefined;
	addressProvider: IAddressProvider<T>;
	remoteSocketFactoryService: IRemoteSocketFactoryService;
	signService: ISignService;
	logService: ILogService;
	ipcLogger: IIPCLogger | null;
}

export interface IAddress<T extends RemoteConnection = RemoteConnection> {
	connectTo: T;
	connectionToken: string | undefined;
}

export interface IAddressProvider<T extends RemoteConnection = RemoteConnection> {
	getAddress(): Promise<IAddress<T>>;
}

export const enum PersistentConnectionEventType {
	ConnectionLost,
	ReconnectionWait,
	ReconnectionRunning,
	ReconnectionPermanentFailure,
	ConnectionGain
}

export class ConnectionLostEvent {
	public readonly type = PersistentConnectionEventType.ConnectionLost;
	constructor(
		public readonly reconnectionToken: string,
		public readonly millisSinceLastIncomingData: number
	) {}
}

export class ReconnectionWaitEvent {
	public readonly type = PersistentConnectionEventType.ReconnectionWait;
	constructor(
		public readonly reconnectionToken: string,
		public readonly millisSinceLastIncomingData: number,
		public readonly durationSeconds: number,
		private readonly cancellableTimer: CancelablePromise<void>
	) {}
	public skipWait(): void {
		this.cancellableTimer.cancel();
	}
}

export class ReconnectionRunningEvent {
	public readonly type = PersistentConnectionEventType.ReconnectionRunning;
	constructor(
		public readonly reconnectionToken: string,
		public readonly millisSinceLastIncomingData: number,
		public readonly attempt: number
	) {}
}

export class ConnectionGainEvent {
	public readonly type = PersistentConnectionEventType.ConnectionGain;
	constructor(
		public readonly reconnectionToken: string,
		public readonly millisSinceLastIncomingData: number,
		public readonly attempt: number
	) {}
}

export class ReconnectionPermanentFailureEvent {
	public readonly type = PersistentConnectionEventType.ReconnectionPermanentFailure;
	constructor(
		public readonly reconnectionToken: string,
		public readonly millisSinceLastIncomingData: number,
		public readonly attempt: number,
		public readonly handled: boolean
	) {}
}

export type PersistentConnectionEvent =
	| ConnectionGainEvent
	| ConnectionLostEvent
	| ReconnectionWaitEvent
	| ReconnectionRunningEvent
	| ReconnectionPermanentFailureEvent;

export abstract class PersistentConnection extends Disposable {
	public static triggerPermanentFailure(
		_millisSinceLastIncomingData: number,
		_attempt: number,
		_handled: boolean
	): void {}
	public static debugTriggerReconnection(): void {}
	public static debugPauseSocketWriting(): void {}

	private readonly _onDidStateChange = this._register(new Emitter<PersistentConnectionEvent>());
	public readonly onDidStateChange = this._onDidStateChange.event;

	constructor(
		_connectionType: ConnectionType,
		protected readonly _options: IConnectionOptions,
		public readonly reconnectionToken: string,
		public readonly protocol: PersistentProtocol,
		_reconnectionFailureIsFatal: boolean
	) {
		super();
	}

	public updateGraceTime(_graceTime: number): void {}
}

export class ManagementPersistentConnection extends PersistentConnection {
	public readonly client: Client<RemoteAgentConnectionContext>;

	constructor(
		options: IConnectionOptions,
		remoteAuthority: string,
		clientId: string,
		reconnectionToken: string,
		protocol: PersistentProtocol
	) {
		super(ConnectionType.Management, options, reconnectionToken, protocol, true);
		this.client = this._register(
			new Client<RemoteAgentConnectionContext>(protocol, { remoteAuthority, clientId }, options.ipcLogger)
		);
	}
}

export class ExtensionHostPersistentConnection extends PersistentConnection {
	public readonly debugPort: number | undefined;

	constructor(
		options: IConnectionOptions,
		_startArguments: IRemoteExtensionHostStartParams,
		reconnectionToken: string,
		protocol: PersistentProtocol,
		debugPort: number | undefined
	) {
		super(ConnectionType.ExtensionHost, options, reconnectionToken, protocol, false);
		this.debugPort = debugPort;
	}
}

export async function connectRemoteAgentManagement(
	_options: IConnectionOptions,
	_remoteAuthority: string,
	_clientId: string
): Promise<ManagementPersistentConnection> {
	throw new Error('Remote agent connections are handled by Rust runtime');
}

export async function connectRemoteAgentExtensionHost(
	_options: IConnectionOptions,
	_startArguments: IRemoteExtensionHostStartParams
): Promise<ExtensionHostPersistentConnection> {
	throw new Error('Remote agent connections are handled by Rust runtime');
}

export async function connectRemoteAgentTunnel(
	_options: IConnectionOptions,
	_tunnelRemoteHost: string,
	_tunnelRemotePort: number
): Promise<PersistentProtocol> {
	throw new Error('Remote agent connections are handled by Rust runtime');
}
