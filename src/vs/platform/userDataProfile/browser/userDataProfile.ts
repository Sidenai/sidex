/*---------------------------------------------------------------------------------------------
 *  SideX - Profile registry backed by the Rust `sidex-profiles` crate.
 *--------------------------------------------------------------------------------------------*/

import { BroadcastDataChannel } from '../../../base/browser/broadcast.js';
import { revive } from '../../../base/common/marshalling.js';
import { UriDto } from '../../../base/common/uri.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { IUriIdentityService } from '../../uriIdentity/common/uriIdentity.js';
import {
	DidChangeProfilesEvent,
	IUserDataProfile,
	IUserDataProfilesService,
	reviveProfile,
	StoredProfileAssociations,
	StoredUserDataProfile,
	UserDataProfilesService
} from '../common/userDataProfile.js';

type BroadcastedProfileChanges = UriDto<Omit<DidChangeProfilesEvent, 'all'>>;

const PROFILES_CHANGED_EVENT = 'sidex://profiles/changed';

interface TauriBindings {
	invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
	listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
}

async function loadTauri(): Promise<TauriBindings | undefined> {
	try {
		const [core, event] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
		return { invoke: core.invoke, listen: event.listen };
	} catch {
		return undefined;
	}
}

export class BrowserUserDataProfilesService extends UserDataProfilesService implements IUserDataProfilesService {
	private readonly changesBroadcastChannel: BroadcastDataChannel<BroadcastedProfileChanges>;
	private readonly _tauri: Promise<TauriBindings | undefined>;

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ILogService logService: ILogService
	) {
		super(environmentService, fileService, uriIdentityService, logService);

		this._tauri = loadTauri();
		this.changesBroadcastChannel = this._register(
			new BroadcastDataChannel<BroadcastedProfileChanges>(`${UserDataProfilesService.PROFILES_KEY}.changes`)
		);
		this._register(
			this.changesBroadcastChannel.onDidReceiveData(changes => {
				try {
					this._profilesObject = undefined;
					const added = changes.added.map(p => reviveProfile(p, this.profilesHome.scheme));
					const removed = changes.removed.map(p => reviveProfile(p, this.profilesHome.scheme));
					const updated = changes.updated.map(p => reviveProfile(p, this.profilesHome.scheme));

					this.updateTransientProfiles(
						added.filter(a => a.isTransient),
						removed.filter(a => a.isTransient),
						updated.filter(a => a.isTransient)
					);

					this._onDidChangeProfiles.fire({
						added,
						removed,
						updated,
						all: this.profiles
					});
				} catch (error) {
					/* ignore */
				}
			})
		);

		void this.hydrateFromDisk();
		void this.subscribeToDiskChanges();
	}

	private updateTransientProfiles(
		added: IUserDataProfile[],
		removed: IUserDataProfile[],
		updated: IUserDataProfile[]
	): void {
		if (added.length) {
			this.transientProfilesObject.profiles.push(...added);
		}
		if (removed.length || updated.length) {
			const allTransientProfiles = this.transientProfilesObject.profiles;
			this.transientProfilesObject.profiles = [];
			for (const profile of allTransientProfiles) {
				if (removed.some(p => profile.id === p.id)) {
					continue;
				}
				this.transientProfilesObject.profiles.push(updated.find(p => profile.id === p.id) ?? profile);
			}
		}
	}

	private async hydrateFromDisk(): Promise<void> {
		const tauri = await this._tauri;
		if (!tauri) {
			return;
		}

		try {
			const [profiles, associations] = await Promise.all([
				tauri.invoke<StoredUserDataProfile[]>('profiles_load'),
				tauri.invoke<StoredProfileAssociations>('profiles_load_associations')
			]);

			const encodedProfiles = JSON.stringify(profiles ?? []);
			const encodedAssociations = JSON.stringify(associations ?? {});

			if (localStorage.getItem(UserDataProfilesService.PROFILES_KEY) !== encodedProfiles) {
				localStorage.setItem(UserDataProfilesService.PROFILES_KEY, encodedProfiles);
			}
			if (localStorage.getItem(UserDataProfilesService.PROFILE_ASSOCIATIONS_KEY) !== encodedAssociations) {
				localStorage.setItem(UserDataProfilesService.PROFILE_ASSOCIATIONS_KEY, encodedAssociations);
			}
		} catch (error) {
			this.logService.warn('[sidex-profiles] hydrate failed', error);
		}
	}

	private async subscribeToDiskChanges(): Promise<void> {
		const tauri = await this._tauri;
		if (!tauri) {
			return;
		}
		try {
			const unlisten = await tauri.listen(PROFILES_CHANGED_EVENT, () => {
				void this.hydrateFromDisk();
			});
			this._register({ dispose: () => unlisten() });
		} catch (error) {
			this.logService.warn('[sidex-profiles] listen failed', error);
		}
	}

	private async mirrorToDisk(command: string, payload: Record<string, unknown>): Promise<void> {
		const tauri = await this._tauri;
		if (!tauri) {
			return;
		}
		try {
			await tauri.invoke(command, payload);
		} catch (error) {
			this.logService.warn(`[sidex-profiles] ${command} failed`, error);
		}
	}

	protected override getStoredProfiles(): StoredUserDataProfile[] {
		try {
			const value = localStorage.getItem(UserDataProfilesService.PROFILES_KEY);
			if (value) {
				return revive(JSON.parse(value));
			}
		} catch (error) {
			this.logService.error(error);
		}
		return [];
	}

	protected override triggerProfilesChanges(
		added: IUserDataProfile[],
		removed: IUserDataProfile[],
		updated: IUserDataProfile[]
	) {
		super.triggerProfilesChanges(added, removed, updated);
		this.changesBroadcastChannel.postData({ added, removed, updated });
	}

	protected override saveStoredProfiles(storedProfiles: StoredUserDataProfile[]): void {
		localStorage.setItem(UserDataProfilesService.PROFILES_KEY, JSON.stringify(storedProfiles));
		void this.mirrorToDisk('profiles_save', { profiles: storedProfiles });
	}

	protected override getStoredProfileAssociations(): StoredProfileAssociations {
		try {
			const value = localStorage.getItem(UserDataProfilesService.PROFILE_ASSOCIATIONS_KEY);
			if (value) {
				return JSON.parse(value);
			}
		} catch (error) {
			this.logService.error(error);
		}
		return {};
	}

	protected override saveStoredProfileAssociations(storedProfileAssociations: StoredProfileAssociations): void {
		localStorage.setItem(UserDataProfilesService.PROFILE_ASSOCIATIONS_KEY, JSON.stringify(storedProfileAssociations));
		void this.mirrorToDisk('profiles_save_associations', { value: storedProfileAssociations });
	}
}
