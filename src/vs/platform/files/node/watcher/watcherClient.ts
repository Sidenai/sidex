/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileChangeType, IFileChange } from '../../common/files.js';
import { AbstractUniversalWatcherClient, ILogMessage, IUniversalWatcher, IUniversalWatchRequest } from '../../common/watcher.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

interface WatchBatchEvent {
	watch_id: number;
	events: { path: string; kind: string; is_dir: boolean; content?: string }[];
	timestamp: number;
}

const KIND_MAP: Record<string, FileChangeType> = {
	'created': FileChangeType.ADDED,
	'deleted': FileChangeType.DELETED,
	'modified': FileChangeType.UPDATED,
	'renamed_from': FileChangeType.DELETED,
	'renamed_to': FileChangeType.ADDED,
	'renamed': FileChangeType.UPDATED,
};

class TauriUniversalWatcher implements IUniversalWatcher {
	private readonly _onDidChangeFile = new Emitter<IFileChange[]>();
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _onDidLogMessage = new Emitter<ILogMessage>();
	readonly onDidLogMessage = this._onDidLogMessage.event;

	private readonly _onDidError = new Emitter<any>();
	readonly onDidError = this._onDidError.event;

	private _unlisten: (() => void) | undefined;
	private _activeWatchIds: number[] = [];
	private _verbose = false;

	constructor() {
		this._initListener();
	}

	private async _initListener(): Promise<void> {
		try {
			const unlisten = await listen<WatchBatchEvent>('watch-batch', (event) => {
				const batch = event.payload;
				if (!batch?.events?.length) {
					return;
				}

				const changes: IFileChange[] = batch.events
					.map(e => ({
						resource: URI.file(e.path),
						type: KIND_MAP[e.kind] ?? FileChangeType.UPDATED,
					}))
					.filter(c => c.type !== undefined);

				if (this._verbose) {
					this._onDidLogMessage.fire({
						type: 'trace',
						message: `[watcher] batch id=${batch.watch_id} count=${changes.length}`,
					});
				}

				if (changes.length) {
					this._onDidChangeFile.fire(changes);
				}
			});
			this._unlisten = unlisten;
		} catch (e) {
			console.error('[SideX-FS] watcher listener setup failed:', e);
		}
	}

	async watch(requests: IUniversalWatchRequest[]): Promise<void> {
		await this._stopAll();

		for (const req of requests) {
			try {
				const watchId = await invoke<number>('watch_start', {
					paths: [req.path],
					options: {
						recursive: true,
						debounce_ms: 100,
						ignore_patterns: req.excludes ?? [],
						file_extensions: null,
						emit_content: false,
					},
				});
				this._activeWatchIds.push(watchId);
			} catch (e) {
				if (this._verbose) {
					this._onDidLogMessage.fire({ type: 'error', message: `watch_start failed for ${req.path}: ${e}` });
				}
			}
		}
	}

	async setVerboseLogging(enabled: boolean): Promise<void> {
		this._verbose = enabled;
	}

	async stop(): Promise<void> {
		await this._stopAll();
		this._unlisten?.();
	}

	private async _stopAll(): Promise<void> {
		const ids = this._activeWatchIds.splice(0);
		for (const id of ids) {
			try {
				await invoke('watch_stop', { id });
			} catch { }
		}
	}

	dispose(): void {
		this.stop();
		this._onDidChangeFile.dispose();
		this._onDidLogMessage.dispose();
		this._onDidError.dispose();
	}
}

export class UniversalWatcherClient extends AbstractUniversalWatcherClient {

	constructor(
		onFileChanges: (changes: IFileChange[]) => void,
		onLogMessage: (msg: ILogMessage) => void,
		verboseLogging: boolean
	) {
		super(onFileChanges, onLogMessage, verboseLogging);
		this.init();
	}

	protected override createWatcher(disposables: DisposableStore): IUniversalWatcher {
		const watcher = new TauriUniversalWatcher();
		disposables.add(toDisposable(() => watcher.dispose()));
		return watcher;
	}
}
