/*---------------------------------------------------------------------------------------------
 *  SideX - Tree-sitter library service stub.
 *
 *  Native tree-sitter parsing lives in the `sidex-syntax` Rust crate and is
 *  exposed through the `syntax_tokenize` Tauri command. The webview no
 *  longer loads `@vscode/tree-sitter-wasm`; instead this service reports
 *  every language as unsupported so editor code falls back to the
 *  standard TextMate tokenizer path (which is also what upstream VS Code
 *  does when `editor.experimental.preferTreeSitter` is off).
 *--------------------------------------------------------------------------------------------*/

import type { Language, Parser, Query } from '@vscode/tree-sitter-wasm';
import { IReader } from '../../../../base/common/observable.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';

export class TreeSitterLibraryService extends Disposable implements ITreeSitterLibraryService {
	declare readonly _serviceBrand: undefined;

	supportsLanguage(_languageId: string, _reader: IReader | undefined): boolean {
		return false;
	}

	async getParserClass(): Promise<typeof Parser> {
		throw new Error('[sidex] tree-sitter WASM parser disabled; use the Rust backend');
	}

	getLanguage(_languageId: string, _ignoreSupportsCheck: boolean, _reader: IReader | undefined): Language | undefined {
		return undefined;
	}

	async getLanguagePromise(_languageId: string): Promise<Language | undefined> {
		return undefined;
	}

	getInjectionQueries(_languageId: string, _reader: IReader | undefined): Query | null | undefined {
		return null;
	}

	getHighlightingQueries(_languageId: string, _reader: IReader | undefined): Query | null | undefined {
		return null;
	}

	async createQuery(_language: Language, _querySource: string): Promise<Query> {
		throw new Error('[sidex] tree-sitter WASM parser disabled; use the Rust backend');
	}
}
