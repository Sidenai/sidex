/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import * as Platform from '../common/platform.js';

type ReleaseInfo = {
	id: string;
	id_like?: string;
	version_id?: string;
};

export async function getOSReleaseInfo(errorLogger: (error: string | Error) => void): Promise<ReleaseInfo | undefined> {
	if (Platform.isMacintosh || Platform.isWindows) {
		return;
	}

	try {
		return await invoke<ReleaseInfo>('os_get_release_info');
	} catch (err: any) {
		errorLogger(err);
		return undefined;
	}
}
