/*---------------------------------------------------------------------------------------------
 *  InlineEditInputWidget — A small floating input that appears below the
 *  user's code selection, styled to match Cursor's CMD+K prompt.
 *  Uses Monaco's IContentWidget API for editor-relative positioning.
 *--------------------------------------------------------------------------------------------*/

import { ICodeEditor, IContentWidget, IContentWidgetPosition, ContentWidgetPositionPreference } from '../../../../../editor/browser/editorBrowser.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import * as DOM from '../../../../../base/browser/dom.js';

export class InlineEditInputWidget extends Disposable implements IContentWidget {
	private static _idCounter = 0;
	private readonly _id: string;
	private readonly _domNode: HTMLElement;
	private readonly _input: HTMLInputElement;
	private readonly _lineNumber: number;
	private readonly _column: number;
	private _isVisible = false;

	private readonly _onDidSubmit = this._register(new Emitter<string>());
	readonly onDidSubmit: Event<string> = this._onDidSubmit.event;

	private readonly _onDidCancel = this._register(new Emitter<void>());
	readonly onDidCancel: Event<void> = this._onDidCancel.event;

	constructor(
		private readonly _editor: ICodeEditor,
		lineNumber: number,
		column: number,
	) {
		super();
		this._id = `sidex.inlineEditInput.${InlineEditInputWidget._idCounter++}`;
		this._lineNumber = lineNumber;
		this._column = column;

		this._domNode = document.createElement('div');
		this._domNode.className = 'sidex-inline-edit-widget';

		const row = document.createElement('div');
		row.className = 'sidex-inline-edit-row';

		const label = document.createElement('span');
		label.className = 'sidex-inline-edit-label';
		label.textContent = 'Edit';
		row.appendChild(label);

		this._input = document.createElement('input');
		this._input.className = 'sidex-inline-edit-input';
		this._input.type = 'text';
		this._input.placeholder = 'Describe the change...';
		this._input.setAttribute('autocomplete', 'off');
		this._input.setAttribute('autocorrect', 'off');
		this._input.setAttribute('spellcheck', 'false');
		row.appendChild(this._input);

		const hint = document.createElement('span');
		hint.className = 'sidex-inline-edit-hint';
		hint.textContent = 'Enter';
		row.appendChild(hint);

		this._domNode.appendChild(row);

		this._register(DOM.addDisposableListener(this._input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				const value = this._input.value.trim();
				if (value) {
					this._onDidSubmit.fire(value);
				}
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this._onDidCancel.fire();
			}
		}));

		// Prevent the editor from handling key events while input is focused
		this._register(DOM.addDisposableListener(this._input, 'keydown', (e: KeyboardEvent) => {
			e.stopPropagation();
		}, true));
		this._register(DOM.addDisposableListener(this._input, 'keyup', (e: KeyboardEvent) => {
			e.stopPropagation();
		}, true));
		this._register(DOM.addDisposableListener(this._input, 'keypress', (e: KeyboardEvent) => {
			e.stopPropagation();
		}, true));
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		if (!this._isVisible) {
			return null;
		}
		return {
			position: { lineNumber: this._lineNumber, column: this._column },
			preference: [ContentWidgetPositionPreference.BELOW],
		};
	}

	show(): void {
		if (this._isVisible) {
			return;
		}
		this._isVisible = true;
		this._editor.addContentWidget(this);
		setTimeout(() => this._input.focus(), 0);
	}

	hide(): void {
		if (!this._isVisible) {
			return;
		}
		this._isVisible = false;
		this._editor.removeContentWidget(this);
	}

	setLoading(loading: boolean): void {
		this._input.disabled = loading;
		if (loading) {
			this._input.placeholder = 'Generating edit...';
			this._domNode.classList.add('loading');
		} else {
			this._input.placeholder = 'Describe the change...';
			this._domNode.classList.remove('loading');
		}
	}

	focus(): void {
		this._input.focus();
	}

	override dispose(): void {
		this.hide();
		super.dispose();
	}
}
