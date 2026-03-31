/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { getCaseInsensitive } from '../common/objects.js';
import * as path from '../common/path.js';
import * as Platform from '../common/platform.js';
import * as processCommon from '../common/process.js';
import { CommandOptions, ForkOptions, Source, SuccessData, TerminateResponse, TerminateResponseCode } from '../common/processes.js';
import * as Types from '../common/types.js';
import * as pfs from './pfs.js';
export { Source, TerminateResponseCode, type CommandOptions, type ForkOptions, type SuccessData, type TerminateResponse };

export type ValueCallback<T> = (value: T | Promise<T>) => void;
export type ErrorCallback = (error?: any) => void;
export type ProgressCallback<T> = (progress: T) => void;


export function getWindowsShell(env = processCommon.env): string {
	return env['comspec'] || 'cmd.exe';
}

export interface IQueuedSender {
	send: (msg: any) => void;
}

export function createQueuedSender(_childProcess: any): IQueuedSender {
	// TODO: In Tauri, IPC between processes is handled differently.
	// This is a stub that buffers messages and logs them.
	const msgQueue: any[] = [];
	let processing = false;

	const send = function (msg: any): void {
		msgQueue.push(msg);
		if (!processing) {
			processing = true;
			Promise.resolve().then(async () => {
				while (msgQueue.length > 0) {
					const m = msgQueue.shift();
					try {
						await invoke('ipc_send_message', { message: JSON.stringify(m) });
					} catch (error) {
						console.error('Failed to send IPC message via Tauri:', error);
					}
				}
				processing = false;
			});
		}
	};

	return { send };
}

async function fileExistsDefault(filePath: string): Promise<boolean> {
	if (await pfs.Promises.exists(filePath)) {
		try {
			const result = await invoke<{ is_directory: boolean }>('fs_stat', { path: filePath });
			return !result.is_directory;
		} catch (e: any) {
			if (String(e).includes('EACCES')) {
				const result = await invoke<{ is_directory: boolean }>('fs_lstat', { path: filePath });
				return !result.is_directory;
			}
		}
		return false;
	}
	return false;
}

export async function findExecutable(command: string, cwd?: string, paths?: string[], env: Platform.IProcessEnvironment = processCommon.env, fileExists: (path: string) => Promise<boolean> = fileExistsDefault): Promise<string | undefined> {
	if (path.isAbsolute(command)) {
		return await fileExists(command) ? command : undefined;
	}
	if (cwd === undefined) {
		cwd = processCommon.cwd();
	}
	const dir = path.dirname(command);
	if (dir !== '.') {
		const fullPath = path.join(cwd, command);
		return await fileExists(fullPath) ? fullPath : undefined;
	}
	const envPath = getCaseInsensitive(env, 'PATH');
	if (paths === undefined && Types.isString(envPath)) {
		paths = envPath.split(path.delimiter);
	}
	if (paths === undefined || paths.length === 0) {
		const fullPath = path.join(cwd, command);
		return await fileExists(fullPath) ? fullPath : undefined;
	}

	for (const pathEntry of paths) {
		let fullPath: string;
		if (path.isAbsolute(pathEntry)) {
			fullPath = path.join(pathEntry, command);
		} else {
			fullPath = path.join(cwd, pathEntry, command);
		}
		if (Platform.isWindows) {
			const pathExt = getCaseInsensitive(env, 'PATHEXT') as string || '.COM;.EXE;.BAT;.CMD';
			const pathExtsFound = pathExt.split(';').map(async ext => {
				const withExtension = fullPath + ext;
				return await fileExists(withExtension) ? withExtension : undefined;
			});
			for (const foundPromise of pathExtsFound) {
				const found = await foundPromise;
				if (found) {
					return found;
				}
			}
		}

		if (await fileExists(fullPath)) {
			return fullPath;
		}
	}
	const fullPath = path.join(cwd, command);
	return await fileExists(fullPath) ? fullPath : undefined;
}

/**
 * Kills a process and all its children via Tauri backend.
 */
export async function killTree(pid: number, forceful = false) {
	await invoke('process_kill_tree', { pid, forceful });
}
