/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { ProcessItem } from '../common/processes.js';

export const JS_FILENAME_PATTERN = /[a-zA-Z-]+\.js\b/g;

export function listProcesses(rootPid: number): Promise<ProcessItem> {
	return invoke<ProcessItem>('process_list', { rootPid });
}
