/*---------------------------------------------------------------------------------------------
 *  InlineEditController — Orchestrates the CMD+K inline edit flow:
 *  selection → floating input → stream edit → inline diff → accept/reject.
 *  One controller instance lives per editor that has been activated.
 *--------------------------------------------------------------------------------------------*/

import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { InlineEditInputWidget } from './inlineEditInputWidget.js';
import { computeDiff } from '../components/diff/diffAlgorithm.js';
import { serverWsUrl } from '../localServer.js';

export class InlineEditController extends Disposable {
	private _inputWidget: InlineEditInputWidget | null = null;
	private _diffDecorations: string[] = [];
	private _actionWidgetDom: HTMLElement | null = null;
	private _originalCode: string = '';
	private _editedCode: string = '';
	private _editRange: Range | null = null;
	private _isActive = false;
	private readonly _widgetDisposables = this._register(new DisposableStore());

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _configService: IConfigurationService,
	) {
		super();
	}

	get isActive(): boolean {
		return this._isActive;
	}

	activate(): void {
		if (this._isActive) {
			this.dismiss();
		}

		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const sel = this._editor.getSelection();
		let editRange: Range;
		if (!sel || sel.isEmpty()) {
			const pos = this._editor.getPosition();
			if (!pos) { return; }
			editRange = new Range(pos.lineNumber, 1, pos.lineNumber, model.getLineMaxColumn(pos.lineNumber));
		} else {
			editRange = sel;
		}

		this._editRange = editRange;
		this._originalCode = model.getValueInRange(editRange);
		this._isActive = true;

		// Highlight the selected range
		this._diffDecorations = this._editor.deltaDecorations(this._diffDecorations, [{
			range: editRange,
			options: {
				description: 'sidex-inline-edit-selection',
				className: 'sidex-inline-edit-selection',
				isWholeLine: false,
			},
		}]);

		this._inputWidget = this._widgetDisposables.add(
			new InlineEditInputWidget(this._editor, editRange.endLineNumber, 1)
		);

		this._widgetDisposables.add(this._inputWidget.onDidSubmit(instruction => {
			void this._submit(instruction);
		}));

		this._widgetDisposables.add(this._inputWidget.onDidCancel(() => {
			this.dismiss();
		}));

		this._inputWidget.show();
	}

	private async _submit(instruction: string): Promise<void> {
		if (!this._editRange || !this._inputWidget) {
			return;
		}

		const model = this._editor.getModel();
		if (!model) { return; }

		this._inputWidget.setLoading(true);

		const serverUrl = this._getServerUrl();
		const language = model.getLanguageId();
		const filePath = model.uri.fsPath || model.uri.path;

		try {
			this._editedCode = await this._streamEdit(serverUrl, {
				instruction,
				code: this._originalCode,
				language,
				file_path: filePath,
			});

			this._inputWidget.hide();
			this._showInlineDiff(model);
		} catch (err) {
			this._inputWidget.setLoading(false);
			console.error('[Sidex InlineEdit] Error:', err);
		}
	}

	private async _streamEdit(
		serverUrl: string,
		body: { instruction: string; code: string; language: string; file_path: string },
	): Promise<string> {
		const httpUrl = serverUrl.replace(/^ws/, 'http');
		const model = this._configService.getValue<string>('sidex.selectedModel') || '';

		const resp = await fetch(`${httpUrl}/v1/inline-edit`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...body, model }),
		});

		if (!resp.ok) {
			throw new Error(`Server error: ${resp.status}`);
		}

		const reader = resp.body?.getReader();
		if (!reader) {
			throw new Error('No response body');
		}

		const decoder = new TextDecoder();
		let result = '';
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }

			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) { continue; }
				const jsonStr = line.slice(6).trim();
				if (!jsonStr) { continue; }

				try {
					const chunk = JSON.parse(jsonStr);
					if (chunk.type === 'text' && chunk.content) {
						result += chunk.content;
					} else if (chunk.type === 'error') {
						throw new Error(chunk.error || 'Unknown server error');
					}
				} catch (e) {
					if (e instanceof SyntaxError) { continue; }
					throw e;
				}
			}
		}

		return result;
	}

	private _showInlineDiff(model: ITextModel): void {
		if (!this._editRange) { return; }

		// Clear the selection highlight
		this._diffDecorations = this._editor.deltaDecorations(this._diffDecorations, []);

		const diffLines = computeDiff(this._originalCode, this._editedCode);
		const decorations: Array<{
			range: Range;
			options: {
				description: string;
				className?: string;
				isWholeLine: boolean;
				glyphMarginClassName?: string;
				after?: { content: string; inlineClassName: string };
			};
		}> = [];

		const startLine = this._editRange.startLineNumber;

		let oldLineOffset = 0;

		for (const line of diffLines) {
			if (line.type === 'removed') {
				const lineNo = startLine + oldLineOffset;
				if (lineNo <= model.getLineCount()) {
					decorations.push({
						range: new Range(lineNo, 1, lineNo, model.getLineMaxColumn(lineNo)),
						options: {
							description: 'sidex-inline-diff-removed',
							className: 'sidex-inline-diff-removed',
							isWholeLine: true,
							glyphMarginClassName: 'sidex-inline-diff-glyph-removed',
						},
					});
				}
				oldLineOffset++;
			} else if (line.type === 'added') {
				// Added lines will be shown as inserted decorations on the line following removals
				const lineNo = startLine + oldLineOffset;
				const insertLine = Math.min(lineNo, model.getLineCount());
				decorations.push({
					range: new Range(insertLine, 1, insertLine, 1),
					options: {
						description: 'sidex-inline-diff-added',
						className: 'sidex-inline-diff-added',
						isWholeLine: false,
						after: {
							content: ' + ' + line.content,
							inlineClassName: 'sidex-inline-diff-added-text',
						},
					},
				});
			} else {
				oldLineOffset++;
			}
		}

		this._diffDecorations = this._editor.deltaDecorations(this._diffDecorations, decorations);

		this._showAcceptRejectButtons();
	}

	private _showAcceptRejectButtons(): void {
		if (!this._editRange) { return; }

		this._removeActionWidget();

		const widget = document.createElement('div');
		widget.className = 'sidex-inline-edit-actions';

		const acceptBtn = document.createElement('button');
		acceptBtn.className = 'sidex-inline-edit-accept';
		acceptBtn.textContent = 'Accept';
		acceptBtn.title = 'Accept edit (Enter)';
		acceptBtn.addEventListener('click', () => this.accept());

		const rejectBtn = document.createElement('button');
		rejectBtn.className = 'sidex-inline-edit-reject';
		rejectBtn.textContent = 'Reject';
		rejectBtn.title = 'Reject edit (Escape)';
		rejectBtn.addEventListener('click', () => this.reject());

		widget.appendChild(acceptBtn);
		widget.appendChild(rejectBtn);

		const editorDom = this._editor.getDomNode();
		if (editorDom) {
			editorDom.style.position = 'relative';
			editorDom.appendChild(widget);
			this._actionWidgetDom = widget;
		}

		// Keyboard shortcuts while diff is showing
		const keyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				this.accept();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.reject();
			}
		};
		editorDom?.addEventListener('keydown', keyHandler, true);
		this._widgetDisposables.add({ dispose: () => editorDom?.removeEventListener('keydown', keyHandler, true) });
	}

	accept(): void {
		if (!this._editRange || !this._editedCode) {
			this.dismiss();
			return;
		}

		const model = this._editor.getModel();
		if (!model) {
			this.dismiss();
			return;
		}

		// Apply the edit
		this._editor.executeEdits('sidex.inlineEdit', [{
			range: this._editRange,
			text: this._editedCode,
		}]);

		this.dismiss();
	}

	reject(): void {
		this.dismiss();
	}

	dismiss(): void {
		this._widgetDisposables.clear();

		if (this._inputWidget) {
			this._inputWidget.dispose();
			this._inputWidget = null;
		}

		this._removeActionWidget();

		this._diffDecorations = this._editor.deltaDecorations(this._diffDecorations, []);

		this._originalCode = '';
		this._editedCode = '';
		this._editRange = null;
		this._isActive = false;

		this._editor.focus();
	}

	private _removeActionWidget(): void {
		if (this._actionWidgetDom) {
			this._actionWidgetDom.remove();
			this._actionWidgetDom = null;
		}
	}

	private _getServerUrl(): string {
		return serverWsUrl(this._configService.getValue<string>('sidex.chat.serverUrl'));
	}

	override dispose(): void {
		this.dismiss();
		super.dispose();
	}
}
