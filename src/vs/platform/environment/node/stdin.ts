/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { randomPath } from '../../../base/common/extpath.js';

export function hasStdinWithoutTty() {
	// In Tauri webview, there is no stdin TTY
	return false;
}

export function stdinDataListener(_durationinMs: number): Promise<boolean> {
	// No stdin in Tauri webview
	return Promise.resolve(false);
}

export function getStdinFilePath(): string {
	return randomPath('/tmp', 'code-stdin', 3);
}

export async function readFromStdin(_targetPath: string, _verbose: boolean, onEnd?: Function): Promise<void> {
	// In Tauri, stdin piping is not available from the webview.
	// If needed, the Rust backend handles stdin piping.
	onEnd?.();
}
