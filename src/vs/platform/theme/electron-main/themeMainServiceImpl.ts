/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getAllWindows } from '@tauri-apps/api/window';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IStateService } from '../../state/node/state.js';
import { IPartsSplash } from '../common/themeService.js';
import { IColorScheme } from '../../window/common/window.js';
import { ThemeTypeSelector } from '../common/theme.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { coalesce } from '../../../base/common/arrays.js';
import { ILogService, LogLevel } from '../../log/common/log.js';
import { IThemeMainService } from './themeMainService.js';

const DEFAULT_BG_LIGHT = '#FFFFFF';
const DEFAULT_BG_DARK = '#1F1F1F';
const DEFAULT_BG_HC_BLACK = '#000000';
const DEFAULT_BG_HC_LIGHT = '#FFFFFF';

const THEME_STORAGE_KEY = 'theme';
const THEME_BG_STORAGE_KEY = 'themeBackground';

const THEME_WINDOW_SPLASH_KEY = 'windowSplash';
const THEME_WINDOW_SPLASH_OVERRIDE_KEY = 'windowSplashWorkspaceOverride';

interface NativeThemeState {
	shouldUseDarkColors: boolean;
	shouldUseHighContrastColors: boolean;
	shouldUseInvertedColorScheme: boolean;
	themeSource: 'system' | 'light' | 'dark';
	shouldUseDarkColorsForSystemIntegratedUI: boolean;
}

class Setting<T> {
	constructor(public readonly key: string, public readonly defaultValue: T) {
	}
	getValue(configurationService: IConfigurationService): T {
		return configurationService.getValue<T>(this.key) ?? this.defaultValue;
	}
}

namespace Setting {
	export const DETECT_COLOR_SCHEME = new Setting<boolean>('window.autoDetectColorScheme', false);
	export const DETECT_HC = new Setting<boolean>('window.autoDetectHighContrast', true);
	export const SYSTEM_COLOR_THEME = new Setting<'default' | 'auto' | 'light' | 'dark'>('window.systemColorTheme', 'default');
	export const AUXILIARYBAR_DEFAULT_VISIBILITY = new Setting<'hidden' | 'visibleInWorkspace' | 'visible' | 'maximizedInWorkspace' | 'maximized'>('workbench.secondarySideBar.defaultVisibility', 'visibleInWorkspace');
	export const STARTUP_EDITOR = new Setting<'none' | 'welcomePage' | 'readme' | 'newUntitledFile' | 'welcomePageInEmptyWorkbench' | 'terminal' | 'agentSessionsWelcomePage'>('workbench.startupEditor', 'welcomePage');
}

interface IPartSplashOverrideWorkspaces {
	[workspaceId: string]: {
		sideBarVisible: boolean;
		auxiliaryBarVisible: boolean;
	};
}

interface IPartsSplashOverride {
	layoutInfo: {
		sideBarWidth: number;
		auxiliaryBarWidth: number;

		workspaces: IPartSplashOverrideWorkspaces;
	};
}

export class ThemeMainService extends Disposable implements IThemeMainService {

	declare readonly _serviceBrand: undefined;

	private static readonly DEFAULT_BAR_WIDTH = 300;

	private static readonly WORKSPACE_OVERRIDE_LIMIT = 50;

	private readonly _onDidChangeColorScheme = this._register(new Emitter<IColorScheme>());
	readonly onDidChangeColorScheme = this._onDidChangeColorScheme.event;

	private cachedThemeState: NativeThemeState = {
		shouldUseDarkColors: false,
		shouldUseHighContrastColors: false,
		shouldUseInvertedColorScheme: false,
		themeSource: 'system',
		shouldUseDarkColorsForSystemIntegratedUI: false
	};

	constructor(
		@IStateService private stateService: IStateService,
		@IConfigurationService private configurationService: IConfigurationService,
		@ILogService private logService: ILogService
	) {
		super();

		// System Theme
		if (!isLinux) {
			this._register(this.configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(Setting.SYSTEM_COLOR_THEME.key) || e.affectsConfiguration(Setting.DETECT_COLOR_SCHEME.key)) {
					this.updateSystemColorTheme();
					this.logThemeSettings();
				}
			}));
		}

		this.initializeThemeState();
	}

	private async initializeThemeState(): Promise<void> {
		await this.refreshThemeState();
		this.updateSystemColorTheme();
		this.logThemeSettings();

		// Listen for OS theme changes from the Rust backend
		const unlisten = await listen<NativeThemeState>('native-theme-updated', (event) => {
			this.cachedThemeState = event.payload;
			this.logThemeSettings();
			this._onDidChangeColorScheme.fire(this.getColorScheme());
		});
		this._register({ dispose: () => unlisten() });
	}

	private async refreshThemeState(): Promise<void> {
		try {
			this.cachedThemeState = await invoke<NativeThemeState>('get_native_theme_state');
		} catch {
			// keep defaults
		}
	}

	private logThemeSettings(): void {
		if (this.logService.getLevel() >= LogLevel.Debug) {
			const logSetting = (setting: Setting<string | boolean>) => `${setting.key}=${setting.getValue(this.configurationService)}`;
			this.logService.debug(`[theme main service] ${logSetting(Setting.DETECT_COLOR_SCHEME)}, ${logSetting(Setting.DETECT_HC)}, ${logSetting(Setting.SYSTEM_COLOR_THEME)}`);

			const state = this.cachedThemeState;
			this.logService.debug(`[theme main service] nativeTheme: themeSource=${state.themeSource}, shouldUseDarkColors=${state.shouldUseDarkColors}, shouldUseHighContrastColors=${state.shouldUseHighContrastColors}, shouldUseInvertedColorScheme=${state.shouldUseInvertedColorScheme}, shouldUseDarkColorsForSystemIntegratedUI=${state.shouldUseDarkColorsForSystemIntegratedUI}`);
			this.logService.debug(`[theme main service] New color scheme: ${JSON.stringify(this.getColorScheme())}`);
		}
	}

	private updateSystemColorTheme(): void {
		let themeSource: 'system' | 'light' | 'dark';

		if (isLinux || this.isAutoDetectColorScheme()) {
			themeSource = 'system';
		} else {
			switch (Setting.SYSTEM_COLOR_THEME.getValue(this.configurationService)) {
				case 'dark':
					themeSource = 'dark';
					break;
				case 'light':
					themeSource = 'light';
					break;
				case 'auto':
					switch (this.getPreferredBaseTheme() ?? this.getStoredBaseTheme()) {
						case ThemeTypeSelector.VS: themeSource = 'light'; break;
						case ThemeTypeSelector.VS_DARK: themeSource = 'dark'; break;
						default: themeSource = 'system';
					}
					break;
				default:
					themeSource = 'system';
					break;
			}
		}

		invoke('set_native_theme_source', { themeSource }).catch(() => {
			// theme backend may not be available
		});
		this.cachedThemeState.themeSource = themeSource;
	}

	getColorScheme(): IColorScheme {

		if (isWindows) {
			if (this.cachedThemeState.shouldUseHighContrastColors) {
				return { dark: this.cachedThemeState.shouldUseInvertedColorScheme, highContrast: true };
			}
		}

		else if (isMacintosh) {
			if (this.cachedThemeState.shouldUseInvertedColorScheme || this.cachedThemeState.shouldUseHighContrastColors) {
				return { dark: this.cachedThemeState.shouldUseDarkColors, highContrast: true };
			}
		}

		else if (isLinux) {
			if (this.cachedThemeState.shouldUseHighContrastColors) {
				return { dark: true, highContrast: true };
			}
		}

		return {
			dark: this.cachedThemeState.shouldUseDarkColors,
			highContrast: false
		};
	}

	getPreferredBaseTheme(): ThemeTypeSelector | undefined {
		const colorScheme = this.getColorScheme();
		if (Setting.DETECT_HC.getValue(this.configurationService) && colorScheme.highContrast) {
			return colorScheme.dark ? ThemeTypeSelector.HC_BLACK : ThemeTypeSelector.HC_LIGHT;
		}

		if (this.isAutoDetectColorScheme()) {
			return colorScheme.dark ? ThemeTypeSelector.VS_DARK : ThemeTypeSelector.VS;
		}

		return undefined;
	}

	isAutoDetectColorScheme(): boolean {
		if (Setting.DETECT_COLOR_SCHEME.getValue(this.configurationService)) {
			return true;
		}
		if (!this.stateService.getItem(THEME_STORAGE_KEY)) {
			const { userValue } = this.configurationService.inspect<boolean>(Setting.DETECT_COLOR_SCHEME.key);
			return userValue === undefined;
		}
		return false;
	}

	getBackgroundColor(): string {
		const preferred = this.getPreferredBaseTheme();
		const stored = this.getStoredBaseTheme();

		if (preferred === undefined || preferred === stored) {
			const storedBackground = this.stateService.getItem<string | null>(THEME_BG_STORAGE_KEY, null);
			if (storedBackground) {
				return storedBackground;
			}
		}

		switch (preferred ?? stored) {
			case ThemeTypeSelector.VS: return DEFAULT_BG_LIGHT;
			case ThemeTypeSelector.HC_BLACK: return DEFAULT_BG_HC_BLACK;
			case ThemeTypeSelector.HC_LIGHT: return DEFAULT_BG_HC_LIGHT;
			default: return DEFAULT_BG_DARK;
		}
	}

	private getStoredBaseTheme(): ThemeTypeSelector {
		const baseTheme = this.stateService.getItem<ThemeTypeSelector>(THEME_STORAGE_KEY, ThemeTypeSelector.VS_DARK).split(' ')[0];
		switch (baseTheme) {
			case ThemeTypeSelector.VS: return ThemeTypeSelector.VS;
			case ThemeTypeSelector.HC_BLACK: return ThemeTypeSelector.HC_BLACK;
			case ThemeTypeSelector.HC_LIGHT: return ThemeTypeSelector.HC_LIGHT;
			default: return ThemeTypeSelector.VS_DARK;
		}
	}

	saveWindowSplash(windowId: number | undefined, workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined, splash: IPartsSplash): void {

		const splashOverride = this.updateWindowSplashOverride(workspace, splash);

		this.stateService.setItems(coalesce([
			{ key: THEME_STORAGE_KEY, data: splash.baseTheme },
			{ key: THEME_BG_STORAGE_KEY, data: splash.colorInfo.background },
			{ key: THEME_WINDOW_SPLASH_KEY, data: splash },
			splashOverride ? { key: THEME_WINDOW_SPLASH_OVERRIDE_KEY, data: splashOverride } : undefined
		]));

		if (typeof windowId === 'number') {
			this.updateBackgroundColor(windowId, splash);
		}

		this.updateSystemColorTheme();
	}

	private updateWindowSplashOverride(workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined, splash: IPartsSplash): IPartsSplashOverride | undefined {
		let splashOverride: IPartsSplashOverride | undefined = undefined;
		let changed = false;
		if (workspace) {
			splashOverride = { ...this.getWindowSplashOverride() };

			changed = this.doUpdateWindowSplashOverride(workspace, splash, splashOverride, 'sideBar');
			changed = this.doUpdateWindowSplashOverride(workspace, splash, splashOverride, 'auxiliaryBar') || changed;
		}

		return changed ? splashOverride : undefined;
	}

	private doUpdateWindowSplashOverride(workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier, splash: IPartsSplash, splashOverride: IPartsSplashOverride, part: 'sideBar' | 'auxiliaryBar'): boolean {
		const currentWidth = part === 'sideBar' ? splash.layoutInfo?.sideBarWidth : splash.layoutInfo?.auxiliaryBarWidth;
		const overrideWidth = part === 'sideBar' ? splashOverride.layoutInfo.sideBarWidth : splashOverride.layoutInfo.auxiliaryBarWidth;

		let changed = false;
		if (typeof currentWidth !== 'number') {
			if (splashOverride.layoutInfo.workspaces[workspace.id]) {
				delete splashOverride.layoutInfo.workspaces[workspace.id];
				changed = true;
			}

			return changed;
		}

		let workspaceOverride = splashOverride.layoutInfo.workspaces[workspace.id];
		if (!workspaceOverride) {
			const workspaceEntries = Object.keys(splashOverride.layoutInfo.workspaces);
			if (workspaceEntries.length >= ThemeMainService.WORKSPACE_OVERRIDE_LIMIT) {
				delete splashOverride.layoutInfo.workspaces[workspaceEntries[0]];
				changed = true;
			}

			workspaceOverride = { sideBarVisible: false, auxiliaryBarVisible: false };
			splashOverride.layoutInfo.workspaces[workspace.id] = workspaceOverride;
			changed = true;
		}

		if (currentWidth > 0) {
			if (overrideWidth !== currentWidth) {
				splashOverride.layoutInfo[part === 'sideBar' ? 'sideBarWidth' : 'auxiliaryBarWidth'] = currentWidth;
				changed = true;
			}

			switch (part) {
				case 'sideBar':
					if (!workspaceOverride.sideBarVisible) {
						workspaceOverride.sideBarVisible = true;
						changed = true;
					}
					break;
				case 'auxiliaryBar':
					if (!workspaceOverride.auxiliaryBarVisible) {
						workspaceOverride.auxiliaryBarVisible = true;
						changed = true;
					}
					break;
			}
		}

		else {
			switch (part) {
				case 'sideBar':
					if (workspaceOverride.sideBarVisible) {
						workspaceOverride.sideBarVisible = false;
						changed = true;
					}
					break;
				case 'auxiliaryBar':
					if (workspaceOverride.auxiliaryBarVisible) {
						workspaceOverride.auxiliaryBarVisible = false;
						changed = true;
					}
					break;
			}
		}

		return changed;
	}

	private async updateBackgroundColor(windowId: number, splash: IPartsSplash): Promise<void> {
		try {
			const allWindows = await getAllWindows();
			for (const window of allWindows) {
				const label = window.label;
				if (label === String(windowId) || label === `window-${windowId}`) {
					await invoke('set_window_background_color', {
						label,
						color: splash.colorInfo.background
					});
					break;
				}
			}
		} catch {
			// window may not be available
		}
	}

	getWindowSplash(workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined): IPartsSplash | undefined {
		try {
			return this.doGetWindowSplash(workspace);
		} catch (error) {
			this.logService.error('[theme main service] Failed to get window splash', error);

			return undefined;
		}
	}

	private doGetWindowSplash(workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined): IPartsSplash | undefined {
		const partSplash = this.stateService.getItem<IPartsSplash>(THEME_WINDOW_SPLASH_KEY);
		if (!partSplash?.layoutInfo) {
			return partSplash;
		}

		const override = this.getWindowSplashOverride();

		let sideBarWidth: number;
		if (workspace) {
			if (override.layoutInfo.workspaces[workspace.id]?.sideBarVisible === false) {
				sideBarWidth = 0;
			} else {
				sideBarWidth = override.layoutInfo.sideBarWidth || partSplash.layoutInfo.sideBarWidth || ThemeMainService.DEFAULT_BAR_WIDTH;
			}
		} else {
			sideBarWidth = 0;
		}

		const auxiliaryBarDefaultVisibility = Setting.AUXILIARYBAR_DEFAULT_VISIBILITY.getValue(this.configurationService);
		const startupEditor = Setting.STARTUP_EDITOR.getValue(this.configurationService);
		let auxiliaryBarWidth: number;
		if (workspace) {
			const auxiliaryBarVisible = override.layoutInfo.workspaces[workspace.id]?.auxiliaryBarVisible;
			if (auxiliaryBarVisible === true) {
				auxiliaryBarWidth = override.layoutInfo.auxiliaryBarWidth || partSplash.layoutInfo.auxiliaryBarWidth || ThemeMainService.DEFAULT_BAR_WIDTH;
			} else if (auxiliaryBarVisible === false) {
				auxiliaryBarWidth = 0;
			} else {
				if (startupEditor !== 'agentSessionsWelcomePage' && (auxiliaryBarDefaultVisibility === 'visible' || auxiliaryBarDefaultVisibility === 'visibleInWorkspace')) {
					auxiliaryBarWidth = override.layoutInfo.auxiliaryBarWidth || partSplash.layoutInfo.auxiliaryBarWidth || ThemeMainService.DEFAULT_BAR_WIDTH;
				} else if (startupEditor !== 'agentSessionsWelcomePage' && (auxiliaryBarDefaultVisibility === 'maximized' || auxiliaryBarDefaultVisibility === 'maximizedInWorkspace')) {
					auxiliaryBarWidth = Number.MAX_SAFE_INTEGER;
				} else {
					auxiliaryBarWidth = 0;
				}
			}
		} else {
			auxiliaryBarWidth = 0;
		}

		return {
			...partSplash,
			layoutInfo: {
				...partSplash.layoutInfo,
				sideBarWidth,
				auxiliaryBarWidth
			}
		};
	}

	private getWindowSplashOverride(): IPartsSplashOverride {
		let override = this.stateService.getItem<IPartsSplashOverride>(THEME_WINDOW_SPLASH_OVERRIDE_KEY);

		if (!override?.layoutInfo) {
			override = {
				layoutInfo: {
					sideBarWidth: ThemeMainService.DEFAULT_BAR_WIDTH,
					auxiliaryBarWidth: ThemeMainService.DEFAULT_BAR_WIDTH,
					workspaces: {}
				}
			};
		}

		if (!override.layoutInfo.sideBarWidth) {
			override.layoutInfo.sideBarWidth = ThemeMainService.DEFAULT_BAR_WIDTH;
		}

		if (!override.layoutInfo.auxiliaryBarWidth) {
			override.layoutInfo.auxiliaryBarWidth = ThemeMainService.DEFAULT_BAR_WIDTH;
		}

		if (!override.layoutInfo.workspaces) {
			override.layoutInfo.workspaces = {};
		}

		return override;
	}
}
