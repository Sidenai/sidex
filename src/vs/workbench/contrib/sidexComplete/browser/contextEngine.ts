/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Context Engine: priority-based context assembly for FIM completions.
 *
 *  Gathers context from multiple sources (LSP definitions, open files, recent edits,
 *  imports, file tree) and assembles them into a token-budgeted context object,
 *  inspired by Cursor's Priompt approach.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IRecentEditTracker } from './recentEditTracker.js';

// ── Context Mode ─────────────────────────────────────────────────────

export type ContextMode = 'full' | 'dynamic';

// ── Interfaces ───────────────────────────────────────────────────────

export interface IContextRequest {
	document: ITextModel;
	position: Position;
	maxTokens: number;
	mode?: ContextMode;
}

export interface ICompletionContext {
	prefix: string;
	suffix: string;
	language: string;
	filePath: string;
	openFiles: Array<{ path: string; content: string }>;
	recentEdits: string[];
	lspContext: string[];
	fileTree: string;
}

/**
 * Lightweight context summary for dynamic mode — provides pointers (not content)
 * so the agent can selectively load what it needs via tool calls.
 */
export interface IDynamicContextSummary {
	prefix: string;
	suffix: string;
	language: string;
	filePath: string;
	openFilePointers: Array<{ path: string; firstLine: string }>;
	symbolNames: string[];
	recentEditSummary: string;
	fileTreeRoot: string;
}

export const ISidexContextEngine = createDecorator<ISidexContextEngine>('sidexContextEngine');

export interface ISidexContextEngine {
	readonly _serviceBrand: undefined;
	assembleContext(request: IContextRequest, token: CancellationToken): Promise<ICompletionContext>;
	assembleDynamicContext(request: IContextRequest, token: CancellationToken): Promise<IDynamicContextSummary>;
}

// ── Priority-based context source ────────────────────────────────────

interface IContextSource {
	readonly name: string;
	readonly priority: number; // 0-100, higher = more important
	readonly content: string;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 2048;
const PREFIX_CHARS = 2_000;
const SUFFIX_CHARS = 500;
const LSP_HOVER_LINES = 5;
const MAX_OPEN_FILES = 5;
const MAX_OPEN_FILE_CHARS = 1_500;
const MAX_RECENT_EDITS = 10;
const MAX_FILE_TREE_DEPTH = 3;
const MAX_FILE_TREE_ENTRIES = 80;
const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[^\s;]+)\s+from\s+)?['"]([^'"]+)['"]/g;

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ── Context Assembler (Priompt-style) ────────────────────────────────

class ContextAssembler {
	/**
	 * Given a set of sources and a token budget, includes sources in
	 * descending priority order until the budget is exhausted. Sources
	 * that exceed the remaining budget are truncated rather than dropped,
	 * preserving partial information.
	 */
	static assemble(sources: IContextSource[], maxTokens: number): IContextSource[] {
		const sorted = sources.slice().sort((a, b) => b.priority - a.priority);
		const included: IContextSource[] = [];
		let usedTokens = 0;

		for (const source of sorted) {
			const sourceTokens = estimateTokens(source.content);
			if (sourceTokens === 0) {
				continue;
			}
			const remaining = maxTokens - usedTokens;
			if (remaining <= 0) {
				break;
			}

			if (sourceTokens <= remaining) {
				included.push(source);
				usedTokens += sourceTokens;
			} else {
				const charBudget = remaining * 4;
				included.push({
					name: source.name,
					priority: source.priority,
					content: source.content.slice(0, charBudget),
				});
				usedTokens += remaining;
			}
		}

		return included;
	}
}

// ── Context Engine Service ───────────────────────────────────────────

export class SidexContextEngine extends Disposable implements ISidexContextEngine {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILanguageFeaturesService private readonly _languageFeatures: ILanguageFeaturesService,
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IWorkspaceContextService private readonly _workspaceContext: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IRecentEditTracker private readonly _editTracker: IRecentEditTracker,
	) {
		super();
	}

	async assembleDynamicContext(request: IContextRequest, token: CancellationToken): Promise<IDynamicContextSummary> {
		const { document, position } = request;

		const offset = document.getOffsetAt(position);
		const fullText = document.getValue();
		const prefix = fullText.slice(Math.max(0, offset - PREFIX_CHARS), offset);
		const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);
		const language = document.getLanguageId();
		const filePath = document.uri.fsPath;

		const [openFilePointers, symbolNames, recentEditSummary] = await Promise.all([
			this._gatherOpenFilePointers(document),
			this._gatherSymbolNames(document, position, token),
			this._gatherRecentEditSummary(),
		]);

		const workspace = this._workspaceContext.getWorkspace();
		const fileTreeRoot = workspace.folders.length > 0 ? workspace.folders[0].uri.fsPath : '';

		return {
			prefix,
			suffix,
			language,
			filePath,
			openFilePointers,
			symbolNames,
			recentEditSummary,
			fileTreeRoot,
		};
	}

	async assembleContext(request: IContextRequest, token: CancellationToken): Promise<ICompletionContext> {
		const { document, position, maxTokens = DEFAULT_MAX_TOKENS } = request;

		const offset = document.getOffsetAt(position);
		const fullText = document.getValue();
		const prefix = fullText.slice(Math.max(0, offset - PREFIX_CHARS), offset);
		const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);
		const language = document.getLanguageId();
		const filePath = document.uri.fsPath;

		// Fire all context-gathering concurrently; each catches its own errors
		// so a single failure never blocks the whole assembly.
		const [lspContext, openFiles, recentEdits, importContext, fileTree] = await Promise.all([
			this._gatherLspContext(document, position, token),
			this._gatherOpenFiles(document),
			this._gatherRecentEdits(),
			this._gatherImportContext(document),
			this._gatherFileTree(),
		]);

		// Build prioritised source list — reserve budget for prefix/suffix first.
		const prefixSuffixTokens = estimateTokens(prefix) + estimateTokens(suffix);
		const sourceBudget = Math.max(0, maxTokens - prefixSuffixTokens);

		const sources: IContextSource[] = [
			...lspContext.map((c, i) => ({ name: `lsp-${i}`, priority: 90 - i, content: c })),
			...openFiles.map((f, i) => ({ name: `open-${i}`, priority: 70 - i * 2, content: `// ${f.path}\n${f.content}` })),
			...recentEdits.map((e, i) => ({ name: `edit-${i}`, priority: 60 - i, content: e })),
			...importContext.map((c, i) => ({ name: `import-${i}`, priority: 50 - i, content: c })),
		];

		if (fileTree) {
			sources.push({ name: 'fileTree', priority: 20, content: fileTree });
		}

		const included = ContextAssembler.assemble(sources, sourceBudget);

		const pick = (prefix: string) => included
			.filter(s => s.name.startsWith(prefix))
			.map(s => s.content);

		return {
			prefix,
			suffix,
			language,
			filePath,
			openFiles: included
				.filter(s => s.name.startsWith('open-'))
				.map(s => {
					const newline = s.content.indexOf('\n');
					return {
						path: s.content.slice(3, newline),
						content: s.content.slice(newline + 1),
					};
				}),
			recentEdits: pick('edit-'),
			lspContext: pick('lsp-').concat(pick('import-')),
			fileTree: included.find(s => s.name === 'fileTree')?.content ?? '',
		};
	}

	// ── Dynamic Context Helpers ──────────────────────────────────────────

	private _gatherOpenFilePointers(currentModel: ITextModel): Promise<Array<{ path: string; firstLine: string }>> {
		const result: Array<{ path: string; firstLine: string }> = [];

		try {
			const editors = this._editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);

			let count = 0;
			for (const { editor } of editors) {
				if (count >= MAX_OPEN_FILES) {
					break;
				}

				const resource = editor.resource;
				if (!resource || resource.toString() === currentModel.uri.toString()) {
					continue;
				}

				const model = this._modelService.getModel(resource);
				if (!model) {
					continue;
				}

				const firstLine = model.getLineContent(1);
				result.push({ path: resource.fsPath, firstLine });
				count++;
			}
		} catch {
			// best-effort
		}

		return Promise.resolve(result);
	}

	private async _gatherSymbolNames(
		model: ITextModel,
		position: Position,
		token: CancellationToken,
	): Promise<string[]> {
		const names: string[] = [];

		try {
			const startLine = Math.max(1, position.lineNumber - LSP_HOVER_LINES);
			const endLine = Math.min(model.getLineCount(), position.lineNumber + LSP_HOVER_LINES);

			for (let line = startLine; line <= endLine; line++) {
				const word = model.getWordAtPosition(new Position(line, model.getLineMaxColumn(line)));
				if (word && !names.includes(word.word)) {
					names.push(word.word);
				}
			}
		} catch {
			// best-effort
		}

		// suppress unused parameter lint — token is part of the interface contract
		void token;
		return names;
	}

	private _gatherRecentEditSummary(): Promise<string> {
		try {
			const edits = this._editTracker.getRecentEdits(MAX_RECENT_EDITS);
			if (edits.length === 0) {
				return Promise.resolve('');
			}
			const summary = edits.map(e => {
				const firstLine = e.split('\n')[0];
				return firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
			}).join('; ');
			return Promise.resolve(summary);
		} catch {
			return Promise.resolve('');
		}
	}

	// ── Source 2: LSP Definitions / Hover Info ──────────────────────────

	private async _gatherLspContext(
		model: ITextModel,
		position: Position,
		token: CancellationToken,
	): Promise<string[]> {
		const results: string[] = [];

		try {
			const startLine = Math.max(1, position.lineNumber - LSP_HOVER_LINES);
			const endLine = Math.min(model.getLineCount(), position.lineNumber + LSP_HOVER_LINES);

			const wordPositions: Position[] = [];
			for (let line = startLine; line <= endLine; line++) {
				const word = model.getWordAtPosition(new Position(line, model.getLineMaxColumn(line)));
				if (word) {
					wordPositions.push(new Position(line, word.startColumn));
				}
			}

			// Cap to avoid flooding — pick at most 6 symbol positions
			const capped = wordPositions.slice(0, 6);

			const hoverProviders = this._languageFeatures.hoverProvider.ordered(model);
			if (hoverProviders.length === 0) {
				return results;
			}

			const provider = hoverProviders[0];
			const hoverPromises = capped.map(async (pos) => {
				try {
					const hover = await Promise.race([
						provider.provideHover(model, pos, token),
						new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
					]);

					if (!hover || token.isCancellationRequested) {
						return;
					}

					for (const md of hover.contents) {
						const text = typeof md === 'string' ? md : md.value;
						if (text && text.length > 5) {
							results.push(text.slice(0, 600));
						}
					}
				} catch {
					// individual hover failures are non-fatal
				}
			});

			await Promise.all(hoverPromises);
		} catch {
			// LSP context is best-effort
		}

		return results;
	}

	// ── Source 3: Open Files (prioritised by MRU) ───────────────────────

	private _gatherOpenFiles(currentModel: ITextModel): Promise<Array<{ path: string; content: string }>> {
		const result: Array<{ path: string; content: string }> = [];

		try {
			const editors = this._editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);

			let count = 0;
			for (const { editor } of editors) {
				if (count >= MAX_OPEN_FILES) {
					break;
				}

				const resource = editor.resource;
				if (!resource || resource.toString() === currentModel.uri.toString()) {
					continue;
				}

				const model = this._modelService.getModel(resource);
				if (!model) {
					continue;
				}

				result.push({
					path: resource.fsPath,
					content: model.getValue().slice(0, MAX_OPEN_FILE_CHARS),
				});
				count++;
			}
		} catch {
			// best-effort
		}

		return Promise.resolve(result);
	}

	// ── Source 4: Recent Edits ──────────────────────────────────────────

	private _gatherRecentEdits(): Promise<string[]> {
		try {
			return Promise.resolve(this._editTracker.getRecentEdits(MAX_RECENT_EDITS));
		} catch {
			return Promise.resolve([]);
		}
	}

	// ── Source 5: Import Context ────────────────────────────────────────

	private _gatherImportContext(model: ITextModel): Promise<string[]> {
		const results: string[] = [];

		try {
			const first50Lines = model.getValueInRange(
				new Range(1, 1, Math.min(50, model.getLineCount()), model.getLineMaxColumn(Math.min(50, model.getLineCount()))),
			);

			let match: RegExpExecArray | null;
			IMPORT_PATTERN.lastIndex = 0;
			const importPaths: string[] = [];

			while ((match = IMPORT_PATTERN.exec(first50Lines)) !== null) {
				importPaths.push(match[1]);
			}

			for (const importPath of importPaths.slice(0, 8)) {
				if (importPath.startsWith('.')) {
					const resolvedUri = this._resolveRelativeImport(model, importPath);
					if (resolvedUri) {
						const importModel = this._modelService.getModel(resolvedUri);
						if (importModel) {
							const content = this._extractExports(importModel);
							if (content) {
								results.push(`// ${importPath}\n${content}`);
							}
						}
					}
				}
			}
		} catch {
			// best-effort
		}

		return Promise.resolve(results);
	}

	private _resolveRelativeImport(model: ITextModel, importPath: string): import('../../../../base/common/uri.js').URI | null {
		try {
			const base = model.uri;
			const dir = base.with({ path: base.path.slice(0, base.path.lastIndexOf('/')) });
			const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

			for (const ext of extensions) {
				const candidate = dir.with({ path: `${dir.path}/${importPath}${ext}`.replace(/\/\.\//g, '/') });
				if (this._modelService.getModel(candidate)) {
					return candidate;
				}
			}
		} catch {
			// ignore
		}
		return null;
	}

	private _extractExports(model: ITextModel): string {
		const lines = model.getLinesContent();
		const exports: string[] = [];
		let chars = 0;

		for (const line of lines) {
			if (/^\s*export\s/.test(line)) {
				exports.push(line);
				chars += line.length;
				if (chars > 1200) {
					break;
				}
			}
		}

		return exports.join('\n');
	}

	// ── Source 6: File Tree ─────────────────────────────────────────────

	private async _gatherFileTree(): Promise<string> {
		try {
			const workspace = this._workspaceContext.getWorkspace();
			if (workspace.folders.length === 0) {
				return '';
			}

			const root = workspace.folders[0].uri;
			const lines: string[] = [];
			await this._walkTree(root, '', 0, lines);
			return lines.join('\n');
		} catch {
			return '';
		}
	}

	private async _walkTree(uri: import('../../../../base/common/uri.js').URI, prefix: string, depth: number, lines: string[]): Promise<void> {
		if (depth > MAX_FILE_TREE_DEPTH || lines.length >= MAX_FILE_TREE_ENTRIES) {
			return;
		}

		try {
			const stat = await this._fileService.resolve(uri, { resolveMetadata: false });
			if (!stat.children) {
				return;
			}

			const sorted = stat.children
				.filter(c => !c.name.startsWith('.') && c.name !== 'node_modules' && c.name !== '__pycache__')
				.sort((a, b) => {
					if (a.isDirectory === b.isDirectory) {
						return a.name.localeCompare(b.name);
					}
					return a.isDirectory ? -1 : 1;
				});

			for (const child of sorted) {
				if (lines.length >= MAX_FILE_TREE_ENTRIES) {
					lines.push(`${prefix}...`);
					break;
				}

				const icon = child.isDirectory ? '[D]' : '   ';
				lines.push(`${prefix}${icon} ${child.name}`);

				if (child.isDirectory) {
					await this._walkTree(child.resource, prefix + '  ', depth + 1, lines);
				}
			}
		} catch {
			// directory not readable — skip
		}
	}
}

registerSingleton(ISidexContextEngine, SidexContextEngine, InstantiationType.Delayed);
