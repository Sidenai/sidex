/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUserDataInitializer } from '../../userData/browser/userDataInit.js';

export class UserDataProfileInitializer implements IUserDataInitializer {
	_serviceBrand: undefined;

	async whenInitializationFinished(): Promise<void> {}
	async requiresInitialization(): Promise<boolean> {
		return false;
	}
	async initializeRequiredResources(): Promise<void> {}
	async initializeOtherResources(_instantiationService: IInstantiationService): Promise<void> {}
	async initializeInstalledExtensions(_instantiationService: IInstantiationService): Promise<void> {}
}
