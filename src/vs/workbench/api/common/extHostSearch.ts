/*---------------------------------------------------------------------------------------------
 *  SideX — ExtHost search stub. Search is routed through TauriSearchService; extension-
 *  registered search providers are accepted but not wired to a manager.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type * as vscode from 'vscode';
import { ExtHostSearchShape, MainThreadSearchShape, MainContext } from './extHost.protocol.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { IURITransformerService } from './extHostUriTransformerService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import {
	IRawFileQuery,
	ISearchCompleteStats,
	IFileQuery,
	IRawTextQuery,
	IRawQuery,
	IFolderQuery,
	IRawAITextQuery,
	IAITextQuery,
	ITextQuery
} from '../../services/search/common/search.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { revive } from '../../../base/common/marshalling.js';

export interface IExtHostSearch extends ExtHostSearchShape {
	registerTextSearchProviderOld(scheme: string, provider: vscode.TextSearchProvider): IDisposable;
	registerFileSearchProviderOld(scheme: string, provider: vscode.FileSearchProvider): IDisposable;
	registerTextSearchProvider(scheme: string, provider: vscode.TextSearchProvider2): IDisposable;
	registerAITextSearchProvider(scheme: string, provider: vscode.AITextSearchProvider): IDisposable;
	registerFileSearchProvider(scheme: string, provider: vscode.FileSearchProvider2): IDisposable;
	doInternalFileSearchWithCustomCallback(
		query: IFileQuery,
		token: CancellationToken,
		handleFileMatch: (data: URI[]) => void
	): Promise<ISearchCompleteStats>;
}

export const IExtHostSearch = createDecorator<IExtHostSearch>('IExtHostSearch');

export class ExtHostSearch implements IExtHostSearch {
	protected readonly _proxy: MainThreadSearchShape;
	protected _handlePool: number = 0;

	private readonly _textSearchUsedSchemes = new Set<string>();
	private readonly _aiTextSearchUsedSchemes = new Set<string>();
	private readonly _fileSearchUsedSchemes = new Set<string>();

	constructor(
		@IExtHostRpcService private extHostRpc: IExtHostRpcService,
		@IURITransformerService protected _uriTransformer: IURITransformerService,
		@ILogService protected _logService: ILogService
	) {
		this._proxy = this.extHostRpc.getProxy(MainContext.MainThreadSearch);
	}

	protected _transformScheme(scheme: string): string {
		return this._uriTransformer.transformOutgoingScheme(scheme);
	}

	registerTextSearchProviderOld(scheme: string, _provider: vscode.TextSearchProvider): IDisposable {
		return this._registerNoop(this._textSearchUsedSchemes, scheme, 'text');
	}

	registerTextSearchProvider(scheme: string, _provider: vscode.TextSearchProvider2): IDisposable {
		return this._registerNoop(this._textSearchUsedSchemes, scheme, 'text');
	}

	registerAITextSearchProvider(scheme: string, _provider: vscode.AITextSearchProvider): IDisposable {
		return this._registerNoop(this._aiTextSearchUsedSchemes, scheme, 'aiText');
	}

	registerFileSearchProviderOld(scheme: string, _provider: vscode.FileSearchProvider): IDisposable {
		return this._registerNoop(this._fileSearchUsedSchemes, scheme, 'file');
	}

	registerFileSearchProvider(scheme: string, _provider: vscode.FileSearchProvider2): IDisposable {
		return this._registerNoop(this._fileSearchUsedSchemes, scheme, 'file');
	}

	private _registerNoop(set: Set<string>, scheme: string, kind: string): IDisposable {
		if (set.has(scheme)) {
			throw new Error(`a ${kind} search provider for the scheme '${scheme}' is already registered`);
		}
		set.add(scheme);
		this._logService.trace(
			`[SideX] extHostSearch: ignoring ${kind} provider for scheme '${scheme}' (search routed through Rust)`
		);
		return toDisposable(() => set.delete(scheme));
	}

	async $provideFileSearchResults(
		_handle: number,
		_session: number,
		_rawQuery: IRawFileQuery,
		_token: vscode.CancellationToken
	): Promise<ISearchCompleteStats> {
		return { messages: [] };
	}

	async doInternalFileSearchWithCustomCallback(
		_query: IFileQuery,
		_token: CancellationToken,
		_handleFileMatch: (data: URI[]) => void
	): Promise<ISearchCompleteStats> {
		return { messages: [] };
	}

	async $clearCache(_cacheKey: string): Promise<void> {
		return undefined;
	}

	async $provideTextSearchResults(
		_handle: number,
		_session: number,
		_rawQuery: IRawTextQuery,
		_token: vscode.CancellationToken
	): Promise<ISearchCompleteStats> {
		return { messages: [] };
	}

	async $provideAITextSearchResults(
		_handle: number,
		_session: number,
		_rawQuery: IRawAITextQuery,
		_token: vscode.CancellationToken
	): Promise<ISearchCompleteStats> {
		return { messages: [] };
	}

	$enableExtensionHostSearch(): void {}

	async $getAIName(_handle: number): Promise<string | undefined> {
		return undefined;
	}
}

export function reviveQuery<U extends IRawQuery>(
	rawQuery: U
): U extends IRawTextQuery ? ITextQuery : U extends IRawAITextQuery ? IAITextQuery : IFileQuery {
	return {
		...(<any>rawQuery),
		...{
			folderQueries: rawQuery.folderQueries && rawQuery.folderQueries.map(reviveFolderQuery),
			extraFileResources:
				rawQuery.extraFileResources && rawQuery.extraFileResources.map(components => URI.revive(components))
		}
	};
}

function reviveFolderQuery(rawFolderQuery: IFolderQuery<UriComponents>): IFolderQuery<URI> {
	return revive(rawFolderQuery);
}
