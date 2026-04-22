/*---------------------------------------------------------------------------------------------
 *  SideX — Native TextMate tokenization bridge.
 *--------------------------------------------------------------------------------------------*/

interface TauriCore {
	invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

async function loadInvoke(): Promise<TauriCore['invoke'] | undefined> {
	try {
		const core = await import('@tauri-apps/api/core');
		return core.invoke;
	} catch {
		return undefined;
	}
}

export interface NativeThemeSetting {
	name?: string;
	scope?: string | string[] | null;
	settings?: {
		fontStyle?: string;
		foreground?: string;
		background?: string;
		fontFamily?: string;
		fontSize?: number;
		lineHeight?: number;
	};
}

export interface NativeTextMateToken {
	startIndex: number;
	endIndex: number;
	scopes: string[];
}

export interface NativeTokenizeLineResult {
	tokens: NativeTextMateToken[];
	ruleStack: number;
	stoppedEarly: boolean;
}

export interface NativeTokenizeLineBinaryResult {
	tokens: number[];
	ruleStack: number;
	stoppedEarly: boolean;
}

/**
 * Bridge singleton for the native textmate service. Instances are
 * cheap; hold one per grammar scope you tokenize.
 */
export class NativeTextMate {
	private readonly _invoke: Promise<TauriCore['invoke'] | undefined>;

	constructor() {
		this._invoke = loadInvoke();
	}

	/**
	 * Loads (or replaces) a grammar. `grammarJson` is a full
	 * `.tmLanguage.json` document; plist grammars must be converted
	 * upstream because the wire format is JSON.
	 */
	async loadGrammar(options: {
		scopeName: string;
		grammarJson: string;
		initialLanguageId: number;
		embeddedLanguages?: Record<string, number>;
		injectionScopeNames?: string[];
	}): Promise<void> {
		const invoke = await this._invoke;
		if (!invoke) {
			return;
		}
		await invoke('textmate_load_grammar', {
			scopeName: options.scopeName,
			grammarJson: options.grammarJson,
			initialLanguageId: options.initialLanguageId,
			embeddedLanguages: options.embeddedLanguages,
			injectionScopeNames: options.injectionScopeNames
		});
	}

	/**
	 * Swaps the active theme, returning the resolved color palette.
	 */
	async updateTheme(settings: NativeThemeSetting[], colorMap?: string[]): Promise<string[]> {
		const invoke = await this._invoke;
		if (!invoke) {
			return colorMap ?? [];
		}
		return (
			(await invoke<string[]>('textmate_update_theme', {
				settings,
				colorMap
			})) ?? []
		);
	}

	/**
	 * Tokenizes a single line in plain mode. Pass the `ruleStack` from
	 * the previous line's result to resume state across lines.
	 */
	async tokenizeLine(
		scopeName: string,
		lineText: string,
		prevStack?: number,
		timeLimitMs?: number
	): Promise<NativeTokenizeLineResult | undefined> {
		const invoke = await this._invoke;
		if (!invoke) {
			return undefined;
		}
		return invoke<NativeTokenizeLineResult>('textmate_tokenize_line', {
			scopeName,
			lineText,
			prevStack,
			timeLimitMs
		});
	}

	/**
	 * Binary-mode tokenization — returns the packed `[startIndex,
	 * metadata]` stream Monaco consumes as a `Uint32Array`.
	 */
	async tokenizeLineBinary(
		scopeName: string,
		lineText: string,
		prevStack?: number,
		timeLimitMs?: number
	): Promise<NativeTokenizeLineBinaryResult | undefined> {
		const invoke = await this._invoke;
		if (!invoke) {
			return undefined;
		}
		return invoke<NativeTokenizeLineBinaryResult>('textmate_tokenize_line_binary', {
			scopeName,
			lineText,
			prevStack,
			timeLimitMs
		});
	}

	async tokenizeDocument(
		scopeName: string,
		lines: string[],
		startStack?: number,
		timeLimitMs?: number
	): Promise<{ lines: NativeTokenizeLineBinaryResult[]; finalStack: number } | undefined> {
		const invoke = await this._invoke;
		if (!invoke) {
			return undefined;
		}
		return invoke<{ lines: NativeTokenizeLineBinaryResult[]; finalStack: number }>('textmate_tokenize_document', {
			scopeName,
			lines,
			startStack,
			timeLimitMs
		});
	}

	/**
	 * Frees a rule-stack handle on the Rust side. Invoke this when
	 * the document backing the tokenization session closes so the
	 * handle map doesn't grow unbounded.
	 */
	async releaseStack(stackId: number): Promise<void> {
		const invoke = await this._invoke;
		if (!invoke) {
			return;
		}
		await invoke('textmate_release_stack', { stackId });
	}
}

let _instance: NativeTextMate | undefined;
export function getNativeTextMate(): NativeTextMate {
	if (!_instance) {
		_instance = new NativeTextMate();
	}
	return _instance;
}
