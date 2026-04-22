/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost filesystem stub. Filesystem operations are routed through the Tauri
 *  backend; extension-registered filesystem providers are accepted but not wired.
 *--------------------------------------------------------------------------------------------*/

import { UriComponents } from '../../../base/common/uri.js';
import { IMainContext, ExtHostFileSystemShape, MainThreadFileSystemShape, MainContext } from './extHost.protocol.js';
import type * as vscode from 'vscode';
import * as files from '../../../platform/files/common/files.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostLanguageFeatures } from './extHostLanguageFeatures.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';

export class ExtHostFileSystem implements ExtHostFileSystemShape {
	private readonly _proxy: MainThreadFileSystemShape;
	private readonly _registeredSchemes = new Set<string>();

	constructor(mainContext: IMainContext, _extHostLanguageFeatures: ExtHostLanguageFeatures) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadFileSystem);
	}

	dispose(): void {}

	registerFileSystemProvider(
		_extension: IExtensionDescription,
		scheme: string,
		_provider: vscode.FileSystemProvider,
		_options: { isCaseSensitive?: boolean; isReadonly?: boolean | vscode.MarkdownString } = {}
	): IDisposable {
		if (this._registeredSchemes.has(scheme)) {
			throw new Error(`a provider for the scheme '${scheme}' is already registered`);
		}
		this._registeredSchemes.add(scheme);
		return toDisposable(() => this._registeredSchemes.delete(scheme));
	}

	async $stat(_handle: number, _resource: UriComponents): Promise<files.IStat> {
		throw new Error('not supported');
	}
	async $readdir(_handle: number, _resource: UriComponents): Promise<[string, files.FileType][]> {
		return [];
	}
	async $readFile(_handle: number, _resource: UriComponents): Promise<VSBuffer> {
		return VSBuffer.alloc(0);
	}
	async $writeFile(
		_handle: number,
		_resource: UriComponents,
		_content: VSBuffer,
		_opts: files.IFileWriteOptions
	): Promise<void> {}
	async $delete(_handle: number, _resource: UriComponents, _opts: files.IFileDeleteOptions): Promise<void> {}
	async $rename(
		_handle: number,
		_oldUri: UriComponents,
		_newUri: UriComponents,
		_opts: files.IFileOverwriteOptions
	): Promise<void> {}
	async $copy(
		_handle: number,
		_oldUri: UriComponents,
		_newUri: UriComponents,
		_opts: files.IFileOverwriteOptions
	): Promise<void> {}
	async $mkdir(_handle: number, _resource: UriComponents): Promise<void> {}
	$watch(_handle: number, _session: number, _resource: UriComponents, _opts: files.IWatchOptions): void {}
	$unwatch(_handle: number, _session: number): void {}
	async $open(_handle: number, _resource: UriComponents, _opts: files.IFileOpenOptions): Promise<number> {
		return 0;
	}
	async $close(_handle: number, _fd: number): Promise<void> {}
	async $read(_handle: number, _fd: number, _pos: number, _length: number): Promise<VSBuffer> {
		return VSBuffer.alloc(0);
	}
	async $write(_handle: number, _fd: number, _pos: number, _data: VSBuffer): Promise<number> {
		return 0;
	}
}
