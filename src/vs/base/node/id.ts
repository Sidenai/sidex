/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { TernarySearchTree } from '../common/ternarySearchTree.js';
import * as uuid from '../common/uuid.js';
import { getMac } from './macAddress.js';
import { isWindows } from '../common/platform.js';

// http://www.techrepublic.com/blog/data-center/mac-address-scorecard-for-common-virtual-machine-platforms/
export const virtualMachineHint: { value(): number } = new class {

	private _virtualMachineOUIs?: TernarySearchTree<string, boolean>;
	private _value?: number;

	private _isVirtualMachineMacAddress(mac: string): boolean {
		if (!this._virtualMachineOUIs) {
			this._virtualMachineOUIs = TernarySearchTree.forStrings<boolean>();

			this._virtualMachineOUIs.set('00-50-56', true);
			this._virtualMachineOUIs.set('00-0C-29', true);
			this._virtualMachineOUIs.set('00-05-69', true);
			this._virtualMachineOUIs.set('00-03-FF', true);
			this._virtualMachineOUIs.set('00-1C-42', true);
			this._virtualMachineOUIs.set('00-16-3E', true);
			this._virtualMachineOUIs.set('08-00-27', true);

			this._virtualMachineOUIs.set('00:50:56', true);
			this._virtualMachineOUIs.set('00:0C:29', true);
			this._virtualMachineOUIs.set('00:05:69', true);
			this._virtualMachineOUIs.set('00:03:FF', true);
			this._virtualMachineOUIs.set('00:1C:42', true);
			this._virtualMachineOUIs.set('00:16:3E', true);
			this._virtualMachineOUIs.set('08:00:27', true);
		}
		return !!this._virtualMachineOUIs.findSubstr(mac);
	}

	value(): number {
		if (this._value === undefined) {
			this._value = 0;
			// TODO: In Tauri, network interface enumeration is done via Rust backend
			// For now, return 0 (not a VM). Will be populated async.
		}
		return this._value;
	}
};

let machineId: Promise<string>;
export async function getMachineId(errorLogger: (error: Error) => void): Promise<string> {
	if (!machineId) {
		machineId = (async () => {
			const id = await getMacMachineId(errorLogger);
			return id || uuid.generateUuid();
		})();
	}
	return machineId;
}

async function getMacMachineId(errorLogger: (error: Error) => void): Promise<string | undefined> {
	try {
		const macAddress = getMac();
		const encoder = new TextEncoder();
		const data = encoder.encode(macAddress);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	} catch (err: any) {
		errorLogger(err);
		return undefined;
	}
}

const SQM_KEY: string = 'Software\\Microsoft\\SQMClient';
export async function getSqmMachineId(errorLogger: (error: Error) => void): Promise<string> {
	if (isWindows) {
		try {
			return await invoke<string>('os_get_registry_string', {
				hive: 'HKEY_LOCAL_MACHINE',
				key: SQM_KEY,
				valueName: 'MachineId'
			});
		} catch (err: any) {
			errorLogger(err);
			return '';
		}
	}
	return '';
}

export async function getDevDeviceId(errorLogger: (error: Error) => void): Promise<string> {
	try {
		return await invoke<string>('os_get_device_id');
	} catch (err: any) {
		errorLogger(err);
		return uuid.generateUuid();
	}
}
