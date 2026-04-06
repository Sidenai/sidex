/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProfileResource, IProfileResourceChildTreeItem, IProfileResourceInitializer, IProfileResourceTreeItem, IUserDataProfileService } from '../common/userDataProfile.js';
// Stub function to avoid importing heavy userDataSync module
const updateIgnoredSettings = (settingsContent: string, _ignoredSettings: string[], _formattingOptions: unknown): string => settingsContent;
// Inline interface to avoid importing heavy userDataSync module
export const IUserDataSyncUtilService = Symbol('IUserDataSyncUtilService');
export interface IUserDataSyncUtilService {
	_serviceBrand: undefined;
	resolveDefaultIgnoredSettings(): Promise<string[]>;
}
import { ITreeItemCheckboxState, TreeItemCollapsibleState } from '../../../common/views.js';
import { IUserDataProfile, ProfileResourceType } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { API_OPEN_EDITOR_COMMAND_ID } from '../../../browser/parts/editor/editorCommands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

interface ISettingsContent {
	settings: string | null;
}

export class SettingsResourceInitializer implements IProfileResourceInitializer {

	constructor(
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
	}

	async initialize(content: string): Promise<void> {
		const settingsContent: ISettingsContent = JSON.parse(content);
		if (settingsContent.settings === null) {
			this.logService.info(`Initializing Profile: No settings to apply...`);
			return;
		}
		await this.fileService.writeFile(this.userDataProfileService.currentProfile.settingsResource, VSBuffer.fromString(settingsContent.settings));
	}
}

export class SettingsResource implements IProfileResource {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
	}

	async getContent(profile: IUserDataProfile): Promise<string> {
		const settingsContent = await this.getSettingsContent(profile);
		return JSON.stringify(settingsContent);
	}

	async getSettingsContent(profile: IUserDataProfile): Promise<ISettingsContent> {
		const localContent = await this.getLocalFileContent(profile);
		if (localContent === null) {
			return { settings: null };
		} else {
			return { settings: localContent || '{}' };
		}
	}

	async apply(content: string, profile: IUserDataProfile): Promise<void> {
		const settingsContent: ISettingsContent = JSON.parse(content);
		if (settingsContent.settings === null) {
			this.logService.info(`Importing Profile (${profile.name}): No settings to apply...`);
			return;
		}
		await this.fileService.writeFile(profile.settingsResource, VSBuffer.fromString(settingsContent.settings));
	}

	private async getLocalFileContent(profile: IUserDataProfile): Promise<string | null> {
		try {
			const content = await this.fileService.readFile(profile.settingsResource);
			return content.value.toString();
		} catch (error) {
			// File not found
			if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return null;
			} else {
				throw error;
			}
		}
	}

}

export class SettingsResourceTreeItem implements IProfileResourceTreeItem {

	readonly type = ProfileResourceType.Settings;
	readonly handle = ProfileResourceType.Settings;
	readonly label = { label: localize('settings', "Settings") };
	readonly collapsibleState = TreeItemCollapsibleState.Expanded;
	checkbox: ITreeItemCheckboxState | undefined;

	constructor(
		private readonly profile: IUserDataProfile,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	async getChildren(): Promise<IProfileResourceChildTreeItem[]> {
		return [{
			handle: this.profile.settingsResource.toString(),
			resourceUri: this.profile.settingsResource,
			collapsibleState: TreeItemCollapsibleState.None,
			parent: this,
			accessibilityInformation: {
				label: this.uriIdentityService.extUri.basename(this.profile.settingsResource)
			},
			command: {
				id: API_OPEN_EDITOR_COMMAND_ID,
				title: '',
				arguments: [this.profile.settingsResource, undefined, undefined]
			}
		}];
	}

	async hasContent(): Promise<boolean> {
		const settingsContent = await this.instantiationService.createInstance(SettingsResource).getSettingsContent(this.profile);
		return settingsContent.settings !== null;
	}

	async getContent(): Promise<string> {
		return this.instantiationService.createInstance(SettingsResource).getContent(this.profile);
	}

	isFromDefaultProfile(): boolean {
		return !this.profile.isDefault && !!this.profile.useDefaultFlags?.settings;
	}

}
