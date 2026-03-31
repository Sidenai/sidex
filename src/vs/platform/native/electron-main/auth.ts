/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event, Emitter } from '../../../base/common/event.js';
import { hash } from '../../../base/common/hash.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEncryptionMainService } from '../../encryption/common/encryptionService.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { AuthInfo, Credentials } from '../../request/common/request.js';
import { StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';

type LoginEvent = {
	event?: { preventDefault(): void };
	authInfo: AuthInfo;
	callback?: (username?: string, password?: string) => void;
};

export const IProxyAuthService = createDecorator<IProxyAuthService>('proxyAuthService');

export interface IProxyAuthService {
	lookupAuthorization(authInfo: AuthInfo): Promise<Credentials | undefined>;
}

export class ProxyAuthService extends Disposable implements IProxyAuthService {

	declare readonly _serviceBrand: undefined;

	private readonly PROXY_CREDENTIALS_SERVICE_KEY = 'proxy-credentials://';

	private pendingProxyResolves = new Map<string, Promise<Credentials | undefined>>();
	private currentDialog: Promise<Credentials | undefined> | undefined = undefined;

	private cancelledAuthInfoHashes = new Set<string>();

	private sessionCredentials = new Map<string, Credentials | undefined>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IEncryptionMainService private readonly encryptionMainService: IEncryptionMainService,
		@IApplicationStorageMainService private readonly applicationStorageMainService: IApplicationStorageMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {
		const onLoginEmitter = new Emitter<LoginEvent>();
		this._register(onLoginEmitter);

		tauriListen<{ authInfo: AuthInfo; firstAuthAttempt?: boolean }>('tauri://login', (event) => {
			const payload = event.payload;
			onLoginEmitter.fire({
				authInfo: { ...payload.authInfo, attempt: payload.firstAuthAttempt ? 1 : 2 },
			});
		}).catch(err => this.logService.error('Failed to listen for login events:', err));

		this._register(onLoginEmitter.event(e => this.onLogin(e)));
	}

	async lookupAuthorization(authInfo: AuthInfo): Promise<Credentials | undefined> {
		return this.onLogin({ authInfo });
	}

	private async onLogin({ event, authInfo, callback }: LoginEvent): Promise<Credentials | undefined> {
		if (!authInfo.isProxy) {
			return;
		}

		event?.preventDefault();

		const authInfoHash = String(hash({ scheme: authInfo.scheme, host: authInfo.host, port: authInfo.port }));

		let credentials: Credentials | undefined = undefined;
		let pendingProxyResolve = this.pendingProxyResolves.get(authInfoHash);
		if (!pendingProxyResolve) {
			this.logService.trace('auth#onLogin (proxy) - no pending proxy handling found, starting new');

			pendingProxyResolve = this.resolveProxyCredentials(authInfo, authInfoHash);
			this.pendingProxyResolves.set(authInfoHash, pendingProxyResolve);
			try {
				credentials = await pendingProxyResolve;
			} finally {
				this.pendingProxyResolves.delete(authInfoHash);
			}
		} else {
			this.logService.trace('auth#onLogin (proxy) - pending proxy handling found');

			credentials = await pendingProxyResolve;
		}

		callback?.(credentials?.username, credentials?.password);
		return credentials;
	}

	private async resolveProxyCredentials(authInfo: AuthInfo, authInfoHash: string): Promise<Credentials | undefined> {
		this.logService.trace('auth#resolveProxyCredentials (proxy) - enter');

		try {
			const credentials = await this.doResolveProxyCredentials(authInfo, authInfoHash);
			if (credentials) {
				this.logService.trace('auth#resolveProxyCredentials (proxy) - got credentials');
				return credentials;
			} else {
				this.logService.trace('auth#resolveProxyCredentials (proxy) - did not get credentials');
			}
		} finally {
			this.logService.trace('auth#resolveProxyCredentials (proxy) - exit');
		}

		return undefined;
	}

	private async doResolveProxyCredentials(authInfo: AuthInfo, authInfoHash: string): Promise<Credentials | undefined> {
		this.logService.trace('auth#doResolveProxyCredentials - enter', authInfo);

		if (this.environmentMainService.extensionTestsLocationURI) {
			try {
				const decodedRealm = Buffer.from(authInfo.realm, 'base64').toString('utf-8');
				if (decodedRealm.startsWith('{')) {
					return JSON.parse(decodedRealm);
				}
			} catch {
				// ignore
			}
			return undefined;
		}

		const newHttpProxy = (this.configurationService.getValue<string>('http.proxy') || '').trim()
			|| (process.env['https_proxy'] || process.env['HTTPS_PROXY'] || process.env['http_proxy'] || process.env['HTTP_PROXY'] || '').trim()
			|| undefined;

		if (newHttpProxy?.indexOf('@') !== -1) {
			const uri = URI.parse(newHttpProxy!);
			const i = uri.authority.indexOf('@');
			if (i !== -1) {
				if (authInfo.attempt > 1) {
					this.logService.trace('auth#doResolveProxyCredentials (proxy) - exit - ignoring previously used config/envvar credentials');
					return undefined;
				}
				this.logService.trace('auth#doResolveProxyCredentials (proxy) - exit - found config/envvar credentials to use');
				const credentials = uri.authority.substring(0, i);
				const j = credentials.indexOf(':');
				if (j !== -1) {
					return {
						username: credentials.substring(0, j),
						password: credentials.substring(j + 1)
					};
				} else {
					return {
						username: credentials,
						password: ''
					};
				}
			}
		}

		const sessionCredentials = authInfo.attempt === 1 && this.sessionCredentials.get(authInfoHash);
		if (sessionCredentials) {
			this.logService.trace('auth#doResolveProxyCredentials (proxy) - exit - found session credentials to use');
			const { username, password } = sessionCredentials;
			return { username, password };
		}

		let storedUsername: string | undefined;
		let storedPassword: string | undefined;
		try {
			const encryptedValue = this.applicationStorageMainService.get(this.PROXY_CREDENTIALS_SERVICE_KEY + authInfoHash, StorageScope.APPLICATION);
			if (encryptedValue) {
				const credentials: Credentials = JSON.parse(await this.encryptionMainService.decrypt(encryptedValue));
				storedUsername = credentials.username;
				storedPassword = credentials.password;
			}
		} catch (error) {
			this.logService.error(error);
		}

		if (authInfo.attempt === 1 && typeof storedUsername === 'string' && typeof storedPassword === 'string') {
			this.logService.trace('auth#doResolveProxyCredentials (proxy) - exit - found stored credentials to use');
			this.sessionCredentials.set(authInfoHash, { username: storedUsername, password: storedPassword });
			return { username: storedUsername, password: storedPassword };
		}

		const previousDialog = this.currentDialog;
		const currentDialog = this.currentDialog = (async () => {
			await previousDialog;
			const credentials = await this.showProxyCredentialsDialog(authInfo, authInfoHash, storedUsername, storedPassword);
			if (this.currentDialog === currentDialog!) {
				this.currentDialog = undefined;
			}
			return credentials;
		})();
		return currentDialog;
	}

	private async showProxyCredentialsDialog(authInfo: AuthInfo, authInfoHash: string, storedUsername: string | undefined, storedPassword: string | undefined): Promise<Credentials | undefined> {
		if (this.cancelledAuthInfoHashes.has(authInfoHash)) {
			this.logService.trace('auth#doResolveProxyCredentials (proxy) - exit - login dialog was cancelled before, not showing again');
			return undefined;
		}

		const window = this.windowsMainService.getFocusedWindow() || this.windowsMainService.getLastActiveWindow();
		if (!window) {
			this.logService.trace('auth#doResolveProxyCredentials (proxy) - exit - no opened window found to show dialog in');
			return undefined;
		}

		this.logService.trace(`auth#doResolveProxyCredentials (proxy) - asking window ${window.id} to handle proxy login`);

		const sessionCredentials = this.sessionCredentials.get(authInfoHash);
		const payload = {
			authInfo,
			username: sessionCredentials?.username ?? storedUsername,
			password: sessionCredentials?.password ?? storedPassword,
			replyChannel: `vscode:proxyAuthResponse:${generateUuid()}`
		};
		window.sendWhenReady('vscode:openProxyAuthenticationDialog', CancellationToken.None, payload);

		const loginDialogCredentials = await new Promise<Credentials | undefined>(resolve => {
			const unlistenPromise = tauriListen<{ channel: string; reply: (Credentials & { remember: boolean }) | undefined }>(
				'vscode:proxyAuthResponse',
				async (event) => {
					const { channel, reply } = event.payload;
					if (channel === payload.replyChannel) {
						this.logService.trace(`auth#doResolveProxyCredentials - exit - received credentials from window ${window.id}`);

						const unlisten = await unlistenPromise;
						unlisten();

						if (reply) {
							const credentials: Credentials = { username: reply.username, password: reply.password };

							try {
								if (reply.remember) {
									const encryptedSerializedCredentials = await this.encryptionMainService.encrypt(JSON.stringify(credentials));
									this.applicationStorageMainService.store(
										this.PROXY_CREDENTIALS_SERVICE_KEY + authInfoHash,
										encryptedSerializedCredentials,
										StorageScope.APPLICATION,
										StorageTarget.MACHINE
									);
								} else {
									this.applicationStorageMainService.remove(this.PROXY_CREDENTIALS_SERVICE_KEY + authInfoHash, StorageScope.APPLICATION);
								}
							} catch (error) {
								this.logService.error(error);
							}

							resolve({ username: credentials.username, password: credentials.password });
						} else {
							this.cancelledAuthInfoHashes.add(authInfoHash);
							resolve(undefined);
						}
					}
				}
			);
		});

		this.sessionCredentials.set(authInfoHash, loginDialogCredentials);

		return loginDialogCredentials;
	}
}
