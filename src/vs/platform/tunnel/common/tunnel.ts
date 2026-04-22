/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable, Disposable } from '../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IAddressProvider } from '../../remote/common/remoteAgentConnection.js';
import { TunnelPrivacy } from '../../remote/common/remoteAuthorityResolver.js';

export const ITunnelService = createDecorator<ITunnelService>('tunnelService');
export const ISharedTunnelsService = createDecorator<ISharedTunnelsService>('sharedTunnelsService');

export interface RemoteTunnel {
	readonly tunnelRemotePort: number;
	readonly tunnelRemoteHost: string;
	readonly tunnelLocalPort?: number;
	readonly localAddress: string;
	readonly privacy: string;
	readonly protocol?: string;
	dispose(silent?: boolean): Promise<void>;
}

export interface TunnelOptions {
	remoteAddress: { port: number; host: string };
	localAddressPort?: number;
	label?: string;
	public?: boolean;
	privacy?: string;
	protocol?: string;
}

export enum TunnelProtocol {
	Http = 'http',
	Https = 'https'
}

export enum TunnelPrivacyId {
	ConstantPrivate = 'constantPrivate',
	Private = 'private',
	Public = 'public'
}

export interface TunnelCreationOptions {
	elevationRequired?: boolean;
}

export interface TunnelProviderFeatures {
	elevation: boolean;
	/** @deprecated */
	public?: boolean;
	privacyOptions: TunnelPrivacy[];
	protocol: boolean;
}

export interface ITunnelProvider {
	forwardPort(
		tunnelOptions: TunnelOptions,
		tunnelCreationOptions: TunnelCreationOptions
	): Promise<RemoteTunnel | string | undefined> | undefined;
}

export function isTunnelProvider(
	addressOrTunnelProvider: IAddressProvider | ITunnelProvider
): addressOrTunnelProvider is ITunnelProvider {
	return !!(addressOrTunnelProvider as ITunnelProvider).forwardPort;
}

export enum ProvidedOnAutoForward {
	Notify = 1,
	OpenBrowser = 2,
	OpenPreview = 3,
	Silent = 4,
	Ignore = 5,
	OpenBrowserOnce = 6
}

export interface ProvidedPortAttributes {
	port: number;
	autoForwardAction: ProvidedOnAutoForward;
}

export interface PortAttributesProvider {
	providePortAttributes(
		ports: number[],
		pid: number | undefined,
		commandLine: string | undefined,
		token: CancellationToken
	): Promise<ProvidedPortAttributes[]>;
}

export interface ITunnel {
	remoteAddress: { port: number; host: string };
	localAddress: string;
	/** @deprecated Use privacy instead */
	public?: boolean;
	privacy?: string;
	protocol?: string;
	readonly onDidDispose: Event<void>;
	dispose(): Promise<void> | void;
}

export interface ISharedTunnelsService {
	readonly _serviceBrand: undefined;
	openTunnel(
		authority: string,
		addressProvider: IAddressProvider | undefined,
		remoteHost: string | undefined,
		remotePort: number,
		localHost: string,
		localPort?: number,
		elevateIfNeeded?: boolean,
		privacy?: string,
		protocol?: string
	): Promise<RemoteTunnel | string | undefined> | undefined;
}

export interface ITunnelService {
	readonly _serviceBrand: undefined;
	readonly tunnels: Promise<readonly RemoteTunnel[]>;
	readonly canChangePrivacy: boolean;
	readonly privacyOptions: TunnelPrivacy[];
	readonly onTunnelOpened: Event<RemoteTunnel>;
	readonly onTunnelClosed: Event<{ host: string; port: number }>;
	readonly canElevate: boolean;
	readonly canChangeProtocol: boolean;
	readonly hasTunnelProvider: boolean;
	readonly onAddedTunnelProvider: Event<void>;
	canTunnel(uri: URI): boolean;
	openTunnel(
		addressProvider: IAddressProvider | undefined,
		remoteHost: string | undefined,
		remotePort: number,
		localHost?: string,
		localPort?: number,
		elevateIfNeeded?: boolean,
		privacy?: string,
		protocol?: string
	): Promise<RemoteTunnel | string | undefined> | undefined;
	getExistingTunnel(remoteHost: string, remotePort: number): Promise<RemoteTunnel | string | undefined>;
	setEnvironmentTunnel(
		remoteHost: string,
		remotePort: number,
		localAddress: string,
		privacy: string,
		protocol: string
	): void;
	closeTunnel(remoteHost: string, remotePort: number): Promise<void>;
	setTunnelProvider(provider: ITunnelProvider | undefined): IDisposable;
	setTunnelFeatures(features: TunnelProviderFeatures): void;
	isPortPrivileged(port: number): boolean;
}

export function extractLocalHostUriMetaDataForPortMapping(uri: URI): { address: string; port: number } | undefined {
	if (uri.scheme !== 'http' && uri.scheme !== 'https') {
		return undefined;
	}
	const localhostMatch = /^(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)$/.exec(uri.authority);
	if (!localhostMatch) {
		return undefined;
	}
	return { address: localhostMatch[1], port: +localhostMatch[2] };
}

export const LOCALHOST_ADDRESSES = ['localhost', '127.0.0.1', '0:0:0:0:0:0:0:1', '::1'];
export function isLocalhost(host: string): boolean {
	return LOCALHOST_ADDRESSES.indexOf(host) >= 0;
}

export const ALL_INTERFACES_ADDRESSES = ['0.0.0.0', '0:0:0:0:0:0:0:0', '::'];
export function isAllInterfaces(host: string): boolean {
	return ALL_INTERFACES_ADDRESSES.indexOf(host) >= 0;
}

export class DisposableTunnel {
	private _onDispose: Emitter<void> = new Emitter();
	readonly onDidDispose: Event<void> = this._onDispose.event;

	constructor(
		public readonly remoteAddress: { port: number; host: string },
		public readonly localAddress: { port: number; host: string } | string,
		private readonly _dispose: () => Promise<void>
	) {}

	dispose(): Promise<void> {
		this._onDispose.fire();
		this._onDispose.dispose();
		return this._dispose();
	}
}

export abstract class AbstractTunnelService extends Disposable implements ITunnelService {
	declare readonly _serviceBrand: undefined;

	private _onTunnelOpened = this._register(new Emitter<RemoteTunnel>());
	public onTunnelOpened: Event<RemoteTunnel> = this._onTunnelOpened.event;
	private _onTunnelClosed = this._register(new Emitter<{ host: string; port: number }>());
	public onTunnelClosed: Event<{ host: string; port: number }> = this._onTunnelClosed.event;
	private _onAddedTunnelProvider = this._register(new Emitter<void>());
	public onAddedTunnelProvider: Event<void> = this._onAddedTunnelProvider.event;
	protected readonly _tunnels = new Map<
		string,
		Map<number, { refcount: number; readonly value: Promise<RemoteTunnel | string | undefined> }>
	>();
	protected _tunnelProvider: ITunnelProvider | undefined;
	protected _canElevate: boolean = false;
	private _canChangeProtocol: boolean = true;
	private _privacyOptions: TunnelPrivacy[] = [];
	private _factoryInProgress: Set<number> = new Set();

	public get hasTunnelProvider(): boolean {
		return !!this._tunnelProvider;
	}
	public get canChangeProtocol(): boolean {
		return this._canChangeProtocol;
	}
	public get canElevate(): boolean {
		return this._canElevate;
	}
	public get canChangePrivacy() {
		return this._privacyOptions.length > 0;
	}
	public get privacyOptions() {
		return this._privacyOptions;
	}
	public get tunnels(): Promise<readonly RemoteTunnel[]> {
		return this.getTunnels();
	}

	setTunnelProvider(provider: ITunnelProvider | undefined): IDisposable {
		this._tunnelProvider = provider;
		if (!provider) {
			this._canElevate = false;
			this._privacyOptions = [];
		}
		this._onAddedTunnelProvider.fire();
		return {
			dispose: () => {
				this._tunnelProvider = undefined;
				this._canElevate = false;
				this._privacyOptions = [];
			}
		};
	}

	setTunnelFeatures(features: TunnelProviderFeatures): void {
		this._canElevate = features.elevation;
		this._privacyOptions = features.privacyOptions;
		this._canChangeProtocol = features.protocol;
	}

	private async getTunnels(): Promise<readonly RemoteTunnel[]> {
		const tunnels: RemoteTunnel[] = [];
		for (const portMap of this._tunnels.values()) {
			for (const x of portMap.values()) {
				const v = await x.value;
				if (v && typeof v !== 'string') {
					tunnels.push(v);
				}
			}
		}
		return tunnels;
	}

	override async dispose(): Promise<void> {
		super.dispose();
		for (const portMap of this._tunnels.values()) {
			for (const { value } of portMap.values()) {
				await value.then(t => (typeof t !== 'string' ? t?.dispose() : undefined));
			}
			portMap.clear();
		}
		this._tunnels.clear();
	}

	setEnvironmentTunnel(
		remoteHost: string,
		remotePort: number,
		localAddress: string,
		privacy: string,
		protocol: string
	): void {
		this.addTunnelToMap(
			remoteHost,
			remotePort,
			Promise.resolve({
				tunnelRemoteHost: remoteHost,
				tunnelRemotePort: remotePort,
				localAddress,
				privacy,
				protocol,
				dispose: () => Promise.resolve()
			})
		);
	}

	async getExistingTunnel(remoteHost: string, remotePort: number): Promise<RemoteTunnel | string | undefined> {
		if (isAllInterfaces(remoteHost) || isLocalhost(remoteHost)) {
			remoteHost = LOCALHOST_ADDRESSES[0];
		}
		const existing = this.getTunnelFromMap(remoteHost, remotePort);
		if (existing) {
			++existing.refcount;
			return existing.value;
		}
		return undefined;
	}

	openTunnel(
		addressProvider: IAddressProvider | undefined,
		remoteHost: string | undefined,
		remotePort: number,
		localHost?: string,
		localPort?: number,
		elevateIfNeeded: boolean = false,
		privacy?: string,
		protocol?: string
	): Promise<RemoteTunnel | string | undefined> | undefined {
		const addressOrTunnelProvider = this._tunnelProvider ?? addressProvider;
		if (!addressOrTunnelProvider) {
			return undefined;
		}
		if (!remoteHost) {
			remoteHost = 'localhost';
		}
		if (this._tunnelProvider && this._factoryInProgress.has(remotePort)) {
			return;
		}

		const resolvedTunnel = this.retainOrCreateTunnel(
			addressOrTunnelProvider,
			remoteHost,
			remotePort,
			localHost ?? '127.0.0.1',
			localPort,
			elevateIfNeeded,
			privacy,
			protocol
		);
		if (!resolvedTunnel) {
			return resolvedTunnel;
		}

		return resolvedTunnel.then(tunnel => {
			if (!tunnel) {
				this.removeEmptyOrErrorTunnelFromMap(remoteHost, remotePort);
				return undefined;
			}
			if (typeof tunnel === 'string') {
				this.removeEmptyOrErrorTunnelFromMap(remoteHost, remotePort);
				return tunnel;
			}
			const newTunnel = this.makeTunnel(tunnel);
			this._onTunnelOpened.fire(newTunnel);
			return newTunnel;
		});
	}

	private makeTunnel(tunnel: RemoteTunnel): RemoteTunnel {
		return {
			tunnelRemotePort: tunnel.tunnelRemotePort,
			tunnelRemoteHost: tunnel.tunnelRemoteHost,
			tunnelLocalPort: tunnel.tunnelLocalPort,
			localAddress: tunnel.localAddress,
			privacy: tunnel.privacy,
			protocol: tunnel.protocol,
			dispose: async () => {
				const existingHost = this._tunnels.get(tunnel.tunnelRemoteHost);
				if (existingHost) {
					const existing = existingHost.get(tunnel.tunnelRemotePort);
					if (existing) {
						existing.refcount--;
						await this.tryDisposeTunnel(tunnel.tunnelRemoteHost, tunnel.tunnelRemotePort, existing);
					}
				}
			}
		};
	}

	private async tryDisposeTunnel(
		remoteHost: string,
		remotePort: number,
		tunnel: { refcount: number; readonly value: Promise<RemoteTunnel | string | undefined> }
	): Promise<void> {
		if (tunnel.refcount <= 0) {
			const disposePromise = tunnel.value.then(async t => {
				if (t && typeof t !== 'string') {
					await t.dispose(true);
					this._onTunnelClosed.fire({ host: t.tunnelRemoteHost, port: t.tunnelRemotePort });
				}
			});
			this._tunnels.get(remoteHost)?.delete(remotePort);
			return disposePromise;
		}
	}

	async closeTunnel(remoteHost: string, remotePort: number): Promise<void> {
		const portMap = this._tunnels.get(remoteHost);
		if (portMap?.has(remotePort)) {
			const value = portMap.get(remotePort)!;
			value.refcount = 0;
			await this.tryDisposeTunnel(remoteHost, remotePort, value);
		}
	}

	protected addTunnelToMap(remoteHost: string, remotePort: number, tunnel: Promise<RemoteTunnel | string | undefined>) {
		if (!this._tunnels.has(remoteHost)) {
			this._tunnels.set(remoteHost, new Map());
		}
		this._tunnels.get(remoteHost)!.set(remotePort, { refcount: 1, value: tunnel });
	}

	private async removeEmptyOrErrorTunnelFromMap(remoteHost: string, remotePort: number) {
		const hostMap = this._tunnels.get(remoteHost);
		if (hostMap) {
			const tunnel = hostMap.get(remotePort);
			const result = tunnel ? await tunnel.value : undefined;
			if (!result || typeof result === 'string') {
				hostMap.delete(remotePort);
			}
			if (hostMap.size === 0) {
				this._tunnels.delete(remoteHost);
			}
		}
	}

	protected getTunnelFromMap(remoteHost: string, remotePort: number) {
		const hosts = [remoteHost];
		if (isLocalhost(remoteHost)) {
			hosts.push(...LOCALHOST_ADDRESSES, ...ALL_INTERFACES_ADDRESSES);
		} else if (isAllInterfaces(remoteHost)) {
			hosts.push(...ALL_INTERFACES_ADDRESSES);
		}
		for (const host of hosts) {
			const existing = this._tunnels.get(host)?.get(remotePort);
			if (existing) {
				return existing;
			}
		}
		return undefined;
	}

	canTunnel(uri: URI): boolean {
		return !!extractLocalHostUriMetaDataForPortMapping(uri);
	}
	public abstract isPortPrivileged(port: number): boolean;

	protected abstract retainOrCreateTunnel(
		addressProvider: IAddressProvider | ITunnelProvider,
		remoteHost: string,
		remotePort: number,
		localHost: string,
		localPort: number | undefined,
		elevateIfNeeded: boolean,
		privacy?: string,
		protocol?: string
	): Promise<RemoteTunnel | string | undefined> | undefined;

	protected createWithProvider(
		tunnelProvider: ITunnelProvider,
		remoteHost: string,
		remotePort: number,
		localPort: number | undefined,
		elevateIfNeeded: boolean,
		privacy?: string,
		protocol?: string
	): Promise<RemoteTunnel | string | undefined> | undefined {
		const key = remotePort;
		this._factoryInProgress.add(key);
		const preferredLocalPort = localPort === undefined ? remotePort : localPort;
		const tunnel = tunnelProvider.forwardPort(
			{
				remoteAddress: { host: remoteHost, port: remotePort },
				localAddressPort: localPort,
				privacy,
				public: privacy ? privacy !== TunnelPrivacyId.Private : undefined,
				protocol
			},
			{ elevationRequired: elevateIfNeeded ? this.isPortPrivileged(preferredLocalPort) : false }
		);
		if (tunnel) {
			this.addTunnelToMap(remoteHost, remotePort, tunnel);
			tunnel.finally(() => {
				this._factoryInProgress.delete(key);
			});
		} else {
			this._factoryInProgress.delete(key);
		}
		return tunnel;
	}
}
