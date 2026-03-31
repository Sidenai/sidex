/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';

export async function checksum(path: string, sha256hash: string | undefined): Promise<void> {
	const hash = await invoke<string>('crypto_hash_file', { path, algorithm: 'sha256' });

	if (hash !== sha256hash) {
		throw new Error('Hash mismatch');
	}
}
