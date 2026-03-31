/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { isWindows } from '../common/platform.js';

let versionInfo: { release: string; buildNumber: number } | undefined;

export async function initWindowsVersionInfo() {
	if (versionInfo) {
		return;
	}

	if (!isWindows) {
		versionInfo = { release: '0.0.0', buildNumber: 0 };
		return;
	}

	try {
		const info = await invoke<{ release: string; build_number: number }>('os_get_windows_version');
		versionInfo = { release: info.release, buildNumber: info.build_number };
	} catch {
		versionInfo = { release: '10.0.0', buildNumber: 0 };
	}
}

export async function getWindowsRelease(): Promise<string> {
	if (!versionInfo) {
		await initWindowsVersionInfo();
	}
	return versionInfo!.release;
}

export async function getWindowsBuildNumberAsync(): Promise<number> {
	if (!versionInfo) {
		await initWindowsVersionInfo();
	}
	return versionInfo!.buildNumber;
}

export function getWindowsBuildNumberSync(): number {
	return versionInfo?.buildNumber ?? 0;
}

export function getWindowsReleaseSync(): string {
	return versionInfo?.release ?? '10.0.0';
}
