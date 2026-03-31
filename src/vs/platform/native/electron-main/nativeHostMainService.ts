/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { exec } from 'child_process';
import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as shellOpen } from '@tauri-apps/plugin-opener';
import { isPermissionGranted, requestPermission, sendNotification, Options as NotificationOptions } from '@tauri-apps/plugin-notification';
import { arch, cpus, freemem, loadavg, platform, release, totalmem, type } from 'os';
import { promisify } from 'util';
import { memoize } from '../../../base/common/decorators.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { matchesSomeScheme, Schemas } from '../../../base/common/network.js';
import { dirname, join, posix, resolve, win32 } from '../../../base/common/path.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { AddFirstParameterToFunctions } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { virtualMachineHint } from '../../../base/node/id.js';
import { Promises, SymlinkSupport } from '../../../base/node/pfs.js';
import { findFreePort, isPortFree } from '../../../base/node/ports.js';
import { localize } from '../../../nls.js';
import { ISerializableCommandAction } from '../../action/common/action.js';
import { INativeOpenDialogOptions } from '../../dialogs/common/dialogs.js';
import { IDialogMainService } from '../../dialogs/electron-main/dialogMainService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator, IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILifecycleMainService, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { FocusMode, ICommonNativeHostService, INativeHostOptions, IOSProperties, IOSStatistics, IToastOptions, IToastResult, PowerSaveBlockerType, SystemIdleState, ThermalState } from '../common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { IPartsSplash } from '../../theme/common/themeService.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { defaultWindowState, ICodeWindow } from '../../window/electron-main/window.js';
import { IColorScheme, IOpenedAuxiliaryWindow, IOpenedMainWindow, IOpenEmptyWindowOptions, IOpenWindowOptions, IPoint, IRectangle, IWindowOpenable } from '../../window/common/window.js';
import { defaultBrowserWindowOptions, IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { isWorkspaceIdentifier, toWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { IWorkspacesManagementMainService } from '../../workspaces/electron-main/workspacesManagementMainService.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { hasWSLFeatureInstalled } from '../../remote/node/wsl.js';
import { WindowProfiler } from '../../profiling/electron-main/windowProfiling.js';
import { IV8Profile } from '../../profiling/common/profiling.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import { CancellationError } from '../../../base/common/errors.js';
import { zip } from '../../../base/node/zip.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IProxyAuthService } from './auth.js';
import { AuthInfo, Credentials, IRequestService } from '../../request/common/request.js';
import { randomPath } from '../../../base/common/extpath.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';

export interface INativeHostMainService extends AddFirstParameterToFunctions<ICommonNativeHostService, Promise<unknown>, number | undefined> { }

export const INativeHostMainService = createDecorator<INativeHostMainService>('nativeHostMainService');

export class NativeHostMainService extends Disposable implements INativeHostMainService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		@IDialogMainService private readonly dialogMainService: IDialogMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IThemeMainService private readonly themeMainService: IThemeMainService,
		@IWorkspacesManagementMainService private readonly workspacesManagementMainService: IWorkspacesManagementMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IRequestService private readonly requestService: IRequestService,
		@IProxyAuthService private readonly proxyAuthService: IProxyAuthService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();

		this.onDidOpenMainWindow = Event.map(this.windowsMainService.onDidOpenWindow, window => window.id);

		this.onDidTriggerWindowSystemContextMenu = Event.any(
			Event.map(this.windowsMainService.onDidTriggerSystemContextMenu, ({ window, x, y }) => ({ windowId: window.id, x, y })),
			Event.map(this.auxiliaryWindowsMainService.onDidTriggerSystemContextMenu, ({ window, x, y }) => ({ windowId: window.id, x, y }))
		);

		this.onDidMaximizeWindow = Event.any(
			Event.map(this.windowsMainService.onDidMaximizeWindow, window => window.id),
			Event.map(this.auxiliaryWindowsMainService.onDidMaximizeWindow, window => window.id)
		);
		this.onDidUnmaximizeWindow = Event.any(
			Event.map(this.windowsMainService.onDidUnmaximizeWindow, window => window.id),
			Event.map(this.auxiliaryWindowsMainService.onDidUnmaximizeWindow, window => window.id)
		);

		this.onDidChangeWindowFullScreen = Event.any(
			Event.map(this.windowsMainService.onDidChangeFullScreen, e => ({ windowId: e.window.id, fullscreen: e.fullscreen })),
			Event.map(this.auxiliaryWindowsMainService.onDidChangeFullScreen, e => ({ windowId: e.window.id, fullscreen: e.fullscreen }))
		);

		this.onDidChangeWindowAlwaysOnTop = Event.any(
			Event.None,
			Event.map(this.auxiliaryWindowsMainService.onDidChangeAlwaysOnTop, e => ({ windowId: e.window.id, alwaysOnTop: e.alwaysOnTop }))
		);

		// Window focus/blur events via Tauri listen
		const blurEmitter = this._register(new Emitter<number>());
		const focusEmitter = this._register(new Emitter<number>());
		tauriListen<{ windowId: number }>('tauri://blur', e => blurEmitter.fire(e.payload.windowId)).catch(() => {});
		tauriListen<{ windowId: number }>('tauri://focus', e => focusEmitter.fire(e.payload.windowId)).catch(() => {});

		this.onDidBlurMainWindow = Event.filter(blurEmitter.event, id => !!this.windowsMainService.getWindowById(id));
		this.onDidFocusMainWindow = Event.any(
			Event.map(Event.filter(Event.map(this.windowsMainService.onDidChangeWindowsCount, () => this.windowsMainService.getLastActiveWindow()), window => !!window), window => window!.id),
			Event.filter(focusEmitter.event, id => !!this.windowsMainService.getWindowById(id))
		);

		this.onDidBlurMainOrAuxiliaryWindow = Event.any(this.onDidBlurMainWindow, blurEmitter.event);
		this.onDidFocusMainOrAuxiliaryWindow = Event.any(this.onDidFocusMainWindow, focusEmitter.event);

		// Power events via invoke
		const suspendEmitter = this._register(new Emitter<void>());
		const resumeEmitter = this._register(new Emitter<void>());
		const onAcEmitter = this._register(new Emitter<void>());
		const onBatteryEmitter = this._register(new Emitter<void>());
		const thermalEmitter = this._register(new Emitter<ThermalState>());
		const speedLimitEmitter = this._register(new Emitter<number>());
		const shutdownEmitter = this._register(new Emitter<void>());
		const lockEmitter = this._register(new Emitter<void>());
		const unlockEmitter = this._register(new Emitter<void>());
		const displayChangeEmitter = this._register(new Emitter<void>());

		tauriListen('power://suspend', () => suspendEmitter.fire()).catch(() => {});
		tauriListen('power://resume', () => resumeEmitter.fire()).catch(() => {});
		tauriListen('power://on-ac', () => onAcEmitter.fire()).catch(() => {});
		tauriListen('power://on-battery', () => onBatteryEmitter.fire()).catch(() => {});
		tauriListen<{ state: ThermalState }>('power://thermal-state-change', e => thermalEmitter.fire(e.payload.state)).catch(() => {});
		tauriListen<{ limit: number }>('power://speed-limit-change', e => speedLimitEmitter.fire(e.payload.limit)).catch(() => {});
		tauriListen('power://shutdown', () => shutdownEmitter.fire()).catch(() => {});
		tauriListen('power://lock-screen', () => lockEmitter.fire()).catch(() => {});
		tauriListen('power://unlock-screen', () => unlockEmitter.fire()).catch(() => {});
		tauriListen('display://changed', () => displayChangeEmitter.fire()).catch(() => {});

		this.onDidSuspendOS = suspendEmitter.event;
		this.onDidResumeOS = resumeEmitter.event;
		this.onDidChangeOnBatteryPower = Event.any(Event.map(onAcEmitter.event, () => false), Event.map(onBatteryEmitter.event, () => true));
		this.onDidChangeThermalState = thermalEmitter.event;
		this.onDidChangeSpeedLimit = speedLimitEmitter.event;
		this.onWillShutdownOS = shutdownEmitter.event;
		this.onDidLockScreen = lockEmitter.event;
		this.onDidUnlockScreen = unlockEmitter.event;
		this.onDidChangeColorScheme = this.themeMainService.onDidChangeColorScheme;
		this.onDidChangeDisplay = Event.debounce(displayChangeEmitter.event, () => { }, 100);
	}

	//#region Properties
	get windowId(): never { throw new Error('Not implemented in electron-main'); }
	//#endregion

	//#region Events
	readonly onDidOpenMainWindow: Event<number>;
	readonly onDidTriggerWindowSystemContextMenu: Event<{ windowId: number; x: number; y: number }>;
	readonly onDidMaximizeWindow: Event<number>;
	readonly onDidUnmaximizeWindow: Event<number>;
	readonly onDidChangeWindowFullScreen: Event<{ readonly windowId: number; readonly fullscreen: boolean }>;
	readonly onDidBlurMainWindow: Event<number>;
	readonly onDidFocusMainWindow: Event<number>;
	readonly onDidBlurMainOrAuxiliaryWindow: Event<number>;
	readonly onDidFocusMainOrAuxiliaryWindow: Event<number>;
	readonly onDidChangeWindowAlwaysOnTop: Event<{ readonly windowId: number; readonly alwaysOnTop: boolean }>;
	readonly onDidSuspendOS: Event<void>;
	readonly onDidResumeOS: Event<void>;
	readonly onDidChangeOnBatteryPower: Event<boolean>;
	readonly onDidChangeThermalState: Event<ThermalState>;
	readonly onDidChangeSpeedLimit: Event<number>;
	readonly onWillShutdownOS: Event<void>;
	readonly onDidLockScreen: Event<void>;
	readonly onDidUnlockScreen: Event<void>;
	readonly onDidChangeColorScheme: Event<IColorScheme>;
	private readonly _onDidChangePassword = this._register(new Emitter<{ account: string; service: string }>());
	readonly onDidChangePassword = this._onDidChangePassword.event;
	readonly onDidChangeDisplay: Event<void>;
	//#endregion

	//#region Window

	getWindows(windowId: number | undefined, options: { includeAuxiliaryWindows: true }): Promise<Array<IOpenedMainWindow | IOpenedAuxiliaryWindow>>;
	getWindows(windowId: number | undefined, options: { includeAuxiliaryWindows: false }): Promise<Array<IOpenedMainWindow>>;
	async getWindows(windowId: number | undefined, options: { includeAuxiliaryWindows: boolean }): Promise<Array<IOpenedMainWindow | IOpenedAuxiliaryWindow>> {
		const mainWindows = this.windowsMainService.getWindows().map(window => ({
			id: window.id,
			workspace: window.openedWorkspace ?? toWorkspaceIdentifier(window.backupPath, window.isExtensionDevelopmentHost),
			title: window.win?.getTitle() ?? '',
			filename: window.getRepresentedFilename(),
			dirty: window.isDocumentEdited()
		}));
		const auxiliaryWindows = [];
		if (options.includeAuxiliaryWindows) {
			auxiliaryWindows.push(...this.auxiliaryWindowsMainService.getWindows().map(window => ({
				id: window.id,
				parentId: window.parentId,
				title: window.win?.getTitle() ?? '',
				filename: window.getRepresentedFilename()
			})));
		}
		return [...mainWindows, ...auxiliaryWindows];
	}

	async getWindowCount(windowId: number | undefined): Promise<number> {
		return this.windowsMainService.getWindowCount();
	}

	async getActiveWindowId(windowId: number | undefined): Promise<number | undefined> {
		const activeWindow = this.windowsMainService.getFocusedWindow() || this.windowsMainService.getLastActiveWindow();
		return activeWindow?.id;
	}

	async getActiveWindowPosition(): Promise<IRectangle | undefined> {
		const activeWindow = this.windowsMainService.getFocusedWindow() || this.windowsMainService.getLastActiveWindow();
		return activeWindow?.getBounds();
	}

	async getNativeWindowHandle(fallbackWindowId: number | undefined, windowId: number): Promise<VSBuffer | undefined> {
		return invoke<number[]>('get_native_window_handle', { windowId }).then(
			buf => VSBuffer.wrap(new Uint8Array(buf)),
			() => undefined
		);
	}

	openWindow(windowId: number | undefined, options?: IOpenEmptyWindowOptions): Promise<void>;
	openWindow(windowId: number | undefined, toOpen: IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
	openWindow(windowId: number | undefined, arg1?: IOpenEmptyWindowOptions | IWindowOpenable[], arg2?: IOpenWindowOptions): Promise<void> {
		if (Array.isArray(arg1)) {
			return this.doOpenWindow(windowId, arg1, arg2);
		}
		return this.doOpenEmptyWindow(windowId, arg1);
	}

	private async doOpenWindow(windowId: number | undefined, toOpen: IWindowOpenable[], options: IOpenWindowOptions = Object.create(null)): Promise<void> {
		if (toOpen.length > 0) {
			await this.windowsMainService.open({
				context: OpenContext.API, contextWindowId: windowId, urisToOpen: toOpen,
				cli: this.environmentMainService.args, forceNewWindow: options.forceNewWindow,
				forceReuseWindow: options.forceReuseWindow, preferNewWindow: options.preferNewWindow,
				diffMode: options.diffMode, mergeMode: options.mergeMode, addMode: options.addMode,
				removeMode: options.removeMode, gotoLineMode: options.gotoLineMode,
				noRecentEntry: options.noRecentEntry, waitMarkerFileURI: options.waitMarkerFileURI,
				remoteAuthority: options.remoteAuthority || undefined, forceProfile: options.forceProfile,
				forceTempProfile: options.forceTempProfile,
			});
		}
	}

	private async doOpenEmptyWindow(windowId: number | undefined, options?: IOpenEmptyWindowOptions): Promise<void> {
		await this.windowsMainService.openEmptyWindow({ context: OpenContext.API, contextWindowId: windowId }, options);
	}

	async openAgentsWindow(windowId: number | undefined): Promise<void> {
		await this.windowsMainService.openAgentsWindow({ context: OpenContext.API, contextWindowId: windowId });
	}

	async isFullScreen(windowId: number | undefined, options?: INativeHostOptions): Promise<boolean> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return window?.isFullScreen ?? false;
	}

	async toggleFullScreen(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.toggleFullScreen();
	}

	async getCursorScreenPoint(windowId: number | undefined): Promise<{ readonly point: IPoint; readonly display: IRectangle }> {
		return invoke<{ point: IPoint; display: IRectangle }>('get_cursor_screen_point');
	}

	async isMaximized(windowId: number | undefined, options?: INativeHostOptions): Promise<boolean> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return window?.win?.isMaximized() ?? false;
	}

	async maximizeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.maximize();
	}

	async unmaximizeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.unmaximize();
	}

	async minimizeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.minimize();
	}

	async moveWindowTop(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		if (window?.win) {
			invoke('move_window_top', { windowId: window.id }).catch(() => {});
		}
	}

	async isWindowAlwaysOnTop(windowId: number | undefined, options?: INativeHostOptions): Promise<boolean> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return window?.win?.isAlwaysOnTop() ?? false;
	}

	async toggleWindowAlwaysOnTop(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		if (window?.win) {
			const current = window.win.isAlwaysOnTop();
			window.win.setAlwaysOnTop(!current);
		}
	}

	async setWindowAlwaysOnTop(windowId: number | undefined, alwaysOnTop: boolean, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.win?.setAlwaysOnTop(alwaysOnTop);
	}

	async positionWindow(windowId: number | undefined, position: IRectangle, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		if (window?.win) {
			window.win.setBounds(position);
		}
	}

	async updateWindowControls(windowId: number | undefined, options: INativeHostOptions & { height?: number; backgroundColor?: string; foregroundColor?: string; dimmed?: boolean }): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.updateWindowControls(options);
	}

	async updateWindowAccentColor(windowId: number | undefined, color: 'default' | 'off' | string, inactiveColor: string | undefined): Promise<void> {
		if (!isWindows) { return; }
		invoke('update_window_accent_color', { windowId, color, inactiveColor }).catch(() => {});
	}

	async focusWindow(windowId: number | undefined, options?: INativeHostOptions & { mode?: FocusMode }): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.focus({ mode: options?.mode ?? FocusMode.Transfer });
	}

	async setMinimumSize(windowId: number | undefined, width: number | undefined, height: number | undefined): Promise<void> {
		const window = this.codeWindowById(windowId);
		if (window?.win) {
			const [windowWidth, windowHeight] = window.win.getSize();
			const [minWindowWidth, minWindowHeight] = window.win.getMinimumSize();
			const [newMinW, newMinH] = [width ?? minWindowWidth, height ?? minWindowHeight];
			const [newW, newH] = [Math.max(windowWidth, newMinW), Math.max(windowHeight, newMinH)];
			if (minWindowWidth !== newMinW || minWindowHeight !== newMinH) { window.win.setMinimumSize(newMinW, newMinH); }
			if (windowWidth !== newW || windowHeight !== newH) { window.win.setSize(newW, newH); }
		}
	}

	async saveWindowSplash(windowId: number | undefined, splash: IPartsSplash): Promise<void> {
		const window = this.codeWindowById(windowId);
		this.themeMainService.saveWindowSplash(windowId, window?.openedWorkspace, splash);
	}

	async setBackgroundThrottling(windowId: number | undefined, allowed: boolean): Promise<void> {
		this.logService.trace(`Setting background throttling for window ${windowId} to '${allowed}'`);
		invoke('set_background_throttling', { windowId, allowed }).catch(() => {});
	}

	//#endregion

	//#region macOS Shell Command

	async installShellCommand(windowId: number | undefined): Promise<void> {
		const { source, target } = await this.getShellCommandLink();
		try {
			const { symbolicLink } = await SymlinkSupport.stat(source);
			if (symbolicLink && !symbolicLink.dangling) {
				const linkTargetRealPath = await Promises.realpath(source);
				if (target === linkTargetRealPath) { return; }
			}
		} catch (error) {
			if (error.code !== 'ENOENT') { throw error; }
		}
		await this.installShellCommandWithPrivileges(windowId, source, target);
	}

	private async installShellCommandWithPrivileges(windowId: number | undefined, source: string, target: string): Promise<void> {
		const { response } = await this.showMessageBox(windowId, {
			type: 'info',
			message: localize('warnEscalation', "{0} will now prompt with 'osascript' for Administrator privileges to install the shell command.", this.productService.nameShort),
			buttons: [localize({ key: 'ok', comment: ['&& denotes a mnemonic'] }, "&&OK"), localize('cancel', "Cancel")]
		});
		if (response === 1) { throw new CancellationError(); }
		try {
			const command = `osascript -e "do shell script \\"mkdir -p /usr/local/bin && ln -sf \'${target}\' \'${source}\'\\" with administrator privileges"`;
			await promisify(exec)(command);
		} catch (error) {
			throw new Error(localize('cantCreateBinFolder', "Unable to install the shell command '{0}'.", source));
		}
	}

	async uninstallShellCommand(windowId: number | undefined): Promise<void> {
		const { source } = await this.getShellCommandLink();
		try {
			await fs.promises.unlink(source);
		} catch (error) {
			switch (error.code) {
				case 'EACCES': {
					const { response } = await this.showMessageBox(windowId, {
						type: 'info',
						message: localize('warnEscalationUninstall', "{0} will now prompt with 'osascript' for Administrator privileges to uninstall the shell command.", this.productService.nameShort),
						buttons: [localize({ key: 'ok', comment: ['&& denotes a mnemonic'] }, "&&OK"), localize('cancel', "Cancel")]
					});
					if (response === 1) { throw new CancellationError(); }
					try {
						const command = `osascript -e "do shell script \\"rm \'${source}\'\\" with administrator privileges"`;
						await promisify(exec)(command);
					} catch (error) {
						throw new Error(localize('cantUninstall', "Unable to uninstall the shell command '{0}'.", source));
					}
					break;
				}
				case 'ENOENT': break;
				default: throw error;
			}
		}
	}

	private async getShellCommandLink(): Promise<{ readonly source: string; readonly target: string }> {
		const target = resolve(this.environmentMainService.appRoot, 'bin', 'code');
		const source = `/usr/local/bin/${this.productService.applicationName}`;
		const sourceExists = await Promises.exists(target);
		if (!sourceExists) { throw new Error(localize('sourceMissing', "Unable to find shell script in '{0}'", target)); }
		return { source, target };
	}

	//#endregion

	//#region Dialog

	async showMessageBox(windowId: number | undefined, options: any): Promise<any> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return this.dialogMainService.showMessageBox(options, window?.win ?? undefined);
	}

	async showSaveDialog(windowId: number | undefined, options: any): Promise<any> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return this.dialogMainService.showSaveDialog(options, window?.win ?? undefined);
	}

	async showOpenDialog(windowId: number | undefined, options: any): Promise<any> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return this.dialogMainService.showOpenDialog(options, window?.win ?? undefined);
	}

	async pickFileFolderAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickFileFolder(options);
		if (paths) {
			await this.doOpenPicked(await Promise.all(paths.map(async path => (await SymlinkSupport.existsDirectory(path)) ? { folderUri: URI.file(path) } : { fileUri: URI.file(path) })), options, windowId);
		}
	}

	async pickFolderAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickFolder(options);
		if (paths) { await this.doOpenPicked(paths.map(path => ({ folderUri: URI.file(path) })), options, windowId); }
	}

	async pickFileAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickFile(options);
		if (paths) { await this.doOpenPicked(paths.map(path => ({ fileUri: URI.file(path) })), options, windowId); }
	}

	async pickWorkspaceAndOpen(windowId: number | undefined, options: INativeOpenDialogOptions): Promise<void> {
		const paths = await this.dialogMainService.pickWorkspace(options);
		if (paths) { await this.doOpenPicked(paths.map(path => ({ workspaceUri: URI.file(path) })), options, windowId); }
	}

	private async doOpenPicked(openable: IWindowOpenable[], options: INativeOpenDialogOptions, windowId: number | undefined): Promise<void> {
		await this.windowsMainService.open({
			context: OpenContext.DIALOG, contextWindowId: windowId,
			cli: this.environmentMainService.args, urisToOpen: openable, forceNewWindow: options.forceNewWindow,
		});
	}

	//#endregion

	//#region OS

	async showItemInFolder(windowId: number | undefined, path: string): Promise<void> {
		invoke('show_item_in_folder', { path }).catch(err => this.logService.error('show_item_in_folder failed:', err));
	}

	async setRepresentedFilename(windowId: number | undefined, path: string, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.setRepresentedFilename(path);
	}

	async setDocumentEdited(windowId: number | undefined, edited: boolean, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		window?.setDocumentEdited(edited);
	}

	async openExternal(windowId: number | undefined, url: string, defaultApplication?: string): Promise<boolean> {
		this.environmentMainService.unsetSnapExportedVariables();
		try {
			if (matchesSomeScheme(url, Schemas.http, Schemas.https)) {
				await this.openExternalBrowser(windowId, url, defaultApplication);
			} else {
				await shellOpen(url);
			}
		} finally {
			this.environmentMainService.restoreSnapExportedVariables();
		}
		return true;
	}

	private async openExternalBrowser(windowId: number | undefined, url: string, defaultApplication?: string): Promise<void> {
		const configuredBrowser = defaultApplication ?? this.configurationService.getValue<string>('workbench.externalBrowser');
		if (!configuredBrowser) {
			await shellOpen(url);
			return;
		}
		try {
			const { default: open, apps } = await import('open');
			await open(url, {
				app: { name: Object.hasOwn(apps, configuredBrowser) ? apps[(configuredBrowser as keyof typeof apps)] : configuredBrowser }
			});
		} catch (error) {
			this.logService.error(`Unable to open external URL '${url}' using browser '${configuredBrowser}' due to ${error}.`);
			await shellOpen(url);
		}
	}

	moveItemToTrash(windowId: number | undefined, fullPath: string): Promise<void> {
		return invoke('trash_item', { path: fullPath });
	}

	async isAdmin(): Promise<boolean> {
		if (isWindows) {
			return (await import('native-is-elevated')).default();
		}
		return process.getuid?.() === 0;
	}

	async writeElevated(windowId: number | undefined, source: URI, target: URI, options?: { unlock?: boolean }): Promise<void> {
		const sudoPrompt = await import('@vscode/sudo-prompt');
		const argsFile = randomPath(this.environmentMainService.userDataPath, 'code-elevated');
		await Promises.writeFile(argsFile, JSON.stringify({ source: source.fsPath, target: target.fsPath }));
		try {
			await new Promise<void>((resolve, reject) => {
				const sudoCommand: string[] = [`"${this.cliPath}"`];
				if (options?.unlock) { sudoCommand.push('--file-chmod'); }
				sudoCommand.push('--file-write', `"${argsFile}"`);
				const promptOptions = {
					name: this.productService.nameLong.replace('-', ''),
					icns: (isMacintosh && this.environmentMainService.isBuilt) ? join(dirname(this.environmentMainService.appRoot), `${this.productService.nameShort}.icns`) : undefined
				};
				sudoPrompt.exec(sudoCommand.join(' '), promptOptions, (error?) => { if (error) { reject(error); } else { resolve(undefined); } });
			});
		} finally {
			await fs.promises.unlink(argsFile);
		}
	}

	async isRunningUnderARM64Translation(): Promise<boolean> {
		if (isLinux || isWindows) { return false; }
		return invoke<boolean>('is_running_under_arm64_translation').catch(() => false);
	}

	@memoize
	private get cliPath(): string {
		if (isWindows) {
			return this.environmentMainService.isBuilt
				? join(dirname(process.execPath), 'bin', `${this.productService.applicationName}.cmd`)
				: join(this.environmentMainService.appRoot, 'scripts', 'code-cli.bat');
		}
		if (isLinux) {
			return this.environmentMainService.isBuilt
				? join(dirname(process.execPath), 'bin', `${this.productService.applicationName}`)
				: join(this.environmentMainService.appRoot, 'scripts', 'code-cli.sh');
		}
		return this.environmentMainService.isBuilt
			? join(this.environmentMainService.appRoot, 'bin', 'code')
			: join(this.environmentMainService.appRoot, 'scripts', 'code-cli.sh');
	}

	async getOSStatistics(): Promise<IOSStatistics> {
		return { totalmem: totalmem(), freemem: freemem(), loadavg: loadavg() };
	}

	async getOSProperties(): Promise<IOSProperties> {
		return { arch: arch(), platform: platform(), release: release(), type: type(), cpus: cpus() };
	}

	async getOSVirtualMachineHint(): Promise<number> { return virtualMachineHint.value(); }

	async getOSColorScheme(): Promise<IColorScheme> { return this.themeMainService.getColorScheme(); }

	async hasWSLFeatureInstalled(): Promise<boolean> { return isWindows && hasWSLFeatureInstalled(); }

	//#endregion

	//#region Screenshots
	async getScreenshot(windowId: number | undefined, rect?: IRectangle, options?: INativeHostOptions): Promise<VSBuffer | undefined> {
		return invoke<number[]>('capture_page', { windowId: options?.targetWindowId ?? windowId, rect }).then(
			buf => VSBuffer.wrap(new Uint8Array(buf)), () => undefined
		);
	}
	//#endregion

	//#region Process
	async getProcessId(windowId: number | undefined): Promise<number | undefined> {
		return invoke<number>('get_webcontents_os_process_id', { windowId }).catch(() => undefined);
	}

	async killProcess(windowId: number | undefined, pid: number, code: string): Promise<void> {
		process.kill(pid, code);
	}
	//#endregion

	//#region Clipboard
	async readClipboardText(windowId: number | undefined, type?: 'selection' | 'clipboard'): Promise<string> {
		return readText();
	}

	async triggerPaste(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		invoke('trigger_paste', { windowId: options?.targetWindowId ?? windowId }).catch(() => {});
	}

	async readImage(): Promise<Uint8Array> {
		return invoke<number[]>('read_clipboard_image').then(buf => new Uint8Array(buf)).catch(() => new Uint8Array(0));
	}

	async writeClipboardText(windowId: number | undefined, text: string, type?: 'selection' | 'clipboard'): Promise<void> {
		await writeText(text);
	}

	async readClipboardFindText(windowId: number | undefined): Promise<string> {
		return invoke<string>('read_clipboard_find_text').catch(() => '');
	}

	async writeClipboardFindText(windowId: number | undefined, text: string): Promise<void> {
		invoke('write_clipboard_find_text', { text }).catch(() => {});
	}

	async writeClipboardBuffer(windowId: number | undefined, format: string, buffer: VSBuffer, type?: 'selection' | 'clipboard'): Promise<void> {
		invoke('write_clipboard_buffer', { format, buffer: Array.from(buffer.buffer), type }).catch(() => {});
	}

	async readClipboardBuffer(windowId: number | undefined, format: string): Promise<VSBuffer> {
		return invoke<number[]>('read_clipboard_buffer', { format }).then(buf => VSBuffer.wrap(new Uint8Array(buf))).catch(() => VSBuffer.alloc(0));
	}

	async hasClipboard(windowId: number | undefined, format: string, type?: 'selection' | 'clipboard'): Promise<boolean> {
		return invoke<boolean>('has_clipboard', { format, type }).catch(() => false);
	}
	//#endregion

	//#region macOS Touchbar
	async newWindowTab(): Promise<void> {
		await this.windowsMainService.open({
			context: OpenContext.API, cli: this.environmentMainService.args,
			forceNewTabbedWindow: true, forceEmpty: true,
			remoteAuthority: this.environmentMainService.args.remote || undefined
		});
	}

	async showPreviousWindowTab(): Promise<void> { invoke('send_action_to_first_responder', { action: 'selectPreviousTab:' }).catch(() => {}); }
	async showNextWindowTab(): Promise<void> { invoke('send_action_to_first_responder', { action: 'selectNextTab:' }).catch(() => {}); }
	async moveWindowTabToNewWindow(): Promise<void> { invoke('send_action_to_first_responder', { action: 'moveTabToNewWindow:' }).catch(() => {}); }
	async mergeAllWindowTabs(): Promise<void> { invoke('send_action_to_first_responder', { action: 'mergeAllWindows:' }).catch(() => {}); }
	async toggleWindowTabsBar(): Promise<void> { invoke('send_action_to_first_responder', { action: 'toggleTabBar:' }).catch(() => {}); }

	async updateTouchBar(windowId: number | undefined, items: ISerializableCommandAction[][]): Promise<void> {
		const window = this.codeWindowById(windowId);
		window?.updateTouchBar(items);
	}
	//#endregion

	//#region Lifecycle
	async notifyReady(windowId: number | undefined): Promise<void> {
		this.codeWindowById(windowId)?.setReady();
	}

	async relaunch(windowId: number | undefined, options?: IRelaunchOptions): Promise<void> {
		return this.lifecycleMainService.relaunch(options);
	}

	async reload(windowId: number | undefined, options?: { disableExtensions?: boolean }): Promise<void> {
		const window = this.codeWindowById(windowId);
		if (window) {
			if (isWorkspaceIdentifier(window.openedWorkspace)) {
				const configPath = window.openedWorkspace.configPath;
				if (configPath.scheme === Schemas.file) {
					const workspace = await this.workspacesManagementMainService.resolveLocalWorkspace(configPath);
					if (workspace?.transient) { return this.openWindow(window.id, { forceReuseWindow: true }); }
				}
			}
			return this.lifecycleMainService.reload(window, options?.disableExtensions !== undefined ? { _: [], 'disable-extensions': options.disableExtensions } : undefined);
		}
	}

	async closeWindow(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		const window = this.windowById(options?.targetWindowId, windowId);
		return window?.win?.close();
	}

	async quit(windowId: number | undefined): Promise<void> {
		const window = this.windowsMainService.getLastActiveWindow();
		if (window?.isExtensionDevelopmentHost && this.windowsMainService.getWindowCount() > 1 && window.win) {
			window.win.close();
		} else {
			this.lifecycleMainService.quit();
		}
	}

	async exit(windowId: number | undefined, code: number): Promise<void> {
		await this.lifecycleMainService.kill(code);
	}
	//#endregion

	//#region Connectivity
	async resolveProxy(windowId: number | undefined, url: string): Promise<string | undefined> {
		return invoke<string>('resolve_proxy', { url }).catch(() => undefined);
	}

	async lookupAuthorization(_windowId: number | undefined, authInfo: AuthInfo): Promise<Credentials | undefined> {
		return this.proxyAuthService.lookupAuthorization(authInfo);
	}

	async lookupKerberosAuthorization(_windowId: number | undefined, url: string): Promise<string | undefined> {
		return this.requestService.lookupKerberosAuthorization(url);
	}

	async loadCertificates(_windowId: number | undefined): Promise<string[]> {
		return this.requestService.loadCertificates();
	}

	isPortFree(windowId: number | undefined, port: number): Promise<boolean> {
		return isPortFree(port, 1_000);
	}

	findFreePort(windowId: number | undefined, startPort: number, giveUpAfter: number, timeout: number, stride = 1): Promise<number> {
		return findFreePort(startPort, giveUpAfter, timeout, stride);
	}
	//#endregion

	//#region Development
	private gpuInfoWindowId: number | undefined;
	private contentTracingWindowId: number | undefined;

	async openDevTools(windowId: number | undefined, options?: any): Promise<void> {
		invoke('open_dev_tools', { windowId: options?.targetWindowId ?? windowId }).catch(() => {});
	}

	async toggleDevTools(windowId: number | undefined, options?: INativeHostOptions): Promise<void> {
		invoke('toggle_dev_tools', { windowId: options?.targetWindowId ?? windowId }).catch(() => {});
	}

	async openDevToolsWindow(windowId: number | undefined, url: string): Promise<void> {
		invoke('open_child_window', { parentWindowId: windowId, url }).catch(() => {});
	}

	async openGPUInfoWindow(windowId: number | undefined): Promise<void> {
		invoke('open_gpu_info_window', { parentWindowId: windowId }).catch(() => {});
	}

	async openContentTracingWindow(): Promise<void> {
		invoke('open_content_tracing_window').catch(() => {});
	}

	async stopTracing(windowId: number | undefined): Promise<void> {
		if (!this.environmentMainService.args.trace) { return; }
		const path = await invoke<string>('stop_content_tracing', {
			outputPath: `${randomPath(this.environmentMainService.userHome.fsPath, this.productService.applicationName)}.trace.txt`
		});
		await this.dialogMainService.showMessageBox({
			type: 'info',
			message: localize('trace.message', "Successfully created the trace file"),
			detail: localize('trace.detail', "Please create an issue and manually attach the following file:\n{0}", path),
			buttons: [localize({ key: 'trace.ok', comment: ['&& denotes a mnemonic'] }, "&&OK")],
		});
		this.showItemInFolder(undefined, path);
	}
	//#endregion

	//#region Performance
	async profileRenderer(windowId: number | undefined, session: string, duration: number): Promise<IV8Profile> {
		const window = this.codeWindowById(windowId);
		if (!window?.win) { throw new Error(); }
		const profiler = new WindowProfiler(window.win, session, this.logService);
		return profiler.inspect(duration);
	}
	//#endregion

	//#region Toast Notifications
	private readonly activeToasts = this._register(new DisposableMap<string>());

	async showToast(windowId: number | undefined, options: IToastOptions): Promise<IToastResult> {
		const permissionGranted = await isPermissionGranted();
		if (!permissionGranted) {
			const permission = await requestPermission();
			if (permission !== 'granted') { return { supported: false, clicked: false }; }
		}
		const disposables = new DisposableStore();
		this.activeToasts.set(options.id, disposables);
		const cts = new CancellationTokenSource();
		disposables.add(toDisposable(() => { this.activeToasts.deleteAndDispose(options.id); cts.dispose(true); }));

		sendNotification({ title: options.title, body: options.body });
		return { supported: true, clicked: false };
	}

	async clearToast(windowId: number | undefined, toastId: string): Promise<void> { this.activeToasts.deleteAndDispose(toastId); }
	async clearToasts(): Promise<void> { this.activeToasts.clearAndDisposeAll(); }
	//#endregion

	//#region Registry (windows)
	async windowsGetStringRegKey(windowId: number | undefined, hive: 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE' | 'HKEY_CLASSES_ROOT' | 'HKEY_USERS' | 'HKEY_CURRENT_CONFIG', path: string, name: string): Promise<string | undefined> {
		if (!isWindows) { return undefined; }
		const Registry = await import('@vscode/windows-registry');
		try { return Registry.GetStringRegKey(hive, path, name); } catch { return undefined; }
	}
	//#endregion

	//#region Zip
	async createZipFile(windowId: number | undefined, zipPath: URI, files: { path: string; contents: string }[]): Promise<void> {
		await zip(zipPath.fsPath, files);
	}
	//#endregion

	//#region Power
	async getSystemIdleState(windowId: number | undefined, idleThreshold: number): Promise<SystemIdleState> {
		return invoke<SystemIdleState>('get_system_idle_state', { idleThreshold }).catch(() => 'unknown' as SystemIdleState);
	}

	async getSystemIdleTime(windowId: number | undefined): Promise<number> {
		return invoke<number>('get_system_idle_time').catch(() => 0);
	}

	async getCurrentThermalState(windowId: number | undefined): Promise<ThermalState> {
		return invoke<ThermalState>('get_current_thermal_state').catch(() => 'unknown' as ThermalState);
	}

	async isOnBatteryPower(windowId: number | undefined): Promise<boolean> {
		return invoke<boolean>('is_on_battery_power').catch(() => false);
	}

	async startPowerSaveBlocker(windowId: number | undefined, type: PowerSaveBlockerType): Promise<number> {
		return invoke<number>('start_power_save_blocker', { type }).catch(() => -1);
	}

	async stopPowerSaveBlocker(windowId: number | undefined, id: number): Promise<boolean> {
		return invoke<boolean>('stop_power_save_blocker', { id }).catch(() => false);
	}

	async isPowerSaveBlockerStarted(windowId: number | undefined, id: number): Promise<boolean> {
		return invoke<boolean>('is_power_save_blocker_started', { id }).catch(() => false);
	}
	//#endregion

	private windowById(windowId: number | undefined, fallbackCodeWindowId?: number): ICodeWindow | IAuxiliaryWindow | undefined {
		return this.codeWindowById(windowId) ?? this.auxiliaryWindowById(windowId) ?? this.codeWindowById(fallbackCodeWindowId);
	}

	private codeWindowById(windowId: number | undefined): ICodeWindow | undefined {
		if (typeof windowId !== 'number') { return undefined; }
		return this.windowsMainService.getWindowById(windowId);
	}

	private auxiliaryWindowById(windowId: number | undefined): IAuxiliaryWindow | undefined {
		if (typeof windowId !== 'number') { return undefined; }
		return this.auxiliaryWindowsMainService.getWindows().find(w => w.id === windowId);
	}
}
