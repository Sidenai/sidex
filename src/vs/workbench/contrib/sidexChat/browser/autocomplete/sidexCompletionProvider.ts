/*---------------------------------------------------------------------------------------------
 *  Sidex Inline Completion Provider — Ghost text autocomplete powered by Haiku
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import {
	InlineCompletionContext,
	InlineCompletions,
	InlineCompletionsProvider,
} from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { serverWsUrl } from '../localServer.js';

const DEBOUNCE_MS = 300;
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 500;
const MIN_PREFIX_LENGTH = 8;

export class SidexCompletionProvider implements InlineCompletionsProvider {
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastController: AbortController | null = null;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
	) { }

	private get _serverUrl(): string {
		const wsUrl = serverWsUrl(this._configService.getValue<string>('sidex.chat.serverUrl'));
		return wsUrl.replace(/^ws/, 'http');
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		_context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions> {
		const empty: InlineCompletions = { items: [] };

		if (token.isCancellationRequested) {
			return empty;
		}

		const fullText = model.getValue();
		const offset = model.getOffsetAt(position);

		const prefix = fullText.slice(Math.max(0, offset - PREFIX_CHARS), offset);
		const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);

		if (prefix.trimEnd().length < MIN_PREFIX_LENGTH) {
			return empty;
		}

		try {
			const completion = await this._debouncedRequest(prefix, suffix, model.uri.fsPath, model.getLanguageId(), token);
			if (!completion || token.isCancellationRequested) {
				return empty;
			}

			return {
				items: [{
					insertText: completion,
					range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
				}],
			};
		} catch {
			return empty;
		}
	}

	freeInlineCompletions(): void {
		// nothing to dispose
	}

	disposeInlineCompletions(): void {
		// nothing to dispose
	}

	private _debouncedRequest(
		prefix: string,
		suffix: string,
		filePath: string,
		language: string,
		token: CancellationToken,
	): Promise<string | null> {
		return new Promise((resolve) => {
			if (this._debounceTimer) {
				clearTimeout(this._debounceTimer);
			}
			if (this._lastController) {
				this._lastController.abort();
				this._lastController = null;
			}

			if (token.isCancellationRequested) {
				resolve(null);
				return;
			}

			this._debounceTimer = setTimeout(async () => {
				if (token.isCancellationRequested) {
					resolve(null);
					return;
				}

				const controller = new AbortController();
				this._lastController = controller;

				token.onCancellationRequested(() => controller.abort());

				try {
					const resp = await fetch(`${this._serverUrl}/v1/completions`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							prefix,
							suffix,
							file_path: filePath,
							language,
						}),
						signal: controller.signal,
					});

					if (!resp.ok) {
						resolve(null);
						return;
					}

					const data: { completion?: string } = await resp.json();
					resolve(data.completion || null);
				} catch {
					resolve(null);
				} finally {
					if (this._lastController === controller) {
						this._lastController = null;
					}
				}
			}, DEBOUNCE_MS);
		});
	}
}
