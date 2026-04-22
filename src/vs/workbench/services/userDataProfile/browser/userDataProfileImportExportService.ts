/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import {
	IUserDataProfile,
	ProfileResourceTypeFlags
} from '../../../../platform/userDataProfile/common/userDataProfile.js';
import {
	IUserDataProfileImportExportService,
	IUserDataProfileContentHandler,
	IUserDataProfileTemplate,
	IUserDataProfileCreateOptions
} from '../common/userDataProfile.js';

class NullUserDataProfileImportExportService implements IUserDataProfileImportExportService {
	declare readonly _serviceBrand: undefined;

	registerProfileContentHandler(_id: string, _profileContentHandler: IUserDataProfileContentHandler): IDisposable {
		return { dispose() {} };
	}
	unregisterProfileContentHandler(_id: string): void {}
	async resolveProfileTemplate(_uri: URI): Promise<IUserDataProfileTemplate | null> {
		return null;
	}
	async exportProfile(_profile: IUserDataProfile, _exportFlags?: ProfileResourceTypeFlags): Promise<void> {}
	async createFromProfile(
		_from: IUserDataProfile,
		_options: IUserDataProfileCreateOptions,
		_token: CancellationToken
	): Promise<IUserDataProfile | undefined> {
		return undefined;
	}
	async createProfileFromTemplate(
		_profileTemplate: IUserDataProfileTemplate,
		_options: IUserDataProfileCreateOptions,
		_token: CancellationToken
	): Promise<IUserDataProfile | undefined> {
		return undefined;
	}
	async createTroubleshootProfile(): Promise<void> {}
}

registerSingleton(
	IUserDataProfileImportExportService,
	NullUserDataProfileImportExportService,
	InstantiationType.Delayed
);
