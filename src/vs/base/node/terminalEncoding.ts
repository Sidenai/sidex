/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { isWindows } from '../common/platform.js';

const windowsTerminalEncodings: Record<string, string> = {
	'437': 'cp437',
	'850': 'cp850',
	'852': 'cp852',
	'855': 'cp855',
	'857': 'cp857',
	'860': 'cp860',
	'861': 'cp861',
	'863': 'cp863',
	'865': 'cp865',
	'866': 'cp866',
	'869': 'cp869',
	'936': 'cp936',
	'1252': 'cp1252'
};

function toIconvLiteEncoding(encodingName: string): string {
	const normalizedEncodingName = encodingName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
	const JSCHARDET_TO_ICONV_ENCODINGS: Record<string, string> = {
		'ibm866': 'cp866',
		'big5': 'cp950'
	};
	return JSCHARDET_TO_ICONV_ENCODINGS[normalizedEncodingName] || normalizedEncodingName;
}

const UTF8 = 'utf8';

export async function resolveTerminalEncoding(verbose?: boolean): Promise<string> {
	let rawEncoding: string | undefined;

	const cliEncodingEnv = typeof globalThis !== 'undefined' ? (globalThis as any).process?.env?.['VSCODE_CLI_ENCODING'] : undefined;
	if (cliEncodingEnv) {
		if (verbose) {
			console.log(`Found VSCODE_CLI_ENCODING variable: ${cliEncodingEnv}`);
		}
		rawEncoding = cliEncodingEnv;
	} else if (isWindows) {
		try {
			rawEncoding = await invoke<string>('os_get_terminal_encoding');
			if (verbose) {
				console.log(`Terminal encoding from Rust backend: ${rawEncoding}`);
			}
			if (rawEncoding) {
				const key = rawEncoding as keyof typeof windowsTerminalEncodings;
				if (windowsTerminalEncodings[key]) {
					rawEncoding = windowsTerminalEncodings[key];
				}
			}
		} catch {
			rawEncoding = undefined;
		}
	} else {
		try {
			rawEncoding = await invoke<string>('os_get_locale_charmap');
			if (verbose) {
				console.log(`Locale charmap from Rust backend: ${rawEncoding}`);
			}
		} catch {
			rawEncoding = undefined;
		}
	}

	if (!rawEncoding || rawEncoding.toLowerCase() === 'utf-8' || rawEncoding.toLowerCase() === UTF8) {
		return UTF8;
	}

	return toIconvLiteEncoding(rawEncoding);
}
