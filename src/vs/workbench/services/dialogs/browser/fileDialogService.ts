/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPickAndOpenOptions, ISaveDialogOptions, IOpenDialogOptions, IFileDialogService, FileFilter, IPromptButton } from '../../../../platform/dialogs/common/dialogs.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AbstractFileDialogService } from './abstractFileDialogService.js';
import { Schemas } from '../../../../base/common/network.js';
import { memoize } from '../../../../base/common/decorators.js';
import { HTMLFileSystemProvider } from '../../../../platform/files/browser/htmlFileSystemProvider.js';
import { localize } from '../../../../nls.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { basename } from '../../../../base/common/resources.js';
import { getActiveWindow, triggerDownload, triggerUpload } from '../../../../base/browser/dom.js';
import Severity from '../../../../base/common/severity.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { extractFileListData } from '../../../../platform/dnd/browser/dnd.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { WebFileSystemAccess } from '../../../../platform/files/browser/webFileSystemAccess.js';
import { EmbeddedCodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/embeddedCodeEditorWidget.js';

export class FileDialogService extends AbstractFileDialogService implements IFileDialogService {

	@memoize
	private get fileSystemProvider(): HTMLFileSystemProvider {
		return this.fileService.getProvider(Schemas.file) as HTMLFileSystemProvider;
	}

	private get isTauri(): boolean {
		return true; // SideX always runs in Tauri
	}

	async pickFileFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		if (this.isTauri) {
			return this._tauriPickFolderAndOpen(options);
		}

		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFilePath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickFileFolderAndOpenSimplified(schema, options, false);
		}

		throw new Error(localize('pickFolderAndOpen', "Can't open folders, try adding a folder to the workspace instead."));
	}

	protected override addFileSchemaIfNeeded(schema: string, isFolder: boolean): string[] {
		return (schema === Schemas.untitled) ? [Schemas.file]
			: (((schema !== Schemas.file) && (!isFolder || (schema !== Schemas.vscodeRemote))) ? [schema, Schemas.file] : [schema]);
	}

	async pickFileAndOpen(options: IPickAndOpenOptions): Promise<void> {
		if (this.isTauri) {
			return this._tauriPickFileAndOpen(options);
		}

		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFilePath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickFileAndOpenSimplified(schema, options, false);
		}

		const activeWindow = getActiveWindow();
		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('open');
		}

		let fileHandle: FileSystemHandle | undefined = undefined;
		try {
			([fileHandle] = await activeWindow.showOpenFilePicker({ multiple: false }));
		} catch (error) {
			return; // `showOpenFilePicker` will throw an error when the user cancels
		}

		if (!WebFileSystemAccess.isFileSystemFileHandle(fileHandle)) {
			return;
		}

		const uri = await this.fileSystemProvider.registerFileHandle(fileHandle);

		this.addFileToRecentlyOpened(uri);

		await this.openerService.open(uri, { fromUserGesture: true, editorOptions: { pinned: true } });
	}

	async pickFolderAndOpen(options: IPickAndOpenOptions): Promise<void> {
		if (this.isTauri) {
			return this._tauriPickFolderAndOpen(options);
		}

		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultFolderPath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickFolderAndOpenSimplified(schema, options);
		}

		throw new Error(localize('pickFolderAndOpen', "Can't open folders, try adding a folder to the workspace instead."));
	}

	private async _tauriPickFolderAndOpen(_options: IPickAndOpenOptions): Promise<void> {
		try {
			console.log('[SideX] Opening Tauri folder picker...');
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({ directory: true, multiple: false, title: 'Open Folder' });
			console.log('[SideX] Folder selected:', selected);
			if (selected && typeof selected === 'string') {
				const folderUri = URI.file(selected);
				await this.hostService.openWindow([{ folderUri }], { forceNewWindow: _options.forceNewWindow, remoteAuthority: _options.remoteAuthority });
			}
		} catch (e) {
			console.error('[SideX] Failed to open folder dialog:', e);
		}
	}

	private async _tauriPickFileAndOpen(_options: IPickAndOpenOptions): Promise<void> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({ directory: false, multiple: false, title: 'Open File' });
			if (selected && typeof selected === 'string') {
				const fileUri = URI.file(selected);
				await this.editorService.openEditor({ resource: fileUri, options: { pinned: true } });
			}
		} catch (e) {
			console.error('[SideX] Failed to open file dialog:', e);
		}
	}

	async pickWorkspaceAndOpen(options: IPickAndOpenOptions): Promise<void> {
		options.availableFileSystems = this.getWorkspaceAvailableFileSystems(options);
		const schema = this.getFileSystemSchema(options);

		if (!options.defaultUri) {
			options.defaultUri = await this.defaultWorkspacePath(schema);
		}

		if (this.shouldUseSimplified(schema)) {
			return super.pickWorkspaceAndOpenSimplified(schema, options);
		}

		throw new Error(localize('pickWorkspaceAndOpen', "Can't open workspaces, try adding a folder to the workspace instead."));
	}

	async pickFileToSave(defaultUri: URI, availableFileSystems?: string[]): Promise<URI | undefined> {
		if (this.isTauri) {
			return this._tauriPickFileToSave(defaultUri, availableFileSystems);
		}

		const schema = this.getFileSystemSchema({ defaultUri, availableFileSystems });

		const options = this.getPickFileToSaveDialogOptions(defaultUri, availableFileSystems);
		if (this.shouldUseSimplified(schema)) {
			return super.pickFileToSaveSimplified(schema, options);
		}

		const activeWindow = getActiveWindow();
		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('save');
		}

		let fileHandle: FileSystemHandle | undefined = undefined;
		const startIn = Iterable.first(this.fileSystemProvider.directories);

		try {
			fileHandle = await activeWindow.showSaveFilePicker({ types: this.getFilePickerTypes(options.filters), ...{ suggestedName: basename(defaultUri), startIn } });
		} catch (error) {
			return;
		}

		if (!WebFileSystemAccess.isFileSystemFileHandle(fileHandle)) {
			return undefined;
		}

		return this.fileSystemProvider.registerFileHandle(fileHandle);
	}

	private async _tauriPickFileToSave(defaultUri: URI, availableFileSystems?: string[]): Promise<URI | undefined> {
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const options = this.getPickFileToSaveDialogOptions(defaultUri, availableFileSystems);
			const tauriFilters = (options.filters || []).map(f => ({
				name: f.name,
				extensions: f.extensions.filter(e => e !== '*' && e !== ''),
			})).filter(f => f.extensions.length > 0);

			const result = await save({
				title: options.title,
				defaultPath: defaultUri.fsPath || undefined,
				filters: tauriFilters.length ? tauriFilters : undefined,
			});
			if (result) {
				return URI.file(result);
			}
		} catch (e) {
			console.error('[SideX] Save dialog failed:', e);
		}
		return undefined;
	}

	private getFilePickerTypes(filters?: FileFilter[]): FilePickerAcceptType[] | undefined {
		return filters?.filter(filter => {
			return !((filter.extensions.length === 1) && ((filter.extensions[0] === '*') || filter.extensions[0] === ''));
		}).map((filter): FilePickerAcceptType => {
			const accept: Record<MIMEType, FileExtension[]> = {};
			const extensions = filter.extensions.filter(ext => (ext.indexOf('-') < 0) && (ext.indexOf('*') < 0) && (ext.indexOf('_') < 0));
			accept[(getMediaOrTextMime(`fileName.${filter.extensions[0]}`) ?? 'text/plain') as MIMEType] = extensions.map(ext => ext.startsWith('.') ? ext : `.${ext}`) as FileExtension[];
			return {
				description: filter.name,
				accept
			};
		});
	}

	async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		if (this.isTauri) {
			return this._tauriShowSaveDialog(options);
		}

		const schema = this.getFileSystemSchema(options);

		if (this.shouldUseSimplified(schema)) {
			return super.showSaveDialogSimplified(schema, options);
		}

		const activeWindow = getActiveWindow();
		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('save');
		}

		let fileHandle: FileSystemHandle | undefined = undefined;
		const startIn = Iterable.first(this.fileSystemProvider.directories);

		try {
			fileHandle = await activeWindow.showSaveFilePicker({ types: this.getFilePickerTypes(options.filters), ...options.defaultUri ? { suggestedName: basename(options.defaultUri) } : undefined, ...{ startIn } });
		} catch (error) {
			return undefined;
		}

		if (!WebFileSystemAccess.isFileSystemFileHandle(fileHandle)) {
			return undefined;
		}

		return this.fileSystemProvider.registerFileHandle(fileHandle);
	}

	private async _tauriShowSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
		try {
			const { save } = await import('@tauri-apps/plugin-dialog');
			const tauriFilters = (options.filters || []).map(f => ({
				name: f.name,
				extensions: f.extensions.filter(e => e !== '*' && e !== ''),
			})).filter(f => f.extensions.length > 0);

			const result = await save({
				title: options.title,
				defaultPath: options.defaultUri?.fsPath || undefined,
				filters: tauriFilters.length ? tauriFilters : undefined,
			});
			if (result) {
				return URI.file(result);
			}
		} catch (e) {
			console.error('[SideX] Save dialog failed:', e);
		}
		return undefined;
	}

	async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		if (this.isTauri) {
			return this._tauriShowOpenDialog(options);
		}

		const schema = this.getFileSystemSchema(options);

		if (this.shouldUseSimplified(schema)) {
			return super.showOpenDialogSimplified(schema, options);
		}

		const activeWindow = getActiveWindow();
		if (!WebFileSystemAccess.supported(activeWindow)) {
			return this.showUnsupportedBrowserWarning('open');
		}

		let uri: URI | undefined;
		const startIn = Iterable.first(this.fileSystemProvider.directories) ?? 'documents';

		try {
			if (options.canSelectFiles) {
				const handle = await activeWindow.showOpenFilePicker({ multiple: false, types: this.getFilePickerTypes(options.filters), ...{ startIn } });
				if (handle.length === 1 && WebFileSystemAccess.isFileSystemFileHandle(handle[0])) {
					uri = await this.fileSystemProvider.registerFileHandle(handle[0]);
				}
			} else {
				const handle = await activeWindow.showDirectoryPicker({ ...{ startIn } });
				uri = await this.fileSystemProvider.registerDirectoryHandle(handle);
			}
		} catch (error) {
			// user cancelled
		}

		return uri ? [uri] : undefined;
	}

	private async _tauriShowOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const isDir = options.canSelectFolders && !options.canSelectFiles;
			const tauriFilters = (options.filters || []).map(f => ({
				name: f.name,
				extensions: f.extensions.filter(e => e !== '*' && e !== ''),
			})).filter(f => f.extensions.length > 0);

			const result = await open({
				directory: isDir,
				multiple: options.canSelectMany ?? false,
				title: options.title,
				defaultPath: options.defaultUri?.fsPath || undefined,
				filters: tauriFilters.length ? tauriFilters : undefined,
			});

			if (!result) {
				return undefined;
			}
			const paths = Array.isArray(result) ? result : [result];
			return paths.map(p => URI.file(p));
		} catch (e) {
			console.error('[SideX] Open dialog failed:', e);
		}
		return undefined;
	}

	private async showUnsupportedBrowserWarning(context: 'save' | 'open'): Promise<undefined> {

		// When saving, try to just download the contents
		// of the active text editor if any as a workaround
		if (context === 'save') {
			const activeCodeEditor = this.codeEditorService.getActiveCodeEditor();
			if (!(activeCodeEditor instanceof EmbeddedCodeEditorWidget)) {
				const activeTextModel = activeCodeEditor?.getModel();
				if (activeTextModel) {
					triggerDownload(VSBuffer.fromString(activeTextModel.getValue()).buffer, basename(activeTextModel.uri));
					return;
				}
			}
		}

		// Otherwise inform the user about options

		const buttons: IPromptButton<void>[] = [
			{
				label: localize({ key: 'openRemote', comment: ['&& denotes a mnemonic'] }, "&&Open Remote..."),
				run: async () => { await this.commandService.executeCommand('workbench.action.remote.showMenu'); }
			},
			{
				label: localize({ key: 'learnMore', comment: ['&& denotes a mnemonic'] }, "&&Learn More"),
				run: async () => { await this.openerService.open('https://aka.ms/VSCodeWebLocalFileSystemAccess'); }
			}
		];
		if (context === 'open') {
			buttons.push({
				label: localize({ key: 'openFiles', comment: ['&& denotes a mnemonic'] }, "Open &&Files..."),
				run: async () => {
					const files = await triggerUpload();
					if (files) {
						const filesData = (await this.instantiationService.invokeFunction(accessor => extractFileListData(accessor, files))).filter(fileData => !fileData.isDirectory);
						if (filesData.length > 0) {
							this.editorService.openEditors(filesData.map(fileData => {
								return {
									resource: fileData.resource,
									contents: fileData.contents?.toString(),
									options: { pinned: true }
								};
							}));
						}
					}
				}
			});
		}

		await this.dialogService.prompt({
			type: Severity.Warning,
			message: localize('unsupportedBrowserMessage', "Opening Local Folders is Unsupported"),
			detail: localize('unsupportedBrowserDetail', "Your browser doesn't support opening local folders.\nYou can either open single files or open a remote repository."),
			buttons
		});

		return undefined;
	}

	private shouldUseSimplified(scheme: string): boolean {
		return ![Schemas.file, Schemas.vscodeUserData, Schemas.tmp].includes(scheme);
	}
}

registerSingleton(IFileDialogService, FileDialogService, InstantiationType.Delayed);
