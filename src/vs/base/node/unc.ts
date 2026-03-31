/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// UNC host management - in Tauri these are no-ops as we don't use
// Node.js custom process properties for UNC host restrictions.

export function getUNCHostAllowlist(): string[] {
	return [];
}

export function addUNCHostToAllowlist(_allowedHost: string | string[]): void {
	// No-op in Tauri
}

export function getUNCHost(maybeUNCPath: string | undefined | null): string | undefined {
	if (typeof maybeUNCPath !== 'string') {
		return undefined;
	}

	const uncRoots = [
		'\\\\.\\UNC\\',
		'\\\\?\\UNC\\',
		'\\\\'
	];

	let host = undefined;

	for (const uncRoot of uncRoots) {
		const indexOfUNCRoot = maybeUNCPath.indexOf(uncRoot);
		if (indexOfUNCRoot !== 0) {
			continue;
		}

		const indexOfUNCPath = maybeUNCPath.indexOf('\\', uncRoot.length);
		if (indexOfUNCPath === -1) {
			continue;
		}

		const hostCandidate = maybeUNCPath.substring(uncRoot.length, indexOfUNCPath);
		if (hostCandidate) {
			host = hostCandidate;
			break;
		}
	}

	return host;
}

export function disableUNCAccessRestrictions(): void {
	// No-op in Tauri
}

export function isUNCAccessRestrictionsDisabled(): boolean {
	return true;
}
