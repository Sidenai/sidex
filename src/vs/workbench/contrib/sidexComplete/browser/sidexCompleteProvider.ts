/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — InlineCompletionsProvider backed by vLLM FIM server.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import {
	InlineCompletionContext,
	InlineCompletions,
	InlineCompletionsDisposeReason,
	InlineCompletionsProvider,
} from '../../../../editor/common/languages.js';
import { SidexCompleteService } from './sidexCompleteService.js';

const PREFIX_CHARS = 2_000;
const SUFFIX_CHARS = 500;
const MIN_PREFIX_LENGTH = 8;
const MAX_TOKENS = 64;
const CACHE_MAX = 32;

export class SidexCompleteProvider implements InlineCompletionsProvider {

	private readonly _service: SidexCompleteService;
	private readonly _cache = new Map<string, string>();
	private _inflightAbort: AbortController | null = null;

	constructor(serverUrl: () => string) {
		this._service = new SidexCompleteService(serverUrl);
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		_context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions> {
		const empty: InlineCompletions = { items: [] };

		const fullText = model.getValue();
		const offset = model.getOffsetAt(position);
		const prefix = fullText.slice(Math.max(0, offset - PREFIX_CHARS), offset);
		const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);

		if (prefix.trimEnd().length < MIN_PREFIX_LENGTH) {
			return empty;
		}

		const cacheKey = this._fnv(prefix) + ':' + this._fnv(suffix);
		const cached = this._cache.get(cacheKey);
		if (cached) {
			console.log('[sidex-complete] cache hit');
			return {
				items: [{
					insertText: cached,
				}],
			};
		}

		if (this._inflightAbort) {
			this._inflightAbort.abort();
		}
		const abort = new AbortController();
		this._inflightAbort = abort;

		token.onCancellationRequested(() => abort.abort());

		try {
			const t0 = Date.now();
			const result = await this._service.complete(
				{
					prefix,
					suffix,
					language: model.getLanguageId(),
					filePath: model.uri.fsPath,
					maxTokens: MAX_TOKENS,
				},
				abort.signal,
			);

			if (!result || !result.text) {
				console.log('[sidex-complete] empty result');
				return empty;
			}

			const text = result.text;
			console.log('[sidex-complete] ✓', text.slice(0, 80).replace(/\n/g, '\\n'), `(${Date.now() - t0}ms)`);

			this._cacheSet(cacheKey, text);

			return {
				items: [{
					insertText: text,
				}],
			};
		} catch (e: any) {
			if (e?.name !== 'AbortError') {
				console.error('[sidex-complete] error:', e);
			}
			return empty;
		} finally {
			if (this._inflightAbort === abort) {
				this._inflightAbort = null;
			}
		}
	}

	disposeInlineCompletions(_completions: InlineCompletions, _reason: InlineCompletionsDisposeReason): void {
	}

	private _fnv(input: string): string {
		let h = 0x811c9dc5;
		for (let i = 0; i < input.length; i++) {
			h ^= input.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return (h >>> 0).toString(36);
	}

	private _cacheSet(key: string, text: string): void {
		if (this._cache.size >= CACHE_MAX) {
			const first = this._cache.keys().next().value;
			if (first !== undefined) {
				this._cache.delete(first);
			}
		}
		this._cache.set(key, text);
	}
}
