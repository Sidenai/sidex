/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { validatedIpcMain, type TauriIpcEvent } from '../../ipc/electron-main/ipcMain.js';
import { CONTEXT_MENU_CHANNEL, CONTEXT_MENU_CLOSE_CHANNEL, IPopupOptions, ISerializableContextMenuItem } from '../common/contextmenu.js';

/**
 * Serializable representation of a menu item suitable for
 * passing to the Rust backend via `invoke()`.
 */
interface TauriMenuItem {
	id: number;
	label?: string;
	item_type: string;
	accelerator?: string;
	enabled?: boolean;
	checked?: boolean;
	visible?: boolean;
	submenu?: TauriMenuItem[];
}

function toTauriMenuItems(items: ISerializableContextMenuItem[]): TauriMenuItem[] {
	return items.map(item => ({
		id: item.id,
		label: item.label,
		item_type: item.type ?? 'normal',
		accelerator: item.accelerator,
		enabled: item.enabled,
		checked: item.checked,
		visible: item.visible,
		submenu: item.submenu ? toTauriMenuItems(item.submenu) : undefined,
	}));
}

export function registerContextMenuListener(): void {
	validatedIpcMain.on(CONTEXT_MENU_CHANNEL, async (
		event: TauriIpcEvent,
		contextMenuId: number,
		items: ISerializableContextMenuItem[],
		onClickChannel: string,
		options?: IPopupOptions,
	) => {
		const tauriItems = toTauriMenuItems(items);

		try {
			const clickedItemId = await invoke<number | null>('plugin:menu|show_context_menu', {
				items: tauriItems,
				position: options ? { x: options.x, y: options.y } : undefined,
			});

			if (clickedItemId !== null && clickedItemId !== undefined) {
				event.sender.send(onClickChannel, clickedItemId, {});
			}
		} catch {
			// Menu was dismissed or invoke failed — treat as close
		} finally {
			event.sender.send(CONTEXT_MENU_CLOSE_CHANNEL, contextMenuId);
		}
	});
}

/**
 * Programmatically create and show a context menu from the main (Rust) side.
 * This is a helper for cases where the menu needs to be shown without
 * going through the IPC listener above.
 */
export async function showContextMenu(
	items: ISerializableContextMenuItem[],
	options?: IPopupOptions,
): Promise<number | null> {
	const tauriItems = toTauriMenuItems(items);

	return invoke<number | null>('plugin:menu|show_context_menu', {
		items: tauriItems,
		position: options ? { x: options.x, y: options.y } : undefined,
	});
}
