/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getAllWindows } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { Color } from '../../../base/common/color.js';
import { Event } from '../../../base/common/event.js';
import { join } from '../../../base/common/path.js';
import { INodeProcess, IProcessEnvironment, isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { NativeParsedArgs } from '../../environment/common/argv.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ServicesAccessor, createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IThemeMainService } from '../../theme/electron-main/themeMainService.js';
import { IOpenEmptyWindowOptions, IWindowOpenable, IWindowSettings, TitlebarStyle, WindowMinimumSize, hasNativeTitlebar, useNativeFullScreen, useWindowControlsOverlay, zoomLevelToZoomFactor } from '../../window/common/window.js';
import { ICodeWindow, IWindowState, TauriRectangle, WindowMode, defaultWindowState } from '../../window/electron-main/window.js';

export interface TauriDisplay {
	id: number;
	bounds: TauriRectangle;
	workArea: TauriRectangle;
	scaleFactor: number;
}

export interface TauriWindowOptions {
	url?: string;
	title?: string;
	width?: number;
	height?: number;
	minWidth?: number;
	minHeight?: number;
	x?: number;
	y?: number;
	fullscreen?: boolean;
	maximized?: boolean;
	visible?: boolean;
	decorations?: boolean;
	alwaysOnTop?: boolean;
	titleBarStyle?: 'visible' | 'transparent' | 'overlay';
	transparent?: boolean;
	acceptFirstMouse?: boolean;
	tabbingIdentifier?: string;
	experimentalDarkMode?: boolean;
}

export const IWindowsMainService = createDecorator<IWindowsMainService>('windowsMainService');

export interface IWindowsMainService {

	readonly _serviceBrand: undefined;

	readonly onDidChangeWindowsCount: Event<IWindowsCountChangedEvent>;

	readonly onDidOpenWindow: Event<ICodeWindow>;
	readonly onDidSignalReadyWindow: Event<ICodeWindow>;
	readonly onDidMaximizeWindow: Event<ICodeWindow>;
	readonly onDidUnmaximizeWindow: Event<ICodeWindow>;
	readonly onDidChangeFullScreen: Event<{ window: ICodeWindow; fullscreen: boolean }>;
	readonly onDidTriggerSystemContextMenu: Event<{ readonly window: ICodeWindow; readonly x: number; readonly y: number }>;
	readonly onDidDestroyWindow: Event<ICodeWindow>;

	open(openConfig: IOpenConfiguration): Promise<ICodeWindow[]>;
	openEmptyWindow(openConfig: IOpenEmptyConfiguration, options?: IOpenEmptyWindowOptions): Promise<ICodeWindow[]>;
	openExtensionDevelopmentHostWindow(extensionDevelopmentPath: string[], openConfig: IOpenConfiguration): Promise<ICodeWindow[]>;
	openExistingWindow(window: ICodeWindow, openConfig: IOpenConfiguration): void;

	openAgentsWindow(openConfig: IBaseOpenConfiguration): Promise<ICodeWindow[]>;

	sendToFocused(channel: string, ...args: unknown[]): void;
	sendToOpeningWindow(channel: string, ...args: unknown[]): void;
	sendToAll(channel: string, payload?: unknown, windowIdsToIgnore?: number[]): void;

	getWindows(): ICodeWindow[];
	getWindowCount(): number;

	getFocusedWindow(): ICodeWindow | undefined;
	getLastActiveWindow(): ICodeWindow | undefined;

	getWindowById(windowId: number): ICodeWindow | undefined;
	getWindowByWebContents(windowLabel: string): ICodeWindow | undefined;
}

export interface IWindowsCountChangedEvent {
	readonly oldCount: number;
	readonly newCount: number;
}

export const enum OpenContext {

	// opening when running from the command line
	CLI,

	// macOS only: opening from the dock (also when opening files to a running instance from desktop)
	DOCK,

	// opening from the main application window
	MENU,

	// opening from a file or folder dialog
	DIALOG,

	// opening from the OS's UI
	DESKTOP,

	// opening through the API
	API,

	// opening from a protocol link
	LINK
}

export interface IBaseOpenConfiguration {
	readonly context: OpenContext;
	readonly contextWindowId?: number;
}

export interface IOpenConfiguration extends IBaseOpenConfiguration {
	readonly cli: NativeParsedArgs;
	readonly userEnv?: IProcessEnvironment;
	readonly urisToOpen?: IWindowOpenable[];
	readonly waitMarkerFileURI?: URI;
	readonly preferNewWindow?: boolean;
	readonly forceNewWindow?: boolean;
	readonly forceNewTabbedWindow?: boolean;
	readonly forceReuseWindow?: boolean;
	readonly forceEmpty?: boolean;
	readonly diffMode?: boolean;
	readonly mergeMode?: boolean;
	addMode?: boolean;
	removeMode?: boolean;
	readonly gotoLineMode?: boolean;
	readonly initialStartup?: boolean;
	readonly noRecentEntry?: boolean;
	/**
	 * The remote authority to use when windows are opened with either
	 * - no workspace (empty window)
	 * - a workspace that is neither `file://` nor `vscode-remote://`
	 */
	readonly remoteAuthority?: string;
	readonly forceProfile?: string;
	readonly forceTempProfile?: boolean;
}

export interface IOpenEmptyConfiguration extends IBaseOpenConfiguration { }

export interface IDefaultBrowserWindowOptionsOverrides {
	forceNativeTitlebar?: boolean;
	disableFullscreen?: boolean;
	alwaysOnTop?: boolean;
}

export function defaultBrowserWindowOptions(accessor: ServicesAccessor, windowState: IWindowState, overrides?: IDefaultBrowserWindowOptionsOverrides): TauriWindowOptions {
	const themeMainService = accessor.get(IThemeMainService);
	const productService = accessor.get(IProductService);
	const configurationService = accessor.get(IConfigurationService);
	const environmentMainService = accessor.get(IEnvironmentMainService);

	const windowSettings = configurationService.getValue<IWindowSettings | undefined>('window');

	const options: TauriWindowOptions = {
		minWidth: WindowMinimumSize.WIDTH,
		minHeight: WindowMinimumSize.HEIGHT,
		title: productService.nameLong,
		visible: windowState.mode !== WindowMode.Maximized && windowState.mode !== WindowMode.Fullscreen,
		x: windowState.x,
		y: windowState.y,
		width: windowState.width,
		height: windowState.height,
		experimentalDarkMode: true
	};

	if (overrides?.disableFullscreen) {
		options.fullscreen = false;
	}

	const useNativeTabs = isMacintosh && windowSettings?.nativeTabs === true;
	if (useNativeTabs) {
		options.tabbingIdentifier = productService.nameShort;
	}

	const hideNativeTitleBar = !hasNativeTitlebar(configurationService, overrides?.forceNativeTitlebar ? TitlebarStyle.NATIVE : undefined);
	if (hideNativeTitleBar) {
		options.decorations = false;
		if (isMacintosh) {
			options.titleBarStyle = 'overlay';
		}
	}

	if (overrides?.alwaysOnTop) {
		options.alwaysOnTop = true;
	}

	if (isMacintosh) {
		options.acceptFirstMouse = true;

		if (windowSettings?.clickThroughInactive === false) {
			options.acceptFirstMouse = false;
		}
	}

	return options;
}

export function getLastFocused(windows: ICodeWindow[]): ICodeWindow | undefined;
export function getLastFocused(windows: IAuxiliaryWindow[]): IAuxiliaryWindow | undefined;
export function getLastFocused(windows: ICodeWindow[] | IAuxiliaryWindow[]): ICodeWindow | IAuxiliaryWindow | undefined {
	let lastFocusedWindow: ICodeWindow | IAuxiliaryWindow | undefined = undefined;
	let maxLastFocusTime = Number.MIN_VALUE;

	for (const window of windows) {
		if (window.lastFocusTime > maxLastFocusTime) {
			maxLastFocusTime = window.lastFocusTime;
			lastFocusedWindow = window;
		}
	}

	return lastFocusedWindow;
}

export namespace WindowStateValidator {

	export async function validateWindowState(logService: ILogService, state: IWindowState, displays?: TauriDisplay[]): Promise<IWindowState | undefined> {
		if (!displays) {
			displays = await invoke<TauriDisplay[]>('get_all_displays');
		}

		logService.trace(`window#validateWindowState: validating window state on ${displays.length} display(s)`, state);

		if (
			typeof state.x !== 'number' ||
			typeof state.y !== 'number' ||
			typeof state.width !== 'number' ||
			typeof state.height !== 'number'
		) {
			logService.trace('window#validateWindowState: unexpected type of state values');

			return undefined;
		}

		if (state.width <= 0 || state.height <= 0) {
			logService.trace('window#validateWindowState: unexpected negative values');

			return undefined;
		}

		// Single Monitor: be strict about x/y positioning
		if (displays.length === 1) {
			const displayWorkingArea = getWorkingArea(displays[0]);
			logService.trace('window#validateWindowState: single monitor working area', displayWorkingArea);

			if (displayWorkingArea) {

				function ensureStateInDisplayWorkingArea(): void {
					if (!state || typeof state.x !== 'number' || typeof state.y !== 'number' || !displayWorkingArea) {
						return;
					}

					if (state.x < displayWorkingArea.x) {
						state.x = displayWorkingArea.x;
					}

					if (state.y < displayWorkingArea.y) {
						state.y = displayWorkingArea.y;
					}
				}

				ensureStateInDisplayWorkingArea();

				if (state.width > displayWorkingArea.width) {
					state.width = displayWorkingArea.width;
				}

				if (state.height > displayWorkingArea.height) {
					state.height = displayWorkingArea.height;
				}

				if (state.x > (displayWorkingArea.x + displayWorkingArea.width - 128)) {
					state.x = displayWorkingArea.x + displayWorkingArea.width - state.width;
				}

				if (state.y > (displayWorkingArea.y + displayWorkingArea.height - 128)) {
					state.y = displayWorkingArea.y + displayWorkingArea.height - state.height;
				}

				ensureStateInDisplayWorkingArea();
			}

			return state;
		}

		// Multi Monitor (fullscreen): try to find the previously used display
		if (state.display && state.mode === WindowMode.Fullscreen) {
			const display = displays.find(d => d.id === state.display);
			if (display && typeof display.bounds?.x === 'number' && typeof display.bounds?.y === 'number') {
				logService.trace('window#validateWindowState: restoring fullscreen to previous display');

				const defaults = defaultWindowState(WindowMode.Fullscreen);
				defaults.x = display.bounds.x;
				defaults.y = display.bounds.y;

				return defaults;
			}
		}

		// Multi Monitor (non-fullscreen): ensure window is within display bounds
		let display: TauriDisplay | undefined;
		let displayWorkingArea: TauriRectangle | undefined;
		try {
			display = await invoke<TauriDisplay>('get_display_matching', { rect: { x: state.x, y: state.y, width: state.width, height: state.height } });
			displayWorkingArea = getWorkingArea(display);

			logService.trace('window#validateWindowState: multi-monitor working area', displayWorkingArea);
		} catch (error) {
			logService.error('window#validateWindowState: error finding display for window state', error);
		}

		if (display && validateWindowStateOnDisplay(state, display)) {
			return state;
		}

		logService.trace('window#validateWindowState: state is outside of the multi-monitor working area');

		return undefined;
	}

	export function validateWindowStateOnDisplay(state: IWindowState, display: TauriDisplay): boolean {
		if (
			typeof state.x !== 'number' ||
			typeof state.y !== 'number' ||
			typeof state.width !== 'number' ||
			typeof state.height !== 'number' ||
			state.width <= 0 || state.height <= 0
		) {
			return false;
		}

		const displayWorkingArea = getWorkingArea(display);
		return Boolean(
			displayWorkingArea &&
			state.x + state.width > displayWorkingArea.x &&
			state.y + state.height > displayWorkingArea.y &&
			state.x < displayWorkingArea.x + displayWorkingArea.width &&
			state.y < displayWorkingArea.y + displayWorkingArea.height
		);
	}

	function getWorkingArea(display: TauriDisplay): TauriRectangle | undefined {
		if (display.workArea.width > 0 && display.workArea.height > 0) {
			return display.workArea;
		}

		if (display.bounds.width > 0 && display.bounds.height > 0) {
			return display.bounds;
		}

		return undefined;
	}
}

/**
 * Returns all Tauri WebviewWindows, filtering out any offscreen utility windows.
 */
export async function getAllWindowsExcludingOffscreen(): Promise<number> {
	const windows = getAllWindows();
	return windows.length;
}
