/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { mnemonicMenuLabel } from '../../../base/common/labels.js';
import { isMacintosh, language } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import * as nls from '../../../nls.js';
import { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IMenubarData, IMenubarKeybinding, IMenubarMenu, IMenubarMenuRecentItemAction, isMenubarMenuItemAction, isMenubarMenuItemRecentAction, isMenubarMenuItemSeparator, isMenubarMenuItemSubmenu, MenubarMenuItem } from '../common/menubar.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { IStateService } from '../../state/node/state.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { IUpdateService, StateType } from '../../update/common/update.js';
import { INativeRunActionInWindowRequest, INativeRunKeybindingInWindowRequest, IWindowOpenable, hasNativeMenu } from '../../window/common/window.js';
import { IWindowsCountChangedEvent, IWindowsMainService, OpenContext } from '../../windows/electron-main/windows.js';
import { IWorkspacesHistoryMainService } from '../../workspaces/electron-main/workspacesHistoryMainService.js';
import { Disposable } from '../../../base/common/lifecycle.js';

const telemetryFrom = 'menu';

interface TauriMenuItemDef {
	id?: string;
	label?: string;
	type?: 'normal' | 'separator' | 'checkbox' | 'submenu';
	enabled?: boolean;
	checked?: boolean;
	accelerator?: string;
	submenu?: TauriMenuItemDef[];
	role?: string;
}

type IMenuItemInvocation = (
	{ type: 'commandId'; commandId: string }
	| { type: 'keybinding'; userSettingsLabel: string }
);

interface IMenuItemWithKeybinding {
	userSettingsLabel?: string;
}

export class Menubar extends Disposable {

	private static readonly lastKnownMenubarStorageKey = 'lastKnownMenubarData';

	private willShutdown: boolean | undefined;
	private appMenuInstalled: boolean | undefined;
	private closedLastWindow: boolean;
	private noActiveMainWindow: boolean;
	private showNativeMenu: boolean;

	private menuUpdater: RunOnceScheduler;
	private menuGC: RunOnceScheduler;

	private oldMenus: TauriMenuItemDef[][];

	private menubarMenus: { [id: string]: IMenubarMenu };

	private keybindings: { [commandId: string]: IMenubarKeybinding };

	private readonly fallbackMenuHandlers: { [id: string]: () => void } = Object.create(null);

	constructor(
		@IUpdateService private readonly updateService: IUpdateService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IWorkspacesHistoryMainService private readonly workspacesHistoryMainService: IWorkspacesHistoryMainService,
		@IStateService private readonly stateService: IStateService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
		@IProductService private readonly productService: IProductService,
		@IAuxiliaryWindowsMainService private readonly auxiliaryWindowsMainService: IAuxiliaryWindowsMainService
	) {
		super();

		this.menuUpdater = this._register(new RunOnceScheduler(() => this.doUpdateMenu(), 0));
		this.menuGC = this._register(new RunOnceScheduler(() => { this.oldMenus = []; }, 10000));

		this.menubarMenus = Object.create(null);
		this.keybindings = Object.create(null);
		this.showNativeMenu = hasNativeMenu(configurationService);

		if (isMacintosh || this.showNativeMenu) {
			this.restoreCachedMenubarData();
		}

		this.addFallbackHandlers();

		this.closedLastWindow = false;
		this.noActiveMainWindow = false;
		this.oldMenus = [];

		this.install();
		this.registerListeners();
	}

	private restoreCachedMenubarData() {
		const menubarData = this.stateService.getItem<IMenubarData>(Menubar.lastKnownMenubarStorageKey);
		if (menubarData) {
			if (menubarData.menus) {
				this.menubarMenus = menubarData.menus;
			}
			if (menubarData.keybindings) {
				this.keybindings = menubarData.keybindings;
			}
		}
	}

	private addFallbackHandlers(): void {
		this.fallbackMenuHandlers['workbench.action.files.newUntitledFile'] = () => {
			if (!this.runActionInRenderer({ type: 'commandId', commandId: 'workbench.action.files.newUntitledFile' })) {
				this.windowsMainService.openEmptyWindow({ context: OpenContext.MENU });
			}
		};
		this.fallbackMenuHandlers['workbench.action.newWindow'] = () => this.windowsMainService.openEmptyWindow({ context: OpenContext.MENU });
		this.fallbackMenuHandlers['workbench.action.files.openFileFolder'] = () => this.nativeHostMainService.pickFileFolderAndOpen(undefined, { forceNewWindow: false, telemetryExtraData: { from: telemetryFrom } });
		this.fallbackMenuHandlers['workbench.action.files.openFolder'] = () => this.nativeHostMainService.pickFolderAndOpen(undefined, { forceNewWindow: false, telemetryExtraData: { from: telemetryFrom } });
		this.fallbackMenuHandlers['workbench.action.openWorkspace'] = () => this.nativeHostMainService.pickWorkspaceAndOpen(undefined, { forceNewWindow: false, telemetryExtraData: { from: telemetryFrom } });
		this.fallbackMenuHandlers['workbench.action.clearRecentFiles'] = () => this.workspacesHistoryMainService.clearRecentlyOpened({ confirm: true });

		const youTubeUrl = this.productService.youTubeUrl;
		if (youTubeUrl) {
			this.fallbackMenuHandlers['workbench.action.openYouTubeUrl'] = () => this.openUrl(youTubeUrl, 'openYouTubeUrl');
		}
		const requestFeatureUrl = this.productService.requestFeatureUrl;
		if (requestFeatureUrl) {
			this.fallbackMenuHandlers['workbench.action.openRequestFeatureUrl'] = () => this.openUrl(requestFeatureUrl, 'openUserVoiceUrl');
		}
		const reportIssueUrl = this.productService.reportIssueUrl;
		if (reportIssueUrl) {
			this.fallbackMenuHandlers['workbench.action.openIssueReporter'] = () => this.openUrl(reportIssueUrl, 'openReportIssues');
		}
		const licenseUrl = this.productService.licenseUrl;
		if (licenseUrl) {
			this.fallbackMenuHandlers['workbench.action.openLicenseUrl'] = () => {
				if (language) {
					const queryArgChar = licenseUrl.indexOf('?') > 0 ? '&' : '?';
					this.openUrl(`${licenseUrl}${queryArgChar}lang=${language}`, 'openLicenseUrl');
				} else {
					this.openUrl(licenseUrl, 'openLicenseUrl');
				}
			};
		}
		const privacyStatementUrl = this.productService.privacyStatementUrl;
		if (privacyStatementUrl && licenseUrl) {
			this.fallbackMenuHandlers['workbench.action.openPrivacyStatementUrl'] = () => {
				this.openUrl(privacyStatementUrl, 'openPrivacyStatement');
			};
		}
	}

	private registerListeners(): void {
		this._register(this.lifecycleMainService.onWillShutdown(() => this.willShutdown = true));
		this._register(this.windowsMainService.onDidChangeWindowsCount(e => this.onDidChangeWindowsCount(e)));
		this._register(this.nativeHostMainService.onDidBlurMainWindow(() => this.onDidChangeWindowFocus()));
		this._register(this.nativeHostMainService.onDidFocusMainWindow(() => this.onDidChangeWindowFocus()));
	}

	private get currentEnableMenuBarMnemonics(): boolean {
		const enableMenuBarMnemonics = this.configurationService.getValue('window.enableMenuBarMnemonics');
		if (typeof enableMenuBarMnemonics !== 'boolean') {
			return true;
		}
		return enableMenuBarMnemonics;
	}

	private get currentEnableNativeTabs(): boolean {
		if (!isMacintosh) {
			return false;
		}
		const enableNativeTabs = this.configurationService.getValue('window.nativeTabs');
		if (typeof enableNativeTabs !== 'boolean') {
			return false;
		}
		return enableNativeTabs;
	}

	updateMenu(menubarData: IMenubarData, windowId: number) {
		this.menubarMenus = menubarData.menus;
		this.keybindings = menubarData.keybindings;
		this.stateService.setItem(Menubar.lastKnownMenubarStorageKey, menubarData);
		this.scheduleUpdateMenu();
	}

	private scheduleUpdateMenu(): void {
		this.menuUpdater.schedule();
	}

	private doUpdateMenu(): void {
		if (!this.willShutdown) {
			setTimeout(() => {
				if (!this.willShutdown) {
					this.install();
				}
			}, 10);
		}
	}

	private onDidChangeWindowsCount(e: IWindowsCountChangedEvent): void {
		if (!isMacintosh) {
			return;
		}
		if ((e.oldCount === 0 && e.newCount > 0) || (e.oldCount > 0 && e.newCount === 0)) {
			this.closedLastWindow = e.newCount === 0;
			this.scheduleUpdateMenu();
		}
	}

	private onDidChangeWindowFocus(): void {
		if (!isMacintosh) {
			return;
		}
		invoke<number | null>('get_focused_window_id').then(focusedId => {
			this.noActiveMainWindow = focusedId === null || !!this.auxiliaryWindowsMainService.getWindows().find(w => w.id === focusedId);
			this.scheduleUpdateMenu();
		}).catch(() => {
			this.noActiveMainWindow = true;
			this.scheduleUpdateMenu();
		});
	}

	private install(): void {
		if (Object.keys(this.menubarMenus).length === 0) {
			this.doSetApplicationMenu(isMacintosh ? [] : null);
			return;
		}

		const menubar: TauriMenuItemDef[] = [];

		if (isMacintosh) {
			const applicationMenu = this.buildMacApplicationMenu();
			menubar.push({ label: this.productService.nameShort, type: 'submenu', submenu: applicationMenu });
		}

		if (isMacintosh && !this.appMenuInstalled) {
			this.appMenuInstalled = true;
			const dockMenu: TauriMenuItemDef[] = [
				{ label: this.mnemonicLabel(nls.localize({ key: 'miNewWindow', comment: ['&& denotes a mnemonic'] }, "New &&Window")), id: 'dock.newWindow' }
			];
			invoke('set_dock_menu', { menu: dockMenu }).catch(err => this.logService.error('Failed to set dock menu:', err));
		}

		const menuIds = ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal'];
		const menuLabels: Record<string, string> = {
			'File': nls.localize({ key: 'mFile', comment: ['&& denotes a mnemonic'] }, "&&File"),
			'Edit': nls.localize({ key: 'mEdit', comment: ['&& denotes a mnemonic'] }, "&&Edit"),
			'Selection': nls.localize({ key: 'mSelection', comment: ['&& denotes a mnemonic'] }, "&&Selection"),
			'View': nls.localize({ key: 'mView', comment: ['&& denotes a mnemonic'] }, "&&View"),
			'Go': nls.localize({ key: 'mGoto', comment: ['&& denotes a mnemonic'] }, "&&Go"),
			'Run': nls.localize({ key: 'mRun', comment: ['&& denotes a mnemonic'] }, "&&Run"),
			'Terminal': nls.localize({ key: 'mTerminal', comment: ['&& denotes a mnemonic'] }, "&&Terminal"),
		};

		for (const menuId of menuIds) {
			if (this.shouldDrawMenu(menuId)) {
				const items = this.buildMenuItems(menuId);
				menubar.push({ label: this.mnemonicLabel(menuLabels[menuId]), type: 'submenu', submenu: items });
			}
		}

		if (this.shouldDrawMenu('Window') && isMacintosh) {
			const windowMenu = this.buildMacWindowMenu();
			menubar.push({ label: this.mnemonicLabel(nls.localize('mWindow', "Window")), type: 'submenu', submenu: windowMenu, role: 'window' });
		}

		if (this.shouldDrawMenu('Help')) {
			const helpItems = this.buildMenuItems('Help');
			menubar.push({ label: this.mnemonicLabel(nls.localize({ key: 'mHelp', comment: ['&& denotes a mnemonic'] }, "&&Help")), type: 'submenu', submenu: helpItems, role: 'help' });
		}

		if (menubar.length > 0) {
			this.doSetApplicationMenu(menubar);
		} else {
			this.doSetApplicationMenu(null);
		}

		this.menuGC.schedule();
	}

	private doSetApplicationMenu(menu: TauriMenuItemDef[] | null): void {
		invoke('set_application_menu', { menu }).catch(err => this.logService.error('Failed to set application menu:', err));

		if (menu) {
			for (const window of this.auxiliaryWindowsMainService.getWindows()) {
				invoke('set_window_menu', { windowId: window.id, menu: null }).catch(() => { });
			}
		}
	}

	private buildMacApplicationMenu(): TauriMenuItemDef[] {
		const items: TauriMenuItemDef[] = [];

		items.push({ id: 'workbench.action.showAboutDialog', label: nls.localize('mAbout', "About {0}", this.productService.nameLong) });

		const updateItems = this.getUpdateMenuItemDefs();
		items.push(...updateItems);

		if (this.shouldDrawMenu('Preferences') && this.menubarMenus?.['Preferences']) {
			items.push({ type: 'separator' });
			const prefItems = this.buildMenuItems('Preferences');
			items.push({ label: this.mnemonicLabel(nls.localize({ key: 'miPreferences', comment: ['&& denotes a mnemonic'] }, "&&Preferences")), type: 'submenu', submenu: prefItems });
		}

		items.push(
			{ type: 'separator' },
			{ label: nls.localize('mServices', "Services"), role: 'services', type: 'submenu', submenu: [] },
			{ type: 'separator' },
			{ label: nls.localize('mHide', "Hide {0}", this.productService.nameLong), role: 'hide', accelerator: 'Command+H' },
			{ label: nls.localize('mHideOthers', "Hide Others"), role: 'hideOthers', accelerator: 'Command+Alt+H' },
			{ label: nls.localize('mShowAll', "Show All"), role: 'unhide' },
			{ type: 'separator' },
			{ id: 'workbench.action.quit', label: nls.localize('miQuit', "Quit {0}", this.productService.nameLong) }
		);

		return items;
	}

	private shouldDrawMenu(menuId: string): boolean {
		if (!isMacintosh && !this.showNativeMenu) {
			return false;
		}
		switch (menuId) {
			case 'File':
			case 'Help':
				if (isMacintosh) {
					return (this.windowsMainService.getWindowCount() === 0 && this.closedLastWindow) || (this.windowsMainService.getWindowCount() > 0 && this.noActiveMainWindow) || (!!this.menubarMenus && !!this.menubarMenus[menuId]);
				}
			case 'Window':
				if (isMacintosh) {
					return (this.windowsMainService.getWindowCount() === 0 && this.closedLastWindow) || (this.windowsMainService.getWindowCount() > 0 && this.noActiveMainWindow) || !!this.menubarMenus;
				}
			default:
				return this.windowsMainService.getWindowCount() > 0 && (!!this.menubarMenus && !!this.menubarMenus[menuId]);
		}
	}

	private buildMenuItems(menuId: string): TauriMenuItemDef[] {
		const items: TauriMenuItemDef[] = [];
		if (this.menubarMenus?.[menuId]) {
			for (const item of this.menubarMenus[menuId].items) {
				items.push(...this.convertMenuItem(item));
			}
		}
		return items;
	}

	private convertMenuItem(item: MenubarMenuItem): TauriMenuItemDef[] {
		if (isMenubarMenuItemSeparator(item)) {
			return [{ type: 'separator' }];
		} else if (isMenubarMenuItemSubmenu(item)) {
			const subItems: TauriMenuItemDef[] = [];
			for (const subItem of item.submenu.items) {
				subItems.push(...this.convertMenuItem(subItem));
			}
			return [{ label: this.mnemonicLabel(item.label), type: 'submenu', submenu: subItems }];
		} else if (isMenubarMenuItemRecentAction(item)) {
			const revivedUri = URI.revive(item.uri);
			const commandId = item.id;
			return [{ id: commandId, label: item.label, type: 'normal' }];
		} else if (isMenubarMenuItemAction(item)) {
			const enabled = typeof item.enabled === 'boolean' ? item.enabled : this.windowsMainService.getWindowCount() > 0;
			const def: TauriMenuItemDef = {
				id: item.id,
				label: this.mnemonicLabel(item.label),
				type: item.checked ? 'checkbox' : 'normal',
				enabled,
				checked: !!item.checked
			};
			const binding = this.keybindings[item.id];
			if (binding?.label && binding.isNative !== false) {
				def.accelerator = binding.label;
			}
			return [def];
		}
		return [];
	}

	private buildMacWindowMenu(): TauriMenuItemDef[] {
		const items: TauriMenuItemDef[] = [
			{ label: nls.localize('mMinimize', "Minimize"), role: 'minimize', accelerator: 'Command+M', enabled: this.windowsMainService.getWindowCount() > 0 },
			{ label: nls.localize('mZoom', "Zoom"), role: 'zoom', enabled: this.windowsMainService.getWindowCount() > 0 },
			{ type: 'separator' },
			{ id: 'workbench.action.switchWindow', label: this.mnemonicLabel(nls.localize({ key: 'miSwitchWindow', comment: ['&& denotes a mnemonic'] }, "Switch &&Window...")) },
		];

		if (this.currentEnableNativeTabs) {
			items.push(
				{ type: 'separator' },
				{ id: 'workbench.action.newWindowTab', label: nls.localize('mNewTab', "New Tab") },
				{ label: nls.localize('mShowPreviousTab', "Show Previous Tab"), role: 'selectPreviousTab' },
				{ label: nls.localize('mShowNextTab', "Show Next Tab"), role: 'selectNextTab' },
				{ label: nls.localize('mMoveTabToNewWindow', "Move Tab to New Window"), role: 'moveTabToNewWindow' },
				{ label: nls.localize('mMergeAllWindows', "Merge All Windows"), role: 'mergeAllWindows' },
			);
		}

		items.push(
			{ type: 'separator' },
			{ label: nls.localize('mBringToFront', "Bring All to Front"), role: 'front', enabled: this.windowsMainService.getWindowCount() > 0 }
		);

		return items;
	}

	private getUpdateMenuItemDefs(): TauriMenuItemDef[] {
		const state = this.updateService.state;
		switch (state.type) {
			case StateType.Idle:
				return [{ id: 'workbench.action.checkForUpdates', label: this.mnemonicLabel(nls.localize('miCheckForUpdates', "Check for &&Updates...")) }];
			case StateType.CheckingForUpdates:
				return [{ label: nls.localize('miCheckingForUpdates', "Checking for Updates..."), enabled: false }];
			case StateType.AvailableForDownload:
				return [{ id: 'workbench.action.downloadUpdate', label: this.mnemonicLabel(nls.localize('miDownloadUpdate', "D&&ownload Available Update")) }];
			case StateType.Downloading:
			case StateType.Overwriting:
				return [{ label: nls.localize('miDownloadingUpdate', "Downloading Update..."), enabled: false }];
			case StateType.Downloaded:
				return isMacintosh ? [] : [{ id: 'workbench.action.installUpdate', label: this.mnemonicLabel(nls.localize('miInstallUpdate', "Install &&Update...")) }];
			case StateType.Updating:
				return [{ label: nls.localize('miInstallingUpdate', "Installing Update..."), enabled: false }];
			case StateType.Ready:
				return [{ id: 'workbench.action.restartToUpdate', label: this.mnemonicLabel(nls.localize('miRestartToUpdate', "Restart to &&Update")) }];
			default:
				return [];
		}
	}

	private runActionInRenderer(invocation: IMenuItemInvocation): boolean {
		const activeWindow = this.windowsMainService.getFocusedWindow() || this.windowsMainService.getLastActiveWindow();

		if (activeWindow) {
			this.logService.trace('menubar#runActionInRenderer', invocation);

			if (isMacintosh && !this.environmentMainService.isBuilt && !activeWindow.isReady) {
				if ((invocation.type === 'commandId' && invocation.commandId === 'workbench.action.toggleDevTools') || (invocation.type !== 'commandId' && invocation.userSettingsLabel === 'alt+cmd+i')) {
					return false;
				}
			}

			if (invocation.type === 'commandId') {
				const runActionPayload: INativeRunActionInWindowRequest = { id: invocation.commandId, from: 'menu' };
				activeWindow.sendWhenReady('vscode:runAction', CancellationToken.None, runActionPayload);
			} else {
				const runKeybindingPayload: INativeRunKeybindingInWindowRequest = { userSettingsLabel: invocation.userSettingsLabel };
				activeWindow.sendWhenReady('vscode:runKeybinding', CancellationToken.None, runKeybindingPayload);
			}

			return true;
		} else {
			this.logService.trace('menubar#runActionInRenderer: no active window found', invocation);
			return false;
		}
	}

	private openUrl(url: string, id: string): void {
		this.nativeHostMainService.openExternal(undefined, url);
		this.reportMenuActionTelemetry(id);
	}

	private reportMenuActionTelemetry(id: string): void {
		this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id, from: telemetryFrom });
	}

	private mnemonicLabel(label: string): string {
		return mnemonicMenuLabel(label, !this.currentEnableMenuBarMnemonics);
	}
}
