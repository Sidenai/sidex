/*---------------------------------------------------------------------------------------------
 *  SideX - Secret storage backed by the OS keyring.
 *
 *  All secret reads and writes flow through the `sidex-auth` crate, which
 *  stores values in the platform keychain (macOS Keychain, Windows
 *  Credential Manager, libsecret on Linux) and keeps a SQLite index of
 *  known keys. OAuth tokens and extension secrets survive cache wipes and
 *  are protected by the OS.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BaseSecretStorageService, ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';

interface TauriCore {
	invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

async function loadInvoke(): Promise<TauriCore['invoke'] | undefined> {
	try {
		const mod = await import('@tauri-apps/api/core');
		return mod.invoke;
	} catch {
		return undefined;
	}
}

export class BrowserSecretStorageService extends BaseSecretStorageService {
	private readonly _invokePromise: Promise<TauriCore['invoke'] | undefined>;
	private readonly _ownChange = new Emitter<string>();

	constructor(
		@IStorageService storageService: IStorageService,
		@IEncryptionService encryptionService: IEncryptionService,
		@ILogService logService: ILogService
	) {
		// The base class handles the in-memory cache and the onDidChange emitter;
		// we override the backing IO to persist through the OS keyring.
		super(true, storageService, encryptionService, logService);
		this._invokePromise = loadInvoke();

		// Forward our own change events through the base class emitter so
		// downstream extensions see writes as soon as the keyring ack lands.
		this._register(this._ownChange.event(key => this.onDidChangeSecretEmitter.fire(key)));
	}

	override get type(): 'in-memory' | 'persisted' | 'unknown' {
		return 'unknown'; // backed by OS keyring, closest match
	}

	private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
		const invoke = await this._invokePromise;
		if (!invoke) {
			return undefined;
		}
		try {
			return await invoke<T>(cmd, args);
		} catch (error) {
			this._logService.warn(`[sidex-auth] ${cmd} failed`, error);
			return undefined;
		}
	}

	override async get(key: string): Promise<string | undefined> {
		const value = await this.invoke<string | null>('secret_get', { key });
		return value ?? undefined;
	}

	override async set(key: string, value: string): Promise<void> {
		await this.invoke<void>('secret_set', { key, value });
		this._ownChange.fire(key);
	}

	override async delete(key: string): Promise<void> {
		await this.invoke<void>('secret_delete', { key });
		this._ownChange.fire(key);
	}

	override async keys(): Promise<string[]> {
		return (await this.invoke<string[]>('secret_keys')) ?? [];
	}
}

registerSingleton(ISecretStorageService, BrowserSecretStorageService as any, InstantiationType.Delayed);
