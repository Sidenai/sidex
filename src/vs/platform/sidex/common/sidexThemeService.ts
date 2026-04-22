/*---------------------------------------------------------------------------------------------
 *  SideX Theme Service
 *  Routes theme discovery/loading through the Rust `sidex-theme` crate.
 *
 *  Registration note: VS Code's IWorkbenchThemeService (services/themes/
 *  browser/workbenchThemeService.ts) owns live theme application and is not
 *  replaced here. This bridge is exposed under its own decorator for consumers
 *  that need raw theme data from the Rust registry.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

export interface ThemeInfo {
	id: string;
	label: string;
	uiTheme: string;
}

export interface ThemeData {
	workbenchColors: Record<string, string>;
	tokenColors: Array<{
		scope: string[];
		settings: { foreground?: string; fontStyle?: string };
	}>;
}

export const ISideXThemeService = createDecorator<ISideXThemeService>('sidexThemeService');

export interface ISideXThemeService extends SideXThemeService {
	readonly _serviceBrand: undefined;
}

export class SideXThemeService {
	declare readonly _serviceBrand: undefined;
	async listThemes(): Promise<ThemeInfo[]> {
		try {
			return (await invoke('theme_list')) || [];
		} catch {
			return [];
		}
	}

	async getTheme(id: string): Promise<ThemeData | null> {
		try {
			return await invoke('theme_get', { id });
		} catch {
			return null;
		}
	}

	async getDefaultDark(): Promise<ThemeData | null> {
		try {
			return await invoke('theme_get_default_dark');
		} catch {
			return null;
		}
	}

	async getDefaultLight(): Promise<ThemeData | null> {
		try {
			return await invoke('theme_get_default_light');
		} catch {
			return null;
		}
	}
}

registerSingleton(ISideXThemeService, SideXThemeService, InstantiationType.Delayed);
