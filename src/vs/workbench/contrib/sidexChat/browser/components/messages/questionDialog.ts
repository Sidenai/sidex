/*---------------------------------------------------------------------------------------------
 *  Question Dialog — Structured multiple-choice widget shown when agent asks user to choose
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';

export interface QuestionData {
	toolCallId: string;
	title?: string;
	prompt: string;
	options: Array<{ id: string; label: string }>;
	allowMultiple: boolean;
}

export interface QuestionResult {
	toolCallId: string;
	selectedIds: string[];
}

export class QuestionDialog extends Component {
	private readonly _onRespond = this._register(new Emitter<QuestionResult>());
	readonly onRespond: Event<QuestionResult> = this._onRespond.event;

	private _selected: Set<string> = new Set();
	private _optionElements: Map<string, HTMLElement> = new Map();
	private _submitBtn!: HTMLElement;

	constructor(data: QuestionData) {
		super('div', 'sc-question-dialog');

		if (data.title) {
			this.appendText('div', data.title, 'sc-question-title');
		}

		this.appendText('div', data.prompt, 'sc-question-prompt');

		const optionsEl = this.append('div', 'sc-question-options');

		for (const opt of data.options) {
			const btn = DOM.append(optionsEl, $('button.sc-question-option'));
			btn.dataset.optionId = opt.id;
			btn.textContent = opt.label;
			this._optionElements.set(opt.id, btn);

			this.on(btn, 'click', () => {
				if (data.allowMultiple) {
					if (this._selected.has(opt.id)) {
						this._selected.delete(opt.id);
						btn.classList.remove('sc-question-selected');
					} else {
						this._selected.add(opt.id);
						btn.classList.add('sc-question-selected');
					}
					this._updateSubmit();
				} else {
					// Single select — immediately respond
					this._onRespond.fire({
						toolCallId: data.toolCallId,
						selectedIds: [opt.id],
					});
					btn.classList.add('sc-question-selected');
					this._disable();
				}
			});
		}

		if (data.allowMultiple) {
			const footer = this.append('div', 'sc-question-footer');
			this._submitBtn = DOM.append(footer, $('button.sc-question-submit'));
			this._submitBtn.textContent = 'Confirm';
			(this._submitBtn as HTMLButtonElement).disabled = true;
			this.on(this._submitBtn, 'click', () => {
				if (this._selected.size > 0) {
					this._onRespond.fire({
						toolCallId: data.toolCallId,
						selectedIds: [...this._selected],
					});
					this._disable();
				}
			});
		}
	}

	private _updateSubmit(): void {
		if (this._submitBtn) {
			(this._submitBtn as HTMLButtonElement).disabled = this._selected.size === 0;
		}
	}

	private _disable(): void {
		this.element.classList.add('sc-question-answered');
		for (const btn of this._optionElements.values()) {
			(btn as HTMLButtonElement).disabled = true;
		}
		if (this._submitBtn) {
			(this._submitBtn as HTMLButtonElement).disabled = true;
		}
	}
}
