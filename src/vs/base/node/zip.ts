/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { CancellationToken } from '../common/cancellation.js';
import * as path from '../common/path.js';
import { Promises } from './pfs.js';
import * as nls from '../../nls.js';

export const CorruptZipMessage: string = 'end of central directory record signature not found';

export interface IExtractOptions {
	overwrite?: boolean;
	sourcePath?: string;
}

export type ExtractErrorType = 'CorruptZip' | 'Incomplete';

export class ExtractError extends Error {
	readonly type?: ExtractErrorType;

	constructor(type: ExtractErrorType | undefined, cause: Error) {
		let message = cause.message;
		switch (type) {
			case 'CorruptZip': message = `Corrupt ZIP: ${message}`; break;
		}
		super(message);
		this.type = type;
		this.cause = cause;
	}
}

export interface IFile {
	path: string;
	contents?: Uint8Array | string;
	localPath?: string;
}

export async function zip(zipPath: string, files: IFile[]): Promise<string> {
	const fileData = files.map(f => ({
		path: f.path,
		contents: f.contents instanceof Uint8Array ? Array.from(f.contents) : f.contents,
		localPath: f.localPath
	}));
	await invoke('zip_create', { zipPath, files: fileData });
	return zipPath;
}

export async function extract(zipPath: string, targetPath: string, options: IExtractOptions = {}, _token: CancellationToken): Promise<void> {
	if (options.overwrite) {
		await Promises.rm(targetPath);
	}

	await invoke('zip_extract', {
		zipPath,
		targetPath,
		sourcePath: options.sourcePath
	});
}

export async function buffer(zipPath: string, filePath: string): Promise<Uint8Array> {
	const data: number[] = await invoke('zip_read_entry', { zipPath, filePath });
	return new Uint8Array(data);
}
