/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import * as path from '../common/path.js';
import * as pfs from './pfs.js';

export interface IPowerShellExeDetails {
	readonly displayName: string;
	readonly exePath: string;
}

export async function* enumeratePowerShellInstallations(): AsyncIterable<IPowerShellExeDetails> {
	try {
		const installations = await invoke<IPowerShellExeDetails[]>('os_enumerate_powershell');
		for (const install of installations) {
			yield install;
		}
	} catch {
		// TODO: Fallback to basic path checks
		const defaultPaths = [
			'/usr/local/bin/pwsh',
			'/usr/bin/pwsh',
			'/snap/bin/pwsh',
		];

		for (const p of defaultPaths) {
			if (await pfs.SymlinkSupport.existsFile(p)) {
				yield { exePath: p, displayName: 'PowerShell' };
				return;
			}
		}
	}
}

export async function getFirstAvailablePowerShellInstallation(): Promise<IPowerShellExeDetails | null> {
	for await (const pwsh of enumeratePowerShellInstallations()) {
		return pwsh;
	}
	return null;
}
