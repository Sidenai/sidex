/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { RemoteAuthorities } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import {
	IRemoteAuthorityResolverService,
	IRemoteConnectionData,
	ResolvedAuthority,
	ResolvedOptions,
	ResolverResult
} from '../common/remoteAuthorityResolver.js';

export class RemoteAuthorityResolverService extends Disposable implements IRemoteAuthorityResolverService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnectionData = this._register(new Emitter<void>());
	public readonly onDidChangeConnectionData = this._onDidChangeConnectionData.event;

	constructor(
		_isWorkbenchOptionsBasedResolution: boolean,
		_connectionToken: Promise<string> | string | undefined,
		_resourceUriProvider: ((uri: URI) => URI) | undefined,
		_serverBasePath: string | undefined,
		@IProductService productService: IProductService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		RemoteAuthorities.setServerRootPath(productService, _serverBasePath);
	}

	async resolveAuthority(_authority: string): Promise<ResolverResult> {
		throw new Error('Remote authority resolution is handled by Rust runtime');
	}

	async getCanonicalURI(uri: URI): Promise<URI> {
		return uri;
	}

	getConnectionData(_authority: string): IRemoteConnectionData | null {
		return null;
	}

	_clearResolvedAuthority(_authority: string): void {}
	_setResolvedAuthority(_resolvedAuthority: ResolvedAuthority, _resolvedOptions?: ResolvedOptions): void {}
	_setResolvedAuthorityError(_authority: string, _err: any): void {}
	_setAuthorityConnectionToken(_authority: string, _connectionToken: string): void {}
	_setCanonicalURIProvider(_provider: (uri: URI) => Promise<URI>): void {}
}
