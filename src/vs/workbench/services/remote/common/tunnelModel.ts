/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { TunnelProtocol, TunnelPrivacyId, PortAttributesProvider } from '../../../../platform/tunnel/common/tunnel.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const ACTIVATION_EVENT = 'onTunnel';
export const forwardedPortsFeaturesEnabled = new RawContextKey<boolean>(
	'forwardedPortsViewEnabled',
	false,
	nls.localize('tunnel.forwardedPortsViewEnabled', 'Whether the Ports view is enabled.')
);
export const forwardedPortsViewEnabled = new RawContextKey<boolean>(
	'forwardedPortsViewOnlyEnabled',
	false,
	nls.localize('tunnel.forwardedPortsViewEnabled', 'Whether the Ports view is enabled.')
);

export interface RestorableTunnel {
	remoteHost: string;
	remotePort: number;
	localAddress: string;
	localUri: URI;
	protocol: TunnelProtocol;
	localPort?: number;
	name?: string;
	source: {
		source: TunnelSource;
		description: string;
	};
}

export interface Tunnel {
	remoteHost: string;
	remotePort: number;
	localAddress: string;
	localUri: URI;
	protocol: TunnelProtocol;
	localPort?: number;
	name?: string;
	closeable?: boolean;
	privacy: TunnelPrivacyId | string;
	runningProcess: string | undefined;
	hasRunningProcess?: boolean;
	pid: number | undefined;
	source: {
		source: TunnelSource;
		description: string;
	};
}

export function parseAddress(address: string): { host: string; port: number } | undefined {
	const matches = address.match(/^([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*:)?([0-9]+)$/);
	if (!matches) {
		return undefined;
	}
	return { host: matches[1]?.substring(0, matches[1].length - 1) || 'localhost', port: Number(matches[2]) };
}

export enum TunnelCloseReason {
	Other = 'Other',
	User = 'User',
	AutoForwardEnd = 'AutoForwardEnd'
}

export enum TunnelSource {
	User,
	Auto,
	Extension
}

export const UserTunnelSource = {
	source: TunnelSource.User,
	description: nls.localize('tunnel.source.user', 'User Forwarded')
};
export const AutoTunnelSource = {
	source: TunnelSource.Auto,
	description: nls.localize('tunnel.source.auto', 'Auto Forwarded')
};

export function makeAddress(host: string, port: number): string {
	return host + ':' + port;
}

export interface TunnelProperties {
	remote: { host: string; port: number };
	local?: number;
	name?: string;
	source?: {
		source: TunnelSource;
		description: string;
	};
	elevateIfNeeded?: boolean;
	privacy?: string;
}

export interface CandidatePort {
	host: string;
	port: number;
	detail?: string;
	pid?: number;
}

export enum OnPortForward {
	Notify = 'notify',
	OpenBrowser = 'openBrowser',
	OpenBrowserOnce = 'openBrowserOnce',
	OpenPreview = 'openPreview',
	Silent = 'silent',
	Ignore = 'ignore'
}

export interface Attributes {
	label: string | undefined;
	onAutoForward: OnPortForward | undefined;
	elevateIfNeeded: boolean | undefined;
	requireLocalPort: boolean | undefined;
	protocol: TunnelProtocol | undefined;
}

export function isCandidatePort(candidate: any): candidate is CandidatePort {
	return (
		candidate &&
		'host' in candidate &&
		typeof candidate.host === 'string' &&
		'port' in candidate &&
		typeof candidate.port === 'number' &&
		(!('detail' in candidate) || typeof candidate.detail === 'string') &&
		(!('pid' in candidate) || typeof candidate.pid === 'string')
	);
}

export function mapHasAddress<T>(map: Map<string, T>, host: string, port: number): T | undefined {
	return map.get(makeAddress(host, port));
}

export function mapHasAddressLocalhostOrAllInterfaces<T>(
	map: Map<string, T>,
	host: string,
	port: number
): T | undefined {
	return mapHasAddress(map, host, port);
}

// Stub: TunnelModel is now handled by sidex-remote Rust crate
export class TunnelModel extends Disposable {
	readonly forwarded: Map<string, Tunnel> = new Map();
	readonly detected: Map<string, Tunnel> = new Map();
	readonly configPortsAttributes = {
		onDidChangeAttributes: new Emitter<void>().event,
		getAttributes: (_port: number, _host: string, _commandLine?: string) => undefined as Attributes | undefined
	};
	onForwardPort = new Emitter<Tunnel | void>().event;
	onClosePort = new Emitter<{ host: string; port: number }>().event;
	onPortName = new Emitter<{ host: string; port: number }>().event;
	onCandidatesChanged = new Emitter<Map<string, { host: string; port: number }>>().event;
	onEnvironmentTunnelsSet = new Emitter<void>().event;

	get environmentTunnelsSet(): boolean {
		return false;
	}
	get candidates(): CandidatePort[] {
		return [];
	}
	get candidatesOrUndefined(): CandidatePort[] | undefined {
		return undefined;
	}

	async forward(_tunnelProperties: TunnelProperties, _attributes?: Attributes | null): Promise<undefined> {
		return undefined;
	}
	async close(_host: string, _port: number, _reason: TunnelCloseReason): Promise<void> {}
	async name(_host: string, _port: number, _name: string): Promise<void> {}
	address(_host: string, _port: number): string | undefined {
		return undefined;
	}
	addEnvironmentTunnels(_tunnels: unknown): void {}
	setCandidateFilter(_filter: unknown): void {}
	async setCandidates(_candidates: CandidatePort[]): Promise<void> {}
	async restoreForwarded(): Promise<void> {}
	addAttributesProvider(_provider: PortAttributesProvider): void {}
}

// Stub: PortsAttributes is now handled by sidex-remote Rust crate
export class PortsAttributes extends Disposable {
	readonly onDidChangeAttributes = new Emitter<void>().event;
	getAttributes(_port: number, _host: string, _commandLine?: string): Attributes | undefined {
		return undefined;
	}
	static providedActionToAction(_providedAction: unknown) {
		return undefined;
	}
	async addAttributes(_port: number, _attributes: Partial<Attributes>, _target: unknown): Promise<void> {}
}
