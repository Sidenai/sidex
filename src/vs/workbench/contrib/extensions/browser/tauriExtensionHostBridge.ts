/*---------------------------------------------------------------------------------------------
 *  SideX Extension Host Bridge
 *  Connects to the Node.js extension host via WebSocket and registers
 *  Monaco language feature providers that forward to loaded extensions.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { Disposable, DisposableStore as _DisposableStore, toDisposable as _toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import * as languages from '../../../../editor/common/languages.js';
import { LanguageSelector } from '../../../../editor/common/languageSelector.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

interface ExtHostMessage {
	id?: number;
	type?: string;
	method?: string;
	params?: any;
	result?: any;
	error?: string;
	event?: any;
}

class ExtHostConnection extends Disposable {
	private _ws: WebSocket | null = null;
	private _reqId = 0;
	private _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private _onEvent = this._register(new Emitter<any>());
	readonly onEvent = this._onEvent.event;

	async connect(): Promise<void> {
		const port = await invoke<number>('start_extension_host');
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			ws.onopen = () => {
				this._ws = ws;
				resolve();
			};
			ws.onerror = () => reject(new Error('ext host ws failed'));
			ws.onclose = () => { this._ws = null; };
			ws.onmessage = (ev) => {
				try {
					const msg: ExtHostMessage = JSON.parse(ev.data);
					if (msg.event) {
						this._onEvent.fire(msg.event);
					}
					if (msg.id !== undefined && this._pending.has(msg.id)) {
						const p = this._pending.get(msg.id)!;
						this._pending.delete(msg.id);
						if (msg.error) {
							p.reject(new Error(msg.error));
						} else {
							p.resolve(msg.result);
						}
					}
				} catch { }
			};
		});
	}

	request(method: string, params?: any): Promise<any> {
		if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('ext host not connected'));
		}
		const id = ++this._reqId;
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject });
			this._ws!.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this._pending.has(id)) {
					this._pending.delete(id);
					reject(new Error(`ext host timeout: ${method}`));
				}
			}, 30000);
		});
	}

	send(method: string, params?: any): void {
		if (this._ws && this._ws.readyState === WebSocket.OPEN) {
			this._ws.send(JSON.stringify({ id: ++this._reqId, method, params }));
		}
	}

	override dispose(): void {
		this._ws?.close();
		this._ws = null;
		for (const p of this._pending.values()) {
			p.reject(new Error('disposed'));
		}
		this._pending.clear();
		super.dispose();
	}
}

function toMonacoRange(r: any): Range {
	if (!r) { return new Range(1, 1, 1, 1); }
	return new Range(
		(r.start?.line ?? r.startLineNumber ?? 0) + 1,
		(r.start?.character ?? r.startColumn ?? 0) + 1,
		(r.end?.line ?? r.endLineNumber ?? 0) + 1,
		(r.end?.character ?? r.endColumn ?? 0) + 1,
	);
}

function toExtPos(pos: Position): { line: number; character: number } {
	return { line: pos.lineNumber - 1, character: pos.column - 1 };
}

export class TauriExtensionHostBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriExtensionHostBridge';

	private _conn: ExtHostConnection | null = null;

	constructor(
		@ILanguageFeaturesService private readonly _langFeatures: ILanguageFeaturesService,
	) {
		super();
		this._boot();
	}

	private async _boot(): Promise<void> {
		try {
			const conn = this._register(new ExtHostConnection());
			await conn.connect();
			this._conn = conn;

			await conn.request('initialize', {
				workspaceFolders: [],
				extensionPaths: [],
			});

			this._registerProviders(conn);
			this._listenEvents(conn);

			console.log('[SideX] Extension host bridge connected');
		} catch (e) {
			console.warn('[SideX] Extension host bridge failed:', e);
		}
	}

	private _registerProviders(conn: ExtHostConnection): void {
		const selector: LanguageSelector = { scheme: 'file' };

		this._register(this._langFeatures.completionProvider.register(selector, {
			_debugDisplayName: 'TauriExtHostCompletion',
			provideCompletionItems: async (model: ITextModel, position: Position, _context, token: CancellationToken) => {
				if (token.isCancellationRequested) { return { suggestions: [] }; }
				try {
					const result = await conn.request('provideCompletionItems', {
						uri: model.uri.toString(),
						position: toExtPos(position),
					});
					if (!result?.items?.length) { return { suggestions: [] }; }
					return {
						suggestions: result.items.map((item: any) => ({
							label: item.label || '',
							kind: item.kind ?? languages.CompletionItemKind.Text,
							insertText: item.insertText || item.label || '',
							detail: item.detail,
							documentation: item.documentation,
							sortText: item.sortText,
							filterText: item.filterText,
							range: undefined!,
						})),
					};
				} catch { return { suggestions: [] }; }
			}
		}));

		this._register(this._langFeatures.hoverProvider.register(selector, {
			provideHover: async (model: ITextModel, position: Position, token: CancellationToken) => {
				if (token.isCancellationRequested) { return null; }
				try {
					const result = await conn.request('provideHover', {
						uri: model.uri.toString(),
						position: toExtPos(position),
					});
					if (!result?.contents?.length) { return null; }
					return {
						contents: result.contents.map((c: any) => ({
							value: typeof c === 'string' ? c : c?.value || '',
						})),
						range: result.range ? toMonacoRange(result.range) : undefined,
					};
				} catch { return null; }
			}
		}));

		this._register(this._langFeatures.definitionProvider.register(selector, {
			provideDefinition: async (model: ITextModel, position: Position, token: CancellationToken) => {
				if (token.isCancellationRequested) { return null; }
				try {
					const result = await conn.request('provideDefinition', {
						uri: model.uri.toString(),
						position: toExtPos(position),
					});
					if (!result) { return null; }
					const locs = Array.isArray(result) ? result : [result];
					return locs.filter((l: any) => l?.uri).map((l: any) => ({
						uri: URI.parse(l.uri),
						range: toMonacoRange(l.range),
					}));
				} catch { return null; }
			}
		}));

		this._register(this._langFeatures.referenceProvider.register(selector, {
			provideReferences: async (model: ITextModel, position: Position, _context, token: CancellationToken) => {
				if (token.isCancellationRequested) { return null; }
				try {
					const result = await conn.request('provideReferences', {
						uri: model.uri.toString(),
						position: toExtPos(position),
					});
					if (!Array.isArray(result)) { return null; }
					return result.filter((l: any) => l?.uri).map((l: any) => ({
						uri: URI.parse(l.uri),
						range: toMonacoRange(l.range),
					}));
				} catch { return null; }
			}
		}));

		this._register(this._langFeatures.documentSymbolProvider.register(selector, {
			provideDocumentSymbols: async (model: ITextModel, token: CancellationToken) => {
				if (token.isCancellationRequested) { return null; }
				try {
					const result = await conn.request('provideDocumentSymbols', {
						uri: model.uri.toString(),
					});
					if (!Array.isArray(result)) { return null; }
					return result.map((s: any) => ({
						name: s.name || '',
						detail: s.detail || '',
						kind: s.kind ?? languages.SymbolKind.Variable,
						range: toMonacoRange(s.range),
						selectionRange: toMonacoRange(s.selectionRange || s.range),
						tags: [],
						children: [],
					}));
				} catch { return null; }
			}
		}));
	}

	private _listenEvents(conn: ExtHostConnection): void {
		this._register(conn.onEvent((event) => {
			if (event.type === 'showMessage') {
				console.log(`[ext] ${event.severity}: ${event.message}`);
			}
		}));
	}

	notifyDocumentOpened(uri: string, languageId: string, version: number, text: string): void {
		this._conn?.send('documentOpened', { uri, languageId, version, text });
	}

	notifyDocumentChanged(uri: string, version: number, text: string): void {
		this._conn?.send('documentChanged', { uri, version, changes: [{ text }] });
	}

	notifyDocumentClosed(uri: string): void {
		this._conn?.send('documentClosed', { uri });
	}
}

registerWorkbenchContribution2(
	TauriExtensionHostBridge.ID,
	TauriExtensionHostBridge,
	WorkbenchPhase.AfterRestored,
);
