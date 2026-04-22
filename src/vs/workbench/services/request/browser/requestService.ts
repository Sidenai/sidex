/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRequestOptions, IRequestContext } from '../../../../base/parts/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { RequestChannelClient } from '../../../../platform/request/common/requestIpc.js';
import { IRemoteAgentService, IRemoteAgentConnection } from '../../remote/common/remoteAgentService.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import {
	AbstractRequestService,
	AuthInfo,
	Credentials,
	IRequestService
} from '../../../../platform/request/common/request.js';
import { request } from '../../../../base/parts/request/common/requestImpl.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { LogService } from '../../../../platform/log/common/logService.js';
import { windowLogGroup } from '../../log/common/logConstants.js';
import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';

export class BrowserRequestService extends AbstractRequestService implements IRequestService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILoggerService loggerService: ILoggerService
	) {
		const logger = loggerService.createLogger(`network`, {
			name: localize('network', 'Network'),
			group: windowLogGroup
		});
		const logService = new LogService(logger);
		super(logService);
		this._register(logger);
		this._register(logService);
	}

	async request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
		const url = options.url ?? '';
		if (url.startsWith('https://') || url.startsWith('http://')) {
			return this.logAndRequest(options, () => this._tauriProxyRequest(options));
		}

		try {
			if (!options.proxyAuthorization) {
				options.proxyAuthorization =
					this.configurationService.inspect<string>('http.proxyAuthorization').userLocalValue;
			}
			const context = await this.logAndRequest(options, () => request(options, token, () => navigator.onLine));

			const connection = this.remoteAgentService.getConnection();
			if (connection && context.res.statusCode === 405) {
				return this._makeRemoteRequest(connection, options, token);
			}
			return context;
		} catch (error) {
			const connection = this.remoteAgentService.getConnection();
			if (connection) {
				return this._makeRemoteRequest(connection, options, token);
			}
			throw error;
		}
	}

	private async _tauriProxyRequest(options: IRequestOptions): Promise<IRequestContext> {
		const { invoke } = await import('@tauri-apps/api/core');
		const headers: Record<string, string> = {};
		if (options.headers) {
			for (const key of Object.keys(options.headers)) {
				const val = options.headers[key];
				if (typeof val === 'string') {
					headers[key] = val;
				}
			}
		}
		const result = await invoke<{ status: number; headers: Record<string, string>; body_b64: string }>(
			'proxy_request_full',
			{
				url: options.url ?? '',
				method: options.type ?? 'GET',
				headers,
				body: options.data ?? null
			}
		);
		const bodyBytes = Uint8Array.from(atob(result.body_b64), c => c.charCodeAt(0));
		return {
			res: {
				statusCode: result.status,
				headers: result.headers
			},
			stream: bufferToStream(VSBuffer.wrap(bodyBytes))
		};
	}

	async resolveProxy(_url: string): Promise<string | undefined> {
		return undefined; // not implemented in the web
	}

	async lookupAuthorization(_authInfo: AuthInfo): Promise<Credentials | undefined> {
		return undefined; // not implemented in the web
	}

	async lookupKerberosAuthorization(_url: string): Promise<string | undefined> {
		return undefined; // not implemented in the web
	}

	async loadCertificates(): Promise<string[]> {
		return []; // not implemented in the web
	}

	private _makeRemoteRequest(
		connection: IRemoteAgentConnection,
		options: IRequestOptions,
		token: CancellationToken
	): Promise<IRequestContext> {
		return connection.withChannel('request', channel => new RequestChannelClient(channel).request(options, token));
	}
}

// --- Internal commands to help authentication for extensions

CommandsRegistry.registerCommand(
	'_workbench.fetchJSON',
	async function (accessor: ServicesAccessor, url: string, method: string) {
		const result = await fetch(url, { method, headers: { Accept: 'application/json' } });

		if (result.ok) {
			return result.json();
		} else {
			throw new Error(result.statusText);
		}
	}
);
