/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import * as platform from '../common/platform.js';

/**
 * Gets the detected default shell for the _system_, not to be confused with VS Code's _default_
 * shell that the terminal uses by default.
 * @param os The platform to detect the shell of.
 */
export async function getSystemShell(os: platform.OperatingSystem, env: platform.IProcessEnvironment): Promise<string> {
	if (os === platform.OperatingSystem.Windows) {
		return getSystemShellWindows(env);
	}

	return getSystemShellUnixLike(os, env);
}

let _TERMINAL_DEFAULT_SHELL_UNIX_LIKE: string | null = null;
function getSystemShellUnixLike(os: platform.OperatingSystem, env: platform.IProcessEnvironment): string {
	if (platform.isLinux && os === platform.OperatingSystem.Macintosh || platform.isMacintosh && os === platform.OperatingSystem.Linux) {
		return '/bin/bash';
	}

	if (!_TERMINAL_DEFAULT_SHELL_UNIX_LIKE) {
		let unixLikeTerminal: string | undefined | null;
		if (platform.isWindows) {
			unixLikeTerminal = '/bin/bash';
		} else {
			unixLikeTerminal = env['SHELL'];

			if (!unixLikeTerminal) {
				unixLikeTerminal = 'sh';
			}

			if (unixLikeTerminal === '/bin/false') {
				unixLikeTerminal = '/bin/bash';
			}
		}
		_TERMINAL_DEFAULT_SHELL_UNIX_LIKE = unixLikeTerminal;
	}
	return _TERMINAL_DEFAULT_SHELL_UNIX_LIKE;
}

let _TERMINAL_DEFAULT_SHELL_WINDOWS: string | null = null;
async function getSystemShellWindows(env: platform.IProcessEnvironment): Promise<string> {
	if (!_TERMINAL_DEFAULT_SHELL_WINDOWS) {
		try {
			const shell = await invoke<string>('os_get_default_shell');
			_TERMINAL_DEFAULT_SHELL_WINDOWS = shell;
		} catch {
			_TERMINAL_DEFAULT_SHELL_WINDOWS = env['comspec'] || 'cmd.exe';
		}
	}
	return _TERMINAL_DEFAULT_SHELL_WINDOWS;
}
