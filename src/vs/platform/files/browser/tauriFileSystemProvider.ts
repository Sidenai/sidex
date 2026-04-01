/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-backed file system provider for the `file` scheme.
 *  Delegates all I/O to Rust via `invoke()` from @tauri-apps/api/core.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { URI } from '../../../base/common/uri.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import {
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	createFileSystemProviderError,
	IFileChange,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileWriteOptions,
	IStat,
	IWatchOptions,
	IFileSystemProviderWithFileReadWriteCapability,
	FilePermission,
} from '../common/files.js';

interface TauriFileStat {
	size: number;
	is_dir: boolean;
	is_file: boolean;
	is_symlink: boolean;
	modified: number;
	created: number;
	readonly: boolean;
}

interface TauriDirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	is_file: boolean;
	is_symlink: boolean;
	size: number;
	modified: number;
}

export class TauriFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {

	readonly capabilities: FileSystemProviderCapabilities =
		FileSystemProviderCapabilities.FileReadWrite |
		FileSystemProviderCapabilities.PathCaseSensitive;

	readonly onDidChangeCapabilities = Event.None;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private static toPath(resource: URI): string {
		return resource.fsPath;
	}

	private static toError(err: unknown, resource: URI, code: FileSystemProviderErrorCode): Error {
		const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : String(err));
		return createFileSystemProviderError(msg, code);
	}

	async stat(resource: URI): Promise<IStat> {
		const path = TauriFileSystemProvider.toPath(resource);
		let raw: TauriFileStat;
		try {
			raw = await invoke<TauriFileStat>('stat', { path });
		} catch (err) {
			console.warn('[SideX-FS] stat failed:', path, err);
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}

		let type: FileType;
		if (raw.is_dir) {
			type = FileType.Directory;
		} else if (raw.is_symlink) {
			type = FileType.SymbolicLink;
		} else {
			type = FileType.File;
		}

		return {
			type,
			mtime: raw.modified * 1000,
			ctime: raw.created * 1000,
			size: raw.size,
			permissions: raw.readonly ? FilePermission.Readonly : undefined,
		};
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const path = TauriFileSystemProvider.toPath(resource);
		let entries: TauriDirEntry[];
		try {
			entries = await invoke<TauriDirEntry[]>('read_dir', { path });
		} catch (err) {
			console.warn('[SideX-FS] readdir failed:', path, err);
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}

		return entries.map(e => {
			let ft: FileType;
			if (e.is_dir) {
				ft = FileType.Directory;
			} else if (e.is_symlink) {
				ft = FileType.SymbolicLink;
			} else {
				ft = FileType.File;
			}
			return [e.name, ft] as [string, FileType];
		});
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const path = TauriFileSystemProvider.toPath(resource);
		let bytes: number[];
		try {
			bytes = await invoke<number[]>('read_file_bytes', { path });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}
		return new Uint8Array(bytes);
	}

	async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		const path = TauriFileSystemProvider.toPath(resource);
		try {
			await invoke('write_file_bytes', { path, content: Array.from(content) });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.Unknown);
		}
	}

	async mkdir(resource: URI): Promise<void> {
		const path = TauriFileSystemProvider.toPath(resource);
		try {
			await invoke('mkdir', { path, recursive: true });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.Unknown);
		}
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		const path = TauriFileSystemProvider.toPath(resource);
		try {
			await invoke('remove', { path, recursive: opts.recursive });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, resource, FileSystemProviderErrorCode.FileNotFound);
		}
	}

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		const oldPath = TauriFileSystemProvider.toPath(from);
		const newPath = TauriFileSystemProvider.toPath(to);

		if (!opts.overwrite) {
			let exists: boolean;
			try {
				exists = await invoke<boolean>('exists', { path: newPath });
			} catch {
				exists = false;
			}
			if (exists) {
				throw createFileSystemProviderError(
					`Unable to rename — target '${newPath}' already exists`,
					FileSystemProviderErrorCode.FileExists,
				);
			}
		}

		try {
			await invoke('rename', { oldPath, newPath });
		} catch (err) {
			throw TauriFileSystemProvider.toError(err, from, FileSystemProviderErrorCode.Unknown);
		}
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None;
	}
}
