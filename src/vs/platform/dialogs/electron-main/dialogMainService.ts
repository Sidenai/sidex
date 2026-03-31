/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { open, save, message, type DialogFilter } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { Queue } from '../../../base/common/async.js';
import { hash } from '../../../base/common/hash.js';
import { mnemonicButtonLabel } from '../../../base/common/labels.js';
import { Disposable, dispose, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { normalizeNFC } from '../../../base/common/normalization.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { Promises } from '../../../base/node/pfs.js';
import { localize } from '../../../nls.js';
import { INativeOpenDialogOptions, massageMessageBoxOptions } from '../common/dialogs.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { WORKSPACE_FILTER } from '../../workspace/common/workspace.js';

export interface FileFilter {
	name: string;
	extensions: string[];
}

export interface MessageBoxOptions {
	type?: string;
	buttons?: string[];
	defaultId?: number;
	title?: string;
	message: string;
	detail?: string;
	checkboxLabel?: string;
	checkboxChecked?: boolean;
	cancelId?: number;
	noLink?: boolean;
	normalizeAccessKeys?: boolean;
}

export interface MessageBoxReturnValue {
	response: number;
	checkboxChecked: boolean;
}

export interface SaveDialogOptions {
	title?: string;
	defaultPath?: string;
	buttonLabel?: string;
	filters?: FileFilter[];
	properties?: string[];
}

export interface SaveDialogReturnValue {
	canceled: boolean;
	filePath: string;
}

export interface OpenDialogOptions {
	title?: string;
	defaultPath?: string;
	buttonLabel?: string;
	filters?: FileFilter[];
	properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent'>;
}

export interface OpenDialogReturnValue {
	canceled: boolean;
	filePaths: string[];
}

export const IDialogMainService = createDecorator<IDialogMainService>('dialogMainService');

export interface IDialogMainService {

	readonly _serviceBrand: undefined;

	pickFileFolder(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined>;
	pickFolder(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined>;
	pickFile(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined>;
	pickWorkspace(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined>;

	showMessageBox(options: MessageBoxOptions, windowLabel?: string): Promise<MessageBoxReturnValue>;
	showSaveDialog(options: SaveDialogOptions, windowLabel?: string): Promise<SaveDialogReturnValue>;
	showOpenDialog(options: OpenDialogOptions, windowLabel?: string): Promise<OpenDialogReturnValue>;
}

interface IInternalNativeOpenDialogOptions extends INativeOpenDialogOptions {
	readonly pickFolders?: boolean;
	readonly pickFiles?: boolean;

	readonly title: string;
	readonly buttonLabel?: string;
	readonly filters?: FileFilter[];
}

export class DialogMainService implements IDialogMainService {

	declare readonly _serviceBrand: undefined;

	private readonly windowFileDialogLocks = new Map<string, Set<number>>();
	private readonly windowDialogQueues = new Map<string, Queue<MessageBoxReturnValue | SaveDialogReturnValue | OpenDialogReturnValue>>();
	private readonly noWindowDialogueQueue = new Queue<MessageBoxReturnValue | SaveDialogReturnValue | OpenDialogReturnValue>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService
	) {
	}

	pickFileFolder(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined> {
		return this.doPick({ ...options, pickFolders: true, pickFiles: true, title: localize('open', "Open") }, windowLabel);
	}

	pickFolder(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined> {
		let optionsInternal: IInternalNativeOpenDialogOptions = {
			...options,
			pickFolders: true,
			title: localize('openFolder', "Open Folder")
		};

		if (isWindows) {
			optionsInternal = {
				...optionsInternal,
				buttonLabel: mnemonicButtonLabel(localize({ key: 'selectFolder', comment: ['&& denotes a mnemonic'] }, "&&Select folder")).withMnemonic
			};
		}

		return this.doPick(optionsInternal, windowLabel);
	}

	pickFile(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined> {
		return this.doPick({ ...options, pickFiles: true, title: localize('openFile', "Open File") }, windowLabel);
	}

	pickWorkspace(options: INativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined> {
		const title = localize('openWorkspaceTitle', "Open Workspace from File");
		const buttonLabel = mnemonicButtonLabel(localize({ key: 'openWorkspace', comment: ['&& denotes a mnemonic'] }, "&&Open")).withMnemonic;
		const filters = WORKSPACE_FILTER;

		return this.doPick({ ...options, pickFiles: true, title, filters, buttonLabel }, windowLabel);
	}

	private async doPick(options: IInternalNativeOpenDialogOptions, windowLabel?: string): Promise<string[] | undefined> {

		const dialogOptions: OpenDialogOptions = {
			title: options.title,
			buttonLabel: options.buttonLabel,
			filters: options.filters,
			defaultPath: options.defaultPath
		};

		if (typeof options.pickFiles === 'boolean' || typeof options.pickFolders === 'boolean') {
			dialogOptions.properties = undefined;

			if (options.pickFiles && options.pickFolders) {
				dialogOptions.properties = ['multiSelections', 'openDirectory', 'openFile', 'createDirectory'];
			}
		}

		if (!dialogOptions.properties) {
			dialogOptions.properties = ['multiSelections', options.pickFolders ? 'openDirectory' : 'openFile', 'createDirectory'];
		}

		if (isMacintosh) {
			dialogOptions.properties.push('treatPackageAsDirectory');
		}

		const result = await this.showOpenDialog(dialogOptions, windowLabel);
		if (result?.filePaths && result.filePaths.length > 0) {
			return result.filePaths;
		}

		return undefined;
	}

	private getWindowDialogQueue<T extends MessageBoxReturnValue | SaveDialogReturnValue | OpenDialogReturnValue>(windowLabel?: string): Queue<T> {

		if (windowLabel) {
			let windowDialogQueue = this.windowDialogQueues.get(windowLabel);
			if (!windowDialogQueue) {
				windowDialogQueue = new Queue<MessageBoxReturnValue | SaveDialogReturnValue | OpenDialogReturnValue>();
				this.windowDialogQueues.set(windowLabel, windowDialogQueue);
			}

			return windowDialogQueue as unknown as Queue<T>;
		} else {
			return this.noWindowDialogueQueue as unknown as Queue<T>;
		}
	}

	showMessageBox(rawOptions: MessageBoxOptions, windowLabel?: string): Promise<MessageBoxReturnValue> {
		return this.getWindowDialogQueue<MessageBoxReturnValue>(windowLabel).queue(async () => {
			const { options, buttonIndeces } = massageMessageBoxOptions(rawOptions, this.productService);

			const kind = options.type === 'error' ? 'error'
				: options.type === 'warning' ? 'warning'
					: 'info';

			const okTitle = options.buttons?.[options.defaultId ?? 0] ?? 'OK';

			const confirmed = await message(options.message ?? '', {
				title: options.title ?? '',
				kind,
				okLabel: okTitle,
			});

			const response = confirmed ? (options.defaultId ?? 0) : (options.cancelId ?? 1);

			return {
				response: buttonIndeces[response],
				checkboxChecked: false
			};
		});
	}

	async showSaveDialog(options: SaveDialogOptions, windowLabel?: string): Promise<SaveDialogReturnValue> {

		const fileDialogLock = this.acquireFileDialogLock(options, windowLabel);
		if (!fileDialogLock) {
			this.logService.error('[DialogMainService]: file save dialog is already or will be showing for the window with the same configuration');

			return { canceled: true, filePath: '' };
		}

		try {
			return await this.getWindowDialogQueue<SaveDialogReturnValue>(windowLabel).queue(async () => {
				const tauriFilters: DialogFilter[] = (options.filters ?? []).map(f => ({
					name: f.name,
					extensions: f.extensions
				}));

				const result = await save({
					title: options.title,
					defaultPath: options.defaultPath,
					filters: tauriFilters.length > 0 ? tauriFilters : undefined,
				});

				const filePath = result ? this.normalizePath(result) : '';
				return {
					canceled: !result,
					filePath
				};
			});
		} finally {
			dispose(fileDialogLock);
		}
	}

	private normalizePath(path: string): string;
	private normalizePath(path: string | undefined): string | undefined;
	private normalizePath(path: string | undefined): string | undefined {
		if (path && isMacintosh) {
			path = normalizeNFC(path);
		}

		return path;
	}

	private normalizePaths(paths: string[]): string[] {
		return paths.map(path => this.normalizePath(path));
	}

	async showOpenDialog(options: OpenDialogOptions, windowLabel?: string): Promise<OpenDialogReturnValue> {

		if (options.defaultPath) {
			const pathExists = await Promises.exists(options.defaultPath);
			if (!pathExists) {
				options.defaultPath = undefined;
			}
		}

		const fileDialogLock = this.acquireFileDialogLock(options, windowLabel);
		if (!fileDialogLock) {
			this.logService.error('[DialogMainService]: file open dialog is already or will be showing for the window with the same configuration');

			return { canceled: true, filePaths: [] };
		}

		try {
			return await this.getWindowDialogQueue<OpenDialogReturnValue>(windowLabel).queue(async () => {
				const properties = options.properties ?? [];
				const directory = properties.includes('openDirectory');
				const multiple = properties.includes('multiSelections');

				const tauriFilters: DialogFilter[] = (options.filters ?? []).map(f => ({
					name: f.name,
					extensions: f.extensions
				}));

				const result = await open({
					title: options.title,
					defaultPath: options.defaultPath,
					directory,
					multiple,
					filters: tauriFilters.length > 0 ? tauriFilters : undefined,
				});

				if (result === null) {
					return { canceled: true, filePaths: [] };
				}

				const filePaths = Array.isArray(result) ? result : [result];
				return {
					canceled: false,
					filePaths: this.normalizePaths(filePaths)
				};
			});
		} finally {
			dispose(fileDialogLock);
		}
	}

	private acquireFileDialogLock(options: SaveDialogOptions | OpenDialogOptions, windowLabel?: string): IDisposable | undefined {

		if (!windowLabel) {
			return Disposable.None;
		}

		this.logService.trace('[DialogMainService]: request to acquire file dialog lock', options);

		let windowFileDialogLocks = this.windowFileDialogLocks.get(windowLabel);
		if (!windowFileDialogLocks) {
			windowFileDialogLocks = new Set();
			this.windowFileDialogLocks.set(windowLabel, windowFileDialogLocks);
		}

		const optionsHash = hash(options);
		if (windowFileDialogLocks.has(optionsHash)) {
			return undefined;
		}

		this.logService.trace('[DialogMainService]: new file dialog lock created', options);

		windowFileDialogLocks.add(optionsHash);

		return toDisposable(() => {
			this.logService.trace('[DialogMainService]: file dialog lock disposed', options);

			windowFileDialogLocks?.delete(optionsHash);

			if (windowFileDialogLocks?.size === 0) {
				this.windowFileDialogLocks.delete(windowLabel);
			}
		});
	}
}
