/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import {
	ExtensionInstallLocation,
	IExtensionManagementServer,
	IExtensionManagementServerService
} from './extensionManagement.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { isWeb } from '../../../../base/common/platform.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WebExtensionManagementService } from './webExtensionManagementService.js';
import { IExtension } from '../../../../platform/extensions/common/extensions.js';

export class ExtensionManagementServerService implements IExtensionManagementServerService {
	declare readonly _serviceBrand: undefined;

	readonly localExtensionManagementServer: IExtensionManagementServer | null = null;
	readonly remoteExtensionManagementServer: IExtensionManagementServer | null = null;
	readonly webExtensionManagementServer: IExtensionManagementServer | null = null;

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		if (isWeb) {
			const extensionManagementService = instantiationService.createInstance(WebExtensionManagementService);
			this.webExtensionManagementServer = {
				id: 'web',
				extensionManagementService,
				label: localize('browser', 'Browser')
			};
		}
	}

	getExtensionManagementServer(extension: IExtension): IExtensionManagementServer {
		if (this.webExtensionManagementServer) {
			return this.webExtensionManagementServer;
		}
		throw new Error(`Invalid Extension ${extension.location}`);
	}

	getExtensionInstallLocation(_extension: IExtension): ExtensionInstallLocation | null {
		return ExtensionInstallLocation.Web;
	}
}

registerSingleton(IExtensionManagementServerService, ExtensionManagementServerService, InstantiationType.Delayed);
