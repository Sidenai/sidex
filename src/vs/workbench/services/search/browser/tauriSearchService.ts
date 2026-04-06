/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-backed search provider.
 *  Delegates file search and text search to Rust via invoke().
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { Schemas } from '../../../../base/common/network.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IFileMatch,
	IFileQuery,
	ISearchComplete,
	ISearchProgressItem,
	ISearchResultProvider,
	ISearchService,
	ITextQuery,
	SearchProviderType,
	SearchRange,
} from '../common/search.js';
import { SearchService } from '../common/searchService.js';

interface RustFileMatch {
	path: string;
	name: string;
}

interface RustTextMatch {
	path: string;
	line_number: number;
	line_content: string;
	column: number;
	match_length: number;
}

class TauriSearchProvider extends Disposable implements ISearchResultProvider {

	constructor(private readonly logService: ILogService) {
		super();
	}

	async getAIName(): Promise<string | undefined> {
		return undefined;
	}

	async textSearch(
		query: ITextQuery,
		onProgress?: (p: ISearchProgressItem) => void,
		token?: CancellationToken,
	): Promise<ISearchComplete> {
		const results: IFileMatch[] = [];
		let limitHit = false;

		for (const fq of query.folderQueries) {
			if (token?.isCancellationRequested) { break; }

			try {
				const matches = await invoke<RustTextMatch[]>('search_text', {
					root: fq.folder.fsPath,
					query: query.contentPattern.pattern,
					options: {
						max_results: query.maxResults ?? 500,
						case_sensitive: query.contentPattern.isCaseSensitive ?? false,
						is_regex: query.contentPattern.isRegExp ?? false,
						include: query.includePattern ? Object.keys(query.includePattern) : [],
						exclude: query.excludePattern ? Object.keys(query.excludePattern) : [],
					},
				});

				const byFile = new Map<string, RustTextMatch[]>();
				for (const m of matches) {
					const arr = byFile.get(m.path);
					if (arr) { arr.push(m); } else { byFile.set(m.path, [m]); }
				}

				for (const [filePath, fileMatches] of byFile) {
					const resource = URI.file(filePath);
					const textResults = fileMatches.map(m => {
						const line = m.line_number - 1;
						const start = m.column;
						const end = m.column + m.match_length;
						return {
							previewText: m.line_content,
							rangeLocations: [{
								source: new SearchRange(line, start, line, end),
								preview: new SearchRange(0, start, 0, end),
							}],
						};
					});

					const fileMatch: IFileMatch = { resource, results: textResults };
					onProgress?.(fileMatch);
					results.push(fileMatch);
				}

				if (matches.length >= (query.maxResults ?? 500)) {
					limitHit = true;
				}
			} catch (err) {
				this.logService.error('[SideX-Search] textSearch failed:', err);
			}
		}

		return { results, limitHit, messages: [] };
	}

	async fileSearch(
		query: IFileQuery,
		token?: CancellationToken,
	): Promise<ISearchComplete> {
		const results: IFileMatch[] = [];
		let limitHit = false;

		for (const fq of query.folderQueries) {
			if (token?.isCancellationRequested) { break; }

			try {
				const matches = await invoke<RustFileMatch[]>('search_files', {
					root: fq.folder.fsPath,
					pattern: query.filePattern ?? '',
					options: {
						max_results: query.maxResults ?? 500,
						include: query.includePattern ? Object.keys(query.includePattern) : [],
						exclude: query.excludePattern ? Object.keys(query.excludePattern) : [],
					},
				});

				for (const m of matches) {
					results.push({ resource: URI.file(m.path) });
				}

				if (matches.length >= (query.maxResults ?? 500)) {
					limitHit = true;
				}
			} catch (err) {
				this.logService.error('[SideX-Search] fileSearch failed:', err);
			}
		}

		return { results, limitHit, messages: [] };
	}

	async clearCache(_cacheKey: string): Promise<void> {
		// Rust search is stateless, nothing to clear
	}
}

export class TauriSearchService extends SearchService {
	constructor(
		@IModelService modelService: IModelService,
		@IEditorService editorService: IEditorService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILogService logService: ILogService,
		@IExtensionService extensionService: IExtensionService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
	) {
		super(modelService, editorService, telemetryService, logService, extensionService, fileService, uriIdentityService);

		const provider = this._register(new TauriSearchProvider(logService));
		this._register(this.registerSearchResultProvider(Schemas.file, SearchProviderType.file, provider));
		this._register(this.registerSearchResultProvider(Schemas.file, SearchProviderType.text, provider));
	}
}

registerSingleton(ISearchService, TauriSearchService, InstantiationType.Delayed);
