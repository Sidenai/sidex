/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-backed provider for the `vscode-userdata:` scheme.
 *  Maps user-data URIs (e.g. `vscode-userdata:/User/settings.json`) to real
 *  paths under the OS app-data directory, so user settings, installed
 *  extensions, themes, keybindings, etc. persist across sessions.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { URI } from '../../../base/common/uri.js';
import { TauriFileSystemProvider } from './tauriFileSystemProvider.js';

export class TauriUserDataProvider extends TauriFileSystemProvider {
	private _rootPath: string | undefined;
	private _rootPromise: Promise<string> | undefined;

	/**
	 * Resolve the on-disk root for user-data, caching the result.
	 */
	private async resolveRoot(): Promise<string> {
		if (this._rootPath) {
			return this._rootPath;
		}
		if (!this._rootPromise) {
			this._rootPromise = invoke<string>('get_user_data_dir').then(dir => {
				this._rootPath = dir;
				return dir;
			});
		}
		return this._rootPromise;
	}

	/**
	 * Map a `vscode-userdata:` URI to the equivalent `file://` URI under
	 * the app-data directory. All I/O then flows through the parent class.
	 */
	private async toFileUri(resource: URI): Promise<URI> {
		const root = await this.resolveRoot();
		const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
		const relative = resource.path.replace(/^\/+/, '').replaceAll('/', sep);
		const joined = relative ? `${root}${sep}${relative}` : root;
		return URI.file(joined);
	}

	override async stat(resource: URI) {
		return super.stat(await this.toFileUri(resource));
	}

	override async readdir(resource: URI) {
		return super.readdir(await this.toFileUri(resource));
	}

	override async readFile(resource: URI) {
		return super.readFile(await this.toFileUri(resource));
	}

	override async writeFile(
		resource: URI,
		content: Uint8Array,
		opts: Parameters<TauriFileSystemProvider['writeFile']>[2]
	) {
		return super.writeFile(await this.toFileUri(resource), content, opts);
	}

	override async mkdir(resource: URI) {
		return super.mkdir(await this.toFileUri(resource));
	}

	override async delete(resource: URI, opts: Parameters<TauriFileSystemProvider['delete']>[1]) {
		return super.delete(await this.toFileUri(resource), opts);
	}

	override async rename(from: URI, to: URI, opts: Parameters<TauriFileSystemProvider['rename']>[2]) {
		const [fromFile, toFile] = await Promise.all([this.toFileUri(from), this.toFileUri(to)]);
		return super.rename(fromFile, toFile, opts);
	}
}
