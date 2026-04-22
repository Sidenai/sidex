/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost filesystem-event stub. File watching and workspace-edit participation
 *  are handled by the Tauri backend; this service accepts subscriptions but never fires.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import { AsyncEmitter, Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import {
	ExtHostFileSystemEventServiceShape,
	FileSystemEvents,
	IMainContext,
	SourceTargetPair,
	IWillRunFileOperationParticipation
} from './extHost.protocol.js';
import { IExtHostWorkspace } from './extHostWorkspace.js';
import { ExtHostConfigProvider } from './extHostConfiguration.js';
import { ExtHostFileSystemInfo } from './extHostFileSystemInfo.js';
import { ExtHostDocumentsAndEditors } from './extHostDocumentsAndEditors.js';
import { FileOperation } from '../../../platform/files/common/files.js';

export interface FileSystemWatcherCreateOptions {
	readonly ignoreCreateEvents?: boolean;
	readonly ignoreChangeEvents?: boolean;
	readonly ignoreDeleteEvents?: boolean;
}

class StubFileSystemWatcher extends Disposable implements vscode.FileSystemWatcher {
	readonly ignoreCreateEvents = false;
	readonly ignoreChangeEvents = false;
	readonly ignoreDeleteEvents = false;
	private readonly _onDidCreate = this._register(new Emitter<vscode.Uri>());
	private readonly _onDidChange = this._register(new Emitter<vscode.Uri>());
	private readonly _onDidDelete = this._register(new Emitter<vscode.Uri>());
	readonly onDidCreate = this._onDidCreate.event;
	readonly onDidChange = this._onDidChange.event;
	readonly onDidDelete = this._onDidDelete.event;
}

export class ExtHostFileSystemEventService implements ExtHostFileSystemEventServiceShape {
	private readonly _onDidRenameFile = new Emitter<vscode.FileRenameEvent>();
	private readonly _onDidCreateFile = new Emitter<vscode.FileCreateEvent>();
	private readonly _onDidDeleteFile = new Emitter<vscode.FileDeleteEvent>();
	private readonly _onWillRenameFile = new AsyncEmitter<vscode.FileWillRenameEvent>();
	private readonly _onWillCreateFile = new AsyncEmitter<vscode.FileWillCreateEvent>();
	private readonly _onWillDeleteFile = new AsyncEmitter<vscode.FileWillDeleteEvent>();

	readonly onDidRenameFile: Event<vscode.FileRenameEvent> = this._onDidRenameFile.event;
	readonly onDidCreateFile: Event<vscode.FileCreateEvent> = this._onDidCreateFile.event;
	readonly onDidDeleteFile: Event<vscode.FileDeleteEvent> = this._onDidDeleteFile.event;

	constructor(
		_mainContext: IMainContext,
		_logService: ILogService,
		_extHostDocumentsAndEditors: ExtHostDocumentsAndEditors
	) {}

	createFileSystemWatcher(
		_workspace: IExtHostWorkspace,
		_configProvider: ExtHostConfigProvider,
		_fileSystemInfo: ExtHostFileSystemInfo,
		_extension: IExtensionDescription,
		_globPattern: vscode.GlobPattern,
		_options: FileSystemWatcherCreateOptions
	): vscode.FileSystemWatcher {
		return new StubFileSystemWatcher();
	}

	$onFileEvent(_events: FileSystemEvents): void {}

	$onDidRunFileOperation(operation: FileOperation, files: SourceTargetPair[]): void {
		switch (operation) {
			case FileOperation.MOVE:
				this._onDidRenameFile.fire(
					Object.freeze({ files: files.map(f => ({ oldUri: URI.revive(f.source!), newUri: URI.revive(f.target) })) })
				);
				break;
			case FileOperation.DELETE:
				this._onDidDeleteFile.fire(Object.freeze({ files: files.map(f => URI.revive(f.target)) }));
				break;
			case FileOperation.CREATE:
			case FileOperation.COPY:
				this._onDidCreateFile.fire(Object.freeze({ files: files.map(f => URI.revive(f.target)) }));
				break;
		}
	}

	getOnWillRenameFileEvent(_extension: IExtensionDescription): Event<vscode.FileWillRenameEvent> {
		return this._onWillRenameFile.event as unknown as Event<vscode.FileWillRenameEvent>;
	}
	getOnWillCreateFileEvent(_extension: IExtensionDescription): Event<vscode.FileWillCreateEvent> {
		return this._onWillCreateFile.event as unknown as Event<vscode.FileWillCreateEvent>;
	}
	getOnWillDeleteFileEvent(_extension: IExtensionDescription): Event<vscode.FileWillDeleteEvent> {
		return this._onWillDeleteFile.event as unknown as Event<vscode.FileWillDeleteEvent>;
	}

	async $onWillRunFileOperation(
		_operation: FileOperation,
		_files: SourceTargetPair[],
		_timeout: number,
		_token: CancellationToken
	): Promise<IWillRunFileOperationParticipation | undefined> {
		return undefined;
	}
}

// Unused, but keep to avoid accidental breakage from older imports.
export type { IDisposable };
