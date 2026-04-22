/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MainContext, MainThreadFileSystemShape } from './extHost.protocol.js';
import type * as vscode from 'vscode';
import * as files from '../../../platform/files/common/files.js';
import { FileSystemError } from './extHostTypes.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { IExtHostFileSystemInfo } from './extHostFileSystemInfo.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IExtUri, extUri, extUriIgnorePathCase } from '../../../base/common/resources.js';
import { IMarkdownString } from '../../../base/common/htmlContent.js';

export class ExtHostConsumerFileSystem {
	readonly _serviceBrand: undefined;

	readonly value: vscode.FileSystem;

	private readonly _proxy: MainThreadFileSystemShape;
	private readonly _fileSystemProvider = new Map<
		string,
		{ impl: vscode.FileSystemProvider; extUri: IExtUri; isReadonly: boolean }
	>();

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@IExtHostFileSystemInfo fileSystemInfo: IExtHostFileSystemInfo
	) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadFileSystem);
		const that = this;

		this.value = Object.freeze({
			async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
				try {
					const provider = that._fileSystemProvider.get(uri.scheme);
					const stat = provider
						? (await that._proxy.$ensureActivation(uri.scheme), await provider.impl.stat(uri))
						: await that._proxy.$stat(uri);
					return {
						type: stat.type,
						ctime: stat.ctime,
						mtime: stat.mtime,
						size: stat.size,
						permissions: stat.permissions === files.FilePermission.Readonly ? 1 : undefined
					};
				} catch (err) {
					ExtHostConsumerFileSystem._handleError(err);
				}
			},
			async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
				try {
					const provider = that._fileSystemProvider.get(uri.scheme);
					if (provider) {
						await that._proxy.$ensureActivation(uri.scheme);
						return (await provider.impl.readDirectory(uri)).slice();
					}
					return await that._proxy.$readdir(uri);
				} catch (err) {
					return ExtHostConsumerFileSystem._handleError(err);
				}
			},
			async createDirectory(uri: vscode.Uri): Promise<void> {
				try {
					const provider = that._fileSystemProvider.get(uri.scheme);
					if (provider && !provider.isReadonly) {
						await that._proxy.$ensureActivation(uri.scheme);
						return await provider.impl.createDirectory(uri);
					}
					return await that._proxy.$mkdir(uri);
				} catch (err) {
					return ExtHostConsumerFileSystem._handleError(err);
				}
			},
			async readFile(uri: vscode.Uri): Promise<Uint8Array> {
				try {
					const provider = that._fileSystemProvider.get(uri.scheme);
					if (provider) {
						await that._proxy.$ensureActivation(uri.scheme);
						return (await provider.impl.readFile(uri)).slice();
					}
					const buff = await that._proxy.$readFile(uri);
					return buff.buffer;
				} catch (err) {
					return ExtHostConsumerFileSystem._handleError(err);
				}
			},
			async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
				try {
					const provider = that._fileSystemProvider.get(uri.scheme);
					if (provider && !provider.isReadonly) {
						await that._proxy.$ensureActivation(uri.scheme);
						return await provider.impl.writeFile(uri, content, { create: true, overwrite: true });
					}
					return await that._proxy.$writeFile(uri, VSBuffer.wrap(content));
				} catch (err) {
					return ExtHostConsumerFileSystem._handleError(err);
				}
			},
			async delete(uri: vscode.Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
				try {
					const provider = that._fileSystemProvider.get(uri.scheme);
					if (provider && !provider.isReadonly && !options?.useTrash) {
						await that._proxy.$ensureActivation(uri.scheme);
						return await provider.impl.delete(uri, { recursive: false, ...options });
					}
					return await that._proxy.$delete(uri, { recursive: false, useTrash: false, atomic: false, ...options });
				} catch (err) {
					return ExtHostConsumerFileSystem._handleError(err);
				}
			},
			async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options?: { overwrite?: boolean }): Promise<void> {
				try {
					return await that._proxy.$rename(oldUri, newUri, { ...{ overwrite: false }, ...options });
				} catch (err) {
					return ExtHostConsumerFileSystem._handleError(err);
				}
			},
			async copy(source: vscode.Uri, destination: vscode.Uri, options?: { overwrite?: boolean }): Promise<void> {
				try {
					return await that._proxy.$copy(source, destination, { ...{ overwrite: false }, ...options });
				} catch (err) {
					return ExtHostConsumerFileSystem._handleError(err);
				}
			},
			isWritableFileSystem(scheme: string): boolean | undefined {
				const capabilities = fileSystemInfo.getCapabilities(scheme);
				if (typeof capabilities === 'number') {
					return !(capabilities & files.FileSystemProviderCapabilities.Readonly);
				}
				return undefined;
			}
		});
	}

	private static _handleError(err: any): never {
		if (err instanceof FileSystemError) {
			throw err;
		}
		if (err instanceof files.FileSystemProviderError) {
			switch (err.code) {
				case files.FileSystemProviderErrorCode.FileExists:
					throw FileSystemError.FileExists(err.message);
				case files.FileSystemProviderErrorCode.FileNotFound:
					throw FileSystemError.FileNotFound(err.message);
				case files.FileSystemProviderErrorCode.FileNotADirectory:
					throw FileSystemError.FileNotADirectory(err.message);
				case files.FileSystemProviderErrorCode.FileIsADirectory:
					throw FileSystemError.FileIsADirectory(err.message);
				case files.FileSystemProviderErrorCode.NoPermissions:
					throw FileSystemError.NoPermissions(err.message);
				case files.FileSystemProviderErrorCode.Unavailable:
					throw FileSystemError.Unavailable(err.message);
				default:
					throw new FileSystemError(err.message, err.name as files.FileSystemProviderErrorCode);
			}
		}
		if (!(err instanceof Error)) {
			throw new FileSystemError(String(err));
		}
		if (err.name === 'ENOPRO' || err.message.includes('ENOPRO')) {
			throw FileSystemError.Unavailable(err.message);
		}
		throw new FileSystemError(err.message, err.name as files.FileSystemProviderErrorCode);
	}

	addFileSystemProvider(
		scheme: string,
		provider: vscode.FileSystemProvider,
		options?: { isCaseSensitive?: boolean; isReadonly?: boolean | IMarkdownString }
	): IDisposable {
		this._fileSystemProvider.set(scheme, {
			impl: provider,
			extUri: options?.isCaseSensitive ? extUri : extUriIgnorePathCase,
			isReadonly: !!options?.isReadonly
		});
		return toDisposable(() => this._fileSystemProvider.delete(scheme));
	}

	getFileSystemProviderExtUri(scheme: string) {
		return this._fileSystemProvider.get(scheme)?.extUri ?? extUri;
	}
}

export interface IExtHostConsumerFileSystem extends ExtHostConsumerFileSystem {}
export const IExtHostConsumerFileSystem = createDecorator<IExtHostConsumerFileSystem>('IExtHostConsumerFileSystem');
