/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { ResourceQueue } from '../common/async.js';
import { isEqualOrParent, isRootOrDriveLetter, randomPath } from '../common/extpath.js';
import { normalizeNFC } from '../common/normalization.js';
import { basename, dirname, join, normalize, sep } from '../common/path.js';
import { isLinux, isMacintosh, isWindows } from '../common/platform.js';
import { extUriBiasedIgnorePathCase } from '../common/resources.js';
import { URI } from '../common/uri.js';
import { CancellationToken } from '../common/cancellation.js';
import { rtrim } from '../common/strings.js';

//#region rimraf

export enum RimRafMode {
	UNLINK,
	MOVE
}

async function rimraf(path: string, mode: RimRafMode.UNLINK): Promise<void>;
async function rimraf(path: string, mode: RimRafMode.MOVE, moveToPath?: string): Promise<void>;
async function rimraf(path: string, mode?: RimRafMode, moveToPath?: string): Promise<void>;
async function rimraf(path: string, mode = RimRafMode.UNLINK, _moveToPath?: string): Promise<void> {
	if (isRootOrDriveLetter(path)) {
		throw new Error('rimraf - will refuse to recursively delete root');
	}

	try {
		await invoke('fs_remove', { path, recursive: true });
	} catch (error: any) {
		if (error?.code !== 'ENOENT' && !String(error).includes('not found')) {
			throw error;
		}
	}
}

//#endregion

//#region readdir with NFC support (macos)

export interface IDirent {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

interface IRawDirent {
	name: string;
	is_file: boolean;
	is_directory: boolean;
	is_symlink: boolean;
}

async function readdir(path: string): Promise<string[]>;
async function readdir(path: string, options: { withFileTypes: true }): Promise<IDirent[]>;
async function readdir(path: string, options?: { withFileTypes: true }): Promise<(string | IDirent)[]> {
	if (options?.withFileTypes) {
		const entries: IRawDirent[] = await invoke('fs_read_dir_with_types', { path });
		return handleDirectoryChildren(entries.map(e => ({
			name: e.name,
			isFile: () => e.is_file,
			isDirectory: () => e.is_directory,
			isSymbolicLink: () => e.is_symlink,
		})));
	}

	const entries: string[] = await invoke('fs_read_dir', { path });
	return handleDirectoryChildren(entries);
}

function handleDirectoryChildren(children: string[]): string[];
function handleDirectoryChildren(children: IDirent[]): IDirent[];
function handleDirectoryChildren(children: (string | IDirent)[]): (string | IDirent)[];
function handleDirectoryChildren(children: (string | IDirent)[]): (string | IDirent)[] {
	return children.map(child => {
		if (typeof child === 'string') {
			return isMacintosh ? normalizeNFC(child) : child;
		}
		child.name = isMacintosh ? normalizeNFC(child.name) : child.name;
		return child;
	});
}

async function readDirsInDir(dirPath: string): Promise<string[]> {
	const children = await readdir(dirPath);
	const directories: string[] = [];
	for (const child of children) {
		if (await SymlinkSupport.existsDirectory(join(dirPath, child))) {
			directories.push(child);
		}
	}
	return directories;
}

//#endregion

//#region whenDeleted()

export function whenDeleted(path: string, intervalMs = 1000): Promise<void> {
	return new Promise<void>(resolve => {
		let running = false;
		const interval = setInterval(async () => {
			if (!running) {
				running = true;
				try {
					await invoke('fs_access', { path });
					running = false;
				} catch {
					running = false;
					clearInterval(interval);
					resolve(undefined);
				}
			}
		}, intervalMs);
	});
}

//#endregion

//#region Methods with symbolic links support

interface IRawStat {
	size: number;
	mtime: number;
	birthtime: number;
	mode: number;
	is_file: boolean;
	is_directory: boolean;
	is_symlink: boolean;
}

class TauriStats {
	readonly size: number;
	readonly mtime: Date;
	readonly birthtime: Date;
	readonly mode: number;
	private readonly _isFile: boolean;
	private readonly _isDirectory: boolean;
	private readonly _isSymlink: boolean;

	constructor(raw: IRawStat) {
		this.size = raw.size;
		this.mtime = new Date(raw.mtime);
		this.birthtime = new Date(raw.birthtime);
		this.mode = raw.mode;
		this._isFile = raw.is_file;
		this._isDirectory = raw.is_directory;
		this._isSymlink = raw.is_symlink;
	}

	isFile(): boolean { return this._isFile; }
	isDirectory(): boolean { return this._isDirectory; }
	isSymbolicLink(): boolean { return this._isSymlink; }
}

export namespace SymlinkSupport {

	export interface IStats {
		stat: TauriStats;
		symbolicLink?: { dangling: boolean };
	}

	export async function stat(path: string): Promise<IStats> {
		try {
			const lstatRaw: IRawStat = await invoke('fs_lstat', { path });
			const lstats = new TauriStats(lstatRaw);

			if (!lstats.isSymbolicLink()) {
				return { stat: lstats };
			}

			try {
				const statRaw: IRawStat = await invoke('fs_stat', { path });
				const stats = new TauriStats(statRaw);
				return { stat: stats, symbolicLink: { dangling: false } };
			} catch (error: any) {
				if (String(error).includes('not found') || error?.code === 'ENOENT') {
					return { stat: lstats, symbolicLink: { dangling: true } };
				}
				throw error;
			}
		} catch {
			const statRaw: IRawStat = await invoke('fs_stat', { path });
			const stats = new TauriStats(statRaw);
			return { stat: stats };
		}
	}

	export async function existsFile(path: string): Promise<boolean> {
		try {
			const { stat, symbolicLink } = await SymlinkSupport.stat(path);
			return stat.isFile() && symbolicLink?.dangling !== true;
		} catch {
			return false;
		}
	}

	export async function existsDirectory(path: string): Promise<boolean> {
		try {
			const { stat, symbolicLink } = await SymlinkSupport.stat(path);
			return stat.isDirectory() && symbolicLink?.dangling !== true;
		} catch {
			return false;
		}
	}
}

//#endregion

//#region Write File

const writeQueues = new ResourceQueue();

interface IWriteFileOptions {
	mode?: number;
	flag?: string;
}

function writeFile(path: string, data: string, options?: IWriteFileOptions): Promise<void>;
function writeFile(path: string, data: Uint8Array, options?: IWriteFileOptions): Promise<void>;
function writeFile(path: string, data: string | Uint8Array, options?: IWriteFileOptions): Promise<void>;
function writeFile(path: string, data: string | Uint8Array, _options?: IWriteFileOptions): Promise<void> {
	return writeQueues.queueFor(URI.file(path), async () => {
		const contents = typeof data === 'string' ? data : Array.from(data);
		await invoke('fs_write_file', { path, contents });
	}, extUriBiasedIgnorePathCase);
}

let canFlush = true;
export function configureFlushOnWrite(enabled: boolean): void {
	canFlush = enabled;
}

/**
 * @deprecated always prefer async variants over sync!
 */
export function writeFileSync(_path: string, _data: string | Uint8Array, _options?: IWriteFileOptions): void {
	throw new Error('writeFileSync is not available in Tauri webview. Use async writeFile instead.');
}

//#endregion

//#region Move / Copy

async function rename(source: string, target: string, _windowsRetryTimeout: number | false = 60000): Promise<void> {
	if (source === target) {
		return;
	}

	try {
		await invoke('fs_rename', { from: source, to: target });
	} catch (error: any) {
		const errStr = String(error);
		if (errStr.includes('EXDEV') || errStr.includes('cross-device') || source.endsWith('.')) {
			await copy(source, target, { preserveSymlinks: false });
			await rimraf(source, RimRafMode.MOVE);
		} else {
			throw error;
		}
	}
}

async function copy(source: string, target: string, options: { preserveSymlinks: boolean }): Promise<void> {
	await invoke('fs_copy', {
		source,
		target,
		preserveSymlinks: options.preserveSymlinks,
	});
}

//#endregion

//#region Path resolvers

export async function realcase(path: string, token?: CancellationToken): Promise<string | null> {
	if (isLinux) {
		return path;
	}

	const dir = dirname(path);
	if (path === dir) {
		return path;
	}

	const name = (basename(path) || path).toLowerCase();
	try {
		if (token?.isCancellationRequested) {
			return null;
		}

		const entries = await Promises.readdir(dir);
		const found = entries.filter(e => e.toLowerCase() === name);
		if (found.length === 1) {
			const prefix = await realcase(dir, token);
			if (prefix) {
				return join(prefix, found[0]);
			}
		} else if (found.length > 1) {
			const ix = found.indexOf(name);
			if (ix >= 0) {
				const prefix = await realcase(dir, token);
				if (prefix) {
					return join(prefix, found[ix]);
				}
			}
		}
	} catch {
		// silently ignore error
	}

	return null;
}

async function realpath(path: string): Promise<string> {
	try {
		return await invoke<string>('fs_realpath', { path });
	} catch {
		const normalizedPath = normalizePath(path);
		await invoke('fs_access', { path: normalizedPath });
		return normalizedPath;
	}
}

/**
 * @deprecated always prefer async variants over sync!
 */
export function realpathSync(_path: string): string {
	throw new Error('realpathSync is not available in Tauri webview. Use async realpath instead.');
}

function normalizePath(path: string): string {
	return rtrim(normalize(path), sep);
}

//#endregion

//#region Promise based fs methods

export const Promises = new class {

	//#region Implemented via Tauri invoke

	get read() {
		return async (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
			const result = await invoke<{ bytes_read: number; data: number[] }>('fs_read', {
				fd, offset, length, position
			});
			const data = new Uint8Array(result.data);
			buffer.set(data.subarray(0, result.bytes_read), offset);
			return { bytesRead: result.bytes_read, buffer };
		};
	}

	get write() {
		return async (fd: number, buffer: Uint8Array, offset: number | undefined | null, length: number | undefined | null, position: number | undefined | null) => {
			const data = Array.from(buffer.subarray(offset ?? 0, (offset ?? 0) + (length ?? buffer.length)));
			const bytesWritten = await invoke<number>('fs_write', {
				fd, data, position
			});
			return { bytesWritten, buffer };
		};
	}

	get fdatasync() {
		return async (fd: number): Promise<void> => {
			await invoke('fs_fdatasync', { fd });
		};
	}

	get open() {
		return async (path: string, flags: string, mode?: number): Promise<number> => {
			return invoke<number>('fs_open', { path, flags, mode });
		};
	}

	get close() {
		return async (fd: number): Promise<void> => {
			await invoke('fs_close', { fd });
		};
	}

	get ftruncate() {
		return async (fd: number, len?: number): Promise<void> => {
			await invoke('fs_ftruncate', { fd, len });
		};
	}

	//#endregion

	//#region Implemented by us

	async exists(path: string): Promise<boolean> {
		try {
			await invoke('fs_access', { path });
			return true;
		} catch {
			return false;
		}
	}

	get readdir() { return readdir; }
	get readDirsInDir() { return readDirsInDir; }

	get writeFile() { return writeFile; }

	get rm() { return rimraf; }

	get rename() { return rename; }
	get copy() { return copy; }

	get realpath() { return realpath; }

	//#endregion
};

//#endregion
