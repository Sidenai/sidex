/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { randomPath } from '../../../base/common/extpath.js';

export function createWaitMarkerFileSync(verbose?: boolean): string | undefined {
	// In Tauri, we can't do sync file writes from the webview.
	// Use a fire-and-forget async approach via invoke.
	const randomWaitMarkerPath = randomPath('/tmp');

	try {
		invoke('fs_write_file', { path: randomWaitMarkerPath, contents: '' }).catch(err => {
			if (verbose) {
				console.error(`Failed to create marker file for --wait: ${err}`);
			}
		});

		if (verbose) {
			console.log(`Marker file for --wait created: ${randomWaitMarkerPath}`);
		}
		return randomWaitMarkerPath;
	} catch (err) {
		if (verbose) {
			console.error(`Failed to create marker file for --wait: ${err}`);
		}
		return undefined;
	}
}
