/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { KnownStorageProvider, IEncryptionMainService, PasswordStoreCLIOption } from '../common/encryptionService.js';
import { ILogService } from '../../log/common/log.js';

export class EncryptionMainService implements IEncryptionMainService {
	_serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		this.initialize();
	}

	private async initialize(): Promise<void> {
		try {
			const passwordStoreOption = await invoke<string | null>('get_command_line_switch', { name: 'password-store' });
			if (passwordStoreOption === PasswordStoreCLIOption.basic) {
				this.logService.trace('[EncryptionMainService] setting usePlainTextEncryption to true...');
				await invoke('set_use_plain_text_encryption', { usePlainText: true });
				this.logService.trace('[EncryptionMainService] set usePlainTextEncryption to true');
			}
		} catch (e) {
			this.logService.trace('[EncryptionMainService] initialization: no command line switch or backend not available');
		}
	}

	async encrypt(value: string): Promise<string> {
		this.logService.trace('[EncryptionMainService] Encrypting value...');
		try {
			const result = await invoke<string>('encrypt_string', { value });
			this.logService.trace('[EncryptionMainService] Encrypted value.');
			return result;
		} catch (e) {
			this.logService.error(e);
			throw e;
		}
	}

	async decrypt(value: string): Promise<string> {
		this.logService.trace('[EncryptionMainService] Decrypting value...');
		try {
			const result = await invoke<string>('decrypt_string', { value });
			this.logService.trace('[EncryptionMainService] Decrypted value.');
			return result;
		} catch (e) {
			this.logService.error(e);
			throw e;
		}
	}

	async isEncryptionAvailable(): Promise<boolean> {
		this.logService.trace('[EncryptionMainService] Checking if encryption is available...');
		try {
			const result = await invoke<boolean>('is_encryption_available');
			this.logService.trace('[EncryptionMainService] Encryption is available: ', result);
			return result;
		} catch (e) {
			this.logService.error(e);
			return false;
		}
	}

	async getKeyStorageProvider(): Promise<KnownStorageProvider> {
		if (isWindows) {
			return KnownStorageProvider.dplib;
		}
		if (isMacintosh) {
			return KnownStorageProvider.keychainAccess;
		}
		try {
			this.logService.trace('[EncryptionMainService] Getting selected storage backend...');
			const result = await invoke<string>('get_selected_storage_backend');
			this.logService.trace('[EncryptionMainService] Selected storage backend: ', result);
			return result as KnownStorageProvider;
		} catch (e) {
			this.logService.error(e);
		}
		return KnownStorageProvider.unknown;
	}

	async setUsePlainTextEncryption(): Promise<void> {
		if (isWindows) {
			throw new Error('Setting plain text encryption is not supported on Windows.');
		}

		if (isMacintosh) {
			throw new Error('Setting plain text encryption is not supported on macOS.');
		}

		this.logService.trace('[EncryptionMainService] Setting usePlainTextEncryption to true...');
		await invoke('set_use_plain_text_encryption', { usePlainText: true });
		this.logService.trace('[EncryptionMainService] Set usePlainTextEncryption to true');
	}
}
