/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { streamToBufferReadableStream } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { isNumber } from '../../../base/common/types.js';
import { IRequestContext, IRequestOptions } from '../../../base/parts/request/common/request.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import { AbstractRequestService, AuthInfo, Credentials, IRequestService } from '../common/request.js';
import { Agent } from './proxy.js';

export interface IRawRequestFunction {
	(options: any, callback?: (res: any) => void): any;
}

export interface NodeRequestOptions extends IRequestOptions {
	agent?: Agent;
	strictSSL?: boolean;
	isChromiumNetwork?: boolean;
	getRawRequest?(options: IRequestOptions): IRawRequestFunction;
}

export class RequestService extends AbstractRequestService implements IRequestService {

	declare readonly _serviceBrand: undefined;

	private proxyUrl?: string;
	private strictSSL: boolean | undefined;
	private authorization?: string;

	constructor(
		private readonly machine: 'local' | 'remote',
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@ILogService logService: ILogService,
	) {
		super(logService);
		this.configure();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('http')) {
				this.configure();
			}
		}));
	}

	private configure() {
		this.proxyUrl = this.getConfigValue<string>('http.proxy');
		this.strictSSL = !!this.getConfigValue<boolean>('http.proxyStrictSSL');
		this.authorization = this.getConfigValue<string>('http.proxyAuthorization');
	}

	async request(options: NodeRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		return this.logAndRequest(options, () => tauriRequest(options, token));
	}

	async resolveProxy(_url: string): Promise<string | undefined> {
		return undefined;
	}

	async lookupAuthorization(_authInfo: AuthInfo): Promise<Credentials | undefined> {
		return undefined;
	}

	async lookupKerberosAuthorization(_urlStr: string): Promise<string | undefined> {
		return undefined;
	}

	async loadCertificates(): Promise<string[]> {
		try {
			return await invoke<string[]>('os_load_system_certificates');
		} catch {
			return [];
		}
	}

	private getConfigValue<T>(key: string, fallback?: T): T | undefined {
		if (this.machine === 'remote') {
			return this.configurationService.getValue<T>(key);
		}
		const values = this.configurationService.inspect<T>(key);
		return values.userLocalValue ?? values.defaultValue ?? fallback;
	}
}

async function tauriRequest(options: NodeRequestOptions, token: CancellationToken): Promise<IRequestContext> {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}

	const headers: Record<string, string> = {};
	if (options.headers) {
		for (const [key, value] of Object.entries(options.headers)) {
			if (typeof value === 'string') {
				headers[key] = value;
			}
		}
	}

	const controller = new AbortController();
	const cancellationListener = token.onCancellationRequested(() => {
		controller.abort();
	});

	try {
		const fetchOptions: RequestInit = {
			method: options.type || 'GET',
			headers,
			signal: controller.signal,
		};

		if (options.data) {
			fetchOptions.body = typeof options.data === 'string' ? options.data : options.data;
		}

		const response = await fetch(options.url!, fetchOptions);

		const res = {
			statusCode: response.status,
			headers: Object.fromEntries(response.headers.entries()),
		};

		const arrayBuffer = await response.arrayBuffer();
		const data = new Uint8Array(arrayBuffer);

		return {
			res,
			stream: streamToBufferReadableStream({
				on: (event: string, callback: any) => {
					if (event === 'data') {
						callback(data);
					} else if (event === 'end') {
						callback();
					}
				},
				removeListener: () => {},
				resume: () => {},
				pause: () => {},
				destroy: () => {},
			} as any)
		} satisfies IRequestContext;
	} catch (error) {
		if (controller.signal.aborted) {
			throw new CancellationError();
		}
		throw error;
	} finally {
		cancellationListener.dispose();
	}
}
