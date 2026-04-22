/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { URI, UriDto } from '../../../base/common/uri.js';
import {
	DidChangeProfilesEvent,
	IUserDataProfile,
	IUserDataProfileOptions,
	IUserDataProfilesService,
	IUserDataProfileUpdateOptions,
	reviveProfile
} from './userDataProfile.js';
import { IAnyWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { Disposable } from '../../../base/common/lifecycle.js';

export class UserDataProfilesService extends Disposable implements IUserDataProfilesService {
	readonly _serviceBrand: undefined;

	get defaultProfile(): IUserDataProfile {
		return this.profiles[0];
	}
	private _profiles: IUserDataProfile[] = [];
	get profiles(): IUserDataProfile[] {
		return this._profiles;
	}

	private readonly _onDidChangeProfiles = this._register(new Emitter<DidChangeProfilesEvent>());
	readonly onDidChangeProfiles = this._onDidChangeProfiles.event;
	readonly onDidResetWorkspaces: Event<void>;

	constructor(
		profiles: readonly UriDto<IUserDataProfile>[],
		readonly profilesHome: URI,
		private readonly channel: IChannel
	) {
		super();
		this._profiles = profiles.map(p => reviveProfile(p, this.profilesHome.scheme));
		this._register(
			this.channel.listen<DidChangeProfilesEvent>('onDidChangeProfiles')(e => {
				const added = e.added.map(p => reviveProfile(p, this.profilesHome.scheme));
				const removed = e.removed.map(p => reviveProfile(p, this.profilesHome.scheme));
				const updated = e.updated.map(p => reviveProfile(p, this.profilesHome.scheme));
				this._profiles = e.all.map(p => reviveProfile(p, this.profilesHome.scheme));
				this._onDidChangeProfiles.fire({ added, removed, updated, all: this.profiles });
			})
		);
		this.onDidResetWorkspaces = this.channel.listen<void>('onDidResetWorkspaces');
	}

	async createNamedProfile(
		name: string,
		options?: IUserDataProfileOptions,
		workspaceIdentifier?: IAnyWorkspaceIdentifier
	): Promise<IUserDataProfile> {
		return reviveProfile(
			await this.channel.call<UriDto<IUserDataProfile>>('createNamedProfile', [name, options, workspaceIdentifier]),
			this.profilesHome.scheme
		);
	}

	async createProfile(
		id: string,
		name: string,
		options?: IUserDataProfileOptions,
		workspaceIdentifier?: IAnyWorkspaceIdentifier
	): Promise<IUserDataProfile> {
		return reviveProfile(
			await this.channel.call<UriDto<IUserDataProfile>>('createProfile', [id, name, options, workspaceIdentifier]),
			this.profilesHome.scheme
		);
	}

	async createTransientProfile(workspaceIdentifier?: IAnyWorkspaceIdentifier): Promise<IUserDataProfile> {
		return reviveProfile(
			await this.channel.call<UriDto<IUserDataProfile>>('createTransientProfile', [workspaceIdentifier]),
			this.profilesHome.scheme
		);
	}

	async setProfileForWorkspace(workspaceIdentifier: IAnyWorkspaceIdentifier, profile: IUserDataProfile): Promise<void> {
		await this.channel.call('setProfileForWorkspace', [workspaceIdentifier, profile]);
	}

	removeProfile(profile: IUserDataProfile): Promise<void> {
		return this.channel.call('removeProfile', [profile]);
	}

	async updateProfile(
		profile: IUserDataProfile,
		updateOptions: IUserDataProfileUpdateOptions
	): Promise<IUserDataProfile> {
		return reviveProfile(
			await this.channel.call<UriDto<IUserDataProfile>>('updateProfile', [profile, updateOptions]),
			this.profilesHome.scheme
		);
	}

	resetWorkspaces(): Promise<void> {
		return this.channel.call('resetWorkspaces');
	}
	cleanUp(): Promise<void> {
		return this.channel.call('cleanUp');
	}
	cleanUpTransientProfiles(): Promise<void> {
		return this.channel.call('cleanUpTransientProfiles');
	}
}
