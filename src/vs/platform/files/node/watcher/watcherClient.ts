/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IFileChange } from '../../common/files.js';
import { AbstractUniversalWatcherClient, ILogMessage, IUniversalWatcher, IUniversalWatchRequest } from '../../common/watcher.js';
import { Emitter, Event } from '../../../../base/common/event.js';

class TauriUniversalWatcher implements IUniversalWatcher {
	private readonly _onDidChangeFile = new Emitter<IFileChange[]>();
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _onDidLogMessage = new Emitter<ILogMessage>();
	readonly onDidLogMessage = this._onDidLogMessage.event;

	private readonly _onDidError = new Emitter<any>();
	readonly onDidError = this._onDidError.event;

	private _unlisten: (() => void) | undefined;

	constructor() {
		this._init();
	}

	private async _init(): Promise<void> {
		try {
			const unlisten = await listen<IFileChange[]>('fs-watcher-changes', (event) => {
				this._onDidChangeFile.fire(event.payload);
			});
			this._unlisten = unlisten;
		} catch (e) {
			console.error('Failed to set up Tauri file watcher listener:', e);
		}
	}

	async watch(requests: IUniversalWatchRequest[]): Promise<void> {
		await invoke('fs_watch', { requests: requests.map(r => ({
			path: r.path,
			excludes: r.excludes,
			includes: r.includes,
			recursive: true,
			correlationId: r.correlationId,
		}))});
	}

	async setVerboseLogging(enabled: boolean): Promise<void> {
		await invoke('fs_watch_set_verbose', { enabled });
	}

	async stop(): Promise<void> {
		await invoke('fs_watch_stop');
		this._unlisten?.();
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
