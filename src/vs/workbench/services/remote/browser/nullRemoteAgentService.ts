/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IRemoteAgentEnvironment } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IDiagnosticInfoOptions, IDiagnosticInfo } from '../../../../platform/diagnostics/common/diagnostics.js';
import { ITelemetryData, TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { IChannel, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';

export const IRemoteAgentService = createDecorator<IRemoteAgentService>('remoteAgentService');

export interface IRemoteAgentConnection {
	readonly remoteAuthority: string;
	readonly onReconnecting: Event<void>;
	readonly onDidStateChange: Event<unknown>;
	end(): Promise<void>;
	dispose(): void;
	getChannel<T extends IChannel>(channelName: string): T;
	withChannel<T extends IChannel, R>(channelName: string, callback: (channel: T) => Promise<R>): Promise<R>;
	registerChannel<T extends IServerChannel<unknown>>(channelName: string, channel: T): void;
	getInitialConnectionTimeMs(): Promise<number>;
	updateGraceTime(graceTime: number): void;
}

export interface IExtensionHostExitInfo {
	code: number;
	signal: string;
}

export interface IRemoteAgentService {
	readonly _serviceBrand: undefined;
	getConnection(): IRemoteAgentConnection | null;
	getEnvironment(): Promise<IRemoteAgentEnvironment | null>;
	getRawEnvironment(): Promise<IRemoteAgentEnvironment | null>;
	getExtensionHostExitInfo(reconnectionToken: string): Promise<IExtensionHostExitInfo | null>;
	getRoundTripTime(): Promise<number | undefined>;
	endConnection(): Promise<void>;
	getDiagnosticInfo(options: IDiagnosticInfoOptions): Promise<IDiagnosticInfo | undefined>;
	updateTelemetryLevel(telemetryLevel: TelemetryLevel): Promise<void>;
	logTelemetry(eventName: string, data?: ITelemetryData): Promise<void>;
	flushTelemetry(): Promise<void>;
}

export class NullRemoteAgentService implements IRemoteAgentService {
	declare readonly _serviceBrand: undefined;

	getConnection(): IRemoteAgentConnection | null {
		return null;
	}

	async getEnvironment(): Promise<IRemoteAgentEnvironment | null> {
		return null;
	}

	async getRawEnvironment(): Promise<IRemoteAgentEnvironment | null> {
		return null;
	}

	async getExtensionHostExitInfo(_reconnectionToken: string): Promise<IExtensionHostExitInfo | null> {
		return null;
	}

	async getRoundTripTime(): Promise<number | undefined> {
		return undefined;
	}

	async endConnection(): Promise<void> {
		// No-op
	}

	async getDiagnosticInfo(_options: IDiagnosticInfoOptions): Promise<IDiagnosticInfo | undefined> {
		return undefined;
	}

	async updateTelemetryLevel(_telemetryLevel: TelemetryLevel): Promise<void> {
		// No-op
	}

	async logTelemetry(_eventName: string, _data?: ITelemetryData): Promise<void> {
		// No-op
	}

	async flushTelemetry(): Promise<void> {
		// No-op
	}
}

registerSingleton(IRemoteAgentService, NullRemoteAgentService, InstantiationType.Delayed);
