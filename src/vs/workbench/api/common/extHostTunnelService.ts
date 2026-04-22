/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost tunnel service stub. Remote tunneling is handled by the sidex-remote
 *  Rust crate; extension-level tunnel APIs accept registrations but perform no work.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import {
	ProvidedPortAttributes,
	RemoteTunnel,
	TunnelCreationOptions,
	TunnelOptions,
	TunnelPrivacyId
} from '../../../platform/tunnel/common/tunnel.js';
import { ExtHostTunnelServiceShape, PortAttributesSelector, TunnelDto } from './extHost.protocol.js';
import { CandidatePort } from '../../services/remote/common/tunnelModel.js';
import type * as vscode from 'vscode';

export namespace TunnelDtoConverter {
	export function fromApiTunnel(tunnel: vscode.Tunnel): TunnelDto {
		return {
			remoteAddress: tunnel.remoteAddress,
			localAddress: tunnel.localAddress,
			public: !!tunnel.public,
			privacy: tunnel.privacy ?? (tunnel.public ? TunnelPrivacyId.Public : TunnelPrivacyId.Private),
			protocol: tunnel.protocol
		};
	}
	export function fromServiceTunnel(tunnel: RemoteTunnel): TunnelDto {
		return {
			remoteAddress: { host: tunnel.tunnelRemoteHost, port: tunnel.tunnelRemotePort },
			localAddress: tunnel.localAddress,
			public: tunnel.privacy !== TunnelPrivacyId.ConstantPrivate,
			privacy: tunnel.privacy,
			protocol: tunnel.protocol
		};
	}
}

export interface Tunnel extends vscode.Disposable {
	remote: { port: number; host: string };
	localAddress: string;
}

export interface IExtHostTunnelService extends ExtHostTunnelServiceShape {
	readonly _serviceBrand: undefined;
	openTunnel(extension: IExtensionDescription, forward: TunnelOptions): Promise<vscode.Tunnel | undefined>;
	getTunnels(): Promise<vscode.TunnelDescription[]>;
	onDidChangeTunnels: vscode.Event<void>;
	setTunnelFactory(
		provider: vscode.RemoteAuthorityResolver | undefined,
		managedRemoteAuthority: vscode.ManagedResolvedAuthority | undefined
	): Promise<IDisposable>;
	registerPortsAttributesProvider(
		portSelector: PortAttributesSelector,
		provider: vscode.PortAttributesProvider
	): IDisposable;
	registerTunnelProvider(provider: vscode.TunnelProvider, information: vscode.TunnelInformation): Promise<IDisposable>;
	hasTunnelProvider(): Promise<boolean>;
}

export const IExtHostTunnelService = createDecorator<IExtHostTunnelService>('IExtHostTunnelService');

export class ExtHostTunnelService extends Disposable implements IExtHostTunnelService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeTunnels = this._register(new Emitter<void>());
	readonly onDidChangeTunnels = this._onDidChangeTunnels.event;

	async openTunnel(_extension: IExtensionDescription, _forward: TunnelOptions): Promise<vscode.Tunnel | undefined> {
		return undefined;
	}
	async getTunnels(): Promise<vscode.TunnelDescription[]> {
		return [];
	}
	async setTunnelFactory(): Promise<IDisposable> {
		return toDisposable(() => {});
	}
	registerPortsAttributesProvider(): IDisposable {
		return toDisposable(() => {});
	}
	async registerTunnelProvider(): Promise<IDisposable> {
		return toDisposable(() => {});
	}
	async hasTunnelProvider(): Promise<boolean> {
		return false;
	}

	async $forwardPort(
		_tunnelOptions: TunnelOptions,
		_tunnelCreationOptions: TunnelCreationOptions
	): Promise<TunnelDto | string | undefined> {
		return undefined;
	}
	async $closeTunnel(_remote: { host: string; port: number }, _silent?: boolean): Promise<void> {}
	async $onDidTunnelsChange(): Promise<void> {
		this._onDidChangeTunnels.fire();
	}
	async $registerCandidateFinder(_enable: boolean): Promise<void> {}
	async $applyCandidateFilter(candidates: CandidatePort[]): Promise<CandidatePort[]> {
		return candidates;
	}
	async $providePortAttributes(
		_handles: number[],
		_ports: number[],
		_pid: number | undefined,
		_commandline: string | undefined,
		_cancellationToken: CancellationToken
	): Promise<ProvidedPortAttributes[]> {
		return [];
	}
}
