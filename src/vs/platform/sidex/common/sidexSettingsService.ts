/*---------------------------------------------------------------------------------------------
 *  SideX Settings Service
 *  Routes settings read/write through the Rust `sidex-settings` crate.
 *
 *  Registration note: VS Code's IConfigurationService (platform/configuration/
 *  common/configuration.ts) is a layered, observable service covering
 *  default/user/workspace scopes and is not replaced here. This bridge is
 *  exposed under its own decorator for simple Rust-backed get/update.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

export const ISideXSettingsService = createDecorator<ISideXSettingsService>('sidexSettingsService');

export interface ISideXSettingsService extends SideXSettingsService {
	readonly _serviceBrand: undefined;
}

export class SideXSettingsService {
	declare readonly _serviceBrand: undefined;
	async get(section?: string): Promise<Record<string, unknown>> {
		try {
			return (await invoke('settings_get', { section: section || null })) || {};
		} catch {
			return {};
		}
	}

	async update(key: string, value: unknown, scope: string = 'user'): Promise<void> {
		return invoke('settings_update', { key, value: JSON.stringify(value), scope });
	}
}

registerSingleton(ISideXSettingsService, SideXSettingsService, InstantiationType.Delayed);
