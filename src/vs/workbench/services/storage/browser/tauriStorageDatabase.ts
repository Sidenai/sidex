/*---------------------------------------------------------------------------------------------
 *  Copyright (c) SideX. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	IStorageDatabase,
	IStorageItemsChangeEvent,
	IUpdateRequest
} from '../../../../base/parts/storage/common/storage.js';
import { invoke, isTauri } from '../../../../sidex-bridge.js';

/**
 * Storage database backed by the SideX Tauri (`storage_*`) commands,
 * which persist to a local SQLite file on disk.
 *
 * Unlike the IndexedDB implementation this data survives webview
 * refreshes and dev-mode reloads because the SQLite file lives in the
 * OS application-support directory rather than in browser storage.
 *
 * Each storage scope (application / profile / workspace) constructs its
 * own instance with a unique key prefix so that the scopes share a
 * single SQLite table without colliding.
 */
export class TauriStorageDatabase extends Disposable implements IStorageDatabase {
	private readonly _onDidChangeItemsExternal = this._register(new Emitter<IStorageItemsChangeEvent>());
	readonly onDidChangeItemsExternal: Event<IStorageItemsChangeEvent> = this._onDidChangeItemsExternal.event;

	/**
	 * Human-readable identifier used by the storage service for logging.
	 */
	readonly name: string;

	/**
	 * Tracks whether a write is currently in-flight so the storage
	 * service can avoid running idle flushes on top of a slow backend.
	 */
	private _pendingUpdates = 0;
	get hasPendingUpdate(): boolean {
		return this._pendingUpdates > 0;
	}

	/**
	 * In-memory fallback used when running outside the Tauri webview
	 * (e.g. plain browser dev). Keeps the surface identical so callers
	 * don't need to branch on environment.
	 */
	private readonly fallback = new Map<string, string>();

	constructor(private readonly prefix: string) {
		super();
		this.name = `tauri-storage:${prefix}`;
	}

	async getItems(): Promise<Map<string, string>> {
		if (!isTauri()) {
			return new Map(this.fallback);
		}

		try {
			const items = await invoke<Array<[string, string]>>('storage_list', { prefix: this.prefix });
			const result = new Map<string, string>();
			const prefixLen = this.prefix.length;
			for (const [key, value] of items ?? []) {
				// Strip our storage prefix so callers see the original key.
				result.set(key.startsWith(this.prefix) ? key.slice(prefixLen) : key, value);
			}
			return result;
		} catch (error) {
			console.error(`[TauriStorageDatabase] getItems(prefix=${this.prefix}) failed:`, error);
			return new Map();
		}
	}

	async updateItems(request: IUpdateRequest): Promise<void> {
		if (!isTauri()) {
			if (request.insert) {
				for (const [key, value] of request.insert) {
					this.fallback.set(key, value);
				}
			}
			if (request.delete) {
				for (const key of request.delete) {
					this.fallback.delete(key);
				}
			}
			return;
		}

		const tasks: Promise<unknown>[] = [];

		if (request.insert) {
			for (const [key, value] of request.insert) {
				tasks.push(invoke('storage_set', { key: this.prefix + key, value }));
			}
		}

		if (request.delete) {
			for (const key of request.delete) {
				tasks.push(invoke('storage_delete', { key: this.prefix + key }));
			}
		}

		if (tasks.length === 0) {
			return;
		}

		this._pendingUpdates++;
		try {
			const results = await Promise.allSettled(tasks);
			for (const result of results) {
				if (result.status === 'rejected') {
					console.error(`[TauriStorageDatabase] updateItems(prefix=${this.prefix}) failed:`, result.reason);
				}
			}
		} finally {
			this._pendingUpdates--;
		}
	}

	async optimize(): Promise<void> {
		// No-op: SQLite VACUUM is unnecessary for typical usage
		// and the backend does not currently expose such a command.
	}

	async close(): Promise<void> {
		// The SQLite connection is owned by the Rust side and lives
		// for the full lifetime of the application, so nothing to tear
		// down here beyond disposing our emitter.
		this.dispose();
	}

	/**
	 * Remove every entry belonging to this database's prefix. Used by
	 * `BrowserStorageService.clear()` for tests / reset flows.
	 */
	async clear(): Promise<void> {
		if (!isTauri()) {
			this.fallback.clear();
			return;
		}

		const items = await this.getItems();
		if (items.size === 0) {
			return;
		}
		await this.updateItems({ delete: new Set(items.keys()) });
	}
}
