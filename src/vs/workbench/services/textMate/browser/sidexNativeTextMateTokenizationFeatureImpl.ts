/*---------------------------------------------------------------------------------------------
 *  SideX — Native Rust textmate tokenization, wired as ITextMateTokenizationService.
 *--------------------------------------------------------------------------------------------*/

import * as domStylesheets from '../../../../base/browser/domStylesheets.js';
import { equals as equalArray } from '../../../../base/common/arrays.js';
import { Color } from '../../../../base/common/color.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableFromEvent } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { LanguageId } from '../../../../editor/common/encodedTokenAttributes.js';
import {
	EncodedTokenizationResult,
	IBackgroundTokenizationStore,
	IBackgroundTokenizer,
	IState,
	ITokenizationSupport,
	LazyTokenizationSupport,
	TokenizationRegistry,
	TokenizationResult
} from '../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { nullTokenizeEncoded } from '../../../../editor/common/languages/nullTokenize.js';
import {
	generateTokensCSSForColorMap,
	generateTokensCSSForFontMap
} from '../../../../editor/common/languages/supports/tokenization.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFontTokenOptions } from '../../../../platform/theme/common/themeService.js';
import { ExtensionMessageCollector, IExtensionPointUser } from '../../extensions/common/extensionsRegistry.js';
import {
	ITextMateThemingRule,
	IWorkbenchColorTheme,
	IWorkbenchThemeService
} from '../../themes/common/workbenchThemeService.js';
import { ITMSyntaxExtensionPoint, grammarsExtPoint } from '../common/TMGrammars.js';
import { IValidGrammarDefinition } from '../common/TMScopeRegistry.js';
import * as resources from '../../../../base/common/resources.js';
import * as types from '../../../../base/common/types.js';
import * as nls from '../../../../nls.js';
import { getNativeTextMate } from '../../../../platform/sidex/browser/sidexTextMateService.js';
import { ITextMateTokenizationService } from './textMateTokenizationFeature.js';
import type { IGrammar } from 'vscode-textmate';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ContiguousMultilineTokensBuilder } from '../../../../editor/common/tokens/contiguousMultilineTokensBuilder.js';

// ---------------------------------------------------------------------------
// Native tokenizer state — wraps an opaque Rust rule-stack handle.
// Handle 0 means "initial state" (no Rust object yet).
// ---------------------------------------------------------------------------

class NativeTokenizerState implements IState {
	static readonly INITIAL = new NativeTokenizerState(0);

	constructor(public readonly handle: number) {}

	clone(): IState {
		return this;
	}

	equals(other: IState): boolean {
		return other instanceof NativeTokenizerState && other.handle === this.handle;
	}
}

// ---------------------------------------------------------------------------
// Background tokenizer — runs sequentially through all lines and pushes
// results directly into the store without touching TokenizationRegistry.
// ---------------------------------------------------------------------------

class SidexNativeBackgroundTokenizer implements IBackgroundTokenizer {
	private _disposed = false;
	private _running = false;
	/** Next line to start tokenizing from (1-indexed). */
	private _pendingStart = 1;

	private readonly _contentChangeDisposable: IDisposable;

	constructor(
		private readonly _textModel: ITextModel,
		private readonly _store: IBackgroundTokenizationStore,
		private readonly _scopeName: string,
		private readonly _encodedLanguageId: LanguageId,
		private readonly _maxTokenizationLineLength: IObservable<number>
	) {
		// Whenever the document changes, re-tokenize from the earliest touched line.
		this._contentChangeDisposable = this._textModel.onDidChangeContent(e => {
			if (this._disposed) {
				return;
			}
			// Changes are ordered end-to-start; find the minimum start line.
			let minLine = this._textModel.getLineCount();
			for (const change of e.changes) {
				if (change.range.startLineNumber < minLine) {
					minLine = change.range.startLineNumber;
				}
			}
			this.requestTokens(minLine, this._textModel.getLineCount() + 1);
		});

		// Kick off an initial full-file tokenization pass.
		this._scheduleRun();
	}

	requestTokens(startLineNumber: number, _endLineNumberExclusive: number): void {
		if (this._disposed) {
			return;
		}
		this._pendingStart = Math.min(this._pendingStart, startLineNumber);
		this._scheduleRun();
	}

	dispose(): void {
		this._disposed = true;
		this._contentChangeDisposable.dispose();
	}

	private _scheduleRun(): void {
		if (this._running) {
			// A run is already in progress; it will pick up _pendingStart when it
			// loops back and checks for new work.
			return;
		}
		this._running = true;
		this._run().finally(() => {
			this._running = false;
			// If new work arrived while we were running, start another pass.
			if (!this._disposed && this._pendingStart <= this._textModel.getLineCount()) {
				this._scheduleRun();
			}
		});
	}

	private async _run(): Promise<void> {
		const startLine = this._pendingStart;
		this._pendingStart = this._textModel.getLineCount() + 1;

		const maxLen = this._maxTokenizationLineLength.get();
		const lineCount = this._textModel.getLineCount();
		const native = getNativeTextMate();

		// ── Phase 1: recover the rule-stack handle at startLine - 1 ──────────
		// For the common case (startLine === 1) the handle is 0 (initial state)
		// and we skip this entirely.
		let startHandle = 0;
		if (startLine > 1) {
			// Tokenize lines 1..(startLine-1) in ONE batch call to get the
			// start-state handle. We don't push these tokens into the store
			// (they're already there from a previous pass).
			const warmupLines: string[] = [];
			for (let ln = 1; ln < startLine; ln++) {
				const text = this._textModel.getLineContent(ln);
				warmupLines.push(maxLen > 0 && text.length >= maxLen ? '' : text);
			}
			if (warmupLines.length > 0 && !this._disposed) {
				try {
					const warmup = await native.tokenizeDocument(this._scopeName, warmupLines, undefined);
					if (warmup && warmup.lines.length > 0) {
						startHandle = warmup.finalStack;
					}
				} catch {
					/* fall through with handle=0 */
				}
			}
		}

		if (this._disposed) {
			return;
		}

		// ── Phase 2: tokenize from startLine to end in CHUNK_SIZE-line batches ─
		// Each chunk is ONE IPC call instead of one call per line.
		// Chunks of 200 lines keep each round-trip fast and let the UI update
		// in between (we yield with a 0-ms timeout between chunks).
		const CHUNK_SIZE = 200;
		let handle = startHandle;

		for (let chunkStart = startLine; chunkStart <= lineCount; chunkStart += CHUNK_SIZE) {
			if (this._disposed) {
				return;
			}

			const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, lineCount);
			const chunkLines: string[] = [];
			for (let ln = chunkStart; ln <= chunkEnd; ln++) {
				const text = this._textModel.getLineContent(ln);
				chunkLines.push(maxLen > 0 && text.length >= maxLen ? '' : text);
			}

			let chunkResults: { tokens: number[]; ruleStack: number }[] | undefined;
			try {
				const response = await native.tokenizeDocument(this._scopeName, chunkLines, handle === 0 ? undefined : handle);
				if (response) {
					chunkResults = response.lines;
					handle = response.finalStack;
				}
			} catch {
				/* fall through */
			}

			if (this._disposed) {
				return;
			}

			// Push the chunk into the store in one shot.
			const builder = new ContiguousMultilineTokensBuilder();
			for (let i = 0; i < chunkLines.length; i++) {
				const ln = chunkStart + i;
				const result = chunkResults?.[i];
				if (!result) {
					this._store.setEndState(ln, new NativeTokenizerState(0));
					builder.add(ln, nullTokenizeEncoded(this._encodedLanguageId, NativeTokenizerState.INITIAL).tokens);
				} else {
					this._store.setEndState(ln, new NativeTokenizerState(result.ruleStack));
					builder.add(ln, new Uint32Array(result.tokens));
				}
			}
			this._store.setTokens(builder.finalize());

			// Yield between chunks so the editor can render what we just pushed.
			if (chunkEnd < lineCount) {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
		}

		if (!this._disposed) {
			this._store.backgroundTokenizationFinished();
		}
	}
}

// ---------------------------------------------------------------------------
// Per-language tokenization support
// ---------------------------------------------------------------------------

class SidexNativeTokenizationSupport implements ITokenizationSupport, IDisposable {
	constructor(
		private readonly _scopeName: string,
		private readonly _encodedLanguageId: LanguageId,
		private readonly _maxTokenizationLineLength: IObservable<number>
	) {}

	getInitialState(): IState {
		return NativeTokenizerState.INITIAL;
	}

	tokenize(_line: string, _hasEOL: boolean, _state: IState): TokenizationResult {
		throw new Error('SidexNativeTokenizationSupport: plain tokenize() not supported');
	}

	tokenizeEncoded(_line: string, _hasEOL: boolean, state: IState): EncodedTokenizationResult {
		// The background tokenizer handles all real tokenization.  This synchronous
		// path is only called as a fallback while background results are pending;
		// returning null tokens here is correct and avoids flicker because the
		// background tokenizer pushes real tokens via setTokens/setEndState.
		return nullTokenizeEncoded(this._encodedLanguageId, state);
	}

	createBackgroundTokenizer(
		textModel: ITextModel,
		store: IBackgroundTokenizationStore
	): IBackgroundTokenizer | undefined {
		return new SidexNativeBackgroundTokenizer(
			textModel,
			store,
			this._scopeName,
			this._encodedLanguageId,
			this._maxTokenizationLineLength
		);
	}

	dispose(): void {
		// Nothing to release — all per-model state lives in SidexNativeBackgroundTokenizer.
	}
}

// ---------------------------------------------------------------------------
// The main service
// ---------------------------------------------------------------------------

export class SidexTextMateTokenizationFeature extends Disposable implements ITextMateTokenizationService {
	public _serviceBrand: undefined;

	private readonly _styleElement: HTMLStyleElement;
	private readonly _tokenizersRegistrations: DisposableStore;

	private _grammarDefinitions: IValidGrammarDefinition[] | null = null;
	private _currentTheme: { name: string; settings: ITextMateThemingRule[] } | null = null;
	private _currentTokenColorMap: string[] | null = null;
	private _currentTokenFontMap: IFontTokenOptions[] | null = null;
	private readonly _createdModes: string[] = [];

	constructor(
		@ILanguageService private readonly _languageService: ILanguageService,
		@IWorkbenchThemeService private readonly _themeService: IWorkbenchThemeService,
		@IExtensionResourceLoaderService private readonly _extensionResourceLoaderService: IExtensionResourceLoaderService,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super();

		this._tokenizersRegistrations = this._register(new DisposableStore());
		this._styleElement = domStylesheets.createStyleSheet();
		this._styleElement.className = 'vscode-tokens-styles';

		grammarsExtPoint.setHandler(extensions => {
			this._handleGrammarsExtPoint(extensions);
		});

		this._updateTheme(this._themeService.getColorTheme(), true);
		this._register(
			this._themeService.onDidColorThemeChange(() => {
				this._updateTheme(this._themeService.getColorTheme(), false);
			})
		);

		this._register(
			this._languageService.onDidRequestRichLanguageFeatures(languageId => {
				this._createdModes.push(languageId);
			})
		);
	}

	// -------------------------------------------------------------------------
	// ITextMateTokenizationService
	// -------------------------------------------------------------------------

	/** Not used by the native path; returns null. */
	public async createTokenizer(_languageId: string): Promise<IGrammar | null> {
		return null;
	}

	public startDebugMode(_printFn: (str: string) => void, _onStop: () => void): void {
		this._notificationService.info(
			nls.localize('sidex.textmate.noDebug', 'TextMate debug mode is not available with the native Rust tokenizer.')
		);
	}

	// -------------------------------------------------------------------------
	// Grammar registration
	// -------------------------------------------------------------------------

	private _handleGrammarsExtPoint(extensions: readonly IExtensionPointUser<ITMSyntaxExtensionPoint[]>[]): void {
		this._grammarDefinitions = null;
		this._tokenizersRegistrations.clear();

		this._grammarDefinitions = [];
		for (const extension of extensions) {
			for (const grammar of extension.value) {
				const validated = this._validateGrammarDefinition(extension, grammar);
				if (!validated) {
					continue;
				}
				this._grammarDefinitions.push(validated);

				if (validated.language) {
					const language = validated.language;
					const scopeName = validated.scopeName;

					const lazySupport = new LazyTokenizationSupport(() =>
						this._createNativeTokenizationSupport(language, scopeName, validated)
					);
					this._tokenizersRegistrations.add(lazySupport);
					this._tokenizersRegistrations.add(TokenizationRegistry.registerFactory(language, lazySupport));
				}
			}
		}

		for (const createdMode of this._createdModes) {
			TokenizationRegistry.getOrCreate(createdMode);
		}
	}

	private async _createNativeTokenizationSupport(
		languageId: string,
		scopeName: string,
		def: IValidGrammarDefinition
	): Promise<(ITokenizationSupport & IDisposable) | null> {
		if (!this._languageService.isRegisteredLanguageId(languageId)) {
			return null;
		}

		try {
			const grammarContent = await this._extensionResourceLoaderService.readExtensionResource(def.location);

			let grammarJson: string;
			if (def.location.path.endsWith('.json')) {
				grammarJson = grammarContent;
			} else {
				// plist / xml grammar — convert via vscode-textmate's parseRawGrammar then re-serialise
				const vscodeTextmate = await import('vscode-textmate');
				const raw = vscodeTextmate.parseRawGrammar(grammarContent, def.location.path);
				grammarJson = JSON.stringify(raw);
			}

			const embeddedLanguages: Record<string, number> = {};
			for (const [scope, id] of Object.entries(def.embeddedLanguages)) {
				embeddedLanguages[scope] = id;
			}

			await getNativeTextMate().loadGrammar({
				scopeName,
				grammarJson,
				initialLanguageId: this._languageService.languageIdCodec.encodeLanguageId(languageId),
				embeddedLanguages: Object.keys(embeddedLanguages).length > 0 ? embeddedLanguages : undefined,
				injectionScopeNames: def.injectTo
			});
		} catch (err) {
			this._logService.error(`[SideX-TextMate] Failed to load grammar for ${languageId} (${scopeName}):`, err);
			return null;
		}

		const encodedLanguageId = this._languageService.languageIdCodec.encodeLanguageId(languageId);
		const maxTokenizationLineLength = this._observableConfigValue<number>(
			'editor.maxTokenizationLineLength',
			languageId,
			-1
		);

		return new SidexNativeTokenizationSupport(scopeName, encodedLanguageId, maxTokenizationLineLength);
	}

	// -------------------------------------------------------------------------
	// Theme handling
	// -------------------------------------------------------------------------

	private _updateTheme(colorTheme: IWorkbenchColorTheme, forceUpdate: boolean): void {
		if (
			!forceUpdate &&
			this._currentTheme &&
			this._currentTokenColorMap &&
			equalsTokenRules(this._currentTheme.settings, colorTheme.tokenColors) &&
			equalArray(this._currentTokenColorMap, colorTheme.tokenColorMap) &&
			this._currentTokenFontMap &&
			equalArray(this._currentTokenFontMap, colorTheme.tokenFontMap)
		) {
			return;
		}

		this._currentTheme = { name: colorTheme.label, settings: colorTheme.tokenColors };
		this._currentTokenColorMap = colorTheme.tokenColorMap;
		this._currentTokenFontMap = colorTheme.tokenFontMap;

		const colorMap = toColorMap(this._currentTokenColorMap);
		const colorCssRules = generateTokensCSSForColorMap(colorMap);
		const fontCssRules = generateTokensCSSForFontMap(this._currentTokenFontMap);
		this._styleElement.textContent = colorCssRules + fontCssRules;
		TokenizationRegistry.setColorMap(colorMap);

		const nativeSettings = colorTheme.tokenColors.map(rule => ({
			name: rule.name,
			scope: rule.scope ?? null,
			settings: rule.settings
				? {
						fontStyle: rule.settings.fontStyle,
						foreground: rule.settings.foreground,
						background: rule.settings.background
					}
				: {}
		}));

		// Rust expects `colorMap` as `Option<Vec<String>>`.  VS Code's
		// tokenColorMap is a *sparse* array — indices with no color are holes
		// (not null), and Array.prototype.map skips holes leaving them as
		// undefined in the output.  Array.from visits every slot, filling
		// holes with undefined, so the callback always fires and we always
		// produce a dense array of strings.
		const rawColorMap = this._currentTokenColorMap ?? [];
		const colorMapArg: string[] = Array.from({ length: rawColorMap.length }, (_, i) => {
			const c = rawColorMap[i];
			return c === null || c === undefined ? '' : String(c);
		});

		getNativeTextMate()
			.updateTheme(nativeSettings, colorMapArg)
			.catch(err => {
				this._logService.error('[SideX-TextMate] Failed to update theme:', err);
			});
	}

	// -------------------------------------------------------------------------
	// Grammar-definition validation (mirrors the upstream impl)
	// -------------------------------------------------------------------------

	private _validateGrammarDefinition(
		extension: IExtensionPointUser<ITMSyntaxExtensionPoint[]>,
		grammar: ITMSyntaxExtensionPoint
	): IValidGrammarDefinition | null {
		if (
			!_validateGrammarExtensionPoint(
				extension.description.extensionLocation,
				grammar,
				extension.collector,
				this._languageService
			)
		) {
			return null;
		}

		const grammarLocation = resources.joinPath(extension.description.extensionLocation, grammar.path);
		const embeddedLanguages: Record<string, LanguageId> = Object.create(null);
		if (grammar.embeddedLanguages) {
			for (const scope of Object.keys(grammar.embeddedLanguages)) {
				const lang = grammar.embeddedLanguages[scope];
				if (typeof lang === 'string' && this._languageService.isRegisteredLanguageId(lang)) {
					embeddedLanguages[scope] = this._languageService.languageIdCodec.encodeLanguageId(lang);
				}
			}
		}

		const tokenTypes: Record<string, number> = Object.create(null);
		if (grammar.tokenTypes) {
			for (const scope of Object.keys(grammar.tokenTypes)) {
				switch (grammar.tokenTypes[scope]) {
					case 'string':
						tokenTypes[scope] = 2;
						break;
					case 'other':
						tokenTypes[scope] = 0;
						break;
					case 'comment':
						tokenTypes[scope] = 1;
						break;
				}
			}
		}

		const validLanguageId =
			grammar.language && this._languageService.isRegisteredLanguageId(grammar.language) ? grammar.language : undefined;

		return {
			location: grammarLocation,
			language: validLanguageId,
			scopeName: grammar.scopeName,
			embeddedLanguages,
			tokenTypes,
			injectTo: grammar.injectTo,
			balancedBracketSelectors: asStringArray(grammar.balancedBracketScopes, ['*']),
			unbalancedBracketSelectors: asStringArray(grammar.unbalancedBracketScopes, []),
			sourceExtensionId: extension.description.id
		};
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	private _observableConfigValue<T>(key: string, languageId: string, defaultValue: T): IObservable<T> {
		return observableFromEvent(
			handleChange =>
				this._configurationService.onDidChangeConfiguration(e => {
					if (e.affectsConfiguration(key, { overrideIdentifier: languageId })) {
						handleChange(e);
					}
				}),
			() => this._configurationService.getValue<T>(key, { overrideIdentifier: languageId }) ?? defaultValue
		);
	}
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function toColorMap(colorMap: string[]): Color[] {
	const result: Color[] = [null!];
	for (let i = 1, len = colorMap.length; i < len; i++) {
		result[i] = Color.fromHex(colorMap[i]);
	}
	return result;
}

function equalsTokenRules(a: ITextMateThemingRule[] | null, b: ITextMateThemingRule[] | null): boolean {
	if (!b || !a || b.length !== a.length) {
		return false;
	}
	for (let i = b.length - 1; i >= 0; i--) {
		const r1 = b[i];
		const r2 = a[i];
		if (r1.scope !== r2.scope) {
			return false;
		}
		const s1 = r1.settings;
		const s2 = r2.settings;
		if (s1 && s2) {
			if (s1.fontStyle !== s2.fontStyle || s1.foreground !== s2.foreground || s1.background !== s2.background) {
				return false;
			}
		} else if (!s1 || !s2) {
			return false;
		}
	}
	return true;
}

function asStringArray(value: unknown, defaultValue: string[]): string[] {
	if (!Array.isArray(value) || !value.every(e => typeof e === 'string')) {
		return defaultValue;
	}
	return value as string[];
}

function _validateGrammarExtensionPoint(
	extensionLocation: URI,
	syntax: ITMSyntaxExtensionPoint,
	collector: ExtensionMessageCollector,
	languageService: ILanguageService
): boolean {
	if (
		syntax.language &&
		(typeof syntax.language !== 'string' || !languageService.isRegisteredLanguageId(syntax.language))
	) {
		collector.error(
			nls.localize(
				'invalid.language',
				'Unknown language in `contributes.{0}.language`. Provided value: {1}',
				'grammars',
				String(syntax.language)
			)
		);
		return false;
	}
	if (!syntax.scopeName || typeof syntax.scopeName !== 'string') {
		collector.error(
			nls.localize(
				'invalid.scopeName',
				'Expected string in `contributes.{0}.scopeName`. Provided value: {1}',
				'grammars',
				String(syntax.scopeName)
			)
		);
		return false;
	}
	if (!syntax.path || typeof syntax.path !== 'string') {
		collector.error(
			nls.localize(
				'invalid.path.0',
				'Expected string in `contributes.{0}.path`. Provided value: {1}',
				'grammars',
				String(syntax.path)
			)
		);
		return false;
	}
	if (syntax.injectTo && (!Array.isArray(syntax.injectTo) || syntax.injectTo.some(s => typeof s !== 'string'))) {
		collector.error(
			nls.localize(
				'invalid.injectTo',
				'Invalid value in `contributes.{0}.injectTo`. Must be an array of language scope names. Provided value: {1}',
				'grammars',
				JSON.stringify(syntax.injectTo)
			)
		);
		return false;
	}
	if (syntax.embeddedLanguages && !types.isObject(syntax.embeddedLanguages)) {
		collector.error(
			nls.localize(
				'invalid.embeddedLanguages',
				'Invalid value in `contributes.{0}.embeddedLanguages`. Must be an object map from scope name to language. Provided value: {1}',
				'grammars',
				JSON.stringify(syntax.embeddedLanguages)
			)
		);
		return false;
	}
	if (syntax.tokenTypes && !types.isObject(syntax.tokenTypes)) {
		collector.error(
			nls.localize(
				'invalid.tokenTypes',
				'Invalid value in `contributes.{0}.tokenTypes`. Must be an object map from scope name to token type. Provided value: {1}',
				'grammars',
				JSON.stringify(syntax.tokenTypes)
			)
		);
		return false;
	}

	const grammarLocation = resources.joinPath(extensionLocation, syntax.path);
	if (!resources.isEqualOrParent(grammarLocation, extensionLocation)) {
		collector.warn(
			nls.localize(
				'invalid.path.1',
				"Expected `contributes.{0}.path` ({1}) to be included inside extension's folder ({2}). This might make the extension non-portable.",
				'grammars',
				grammarLocation.path,
				extensionLocation.path
			)
		);
	}
	return true;
}
