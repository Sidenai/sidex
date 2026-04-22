/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { RemoteTunnel, TunnelProtocol } from '../../../../platform/tunnel/common/tunnel.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IEditableData } from '../../../common/views.js';
import { TunnelPrivacy } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { URI } from '../../../../base/common/uri.js';
import {
	Attributes,
	CandidatePort,
	TunnelCloseReason,
	TunnelModel,
	TunnelProperties,
	TunnelSource
} from './tunnelModel.js';
import { IExtensionPointUser } from '../../extensions/common/extensionsRegistry.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';

export const IRemoteExplorerService = createDecorator<IRemoteExplorerService>('remoteExplorerService');
export const REMOTE_EXPLORER_TYPE_KEY: string = 'remote.explorerType';
export const TUNNEL_VIEW_ID = '~remote.forwardedPorts';
export const TUNNEL_VIEW_CONTAINER_ID = '~remote.forwardedPortsContainer';
export const PORT_AUTO_FORWARD_SETTING = 'remote.autoForwardPorts';
export const PORT_AUTO_SOURCE_SETTING = 'remote.autoForwardPortsSource';
export const PORT_AUTO_FALLBACK_SETTING = 'remote.autoForwardPortsFallback';
export const PORT_AUTO_SOURCE_SETTING_PROCESS = 'process';
export const PORT_AUTO_SOURCE_SETTING_OUTPUT = 'output';
export const PORT_AUTO_SOURCE_SETTING_HYBRID = 'hybrid';

export enum TunnelType {
	Candidate = 'Candidate',
	Detected = 'Detected',
	Forwarded = 'Forwarded',
	Add = 'Add'
}

export interface ITunnelItem {
	tunnelType: TunnelType;
	remoteHost: string;
	remotePort: number;
	localAddress?: string;
	protocol: TunnelProtocol;
	localUri?: URI;
	localPort?: number;
	name?: string;
	closeable?: boolean;
	source: {
		source: TunnelSource;
		description: string;
	};
	privacy: TunnelPrivacy;
	processDescription?: string;
	readonly label: string;
}

export enum TunnelEditId {
	None = 0,
	New = 1,
	Label = 2,
	LocalPort = 3
}

export interface HelpInformation {
	extensionDescription: IExtensionDescription;
	getStarted?: string | { id: string };
	documentation?: string;
	issues?: string;
	reportIssue?: string;
	remoteName?: string[] | string;
	virtualWorkspace?: string;
}

export enum PortsEnablement {
	Disabled = 0,
	ViewOnly = 1,
	AdditionalFeatures = 2
}

export interface IRemoteExplorerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeTargetType: Event<string[]>;
	targetType: string[];
	readonly onDidChangeHelpInformation: Event<readonly IExtensionPointUser<HelpInformation>[]>;
	helpInformation: IExtensionPointUser<HelpInformation>[];
	readonly tunnelModel: TunnelModel;
	readonly onDidChangeEditable: Event<{ tunnel: ITunnelItem; editId: TunnelEditId } | undefined>;
	setEditable(tunnelItem: ITunnelItem | undefined, editId: TunnelEditId, data: IEditableData | null): void;
	getEditableData(tunnelItem: ITunnelItem | undefined, editId?: TunnelEditId): IEditableData | undefined;
	forward(
		tunnelProperties: TunnelProperties,
		attributes?: Attributes | null
	): Promise<RemoteTunnel | string | undefined>;
	close(remote: { host: string; port: number }, reason: TunnelCloseReason): Promise<void>;
	setTunnelInformation(tunnelInformation: unknown): void;
	setCandidateFilter(filter: ((candidates: CandidatePort[]) => Promise<CandidatePort[]>) | undefined): IDisposable;
	onFoundNewCandidates(candidates: CandidatePort[]): void;
	restore(): Promise<void>;
	enablePortsFeatures(viewOnly: boolean): void;
	readonly onEnabledPortsFeatures: Event<void>;
	portsFeaturesEnabled: PortsEnablement;
	readonly namedProcesses: Map<number, string>;
}

// Stub: RemoteExplorerService is now handled by sidex-remote Rust crate
class RemoteExplorerService implements IRemoteExplorerService {
	_serviceBrand: undefined;

	private _tunnelModel = new TunnelModel();
	private readonly _onDidChangeTargetType = new Emitter<string[]>();
	readonly onDidChangeTargetType = this._onDidChangeTargetType.event;
	private readonly _onDidChangeHelpInformation = new Emitter<readonly IExtensionPointUser<HelpInformation>[]>();
	readonly onDidChangeHelpInformation = this._onDidChangeHelpInformation.event;
	private readonly _onDidChangeEditable = new Emitter<{ tunnel: ITunnelItem; editId: TunnelEditId } | undefined>();
	readonly onDidChangeEditable = this._onDidChangeEditable.event;
	private readonly _onEnabledPortsFeatures = new Emitter<void>();
	readonly onEnabledPortsFeatures = this._onEnabledPortsFeatures.event;
	readonly namedProcesses = new Map<number, string>();

	helpInformation: IExtensionPointUser<HelpInformation>[] = [];
	targetType: string[] = [];
	portsFeaturesEnabled: PortsEnablement = PortsEnablement.Disabled;

	get tunnelModel(): TunnelModel {
		return this._tunnelModel;
	}

	setEditable(_tunnelItem: ITunnelItem | undefined, _editId: TunnelEditId, _data: IEditableData | null): void {}
	getEditableData(_tunnelItem: ITunnelItem | undefined, _editId?: TunnelEditId): IEditableData | undefined {
		return undefined;
	}
	async forward(_tunnelProperties: TunnelProperties, _attributes?: Attributes | null): Promise<undefined> {
		return undefined;
	}
	async close(_remote: { host: string; port: number }, _reason: TunnelCloseReason): Promise<void> {}
	setTunnelInformation(_tunnelInformation: unknown): void {}
	setCandidateFilter(_filter: ((candidates: CandidatePort[]) => Promise<CandidatePort[]>) | undefined): IDisposable {
		return { dispose: () => {} };
	}
	onFoundNewCandidates(_candidates: CandidatePort[]): void {}
	async restore(): Promise<void> {}
	enablePortsFeatures(_viewOnly: boolean): void {}
}

registerSingleton(IRemoteExplorerService, RemoteExplorerService, InstantiationType.Delayed);
