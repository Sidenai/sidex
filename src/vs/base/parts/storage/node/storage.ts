/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { timeout } from '../../../common/async.js';
import { Event } from '../../../common/event.js';
import { mapToString, setToString } from '../../../common/map.js';
import { basename } from '../../../common/path.js';
import { Promises } from '../../../node/pfs.js';
import { IStorageDatabase, IStorageItemsChangeEvent, IUpdateRequest } from '../common/storage.js';

/**
 * Tauri-backed SQLite storage database.
 * Uses invoke() to call Rust-side SQLite operations.
 */

export interface ISQLiteStorageDatabaseOptions {
	readonly logging?: ISQLiteStorageDatabaseLoggingOptions;
}

export interface ISQLiteStorageDatabaseLoggingOptions {
	logError?: (error: string | Error) => void;
	logTrace?: (msg: string) => void;
}

export class SQLiteStorageDatabase implements IStorageDatabase {

	static readonly IN_MEMORY_PATH = ':memory:';

	readonly whenConnected: Promise<void>;

	private _dbId: string | undefined;

	constructor(
		private readonly path: string,
		private readonly options: ISQLiteStorageDatabaseOptions = {}
	) {
		this.whenConnected = this.connect();
	}

	private async connect(): Promise<void> {
		try {
			this._dbId = await invoke<string>('storage_open', { path: this.path });
		} catch (error) {
			this.options.logging?.logError?.(`[storage] failed to open: ${error}`);
			throw error;
		}
	}

	async getItems(): Promise<Map<string, string>> {
		await this.whenConnected;
		if (!this._dbId) { return new Map(); }

		try {
			const items: [string, string][] = await invoke('storage_get_items', { dbId: this._dbId });
			return new Map(items);
		} catch (error) {
			this.options.logging?.logError?.(`[storage] getItems failed: ${error}`);
			return new Map();
		}
	}

	async updateItems(request: IUpdateRequest): Promise<void> {
		await this.whenConnected;
		if (!this._dbId) { return; }

		try {
			const inserts: [string, string][] = [];
			const deletes: string[] = [];

			if (request.insert) {
				request.insert.forEach((value, key) => inserts.push([key, value]));
			}
			if (request.delete) {
				request.delete.forEach(key => deletes.push(key));
			}

			await invoke('storage_update_items', { dbId: this._dbId, inserts, deletes });
		} catch (error) {
			this.options.logging?.logError?.(`[storage] updateItems failed: ${error}`);
		}
	}

	async optimize(): Promise<void> {
		await this.whenConnected;
		if (!this._dbId) { return; }

		try {
			await invoke('storage_optimize', { dbId: this._dbId });
		} catch (error) {
			this.options.logging?.logError?.(`[storage] optimize failed: ${error}`);
		}
	}

	async close(recovery?: () => Map<string, string>): Promise<void> {
		await this.whenConnected;
		if (!this._dbId) { return; }

		try {
			await invoke('storage_close', { dbId: this._dbId });
		} catch (error) {
			this.options.logging?.logError?.(`[storage] close failed: ${error}`);

			if (recovery) {
				const items = recovery();
				this.options.logging?.logTrace?.(`[storage] recovering ${items.size} items`);
			}
		}
	}

	readonly onDidChangeItemsExternal = Event.None;
}
