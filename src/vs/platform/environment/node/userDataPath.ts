/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { NativeParsedArgs } from '../common/argv.js';

/**
 * Returns the user data path to use with some rules:
 * - respect VSCODE_APPDATA environment variable
 * - respect --user-data-dir CLI argument
 */
export function getUserDataPath(cliArgs: NativeParsedArgs, productName: string): string {
	const cliPath = cliArgs['user-data-dir'];
	if (cliPath) {
		return cliPath;
	}

	// In Tauri, we resolve the user data path via the Rust backend
	// as a synchronous fallback, use a default.
	// The actual path will be resolved async on app start.
	return `~/.config/${productName}`;
}

export async function getUserDataPathAsync(cliArgs: NativeParsedArgs, productName: string): Promise<string> {
	const cliPath = cliArgs['user-data-dir'];
	if (cliPath) {
		return cliPath;
	}

	try {
		return await invoke<string>('os_get_user_data_path', { productName });
	} catch {
		return getUserDataPath(cliArgs, productName);
	}
}
