/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';

const invalidMacAddresses = new Set([
	'00:00:00:00:00:00',
	'ff:ff:ff:ff:ff:ff',
	'ac:de:48:00:11:22'
]);

function validateMacAddress(candidate: string): boolean {
	const tempCandidate = candidate.replace(/\-/g, ':').toLowerCase();
	return !invalidMacAddresses.has(tempCandidate);
}

let _cachedMac: string | undefined;

export function getMac(): string {
	if (_cachedMac) {
		return _cachedMac;
	}

	// In Tauri, we can't do sync network interface queries.
	// Return a placeholder; callers should use getMacAsync() where possible.
	// This will be populated once getMacAsync resolves.
	throw new Error('Unable to retrieve mac address synchronously in Tauri. Use getMacAsync().');
}

export async function getMacAsync(): Promise<string> {
	if (_cachedMac) {
		return _cachedMac;
	}

	try {
		const macs: string[] = await invoke('os_get_mac_addresses');
		for (const mac of macs) {
			if (validateMacAddress(mac)) {
				_cachedMac = mac;
				return mac;
			}
		}
	} catch {
		// fall through
	}

	throw new Error('Unable to retrieve mac address (unexpected format)');
}

// Pre-populate the cache on load
getMacAsync().catch(() => { /* ignore */ });
